import type { PayloadRequest } from 'payload'

import { assertTransactionAccess, BlikError } from './blik.js'
import type { TpayClient } from './client.js'
import { finalizeOrder, markTransactionStatus } from './finalize.js'
import { assertRemoteMatchesTransaction } from './remote.js'
import type { TpayAdapterArgs } from './types.js'

type AnyDoc = Record<string, any>

/**
 * Transaction status the Tpay API returns for a settled payment.
 * Source: the official SDK example (`examples/TransactionsApi/CardGate.php`).
 */
export const TPAY_STATUS_PAID = 'correct'

/**
 * Statuses after which the payment will no longer go through. Any other one
 * (including `pending`) we treat as "still in progress" and leave the
 * transaction alone.
 */
const FAILED_STATUSES = new Set(['declined', 'error', 'expired', 'rejected'])

/**
 * Hands out the stock decrement trigger at most once per transaction.
 *
 * The plugin's `confirm-order` handler decrements inventory whenever the
 * adapter's answer carries `transactionID`
 * (`@payloadcms/plugin-ecommerce/dist/endpoints/confirmOrder.js`: the
 * `if (paymentResponse.transactionID)` branch). Its own attempt to strip that
 * key afterwards tests the literal string `'paymentResponse.transactionID'`,
 * so it never fires, and the adapter used to answer with `transactionID` on
 * every call - including the "already confirmed" one. Measured on a live
 * instance: two identical calls took stock from 5 to 4 to 3.
 *
 * So the idempotency gate has to live here. A conditional update claims
 * `tpay.stockClaimedAt` on the transaction, and only the call that wins the
 * claim gets `transactionID` back. Which path created the order does not
 * matter: the buyer's first confirmation, a repeated one, or a notification
 * that closed the order before the browser came back all go through the same
 * claim.
 *
 * A claim that cannot be written hands out nothing. Stock decremented twice
 * cannot be recovered automatically; stock not decremented at all is visible
 * in the panel and is already a documented limitation of this adapter.
 */
const claimStockTrigger = async (args: {
  req: PayloadRequest
  transaction: AnyDoc
  transactionsSlug: string
}): Promise<boolean> => {
  const { req, transaction, transactionsSlug } = args

  try {
    const claimed = await req.payload.update({
      collection: transactionsSlug,
      // The whole group is rewritten rather than the one field: a partial group
      // write is not the same thing across database adapters, and losing
      // `tpay.transactionId` here would cost the transaction its handle on Tpay.
      data: {
        tpay: {
          ...(transaction.tpay && typeof transaction.tpay === 'object' ? transaction.tpay : {}),
          stockClaimedAt: new Date().toISOString(),
        },
      },
      req,
      where: {
        and: [
          { id: { equals: transaction.id } },
          { 'tpay.stockClaimedAt': { exists: false } },
        ],
      },
    })

    return Array.isArray(claimed?.docs) && claimed.docs.length > 0
  } catch (error) {
    req.payload.logger.error({
      err: error,
      msg: `Tpay: could not claim the stock decrement trigger for transaction ${String(transaction.id)}; the shop has to adjust stock itself`,
    })

    return false
  }
}

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
        // The same answer `assertTransactionAccess` gives below, word for word.
        // Transaction identifiers are consecutive integers, so two different
        // messages would turn this endpoint into an oracle telling a stranger
        // which identifiers exist - and the answer a caller is entitled to is
        // the same in both cases: not yours.
        throw new BlikError('You are not allowed to access this payment.', 403)
      }

      // The local `find` bypasses Payload's access control, and transaction
      // identifiers are consecutive numbers. Without this gate anyone who got
      // past the plugin's checks with their own cart could confirm other
      // people's transactions and collect their `orderID` and `accessToken`.
      // The proofs are the same as on the BLIK endpoints: the logged-in owner
      // or the cart secret.
      await assertTransactionAccess({ cartsSlug, req, secret: data.secret, transaction })

      // A notification from Tpay may have closed this transaction already - in
      // that case there is nothing to confirm, there is a finished order to
      // return.
      if (transaction.order) {
        const finished = await finalizeOrder({
          cartsSlug,
          customerEmail,
          ordersSlug,
          req,
          transaction,
          transactionsSlug,
        })

        const claimedStock = await claimStockTrigger({ req, transaction, transactionsSlug })

        return {
          message: 'Order already confirmed',
          orderID: finished.order?.id,
          // `transactionID` is what makes the layer above decrement stock, so
          // it only goes out to the call that won the claim.
          ...(claimedStock ? { transactionID: transaction.id } : {}),
          ...(finished.order?.accessToken ? { accessToken: finished.order.accessToken } : {}),
        }
      }

      // We take the Tpay identifier EXCLUSIVELY from the transaction document.
      // The one in the request body only serves to find the document; were it
      // proof, a buyer could substitute the identifier of their own cheap
      // transaction for an expensive one that has not been given its own yet
      // (the window between `create` and the write).
      const remoteID = transaction.tpay?.transactionId

      if (!remoteID) {
        throw new Error('The transaction has no Tpay transaction ID to verify against.')
      }

      // We take the payment state from the Tpay API, never from whatever the
      // browser brought with it: the return URL lives on the client side and
      // can be opened by hand, without paying for anything.
      const remote = await client.getTransaction(String(remoteID))

      if (remote?.status !== TPAY_STATUS_PAID) {
        // A payment in progress stays in `pending`: the customer may still
        // finish the transfer, and switching it to `failed` would wipe their
        // cart. We go down to `failed` only on a settled refusal.
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

      // `correct` means "some transaction was paid". It has to be the same
      // amount and currency as in our document, otherwise the proof is not for
      // these purchases.
      assertRemoteMatchesTransaction({ remote, transaction })

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

      const claimedStock = await claimStockTrigger({ req, transaction, transactionsSlug })

      return {
        message: 'Order confirmed successfully',
        orderID: finished.order.id,
        // Same claim as in the "already confirmed" branch above: at most one
        // call per transaction ever carries the decrement trigger.
        ...(claimedStock ? { transactionID: transaction.id } : {}),
        ...(finished.order.accessToken ? { accessToken: finished.order.accessToken } : {}),
      }
    } catch (error) {
      payload.logger.error({ err: error, msg: 'Error confirming order with Tpay' })

      // A refusal already decided here keeps its status code; anything else is
      // flattened to a plain error so that Tpay API paths and status codes stay
      // in the log rather than travelling to the browser.
      if (error instanceof BlikError) {
        throw error
      }

      throw new Error(
        error instanceof Error ? error.message : 'Unknown error confirming an order with Tpay',
      )
    }
  }
