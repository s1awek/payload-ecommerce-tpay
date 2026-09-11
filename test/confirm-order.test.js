import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { confirmOrder } from '../dist/confirmOrder.js'
import { makeReq, PayloadStub } from './helpers/payload-stub.js'

const SECRET = 'cart-secret-abc'

const seed = (payload, overrides = {}) => {
  payload.seed('carts', { id: 'carts-1', secret: SECRET })

  return payload.seed('transactions', {
    id: 'transactions-1',
    amount: 1999,
    cart: 'carts-1',
    currency: 'PLN',
    customerEmail: 'customer@example.pl',
    items: [{ product: 'products-1', quantity: 1 }],
    paymentMethod: 'tpay',
    status: 'pending',
    tpay: { transactionId: 'TR-1' },
    ...overrides,
  })
}

/** Tpay API stub: amount and currency matching the seeded transaction (19.99 PLN). */
const clientReturning = (status, extra = {}) => {
  const calls = []

  return {
    calls,
    client: {
      getTransaction: async (id) => {
        calls.push(id)

        return { amount: 19.99, currency: 'PLN', status, transactionId: id, ...extra }
      },
    },
  }
}

describe('order confirmation after the payer returns', () => {
  it('asks Tpay for status and closes the order when the payment is settled', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { calls, client } = clientReturning('correct')

    const result = await confirmOrder({ client })({
      data: { secret: SECRET, transactionID: 'transactions-1' },
      req: makeReq(payload),
    })

    assert.deepEqual(calls, ['TR-1'], 'we take the status from the API, not from what the browser brought back')
    assert.equal(result.message, 'Order confirmed successfully')
    assert.equal(result.orderID, payload.docs('orders')[0].id)
    assert.equal(payload.docs('transactions')[0].status, 'succeeded')
  })

  it('the browser return alone, without a settled payment, does not create an order', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = clientReturning('pending')

    await assert.rejects(
      confirmOrder({ client })({ data: { secret: SECRET, transactionID: 'transactions-1' }, req: makeReq(payload) }),
      /not completed yet/,
    )

    assert.equal(payload.docs('orders').length, 0)
    assert.equal(payload.docs('transactions')[0].status, 'pending', 'a payment in progress stays in progress')
  })

  it('a settled decline moves the transaction to failed', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = clientReturning('declined')

    await assert.rejects(
      confirmOrder({ client })({ data: { secret: SECRET, transactionID: 'transactions-1' }, req: makeReq(payload) }),
      /not completed yet/,
    )

    assert.equal(payload.docs('transactions')[0].status, 'failed')
  })

  it('when the notification arrived first, it returns the ready order without asking the API', async () => {
    const payload = new PayloadStub()
    payload.seed('orders', { id: 'orders-1' })
    seed(payload, { order: 'orders-1', status: 'succeeded' })
    const { calls, client } = clientReturning('correct')

    const result = await confirmOrder({ client })({
      data: { secret: SECRET, transactionID: 'transactions-1' },
      req: makeReq(payload),
    })

    assert.equal(result.message, 'Order already confirmed')
    assert.equal(result.orderID, 'orders-1')
    assert.deepEqual(calls, [], 'there is no point asking Tpay about a transaction already closed')
    assert.equal(payload.docs('orders').length, 1)
  })

  it('finds the transaction also by the Tpay identifier', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = clientReturning('correct')

    const result = await confirmOrder({ client })({
      data: { secret: SECRET, tpayTransactionID: 'TR-1' },
      req: makeReq(payload),
    })

    assert.equal(result.transactionID, 'transactions-1')
  })

  it('without an identifier and for an unknown transaction it ends in an error', async () => {
    const payload = new PayloadStub()
    const { client } = clientReturning('correct')

    await assert.rejects(
      confirmOrder({ client })({ data: {}, req: makeReq(payload) }),
      /transactionID or tpayTransactionID is required/,
    )

    await assert.rejects(
      confirmOrder({ client })({ data: { transactionID: 'missing' }, req: makeReq(payload) }),
      /No transaction found/,
    )
  })

  // --- audit 11.09.2026: access gates and identity of the payment proof ---

  it('K-1: does not close a transaction lacking a Tpay identifier using proof supplied in the request', async () => {
    const payload = new PayloadStub()
    // The window between `create` and saving the Tpay identifier: the document exists, the identifier does not.
    seed(payload, { amount: 149000, tpay: {} })
    const { calls, client } = clientReturning('correct', { amount: 1490 })

    await assert.rejects(
      confirmOrder({ client })({
        // proof of payment for OUR OWN cheap transaction substituted for the expensive one
        data: { secret: SECRET, tpayTransactionID: 'TR-CHEAP', transactionID: 'transactions-1' },
        req: makeReq(payload),
      }),
      /no Tpay transaction ID/,
    )

    assert.deepEqual(calls, [], 'an identifier from the request body must not reach the API as proof')
    assert.equal(payload.docs('orders').length, 0)
    assert.equal(payload.docs('transactions')[0].status, 'pending')
  })

  it('W-1: rejects confirmation without a cart secret and without a logged-in owner', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { calls, client } = clientReturning('correct')

    await assert.rejects(
      confirmOrder({ client })({ data: { transactionID: 'transactions-1' }, req: makeReq(payload) }),
      /not allowed/,
    )
    await assert.rejects(
      confirmOrder({ client })({
        data: { secret: 'attacker-secret', transactionID: 'transactions-1' },
        req: makeReq(payload),
      }),
      /not allowed/,
    )

    assert.deepEqual(calls, [], 'without a right to the transaction we do not even ask Tpay')
    assert.equal(payload.docs('orders').length, 0)
  })

  it('W-1: a transaction already closed is also behind the gate - orderID and accessToken do not leak', async () => {
    const payload = new PayloadStub()
    payload.seed('orders', { id: 'orders-1', accessToken: 'owner-token' })
    seed(payload, { order: 'orders-1', status: 'succeeded' })
    const { client } = clientReturning('correct')

    await assert.rejects(
      confirmOrder({ client })({
        data: { secret: 'attacker-secret', transactionID: 'transactions-1' },
        req: makeReq(payload),
      }),
      /not allowed/,
    )
  })

  it('W-1: lets through the logged-in owner of the transaction without a secret', async () => {
    // known-good: a gate that never lets anyone through is equally broken
    const payload = new PayloadStub()
    seed(payload, { customer: 'users-7' })
    const { client } = clientReturning('correct')

    const result = await confirmOrder({ client })({
      data: { transactionID: 'transactions-1' },
      req: makeReq(payload, { user: { id: 'users-7' } }),
    })

    assert.equal(result.message, 'Order confirmed successfully')
  })

  it('W-4: a payment with a different amount than the transaction does not close the order', async () => {
    const payload = new PayloadStub()
    seed(payload) // 1999 cents
    const { client } = clientReturning('correct', { amount: 1.0 })

    await assert.rejects(
      confirmOrder({ client })({ data: { secret: SECRET, transactionID: 'transactions-1' }, req: makeReq(payload) }),
      /amount does not match/,
    )

    assert.equal(payload.docs('orders').length, 0)
    assert.equal(payload.docs('transactions')[0].status, 'pending')
  })

  it('W-4: a payment in a different currency than the transaction does not close the order', async () => {
    const payload = new PayloadStub()
    seed(payload) // PLN
    const { client } = clientReturning('correct', { currency: 'EUR' })

    await assert.rejects(
      confirmOrder({ client })({ data: { secret: SECRET, transactionID: 'transactions-1' }, req: makeReq(payload) }),
      /currency does not match/,
    )

    assert.equal(payload.docs('orders').length, 0)
  })

  it('W-4: an API response without an amount is a refusal, not a bypass of the check', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = clientReturning('correct', { amount: undefined })

    await assert.rejects(
      confirmOrder({ client })({ data: { secret: SECRET, transactionID: 'transactions-1' }, req: makeReq(payload) }),
      /amount does not match/,
    )
  })
})
