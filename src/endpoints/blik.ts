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
import type { TpayAdapterArgs } from '../types.js'

type AnyDoc = Record<string, any>

/** Statusy Tpay, po ktorych platnosc juz nie dojdzie do skutku. */
const FAILED_STATUSES = new Set(['declined', 'error', 'expired', 'rejected'])

/**
 * Wyciaga kod bledu z ostatniej proby zaplaty.
 *
 * Odrzucony kod BLIK NIE przestawia statusu transakcji - zmierzone 07.09.2026
 * na piaskownicy, gdzie kod `000000` zostawil transakcje w `pending`, a jedynym
 * sladem odmowy bylo `payments.attempts[].paymentErrorCode` rowne `63`.
 * Bez zajrzenia tutaj kasa nie odroznilaby „czekamy na potwierdzenie w banku"
 * od „kod odrzucony, poproś o nowy", i kazalaby kupujacemu czekac w nieskonczonosc.
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
 * Cialo zadania czytamy raz i odpornie na to, czy warstwa wyzej zdazyla je juz
 * rozpakowac do `req.data` (tak robi wtyczka e-commerce w swoich wlasnych
 * punktach), czy nie (nasze punkty stoja obok niej).
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

/** Wspolny wstep obu punktow: znajdz platnosc i sprawdz, czy wolno jej dotknac. */
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
    // Ten sam komunikat i ten sam kod co przy braku uprawnien, zeby odpowiedz
    // nie zdradzala, ktore identyfikatory istnieja.
    throw new BlikError('You are not allowed to access this payment.', 403)
  }

  await assertTransactionAccess({ cartsSlug, req, secret: body.secret, transaction })

  return transaction
}

/**
 * Sprowadza stan platnosci po stronie Tpay do trzech odpowiedzi, ktore kasa
 * sklepu potrafi pokazac kupujacemu, i domyka zamowienie, gdy jest zaplacone.
 *
 * Zamowienie domykamy tym samym `finalizeOrder`, ktorym robi to powiadomienie
 * serwer-serwer, a NIE punktem `confirm-order` wtyczki. Powod jest zmierzony:
 * handler wtyczki zdejmuje stan magazynowy przy kazdym wywolaniu, bez bramki
 * idempotencji, wiec odpytywanie go w petli - a odpytywanie jest w BLIK-u 0
 * konieczne - zabieralo by kolejna sztuke z magazynu przy kazdym sprawdzeniu.
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
    // Transakcji nie ruszamy: zostaje `pending`, bo kupujacy moze podac
    // kolejny kod do tej samej platnosci.
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

  return jsonResponse(
    { message: error instanceof Error ? error.message : 'Unknown error.' },
    500,
  )
}

/**
 * Przyjmuje kod BLIK wpisany w kasie sklepu i dosyla go do istniejacej platnosci.
 *
 * Odpowiedz NIGDY nie oglasza zaplaty, nawet gdy Tpay odpowie `success`:
 * zmierzone 07.09.2026, kod `abcdef` przeszedl tam jako `success`/`pending`.
 * Rozstrzyga dopiero status transakcji, o ktory kasa pyta osobno.
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

/** Zwraca aktualny stan platnosci, zeby kasa mogla odpytywac po wyslaniu kodu. */
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
