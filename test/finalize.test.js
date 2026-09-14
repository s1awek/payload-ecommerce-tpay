import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { finalizeOrder, markTransactionStatus } from '../dist/finalize.js'
import { makeReq, PayloadStub } from './helpers/payload-stub.js'

const seedTransaction = (payload, overrides = {}) =>
  payload.seed('transactions', {
    id: 'transactions-1',
    amount: 1999,
    cart: 'carts-1',
    currency: 'PLN',
    customerEmail: 'customer@example.pl',
    items: [{ product: 'products-1', quantity: 2 }],
    paymentMethod: 'tpay',
    status: 'pending',
    tpay: { shippingAddress: { city: 'Krakow' }, transactionId: 'TR-1' },
    ...overrides,
  })

describe('closing the order', () => {
  it('W-3: address from the request does not overwrite the address saved on the transaction', async () => {
    const payload = new PayloadStub()
    payload.seed('carts', { id: 'carts-1' })
    const transaction = seedTransaction(payload, { customerEmail: 'victim@example.pl' })

    await finalizeOrder({
      customerEmail: 'attacker@example.invalid',
      req: makeReq(payload),
      transaction,
      transactionsSlug: 'transactions',
    })

    assert.equal(payload.docs('orders')[0].customerEmail, 'victim@example.pl')
  })

  it('W-3: address from the request fills in a transaction that lacks one', async () => {
    const payload = new PayloadStub()
    payload.seed('carts', { id: 'carts-1' })
    const transaction = seedTransaction(payload, { customerEmail: undefined })

    await finalizeOrder({
      customerEmail: 'from-notification@example.pl',
      req: makeReq(payload),
      transaction,
      transactionsSlug: 'transactions',
    })

    assert.equal(payload.docs('orders')[0].customerEmail, 'from-notification@example.pl')
  })

  it('creates the order, moves the transaction, and marks the cart as purchased', async () => {
    const payload = new PayloadStub()
    payload.seed('carts', { id: 'carts-1' })
    const transaction = seedTransaction(payload)

    const result = await finalizeOrder({
      req: makeReq(payload),
      transaction,
      transactionsSlug: 'transactions',
    })

    assert.equal(result.created, true)
    assert.equal(payload.docs('orders').length, 1)

    const order = payload.docs('orders')[0]
    assert.equal(order.amount, 1999)
    assert.equal(order.currency, 'PLN')
    assert.equal(order.status, 'processing')
    assert.equal(order.customerEmail, 'customer@example.pl')
    assert.deepEqual(order.items, [{ product: 'products-1', quantity: 2 }])
    assert.deepEqual(order.shippingAddress, { city: 'Krakow' })
    assert.deepEqual(order.transactions, ['transactions-1'])

    const stored = payload.docs('transactions')[0]
    assert.equal(stored.status, 'succeeded')
    assert.equal(stored.order, order.id)
    assert.ok(payload.docs('carts')[0].purchasedAt, 'the cart has a purchase date')
  })

  it('a second call does not create a second order', async () => {
    const payload = new PayloadStub()
    payload.seed('carts', { id: 'carts-1' })
    const transaction = seedTransaction(payload)
    const req = makeReq(payload)

    const first = await finalizeOrder({ req, transaction, transactionsSlug: 'transactions' })
    const again = await finalizeOrder({
      req,
      transaction: payload.docs('transactions')[0],
      transactionsSlug: 'transactions',
    })

    assert.equal(first.created, true)
    assert.equal(again.created, false)
    assert.equal(again.order.id, first.order.id)
    assert.equal(payload.docs('orders').length, 1)
  })

  it('race: the loser deletes its own order and returns the winner order', async () => {
    const payload = new PayloadStub()
    payload.seed('carts', { id: 'carts-1' })
    const transaction = seedTransaction(payload)

    const winnersOrder = payload.seed('orders', { id: 'orders-winner', amount: 1999 })

    // The rival closes the transaction exactly between the creation of our order
    // and the conditional update - the only window where the race actually hurts.
    const create = payload.create.bind(payload)
    payload.create = async (args) => {
      const created = await create(args)

      if (args.collection === 'orders') {
        payload.collection('transactions').set('transactions-1', {
          ...payload.collection('transactions').get('transactions-1'),
          order: winnersOrder.id,
          status: 'succeeded',
        })
      }

      return created
    }

    const result = await finalizeOrder({
      req: makeReq(payload),
      transaction,
      transactionsSlug: 'transactions',
    })

    assert.equal(result.created, false)
    assert.equal(result.order.id, 'orders-winner')
    assert.equal(payload.docs('orders').length, 1, 'the redundant order was deleted')
    assert.equal(payload.docs('orders')[0].id, 'orders-winner')
    assert.equal(payload.docs('transactions')[0].order, 'orders-winner')
  })

  it('W2-4: a transaction outside pending still gets its order instead of losing it silently', async () => {
    const payload = new PayloadStub()
    payload.seed('carts', { id: 'carts-1' })
    // A settled refusal recorded earlier by confirm-order, then a late transfer.
    const transaction = seedTransaction(payload, { status: 'failed' })

    const result = await finalizeOrder({
      req: makeReq(payload),
      transaction,
      transactionsSlug: 'transactions',
    })

    assert.ok(result.order, 'money in with no order is worse than an order on a failed transaction')
    assert.equal(payload.docs('orders').length, 1, 'the order was not deleted')
    assert.equal(
      String(payload.docs('transactions')[0].order),
      String(result.order.id),
      'the transaction points at that order',
    )
    assert.equal(payload.docs('transactions')[0].status, 'succeeded')
  })

  it('W2-4: a conditional write nobody won keeps the order and attaches it unconditionally', async () => {
    const payload = new PayloadStub()
    payload.seed('carts', { id: 'carts-1' })
    const transaction = seedTransaction(payload)

    // `payload.update` with a `where` answers `{ docs, errors }`, and a write
    // refused by validation lands in `errors`. From here that is indistinguishable
    // from losing a race, which is exactly the case that used to delete a real
    // paid order.
    const update = payload.update.bind(payload)
    let refused = false
    payload.update = async (args) => {
      if (!refused && args.collection === 'transactions' && args.where) {
        refused = true

        return { docs: [], errors: [{ id: 'transactions-1', message: 'write refused' }] }
      }

      return await update(args)
    }

    const result = await finalizeOrder({
      req: makeReq(payload),
      transaction,
      transactionsSlug: 'transactions',
    })

    assert.ok(result.order)
    assert.equal(payload.docs('orders').length, 1, 'nothing was deleted, there was no winner to lose to')
    assert.equal(String(payload.docs('transactions')[0].order), String(result.order.id))
  })

  it('W2-4: a refunded transaction gets the order attached but is not reported as succeeded again', async () => {
    const payload = new PayloadStub()
    payload.seed('carts', { id: 'carts-1' })
    const transaction = seedTransaction(payload, { status: 'refunded' })

    const update = payload.update.bind(payload)
    let refused = false
    payload.update = async (args) => {
      if (!refused && args.collection === 'transactions' && args.where) {
        refused = true

        return { docs: [], errors: [{ id: 'transactions-1', message: 'write refused' }] }
      }

      return await update(args)
    }

    const result = await finalizeOrder({
      req: makeReq(payload),
      transaction,
      transactionsSlug: 'transactions',
    })

    assert.equal(String(payload.docs('transactions')[0].order), String(result.order.id))
    assert.equal(
      payload.docs('transactions')[0].status,
      'refunded',
      'a refund is a fact later than the payment',
    )
  })

  it('a failed cart marking does not break the order', async () => {
    const payload = new PayloadStub()
    const transaction = seedTransaction(payload)

    const result = await finalizeOrder({
      req: makeReq(payload),
      transaction,
      transactionsSlug: 'transactions',
    })

    assert.equal(result.created, true)
    assert.equal(payload.logs.error.length, 1, 'the cart failure leaves a trace in the log')
  })
})

describe('final transaction statuses', () => {
  it('sets the status and does not repeat the write', async () => {
    const payload = new PayloadStub()
    const transaction = seedTransaction(payload)
    const req = makeReq(payload)

    await markTransactionStatus({ req, status: 'failed', transaction, transactionsSlug: 'transactions' })
    assert.equal(payload.docs('transactions')[0].status, 'failed')

    const before = payload.calls.filter((call) => call.op === 'update').length
    await markTransactionStatus({
      req,
      status: 'failed',
      transaction: payload.docs('transactions')[0],
      transactionsSlug: 'transactions',
    })
    assert.equal(payload.calls.filter((call) => call.op === 'update').length, before)
  })

  it('does not roll back a successful payment, but accepts a withdrawal of funds', async () => {
    const payload = new PayloadStub()
    const transaction = seedTransaction(payload, { status: 'succeeded' })
    const req = makeReq(payload)

    await markTransactionStatus({ req, status: 'failed', transaction, transactionsSlug: 'transactions' })
    assert.equal(payload.docs('transactions')[0].status, 'succeeded')

    await markTransactionStatus({ req, status: 'refunded', transaction, transactionsSlug: 'transactions' })
    assert.equal(payload.docs('transactions')[0].status, 'refunded')
  })
})
