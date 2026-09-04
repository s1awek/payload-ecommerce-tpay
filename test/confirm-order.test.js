import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { confirmOrder } from '../dist/confirmOrder.js'
import { makeReq, PayloadStub } from './helpers/payload-stub.js'

const seed = (payload, overrides = {}) => {
  payload.seed('carts', { id: 'carts-1' })

  return payload.seed('transactions', {
    id: 'transactions-1',
    amount: 1999,
    cart: 'carts-1',
    currency: 'PLN',
    customerEmail: 'klient@example.pl',
    items: [{ product: 'products-1', quantity: 1 }],
    paymentMethod: 'tpay',
    status: 'pending',
    tpay: { transactionId: 'TR-1' },
    ...overrides,
  })
}

const clientReturning = (status) => {
  const calls = []

  return {
    calls,
    client: {
      getTransaction: async (id) => {
        calls.push(id)

        return { status, transactionId: id }
      },
    },
  }
}

describe('potwierdzenie zamowienia po powrocie platnika', () => {
  it('pyta Tpay o stan i domyka zamowienie, gdy platnosc jest zaksiegowana', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { calls, client } = clientReturning('correct')

    const result = await confirmOrder({ client })({
      data: { transactionID: 'transactions-1' },
      req: makeReq(payload),
    })

    assert.deepEqual(calls, ['TR-1'], 'stan bierzemy z API, nie z tego, co przyniosla przegladarka')
    assert.equal(result.message, 'Order confirmed successfully')
    assert.equal(result.orderID, payload.docs('orders')[0].id)
    assert.equal(payload.docs('transactions')[0].status, 'succeeded')
  })

  it('sam powrot przegladarki bez zaksiegowanej platnosci nie tworzy zamowienia', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = clientReturning('pending')

    await assert.rejects(
      confirmOrder({ client })({ data: { transactionID: 'transactions-1' }, req: makeReq(payload) }),
      /not completed yet/,
    )

    assert.equal(payload.docs('orders').length, 0)
    assert.equal(payload.docs('transactions')[0].status, 'pending', 'platnosc w toku zostaje w toku')
  })

  it('rozstrzygnieta odmowa przestawia transakcje na nieudana', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = clientReturning('declined')

    await assert.rejects(
      confirmOrder({ client })({ data: { transactionID: 'transactions-1' }, req: makeReq(payload) }),
      /not completed yet/,
    )

    assert.equal(payload.docs('transactions')[0].status, 'failed')
  })

  it('gdy powiadomienie zdazylo pierwsze, zwraca gotowe zamowienie bez pytania API', async () => {
    const payload = new PayloadStub()
    payload.seed('orders', { id: 'orders-1' })
    seed(payload, { order: 'orders-1', status: 'succeeded' })
    const { calls, client } = clientReturning('correct')

    const result = await confirmOrder({ client })({
      data: { transactionID: 'transactions-1' },
      req: makeReq(payload),
    })

    assert.equal(result.message, 'Order already confirmed')
    assert.equal(result.orderID, 'orders-1')
    assert.deepEqual(calls, [], 'nie ma po co pytac Tpay o transakcje juz domknieta')
    assert.equal(payload.docs('orders').length, 1)
  })

  it('odnajduje transakcje takze po identyfikatorze Tpay', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = clientReturning('correct')

    const result = await confirmOrder({ client })({
      data: { tpayTransactionID: 'TR-1' },
      req: makeReq(payload),
    })

    assert.equal(result.transactionID, 'transactions-1')
  })

  it('bez identyfikatora i dla nieznanej transakcji konczy sie bledem', async () => {
    const payload = new PayloadStub()
    const { client } = clientReturning('correct')

    await assert.rejects(
      confirmOrder({ client })({ data: {}, req: makeReq(payload) }),
      /transactionID or tpayTransactionID is required/,
    )

    await assert.rejects(
      confirmOrder({ client })({ data: { transactionID: 'brak' }, req: makeReq(payload) }),
      /No transaction found/,
    )
  })
})
