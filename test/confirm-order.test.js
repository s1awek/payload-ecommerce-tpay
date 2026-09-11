import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { confirmOrder } from '../dist/confirmOrder.js'
import { makeReq, PayloadStub } from './helpers/payload-stub.js'

const SEKRET = 'sekret-koszyka-abc'

const seed = (payload, overrides = {}) => {
  payload.seed('carts', { id: 'carts-1', secret: SEKRET })

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

/** Atrapa API Tpay: kwota i waluta takie, jak w zasianej transakcji (19.99 PLN). */
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

describe('potwierdzenie zamowienia po powrocie platnika', () => {
  it('pyta Tpay o stan i domyka zamowienie, gdy platnosc jest zaksiegowana', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { calls, client } = clientReturning('correct')

    const result = await confirmOrder({ client })({
      data: { secret: SEKRET, transactionID: 'transactions-1' },
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
      confirmOrder({ client })({ data: { secret: SEKRET, transactionID: 'transactions-1' }, req: makeReq(payload) }),
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
      confirmOrder({ client })({ data: { secret: SEKRET, transactionID: 'transactions-1' }, req: makeReq(payload) }),
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
      data: { secret: SEKRET, transactionID: 'transactions-1' },
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
      data: { secret: SEKRET, tpayTransactionID: 'TR-1' },
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

  // --- audyt 11.09.2026: bramki dostepu i tozsamosci dowodu zaplaty ---

  it('K-1: nie domyka transakcji bez identyfikatora Tpay dowodem podanym w zadaniu', async () => {
    const payload = new PayloadStub()
    // Okno miedzy `create` a zapisem identyfikatora Tpay: dokument jest, identyfikatora nie ma.
    seed(payload, { amount: 149000, tpay: {} })
    const { calls, client } = clientReturning('correct', { amount: 1490 })

    await assert.rejects(
      confirmOrder({ client })({
        // dowod zaplaty za WLASNA, tania transakcje podstawiony pod droga
        data: { secret: SEKRET, tpayTransactionID: 'TR-TANIA', transactionID: 'transactions-1' },
        req: makeReq(payload),
      }),
      /no Tpay transaction ID/,
    )

    assert.deepEqual(calls, [], 'identyfikator z ciala zadania nie moze trafic do API jako dowod')
    assert.equal(payload.docs('orders').length, 0)
    assert.equal(payload.docs('transactions')[0].status, 'pending')
  })

  it('W-1: odrzuca potwierdzenie bez sekretu koszyka i bez zalogowanego wlasciciela', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { calls, client } = clientReturning('correct')

    await assert.rejects(
      confirmOrder({ client })({ data: { transactionID: 'transactions-1' }, req: makeReq(payload) }),
      /not allowed/,
    )
    await assert.rejects(
      confirmOrder({ client })({
        data: { secret: 'sekret-napastnika', transactionID: 'transactions-1' },
        req: makeReq(payload),
      }),
      /not allowed/,
    )

    assert.deepEqual(calls, [], 'bez prawa do transakcji nie pytamy nawet Tpay')
    assert.equal(payload.docs('orders').length, 0)
  })

  it('W-1: transakcja juz domknieta tez jest za bramka - orderID i accessToken nie wyciekaja', async () => {
    const payload = new PayloadStub()
    payload.seed('orders', { id: 'orders-1', accessToken: 'token-wlasciciela' })
    seed(payload, { order: 'orders-1', status: 'succeeded' })
    const { client } = clientReturning('correct')

    await assert.rejects(
      confirmOrder({ client })({
        data: { secret: 'sekret-napastnika', transactionID: 'transactions-1' },
        req: makeReq(payload),
      }),
      /not allowed/,
    )
  })

  it('W-1: przepuszcza zalogowanego wlasciciela transakcji bez sekretu', async () => {
    // znane-dobre: bramka, ktora nigdy nie przepuszcza, jest tak samo zepsuta
    const payload = new PayloadStub()
    seed(payload, { customer: 'users-7' })
    const { client } = clientReturning('correct')

    const result = await confirmOrder({ client })({
      data: { transactionID: 'transactions-1' },
      req: makeReq(payload, { user: { id: 'users-7' } }),
    })

    assert.equal(result.message, 'Order confirmed successfully')
  })

  it('W-4: zaplata o innej kwocie niz transakcja nie domyka zamowienia', async () => {
    const payload = new PayloadStub()
    seed(payload) // 1999 groszy
    const { client } = clientReturning('correct', { amount: 1.0 })

    await assert.rejects(
      confirmOrder({ client })({ data: { secret: SEKRET, transactionID: 'transactions-1' }, req: makeReq(payload) }),
      /amount does not match/,
    )

    assert.equal(payload.docs('orders').length, 0)
    assert.equal(payload.docs('transactions')[0].status, 'pending')
  })

  it('W-4: zaplata w innej walucie niz transakcja nie domyka zamowienia', async () => {
    const payload = new PayloadStub()
    seed(payload) // PLN
    const { client } = clientReturning('correct', { currency: 'EUR' })

    await assert.rejects(
      confirmOrder({ client })({ data: { secret: SEKRET, transactionID: 'transactions-1' }, req: makeReq(payload) }),
      /currency does not match/,
    )

    assert.equal(payload.docs('orders').length, 0)
  })

  it('W-4: odpowiedz API bez kwoty jest odmowa, nie pominieciem kontroli', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = clientReturning('correct', { amount: undefined })

    await assert.rejects(
      confirmOrder({ client })({ data: { secret: SEKRET, transactionID: 'transactions-1' }, req: makeReq(payload) }),
      /amount does not match/,
    )
  })
})
