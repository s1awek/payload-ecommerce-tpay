import type { Endpoint, PayloadRequest } from 'payload'

import {
  assertBlikToken,
  assertTransactionAccess,
  BLIK_CHANNEL_ID,
  BLIK_METHOD,
  BlikError,
} from '../blik.js'
import type { TpayClient } from '../client.js'
import { TPAY_STATUS_PAID } from '../confirmOrder.js'
import { finalizeOrder, markTransactionStatus } from '../finalize.js'
import { assertRemoteMatchesTransaction, RemoteMismatchError } from '../remote.js'
import type { TpayAdapterArgs } from '../types.js'

type AnyDoc = Record<string, any>

/** Tpay statuses after which the payment will no longer go through. */
const FAILED_STATUSES = new Set(['declined', 'error', 'expired', 'rejected'])

/**
 * Extracts the error code from the last payment attempt.
 *
 * A rejected BLIK code does NOT change the transaction status - measured
 * 07.09.2026 on the sandbox, where the code `000000` left the transaction in
 * `pending` and the only trace of the refusal was
 * `payments.attempts[].paymentErrorCode` equal to `63`.
 * Without looking here, the checkout could not tell "waiting for confirmation
 * in the bank" from "code rejected, ask for a new one", and would have the
 * buyer waiting forever.
 */
const lastAttemptError = (remote: AnyDoc | undefined): null | string => {
  const attempts = (remote?.payments as AnyDoc | undefined)?.attempts

  if (!Array.isArray(attempts) || attempts.length === 0) {
    return null
  }

  const code = (attempts[attempts.length - 1] as AnyDoc)?.paymentErrorCode

  return code === null || code === undefined || code === '' ? null : String(code)
}

type BlikProps = TpayAdapterArgs & {
  cartsSlug?: string
  client: TpayClient
  ordersSlug?: string
  transactionsSlug?: string
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  })

/**
 * We read the request body once, and robustly with respect to whether the layer
 * above has already unpacked it into `req.data` (which is what the ecommerce
 * plugin does in its own endpoints) or not (our endpoints stand next to it).
 */
const readBody = async (req: PayloadRequest): Promise<AnyDoc> => {
  if (req.data && typeof req.data === 'object') {
    return req.data as AnyDoc
  }

  if (typeof req.json === 'function') {
    try {
      return ((await req.json()) as AnyDoc) || {}
    } catch {
      return {}
    }
  }

  return {}
}

/** Shared preamble of both endpoints: find the payment and check it may be touched. */
const loadTransaction = async (args: {
  body: AnyDoc
  cartsSlug: string
  req: PayloadRequest
  transactionsSlug: string
}): Promise<AnyDoc> => {
  const { body, cartsSlug, req, transactionsSlug } = args

  const transactionID = body.transactionID
  const tpayTransactionID = body.tpayTransactionID

  if (!transactionID && !tpayTransactionID) {
    throw new BlikError('Either transactionID or tpayTransactionID is required.')
  }

  const results = await req.payload.find({
    collection: transactionsSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    req,
    where: transactionID
      ? { id: { equals: transactionID } }
      : { 'tpay.transactionId': { equals: tpayTransactionID } },
  })

  const transaction = results.docs[0] as AnyDoc | undefined

  if (!transaction) {
    // The same message and the same code as for missing permission, so that
    // the response does not reveal which identifiers exist.
    throw new BlikError('You are not allowed to access this payment.', 403)
  }

  await assertTransactionAccess({ cartsSlug, req, secret: body.secret, transaction })

  return transaction
}

/**
 * Reduces the payment state on Tpay's side to three answers the shop checkout
 * can show the buyer, and closes the order once it is paid.
 *
 * We close the order with the same `finalizeOrder` the server-to-server
 * notification uses, and NOT with the plugin's `confirm-order` endpoint. The
 * reason is measured: the plugin's handler decrements stock on every call, with
 * no idempotency gate, so polling it in a loop - and polling is unavoidable in
 * BLIK 0 - would take another item off the shelf on every check.
 */
const resolveState = async (args: {
  props: BlikProps
  req: PayloadRequest
  transaction: AnyDoc
}): Promise<{ body: AnyDoc; status: number }> => {
  const { props, req, transaction } = args
  const {
    cartsSlug = 'carts',
    client,
    ordersSlug = 'orders',
    transactionsSlug = 'transactions',
  } = props

  const remoteID = transaction.tpay?.transactionId

  if (!remoteID) {
    throw new BlikError('The transaction has no Tpay transaction ID to check.')
  }

  const remote = await client.getTransaction(String(remoteID))
  const remoteStatus = String(remote?.status ?? 'unknown')

  if (remoteStatus === TPAY_STATUS_PAID) {
    // The same gate as in `confirm-order`: THIS transaction is the one that
    // has to be paid.
    assertRemoteMatchesTransaction({ remote, transaction })

    const finished = await finalizeOrder({
      cartsSlug,
      customerEmail: transaction.customerEmail,
      ordersSlug,
      req,
      transaction,
      transactionsSlug,
    })

    return {
      body: {
        message: 'Payment confirmed.',
        orderID: finished.order?.id,
        status: 'paid',
        transactionID: transaction.id,
      },
      status: 200,
    }
  }

  if (FAILED_STATUSES.has(remoteStatus)) {
    await markTransactionStatus({ req, status: 'failed', transaction, transactionsSlug })

    return {
      body: {
        message: 'The payment was not completed. Ask the buyer for a new BLIK code.',
        status: 'failed',
        tpayStatus: remoteStatus,
        transactionID: transaction.id,
      },
      status: 200,
    }
  }

  const attemptError = lastAttemptError(remote as AnyDoc)

  if (attemptError) {
    // We leave the transaction alone: it stays `pending`, because the buyer
    // can supply another code for the same payment.
    return {
      body: {
        message: 'The BLIK code was rejected. Ask the buyer for a new one.',
        status: 'rejected',
        tpayErrorCode: attemptError,
        tpayStatus: remoteStatus,
        transactionID: transaction.id,
      },
      status: 200,
    }
  }

  return {
    body: {
      message: 'Waiting for the buyer to confirm the payment in their banking app.',
      status: 'pending',
      tpayStatus: remoteStatus,
      transactionID: transaction.id,
    },
    status: 200,
  }
}

const errorResponse = (req: PayloadRequest, error: unknown, msg: string): Response => {
  if (error instanceof BlikError) {
    return jsonResponse({ message: error.message }, error.status)
  }

  req.payload.logger.error({ err: error, msg })

  if (error instanceof RemoteMismatchError) {
    return jsonResponse({ message: 'The payment does not match this transaction.' }, error.status)
  }

  // Details (including the text of `TpayApiError` with the API method and
  // path) stay in the log. What goes out is a fixed message, just as from the
  // plugin's handler.
  return jsonResponse({ message: 'Payment could not be processed.' }, 500)
}

/**
 * Accepts the BLIK code typed at the shop checkout and sends it to the existing
 * payment.
 *
 * The response NEVER announces payment, even when Tpay answers `success`:
 * measured 07.09.2026, the code `abcdef` went through there as
 * `success`/`pending`. Only the transaction status, which the checkout asks for
 * separately, decides.
 */
export const blikEndpoint = (props: BlikProps): Endpoint => {
  const handler = async (req: PayloadRequest): Promise<Response> => {
    const { cartsSlug = 'carts', client, transactionsSlug = 'transactions' } = props

    try {
      const body = await readBody(req)
      const blikToken = assertBlikToken(body.blikToken)
      const transaction = await loadTransaction({ body, cartsSlug, req, transactionsSlug })

      if (transaction.order) {
        return jsonResponse({
          message: 'This payment is already confirmed.',
          status: 'paid',
          transactionID: transaction.id,
        })
      }

      const remoteID = transaction.tpay?.transactionId

      if (!remoteID) {
        throw new BlikError('The transaction has no Tpay transaction ID to pay against.')
      }

      await client.payByTransactionId(String(remoteID), {
        blikPaymentData: { blikToken, type: 0 },
        channelId: BLIK_CHANNEL_ID,
        method: BLIK_METHOD,
      })

      return jsonResponse({
        message: 'Waiting for the buyer to confirm the payment in their banking app.',
        status: 'pending',
        transactionID: transaction.id,
      })
    } catch (error) {
      return errorResponse(req, error, 'Error sending a BLIK code to Tpay')
    }
  }

  return {
    handler,
    method: 'post',
    path: '/blik',
  }
}

/** Returns the current payment state, so the checkout can poll after sending the code. */
export const blikStatusEndpoint = (props: BlikProps): Endpoint => {
  const handler = async (req: PayloadRequest): Promise<Response> => {
    const { cartsSlug = 'carts', transactionsSlug = 'transactions' } = props

    try {
      const body = await readBody(req)
      const transaction = await loadTransaction({ body, cartsSlug, req, transactionsSlug })

      if (transaction.order) {
        return jsonResponse({
          message: 'Payment confirmed.',
          orderID: typeof transaction.order === 'object' ? transaction.order.id : transaction.order,
          status: 'paid',
          transactionID: transaction.id,
        })
      }

      const resolved = await resolveState({ props, req, transaction })

      return jsonResponse(resolved.body, resolved.status)
    } catch (error) {
      return errorResponse(req, error, 'Error checking a Tpay payment status')
    }
  }

  return {
    handler,
    method: 'post',
    path: '/blik-status',
  }
}
