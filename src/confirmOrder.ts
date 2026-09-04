import type { PayloadRequest } from 'payload'

import type { TpayClient } from './client.js'
import { finalizeOrder, markTransactionStatus } from './finalize.js'
import type { TpayAdapterArgs } from './types.js'

type AnyDoc = Record<string, any>

/**
 * Status transakcji zwracany przez API Tpay dla platnosci zaksiegowanej.
 * Zrodlo: oficjalny przyklad SDK (`examples/TransactionsApi/CardGate.php`).
 */
export const TPAY_STATUS_PAID = 'correct'

/**
 * Statusy, po ktorych platnosc juz nie dojdzie do skutku. Kazdy inny
 * (w tym `pending`) traktujemy jako „jeszcze w toku" i transakcji nie ruszamy.
 */
const FAILED_STATUSES = new Set(['declined', 'error', 'expired', 'rejected'])

export const confirmOrder =
  (props: TpayAdapterArgs & { client: TpayClient }) =>
  async ({
    cartsSlug = 'carts',
    data,
    ordersSlug = 'orders',
    req,
    transactionsSlug = 'transactions',
  }: {
    cartsSlug?: string
    customersSlug?: string
    data: { [key: string]: any; customerEmail?: string }
    ordersSlug?: string
    req: PayloadRequest
    transactionsSlug?: string
  }) => {
    const payload = req.payload
    const { client } = props

    const customerEmail = data.customerEmail
    const transactionID = data.transactionID
    const tpayTransactionID = data.tpayTransactionID

    if (!transactionID && !tpayTransactionID) {
      throw new Error('Either transactionID or tpayTransactionID is required to confirm an order.')
    }

    try {
      const results = await payload.find({
        collection: transactionsSlug,
        limit: 1,
        req,
        where: transactionID
          ? { id: { equals: transactionID } }
          : { 'tpay.transactionId': { equals: tpayTransactionID } },
      })

      const transaction = results.docs[0] as AnyDoc | undefined

      if (!transaction) {
        throw new Error('No transaction found for the provided identifier.')
      }

      // Powiadomienie od Tpay moglo juz zamknac te transakcje - wtedy nie ma
      // czego potwierdzac, jest gotowe zamowienie do zwrocenia.
      if (transaction.order) {
        const finished = await finalizeOrder({
          cartsSlug,
          customerEmail,
          ordersSlug,
          req,
          transaction,
          transactionsSlug,
        })

        return {
          message: 'Order already confirmed',
          orderID: finished.order?.id,
          transactionID: transaction.id,
          ...(finished.order?.accessToken ? { accessToken: finished.order.accessToken } : {}),
        }
      }

      const remoteID = transaction.tpay?.transactionId || tpayTransactionID

      if (!remoteID) {
        throw new Error('The transaction has no Tpay transaction ID to verify against.')
      }

      // Stan platnosci bierzemy z API Tpay, nigdy z tego, co przyniosla
      // przegladarka: adres powrotu jest po stronie klienta i da sie go otworzyc
      // recznie, bez placenia czegokolwiek.
      const remote = await client.getTransaction(String(remoteID))

      if (remote?.status !== TPAY_STATUS_PAID) {
        // Platnosc w toku zostaje w stanie `pending`: klient moze jeszcze
        // dokonczyc przelew, a przestawienie na `failed` skasowaloby mu koszyk.
        // Na `failed` schodzimy dopiero przy rozstrzygnietej odmowie.
        if (FAILED_STATUSES.has(String(remote?.status))) {
          await markTransactionStatus({
            req,
            status: 'failed',
            transaction,
            transactionsSlug,
          })
        }

        throw new Error(
          `Payment is not completed yet (Tpay status: ${String(remote?.status ?? 'unknown')}).`,
        )
      }

      const finished = await finalizeOrder({
        cartsSlug,
        customerEmail,
        ordersSlug,
        req,
        transaction,
        transactionsSlug,
      })

      if (!finished.order) {
        throw new Error(finished.reason || 'Order could not be created for this transaction.')
      }

      return {
        message: 'Order confirmed successfully',
        orderID: finished.order.id,
        transactionID: transaction.id,
        ...(finished.order.accessToken ? { accessToken: finished.order.accessToken } : {}),
      }
    } catch (error) {
      payload.logger.error({ err: error, msg: 'Error confirming order with Tpay' })

      throw new Error(
        error instanceof Error ? error.message : 'Unknown error confirming an order with Tpay',
      )
    }
  }
