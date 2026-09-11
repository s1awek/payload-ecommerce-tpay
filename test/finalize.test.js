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
    customerEmail: 'klient@example.pl',
    items: [{ product: 'products-1', quantity: 2 }],
    paymentMethod: 'tpay',
    status: 'pending',
    tpay: { shippingAddress: { city: 'Kraków' }, transactionId: 'TR-1' },
    ...overrides,
  })

describe('domykanie zamowienia', () => {
  it('W-3: adres z zadania nie nadpisuje adresu zapisanego na transakcji', async () => {
    const payload = new PayloadStub()
    payload.seed('carts', { id: 'carts-1' })
    const transaction = seedTransaction(payload, { customerEmail: 'ofiara@example.pl' })

    await finalizeOrder({
      customerEmail: 'napastnik@example.invalid',
      req: makeReq(payload),
      transaction,
      transactionsSlug: 'transactions',
    })

    assert.equal(payload.docs('orders')[0].customerEmail, 'ofiara@example.pl')
  })

  it('W-3: adres z zadania uzupelnia transakcje, ktora go nie ma', async () => {
    const payload = new PayloadStub()
    payload.seed('carts', { id: 'carts-1' })
    const transaction = seedTransaction(payload, { customerEmail: undefined })

    await finalizeOrder({
      customerEmail: 'z-powiadomienia@example.pl',
      req: makeReq(payload),
      transaction,
      transactionsSlug: 'transactions',
    })

    assert.equal(payload.docs('orders')[0].customerEmail, 'z-powiadomienia@example.pl')
  })

  it('tworzy zamowienie, przestawia transakcje i oznacza koszyk jako kupiony', async () => {
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
    assert.equal(order.customerEmail, 'klient@example.pl')
    assert.deepEqual(order.items, [{ product: 'products-1', quantity: 2 }])
    assert.deepEqual(order.shippingAddress, { city: 'Kraków' })
    assert.deepEqual(order.transactions, ['transactions-1'])

    const stored = payload.docs('transactions')[0]
    assert.equal(stored.status, 'succeeded')
    assert.equal(stored.order, order.id)
    assert.ok(payload.docs('carts')[0].purchasedAt, 'koszyk ma date zakupu')
  })

  it('drugie wywolanie nie tworzy drugiego zamowienia', async () => {
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

  it('wyscig: przegrany kasuje swoje zamowienie i zwraca zamowienie zwyciezcy', async () => {
    const payload = new PayloadStub()
    payload.seed('carts', { id: 'carts-1' })
    const transaction = seedTransaction(payload)

    const winnersOrder = payload.seed('orders', { id: 'orders-winner', amount: 1999 })

    // Rywal domyka transakcje dokladnie miedzy utworzeniem naszego zamowienia
    // a warunkowa aktualizacja - czyli w jedynym oknie, w ktorym wyscig boli.
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
    assert.equal(payload.docs('orders').length, 1, 'nadmiarowe zamowienie zostalo skasowane')
    assert.equal(payload.docs('orders')[0].id, 'orders-winner')
    assert.equal(payload.docs('transactions')[0].order, 'orders-winner')
  })

  it('nieudane oznaczenie koszyka nie wywraca zamowienia', async () => {
    const payload = new PayloadStub()
    const transaction = seedTransaction(payload)

    const result = await finalizeOrder({
      req: makeReq(payload),
      transaction,
      transactionsSlug: 'transactions',
    })

    assert.equal(result.created, true)
    assert.equal(payload.logs.error.length, 1, 'awaria koszyka zostawia slad w logu')
  })
})

describe('koncowe statusy transakcji', () => {
  it('ustawia status i nie powtarza zapisu', async () => {
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

  it('nie cofa udanej platnosci, ale przyjmuje wycofanie srodkow', async () => {
    const payload = new PayloadStub()
    const transaction = seedTransaction(payload, { status: 'succeeded' })
    const req = makeReq(payload)

    await markTransactionStatus({ req, status: 'failed', transaction, transactionsSlug: 'transactions' })
    assert.equal(payload.docs('transactions')[0].status, 'succeeded')

    await markTransactionStatus({ req, status: 'refunded', transaction, transactionsSlug: 'transactions' })
    assert.equal(payload.docs('transactions')[0].status, 'refunded')
  })
})
