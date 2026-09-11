import type { Endpoint, PayloadRequest } from 'payload'

import { decimalStringToMinor } from '../amount.js'
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

/** Statusy powiadomienia oznaczajace zaksiegowana platnosc. */
const PAID_STATUSES = new Set(['PAID', 'TRUE'])
/** Wycofanie srodkow po udanej platnosci. */
const CHARGEBACK_STATUS = 'CHARGEBACK'

/**
 * Tpay uznaje powiadomienie za dostarczone dopiero po odpowiedzi o tresci `TRUE`.
 * Kazda inna odpowiedz (takze pusta z kodem 200) powoduje ponowienia.
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
      // Domyslnie WLACZONE. Suma md5 nie obejmuje `tr_status` ani `tr_paid`,
      // czyli pol, na ktorych stoi decyzja o pieniadzach; podpis JWS obejmuje
      // cale cialo. Wylaczenie ma byc jawna decyzja integratora.
      verifyJws = true,
    } = props

    if (!securityCode || merchantId === undefined || merchantId === null || merchantId === '') {
      // Bez kodu bezpieczenstwa nie da sie odroznic powiadomienia od Tpay
      // od zadania wyslanego przez kogokolwiek innego. Przyjmowanie takich
      // powiadomien znaczyloby, ze zamowienie oplaca sie slowem honoru.
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

    if (!isChecksumValid(notification, { merchantId, securityCode })) {
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

    // Dwa niezalezne uchwyty na nasza transakcje: identyfikator Tpay oraz
    // `tr_crc`, w ktorym siedzi identyfikator naszego dokumentu. Drugi ratuje
    // sytuacje, w ktorej zapis identyfikatora Tpay nie doszedl do skutku.
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

      // Powiadomienie jest autentyczne, tylko nie mamy go z czym zestawic.
      // Ponowienia niczego nie zmienia, wiec potwierdzamy odbior i zostawiamy
      // slad w logu - to sprawa do reki operatora, nie do petli ponowien.
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

    // Kwota zaplacona bywa inna niz zadana: przy zwyklym przelewie to platnik
    // wpisuje kwote w swoim banku. Niedoplata nie moze domykac zamowienia.
    const expectedMinor = Number(transaction.amount)
    let paidMinor: number

    try {
      paidMinor = decimalStringToMinor(String(notification.tr_paid ?? '0'))
    } catch {
      // Uwierzytelnione, ale zniekształcone: traktujemy jak niedoplate i
      // potwierdzamy odbior, bo ponowienia Tpay nie naprawia tresci.
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
