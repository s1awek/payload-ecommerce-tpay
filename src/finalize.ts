import type { PayloadRequest } from 'payload'

type AnyDoc = Record<string, any>

type FinalizeArgs = {
  cartsSlug?: string
  customerEmail?: string
  ordersSlug?: string
  req: PayloadRequest
  /** Transaction document from the `transactions` collection. */
  transaction: AnyDoc
  transactionsSlug: string
}

export type FinalizeResult = {
  /** Whether the order was created in this call (false = it already existed). */
  created: boolean
  order: AnyDoc | null
  /** Reason why there is no order, when `order` is empty. */
  reason?: string
}

const idOf = (value: unknown): string | undefined => {
  if (!value) {
    return undefined
  }

  if (typeof value === 'object') {
    return (value as AnyDoc).id ? String((value as AnyDoc).id) : undefined
  }

  return String(value)
}

/**
 * Closes an order from a transaction, exactly once.
 *
 * Two independent paths call this: the server-to-server notification from Tpay
 * and the return of the customer's browser (`confirmOrder`). Both can arrive at
 * the same time, and often do, because Tpay sends the notification at the very
 * moment the customer's browser is coming back to the shop page.
 *
 * The ordering is the reverse of the intuitive one, and that is the most
 * important thing about it: the order is created BEFORE the transaction status
 * is switched. A conditional update (`status: pending` -> `succeeded`) decides
 * who won; the loser deletes its freshly created order, which nobody has seen
 * yet, and returns the winner's order. Were it the other way round (status
 * first, order second), a failure between the one and the other would leave a
 * transaction paid with no order and no way out - a state with no automatic
 * recovery.
 *
 * What this does NOT guarantee. `payload.update` with a `where` is not an
 * atomic compare-and-swap: Payload runs a `db.find` and only then writes per
 * document (`node_modules/payload/dist/collections/operations/update.js`).
 * That leaves a narrow window in which both calls see status `pending` and both
 * consider themselves the winner. The result is an orphaned order document that
 * nothing points to - not a double charge to the payer, because there is only
 * one payment. Closing that window would require `payload.db.updateOne` with a
 * condition, which in turn bypasses the collection hooks that shops can rely
 * on. The choice falls on the hooks; the rest is described in the README as a
 * known limitation.
 */
export async function finalizeOrder(args: FinalizeArgs): Promise<FinalizeResult> {
  const {
    cartsSlug = 'carts',
    customerEmail,
    ordersSlug = 'orders',
    req,
    transaction,
    transactionsSlug,
  } = args

  const payload = req.payload

  const existingOrderID = idOf(transaction.order)

  if (existingOrderID) {
    const existing = await payload.findByID({
      id: existingOrderID,
      collection: ordersSlug,
      req,
    })

    return { created: false, order: existing as AnyDoc }
  }

  const customerID = idOf(transaction.customer)
  // The address saved on the transaction at `initiate` takes precedence. An
  // address from a later request (browser return, notification) only fills in
  // when the transaction has none - otherwise someone who knows another
  // person's transaction identifier could assign themselves an order paid for
  // by somebody else.
  const email = transaction.customerEmail || customerEmail

  const order = (await payload.create({
    collection: ordersSlug,
    data: {
      amount: transaction.amount,
      currency: transaction.currency,
      ...(customerID ? { customer: customerID } : email ? { customerEmail: email } : {}),
      items: transaction.items,
      ...(transaction.tpay?.shippingAddress
        ? { shippingAddress: transaction.tpay.shippingAddress }
        : {}),
      status: 'processing',
      transactions: [transaction.id],
    },
    req,
  })) as AnyDoc

  const claimed = await payload.update({
    collection: transactionsSlug,
    data: {
      order: order.id,
      status: 'succeeded',
    },
    req,
    where: {
      and: [{ id: { equals: transaction.id } }, { status: { equals: 'pending' } }],
    },
  })

  const won = Array.isArray(claimed?.docs) && claimed.docs.length > 0

  if (!won) {
    // Somebody else closed this transaction at the same moment. We delete our
    // own order before anyone sees it and return the one that remained.
    try {
      await payload.delete({ id: order.id, collection: ordersSlug, req })
    } catch (error) {
      payload.logger.error({
        err: error,
        msg: `Tpay: could not remove the duplicate order ${String(order.id)} after losing the finalisation race`,
      })
    }

    const fresh = (await payload.findByID({
      id: transaction.id,
      collection: transactionsSlug,
      req,
    })) as AnyDoc

    const winnerOrderID = idOf(fresh?.order)

    if (!winnerOrderID) {
      return {
        created: false,
        order: null,
        reason: 'Transaction was finalised concurrently but carries no order',
      }
    }

    const winnerOrder = await payload.findByID({
      id: winnerOrderID,
      collection: ordersSlug,
      req,
    })

    return { created: false, order: winnerOrder as AnyDoc }
  }

  const cartID = idOf(transaction.cart)

  if (cartID) {
    try {
      await payload.update({
        id: cartID,
        collection: cartsSlug,
        data: { purchasedAt: new Date().toISOString() },
        req,
      })
    } catch (error) {
      // A cart marked as purchased is a convenience, not a condition of the order.
      payload.logger.error({
        err: error,
        msg: `Tpay: could not mark cart ${cartID} as purchased`,
      })
    }
  }

  return { created: true, order }
}

/**
 * Sets the final status of a transaction that does not end in an order
 * (refusal, chargeback). Never reverts a transaction that already succeeded -
 * apart from a chargeback, which is precisely a change after a successful
 * payment.
 */
export async function markTransactionStatus(args: {
  req: PayloadRequest
  status: 'cancelled' | 'expired' | 'failed' | 'refunded'
  transaction: AnyDoc
  transactionsSlug: string
}): Promise<void> {
  const { req, status, transaction, transactionsSlug } = args

  if (transaction.status === status) {
    return
  }

  if (transaction.status === 'succeeded' && status !== 'refunded') {
    return
  }

  await req.payload.update({
    id: transaction.id,
    collection: transactionsSlug,
    data: { status },
    req,
  })
}
