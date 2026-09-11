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
  addressLine1: 'Dluga 5',
  city: 'Krakow',
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
          throw new Error('Tpay refused')
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
    payerSuccessUrl: 'https://sklep.example/order/ok',
    ...props,
  })

  const result = await handler({
    data: {
      billingAddress,
      cart,
      currency: 'pln',
      customerEmail: 'anna@example.pl',
      shippingAddress: { city: 'Gdansk' },
      ...data,
    },
    req: makeReq(payload),
    transactionsSlug: 'transactions',
  })

  return { calls, payload, result }
}

describe('payment initiation', () => {
  it('saves the transaction before the request to Tpay and sends the decimal amount', async () => {
    const { calls, payload, result } = await run()

    const transaction = payload.docs('transactions')[0]
    assert.equal(transaction.status, 'pending')
    assert.equal(transaction.amount, 1999, 'the database keeps cents')
    assert.equal(transaction.currency, 'PLN')
    assert.equal(transaction.paymentMethod, 'tpay')
    assert.equal(transaction.cart, 'carts-1')

    assert.equal(calls.length, 1)
    assert.equal(calls[0].amount, 19.99, 'Tpay gets the decimal amount, not cents')
    assert.equal(calls[0].currency, 'PLN')
    assert.equal(calls[0].hiddenDescription, transaction.id, 'the identifier comes back in tr_crc')
    assert.equal(calls[0].callbacks.notification.url, 'https://sklep.example/api/payments/tpay/notifications')
    assert.equal(calls[0].callbacks.payerUrls.success, 'https://sklep.example/order/ok')
    assert.equal(calls[0].lang, 'pl')

    assert.equal(result.paymentUrl, 'https://secure.tpay.com/pay/TR-1')
    assert.equal(result.transactionID, transaction.id)
    assert.equal(result.tpayTransactionID, 'TR-1')
  })

  it('appends the Tpay identifier and shipping address to the transaction', async () => {
    const { payload } = await run()
    const transaction = payload.docs('transactions')[0]

    assert.equal(transaction.tpay.transactionId, 'TR-1')
    assert.equal(transaction.tpay.paymentUrl, 'https://secure.tpay.com/pay/TR-1')
    assert.deepEqual(transaction.tpay.shippingAddress, { city: 'Gdansk' })
  })

  it('an amount of 100 PLN is 100.00, not 10000 - a check against a hundredfold mistake', async () => {
    const { calls } = await run({}, { cart: { ...cart, subtotal: 10000 } })

    assert.equal(calls[0].amount, 100)
  })

  it('a failure on the Tpay side leaves the transaction marked as failed', async () => {
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
      /Tpay refused/,
    )

    assert.equal(payload.docs('transactions')[0].status, 'failed')
  })

  it('a missing transaction identifier in the response is an error, not a silent success', async () => {
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

  it('rejects input that cannot end in a payment', async () => {
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

describe('payer data and cart items', () => {
  it('builds the payer name from first and last name, then company, then email', () => {
    assert.equal(buildPayer({ billingAddress, customerEmail: 'a@b.pl' }).name, 'Anna Nowak')
    assert.equal(
      buildPayer({ billingAddress: { company: 'Wellmade' }, customerEmail: 'a@b.pl' }).name,
      'Wellmade',
    )
    assert.equal(buildPayer({ customerEmail: 'a@b.pl' }).name, 'a@b.pl')
  })

  it('the country code goes in uppercase, and empty fields are not sent', () => {
    const payer = buildPayer({ billingAddress, customerEmail: 'a@b.pl' })

    assert.equal(payer.country, 'PL')
    assert.equal(payer.code, '31-000')
    assert.equal(payer.city, 'Krakow')

    const minimal = buildPayer({ billingAddress: {}, customerEmail: 'a@b.pl' })
    assert.deepEqual(Object.keys(minimal).sort(), ['email', 'name'])
  })

  it('flattens items to identifiers, keeping custom fields', () => {
    const flat = flattenCartItems([
      { deliveryOption: 'courier', product: { id: 'p1' }, quantity: 2, variant: { id: 'v1' } },
      { product: 'p2', quantity: 1 },
    ])

    assert.deepEqual(flat, [
      { deliveryOption: 'courier', product: 'p1', quantity: 2, variant: 'v1' },
      { product: 'p2', quantity: 1 },
    ])
  })
})
