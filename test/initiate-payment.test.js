import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildPayer, flattenCartItems, initiatePayment } from '../dist/initiatePayment.js'
import { makeReq, PayloadStub } from './helpers/payload-stub.js'

const cart = {
  id: 'carts-1',
  items: [
    { product: { id: 'products-1' }, quantity: 2, variant: { id: 'variants-7' } },
    { product: 'products-2', quantity: 1 },
  ],
  subtotal: 1999,
}

const billingAddress = {
  addressLine1: 'Długa 5',
  city: 'Kraków',
  country: 'pl',
  firstName: 'Anna',
  lastName: 'Nowak',
  phone: '+48123456789',
  postalCode: '31-000',
}

const fakeClient = (overrides = {}) => {
  const calls = []

  return {
    calls,
    client: {
      createTransaction: async (payload) => {
        calls.push(payload)

        if (overrides.fail) {
          throw new Error('Tpay odmowil')
        }

        return {
          title: 'TR-TITLE',
          transactionId: 'TR-1',
          transactionPaymentUrl: 'https://secure.tpay.com/pay/TR-1',
          ...overrides.response,
        }
      },
    },
  }
}

const run = async (props = {}, data = {}) => {
  const payload = new PayloadStub()
  const { calls, client } = fakeClient(props.clientOverrides || {})

  const handler = initiatePayment({
    client,
    notificationUrl: 'https://sklep.example/api/payments/tpay/notifications',
    payerSuccessUrl: 'https://sklep.example/zamowienie/ok',
    ...props,
  })

  const result = await handler({
    data: {
      billingAddress,
      cart,
      currency: 'pln',
      customerEmail: 'anna@example.pl',
      shippingAddress: { city: 'Gdańsk' },
      ...data,
    },
    req: makeReq(payload),
    transactionsSlug: 'transactions',
  })

  return { calls, payload, result }
}

describe('inicjacja platnosci', () => {
  it('zapisuje transakcje przed zadaniem do Tpay i wysyla kwote dziesietna', async () => {
    const { calls, payload, result } = await run()

    const transaction = payload.docs('transactions')[0]
    assert.equal(transaction.status, 'pending')
    assert.equal(transaction.amount, 1999, 'w bazie zostaja grosze')
    assert.equal(transaction.currency, 'PLN')
    assert.equal(transaction.paymentMethod, 'tpay')
    assert.equal(transaction.cart, 'carts-1')

    assert.equal(calls.length, 1)
    assert.equal(calls[0].amount, 19.99, 'do Tpay idzie kwota dziesietna, nie grosze')
    assert.equal(calls[0].currency, 'PLN')
    assert.equal(calls[0].hiddenDescription, transaction.id, 'identyfikator wraca w tr_crc')
    assert.equal(calls[0].callbacks.notification.url, 'https://sklep.example/api/payments/tpay/notifications')
    assert.equal(calls[0].callbacks.payerUrls.success, 'https://sklep.example/zamowienie/ok')
    assert.equal(calls[0].lang, 'pl')

    assert.equal(result.paymentUrl, 'https://secure.tpay.com/pay/TR-1')
    assert.equal(result.transactionID, transaction.id)
    assert.equal(result.tpayTransactionID, 'TR-1')
  })

  it('dopisuje identyfikator Tpay i adres dostawy do transakcji', async () => {
    const { payload } = await run()
    const transaction = payload.docs('transactions')[0]

    assert.equal(transaction.tpay.transactionId, 'TR-1')
    assert.equal(transaction.tpay.paymentUrl, 'https://secure.tpay.com/pay/TR-1')
    assert.deepEqual(transaction.tpay.shippingAddress, { city: 'Gdańsk' })
  })

  it('kwota 100 zl to 100.00, a nie 10000 - kontrola na pomylke stukrotna', async () => {
    const { calls } = await run({}, { cart: { ...cart, subtotal: 10000 } })

    assert.equal(calls[0].amount, 100)
  })

  it('awaria po stronie Tpay zostawia transakcje oznaczona jako nieudana', async () => {
    const payload = new PayloadStub()
    const { client } = fakeClient({ fail: true })

    const handler = initiatePayment({
      client,
      notificationUrl: 'https://sklep.example/api/payments/tpay/notifications',
    })

    await assert.rejects(
      handler({
        data: { billingAddress, cart, currency: 'PLN', customerEmail: 'anna@example.pl' },
        req: makeReq(payload),
        transactionsSlug: 'transactions',
      }),
      /Tpay odmowil/,
    )

    assert.equal(payload.docs('transactions')[0].status, 'failed')
  })

  it('brak identyfikatora transakcji w odpowiedzi to blad, nie cichy sukces', async () => {
    const payload = new PayloadStub()
    const { client } = fakeClient({ response: { transactionId: undefined } })

    const handler = initiatePayment({
      client,
      notificationUrl: 'https://sklep.example/api/payments/tpay/notifications',
    })

    await assert.rejects(
      handler({
        data: { billingAddress, cart, currency: 'PLN', customerEmail: 'anna@example.pl' },
        req: makeReq(payload),
        transactionsSlug: 'transactions',
      }),
      /did not return a transaction ID/,
    )
  })

  it('odrzuca wejscie, ktore nie moze skonczyc sie platnoscia', async () => {
    const cases = [
      [{ currency: '' }, /Currency is required/],
      [{ cart: { ...cart, items: [] } }, /Cart is empty/],
      [{ customerEmail: '' }, /valid customer email/],
      [{ cart: { ...cart, subtotal: 0 } }, /valid amount/],
      [{ cart: { ...cart, subtotal: -100 } }, /valid amount/],
    ]

    for (const [data, expected] of cases) {
      await assert.rejects(run({}, data), expected)
    }

    await assert.rejects(run({ notificationUrl: undefined }), /notification URL is required/)
  })
})

describe('dane platnika i pozycje koszyka', () => {
  it('sklada nazwe platnika z imienia i nazwiska, potem firmy, potem maila', () => {
    assert.equal(buildPayer({ billingAddress, customerEmail: 'a@b.pl' }).name, 'Anna Nowak')
    assert.equal(
      buildPayer({ billingAddress: { company: 'Wellmade' }, customerEmail: 'a@b.pl' }).name,
      'Wellmade',
    )
    assert.equal(buildPayer({ customerEmail: 'a@b.pl' }).name, 'a@b.pl')
  })

  it('kod kraju idzie wielkimi literami, a puste pola nie sa wysylane', () => {
    const payer = buildPayer({ billingAddress, customerEmail: 'a@b.pl' })

    assert.equal(payer.country, 'PL')
    assert.equal(payer.code, '31-000')
    assert.equal(payer.city, 'Kraków')

    const minimal = buildPayer({ billingAddress: {}, customerEmail: 'a@b.pl' })
    assert.deepEqual(Object.keys(minimal).sort(), ['email', 'name'])
  })

  it('splaszcza pozycje do identyfikatorow, zachowujac pola wlasne', () => {
    const flat = flattenCartItems([
      { deliveryOption: 'kurier', product: { id: 'p1' }, quantity: 2, variant: { id: 'v1' } },
      { product: 'p2', quantity: 1 },
    ])

    assert.deepEqual(flat, [
      { deliveryOption: 'kurier', product: 'p1', quantity: 2, variant: 'v1' },
      { product: 'p2', quantity: 1 },
    ])
  })
})
