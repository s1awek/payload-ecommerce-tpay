import type { Endpoint, PayloadRequest } from 'payload'

import { decimalStringToMinor } from '../amount.js'
import { minorUnitDecimals, TPAY_CURRENCY_DECIMALS } from '../currencies.js'
import { finalizeOrder, markTransactionStatus } from '../finalize.js'
import type { TpayAdapterArgs } from '../types.js'
import {
  allowedX5uHostsFor,
  isChecksumValid,
  parseNotificationBody,
  verifyJwsSignature,
  type TpayNotification,
} from '../verify.js'

type AnyDoc = Record<string, any>

/** Notification statuses meaning a settled payment. */
const PAID_STATUSES = new Set(['PAID', 'TRUE'])
/** Chargeback after a successful payment. */
const CHARGEBACK_STATUS = 'CHARGEBACK'

/**
 * Tpay considers a notification delivered only after a response whose body is
 * `TRUE`. Any other response (including an empty one with code 200) causes
 * retries.
 */
const okResponse = (): Response =>
  new Response('TRUE', { headers: { 'Content-Type': 'text/plain' }, status: 200 })

const rejectResponse = (status: number): Response =>
  new Response('FALSE', { headers: { 'Content-Type': 'text/plain' }, status })

export const notificationsEndpoint = (
  props: TpayAdapterArgs & { ordersSlug?: string; transactionsSlug?: string },
): Endpoint => {
  const handler = async (req: PayloadRequest): Promise<Response> => {
    const payload = req.payload
    const {
      jwsRootCertificate,
      merchantId,
      ordersSlug = 'orders',
      sandbox = false,
      securityCode,
      transactionsSlug = 'transactions',
      // Turned on BY DEFAULT. The md5 checksum covers neither `tr_status` nor
      // `tr_paid`, that is, the fields the decision about money rests on; the
      // JWS signature covers the whole body. Turning it off is meant to be an
      // explicit decision by the integrator.
      verifyJws = true,
    } = props

    if (!securityCode || merchantId === undefined || merchantId === null || merchantId === '') {
      // Without the security code there is no way to tell a notification from
      // Tpay apart from a request sent by anyone else. Accepting such
      // notifications would mean an order can be paid for on one's word of
      // honour.
      payload.logger.error(
        'Tpay: notification rejected because merchantId or securityCode is not configured',
      )

      return rejectResponse(500)
    }

    if (typeof req.text !== 'function') {
      payload.logger.error('Tpay: notification rejected because the raw request body is unavailable')

      return rejectResponse(400)
    }

    const rawBody = await req.text()
    const notification: TpayNotification = parseNotificationBody(rawBody)

    if (!notification.tr_id) {
      payload.logger.error('Tpay: notification rejected, no tr_id in the request body')

      return rejectResponse(400)
    }

    let checksumValid: boolean

    try {
      checksumValid = isChecksumValid(notification, { merchantId, securityCode })
    } catch (error) {
      // `tr_amount` goes into the checksum through `normalizeAmountString`,
      // which throws for anything that is not a plain decimal amount (empty, a
      // comma, three decimal places). This endpoint is a public URL, so a body
      // written by hand has to come back as the ordinary refusal rather than as
      // an unhandled exception the host turns into a 500 with a stack trace.
      payload.logger.error({
        err: error,
        msg: `Tpay: notification for ${String(notification.tr_id)} rejected, its amount could not be read`,
      })

      return rejectResponse(400)
    }

    if (!checksumValid) {
      payload.logger.error(
        `Tpay: notification for ${String(notification.tr_id)} rejected, md5 checksum does not match`,
      )

      return rejectResponse(400)
    }

    if (verifyJws) {
      const header = req.headers.get('x-jws-signature')

      if (!header) {
        payload.logger.error(
          `Tpay: notification for ${String(notification.tr_id)} rejected, X-JWS-Signature header is missing`,
        )

        return rejectResponse(400)
      }

      const jws = await verifyJwsSignature({
        allowedX5uHosts: allowedX5uHostsFor(Boolean(sandbox)),
        header,
        rawBody,
        ...(jwsRootCertificate ? { rootCertificate: jwsRootCertificate } : {}),
      })

      if (!jws.ok) {
        payload.logger.error(
          `Tpay: notification for ${String(notification.tr_id)} rejected, JWS signature invalid: ${String(jws.reason)}`,
        )

        return rejectResponse(400)
      }
    }

    // Two independent handles on our transaction: the Tpay identifier and
    // `tr_crc`, which carries the identifier of our own document. The second
    // one rescues the case where writing the Tpay identifier did not go
    // through.
    let transaction: AnyDoc | undefined

    const byRemoteID = await payload.find({
      collection: transactionsSlug,
      limit: 1,
      req,
      where: { 'tpay.transactionId': { equals: notification.tr_id } },
    })

    transaction = byRemoteID.docs[0] as AnyDoc | undefined

    if (!transaction && notification.tr_crc) {
      try {
        transaction = (await payload.findByID({
          id: notification.tr_crc,
          collection: transactionsSlug,
          req,
        })) as AnyDoc
      } catch {
        transaction = undefined
      }
    }

    if (!transaction) {
      payload.logger.error(
        `Tpay: no transaction found for tr_id=${String(notification.tr_id)} tr_crc=${String(notification.tr_crc)}`,
      )

      // The notification is authentic, we just have nothing to match it
      // against. Retries would change nothing, so we acknowledge receipt and
      // leave a trace in the log - this is a matter for an operator's hands,
      // not for a retry loop.
      return okResponse()
    }

    const status = String(notification.tr_status || '').toUpperCase()

    if (status === CHARGEBACK_STATUS) {
      await markTransactionStatus({ req, status: 'refunded', transaction, transactionsSlug })

      return okResponse()
    }

    if (!PAID_STATUSES.has(status)) {
      payload.logger.warn(
        `Tpay: notification for transaction ${String(transaction.id)} carries status ${status || '(empty)'}`,
      )

      return okResponse()
    }

    // The amount paid is sometimes different from the amount requested: on an
    // ordinary bank transfer it is the payer who types the amount into their
    // bank. An underpayment must not close the order.
    const expectedMinor = Number(transaction.amount)

    if (!Number.isFinite(expectedMinor) || expectedMinor <= 0) {
      // Fail closed, the same way the API path does (`assertRemoteMatchesTransaction`).
      // A document whose amount cannot be read is nothing to compare a payment
      // against, and a comparison that cannot be made must not report "nothing
      // owing": the previous `Number.isFinite(...) && paid < expected` let any
      // payment through, however small, on exactly those transactions.
      payload.logger.error(
        `Tpay: transaction ${String(transaction.id)} has an unusable amount ${JSON.stringify(transaction.amount)}, so the payment cannot be checked against it. Order not created.`,
      )

      return okResponse()
    }

    // The same table the outgoing side refuses on (`initiatePayment`) and the
    // API side compares with (`assertRemoteMatchesTransaction`). A currency this
    // package cannot represent in minor units must not slip through here just
    // because this path does its own arithmetic.
    const currencyDecimals = minorUnitDecimals(transaction.currency)

    if (currencyDecimals !== TPAY_CURRENCY_DECIMALS) {
      payload.logger.error(
        `Tpay: transaction ${String(transaction.id)} is in ${String(transaction.currency)}, which has ${currencyDecimals} minor unit decimal places; this package settles in two decimal currencies only. Order not created.`,
      )

      return okResponse()
    }

    let paidMinor: number

    try {
      paidMinor = decimalStringToMinor(String(notification.tr_paid ?? '0'))
    } catch {
      // Authenticated but malformed: we treat it like an underpayment and
      // acknowledge receipt, because Tpay's retries will not repair the body.
      payload.logger.error(
        `Tpay: transaction ${String(transaction.id)} notification carries unreadable tr_paid=${JSON.stringify(notification.tr_paid)}. Order not created.`,
      )

      return okResponse()
    }

    if (Number.isFinite(expectedMinor) && paidMinor < expectedMinor) {
      payload.logger.error(
        `Tpay: transaction ${String(transaction.id)} underpaid - expected ${expectedMinor}, paid ${paidMinor} (minor units). Order not created.`,
      )

      return okResponse()
    }

    const finished = await finalizeOrder({
      customerEmail: notification.tr_email,
      ordersSlug,
      req,
      transaction,
      transactionsSlug,
    })

    if (!finished.order) {
      payload.logger.error(
        `Tpay: transaction ${String(transaction.id)} confirmed but no order was created: ${String(finished.reason)}`,
      )
    }

    return okResponse()
  }

  return {
    handler,
    method: 'post',
    path: '/notifications',
  }
}
