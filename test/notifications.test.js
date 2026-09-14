import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { notificationsEndpoint } from '../dist/endpoints/notifications.js'
import { notificationChecksum } from '../dist/verify.js'
import { makeReq, PayloadStub } from './helpers/payload-stub.js'

const MERCHANT_ID = '123456'
const SECURITY_CODE = 'test-code'

const seed = (payload, overrides = {}) => {
  payload.seed('carts', { id: 'carts-1' })

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

const body = (fields, { sign = true, securityCode = SECURITY_CODE } = {}) => {
  const base = {
    id: MERCHANT_ID,
    test_mode: '0',
    tr_amount: '19.99',
    tr_crc: 'transactions-1',
    tr_date: '2026-09-04 20:00:00',
    tr_desc: 'Order carts-1',
    tr_email: 'customer@example.pl',
    tr_error: 'none',
    tr_id: 'TR-1',
    tr_paid: '19.99',
    tr_status: 'TRUE',
    ...fields,
  }

  const md5sum = sign ? notificationChecksum(base, { merchantId: MERCHANT_ID, securityCode }) : 'wrong'

  return new URLSearchParams({ ...base, md5sum }).toString()
}

const call = async (payload, raw, props = {}) => {
  const endpoint = notificationsEndpoint({
    merchantId: MERCHANT_ID,
    securityCode: SECURITY_CODE,
    // The md5 checksum tests explicitly disable JWS; a separate test measures the default value.
    verifyJws: false,
    ...props,
  })

  return await endpoint.handler(makeReq(payload, { body: raw, headers: props.headers }))
}

describe('notification receiving endpoint', () => {
  it('is exposed as POST /notifications', () => {
    const endpoint = notificationsEndpoint({ merchantId: MERCHANT_ID, securityCode: SECURITY_CODE })

    assert.equal(endpoint.method, 'post')
    assert.equal(endpoint.path, '/notifications')
  })

  it('known-good: creates the order and responds TRUE', async () => {
    const payload = new PayloadStub()
    seed(payload)

    const response = await call(payload, body({}))

    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'TRUE')
    assert.equal(payload.docs('orders').length, 1)
    assert.equal(payload.docs('transactions')[0].status, 'succeeded')
    assert.equal(payload.docs('transactions')[0].order, payload.docs('orders')[0].id)
  })

  it('known-bad: a wrong checksum does not create an order', async () => {
    const payload = new PayloadStub()
    seed(payload)

    const response = await call(payload, body({}, { sign: false }))

    assert.equal(response.status, 400)
    assert.equal(payload.docs('orders').length, 0)
    assert.equal(payload.docs('transactions')[0].status, 'pending')
    assert.equal(payload.logs.error.length, 1)
  })

  it("known-bad: a checksum computed with someone else's security code is rejected", async () => {
    const payload = new PayloadStub()
    seed(payload)

    const response = await call(payload, body({}, { securityCode: 'someone-elses-code' }))

    assert.equal(response.status, 400)
    assert.equal(payload.docs('orders').length, 0)
  })

  it('known-bad: an amount raised after signing does not pass', async () => {
    const payload = new PayloadStub()
    seed(payload)

    const raw = body({})
    const tampered = raw.replace('tr_amount=19.99', 'tr_amount=1.00')

    const response = await call(payload, tampered)

    assert.equal(response.status, 400)
    assert.equal(payload.docs('orders').length, 0)
  })

  it('missing configuration is a refusal, not a silent acceptance', async () => {
    const payload = new PayloadStub()
    seed(payload)

    const missingConfig = notificationsEndpoint({ merchantId: MERCHANT_ID })
    const response = await missingConfig.handler(makeReq(payload, { body: body({}) }))

    assert.equal(response.status, 500)
    assert.equal(payload.docs('orders').length, 0)
  })

  it('an underpayment does not close the order', async () => {
    const payload = new PayloadStub()
    seed(payload)

    const response = await call(payload, body({ tr_paid: '10.00' }))

    assert.equal(await response.text(), 'TRUE', 'the notification is authentic, so we confirm receipt')
    assert.equal(payload.docs('orders').length, 0, 'but the order is not created')
    assert.equal(payload.docs('transactions')[0].status, 'pending')
    assert.match(String(payload.logs.error[0]), /underpaid/)
  })

  it('an overpayment closes the order', async () => {
    const payload = new PayloadStub()
    seed(payload)

    await call(payload, body({ tr_paid: '25.00' }))

    assert.equal(payload.docs('orders').length, 1)
  })

  it('a withdrawal of funds moves the transaction to refunded', async () => {
    const payload = new PayloadStub()
    seed(payload, { order: 'orders-1', status: 'succeeded' })
    payload.seed('orders', { id: 'orders-1' })

    await call(payload, body({ tr_status: 'CHARGEBACK' }))

    assert.equal(payload.docs('transactions')[0].status, 'refunded')
  })

  it('a status other than paid does not create an order', async () => {
    const payload = new PayloadStub()
    seed(payload)

    const response = await call(payload, body({ tr_status: 'FALSE' }))

    assert.equal(await response.text(), 'TRUE')
    assert.equal(payload.docs('orders').length, 0)
    assert.equal(payload.docs('transactions')[0].status, 'pending')
  })

  it('finds the transaction by tr_crc when the Tpay identifier has not been saved yet', async () => {
    const payload = new PayloadStub()
    seed(payload, { tpay: {} })

    await call(payload, body({}))

    assert.equal(payload.docs('orders').length, 1)
  })

  it('a notification without a match in the database is acknowledged and logged', async () => {
    const payload = new PayloadStub()

    const response = await call(payload, body({ tr_crc: 'transactions-unknown', tr_id: 'TR-FOREIGN' }))

    assert.equal(await response.text(), 'TRUE')
    assert.equal(payload.docs('orders').length, 0)
    assert.match(String(payload.logs.error[0]), /no transaction found/)
  })

  it('a repeated notification does not create a second order', async () => {
    const payload = new PayloadStub()
    seed(payload)

    await call(payload, body({}))
    await call(payload, body({}))

    assert.equal(payload.docs('orders').length, 1)
  })

  it('with JWS enabled, a missing signature header is a refusal', async () => {
    const payload = new PayloadStub()
    seed(payload)

    const response = await call(payload, body({}), { verifyJws: true })

    assert.equal(response.status, 400)
    assert.equal(payload.docs('orders').length, 0)
    assert.match(String(payload.logs.error[0]), /X-JWS-Signature header is missing/)
  })

  it('with JWS enabled, a bad signature is a refusal despite a correct md5 checksum', async () => {
    const payload = new PayloadStub()
    seed(payload)

    const response = await call(payload, body({}), {
      headers: { 'x-jws-signature': 'not-a-signature' },
      verifyJws: true,
    })

    assert.equal(response.status, 400)
    assert.equal(payload.docs('orders').length, 0)
  })
})

describe('default values and resilience of the notification endpoint', () => {
  it('without an explicit decision the JWS signature is required - a notification without the header is rejected', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const endpoint = notificationsEndpoint({ merchantId: MERCHANT_ID, securityCode: SECURITY_CODE })

    const response = await endpoint.handler(makeReq(payload, { body: body({}) }))

    assert.equal(response.status, 400)
    assert.equal(await response.text(), 'FALSE')
    assert.equal(payload.docs('orders').length, 0)
    assert.match(String(payload.logs.error[0]), /X-JWS-Signature/)
  })

  it('verifyJws: false explicitly disables the requirement (known-good)', async () => {
    const payload = new PayloadStub()
    seed(payload)

    const response = await call(payload, body({}), { verifyJws: false })

    assert.equal(response.status, 200)
    assert.equal(payload.docs('orders').length, 1)
  })

  it('a transaction with no readable amount is a refusal, not a pass for any payment at all', async () => {
    const payload = new PayloadStub()
    seed(payload, { amount: undefined })

    const response = await call(payload, body({ tr_paid: '0.01' }))

    assert.equal(await response.text(), 'TRUE', 'the notification is authentic, so we confirm receipt')
    assert.equal(payload.docs('orders').length, 0, 'but there is nothing to compare the payment against')
    assert.equal(payload.docs('transactions')[0].status, 'pending')
    assert.match(String(payload.logs.error[0]), /amount/i)
  })

  it('known-good: a readable amount and a full payment still close the order', async () => {
    const payload = new PayloadStub()
    seed(payload)

    await call(payload, body({ tr_paid: '19.99' }))

    assert.equal(payload.docs('orders').length, 1)
  })

  it('an unreadable tr_amount answers FALSE/400 instead of throwing', async () => {
    // The values hit both exceptions in amount.ts: TypeError for anything
    // outside the decimal pattern, RangeError for too many decimal places.
    for (const trAmount of ['', 'abc', '19,99', '19.999']) {
      const payload = new PayloadStub()
      seed(payload)

      // The md5 cannot possibly match; the point is that an answer is produced at all.
      const raw = new URLSearchParams({
        id: MERCHANT_ID,
        md5sum: '0'.repeat(32),
        tr_amount: trAmount,
        tr_crc: 'transactions-1',
        tr_id: 'TR-1',
        tr_paid: '19.99',
        tr_status: 'TRUE',
      }).toString()

      const response = await call(payload, raw)

      assert.equal(response.status, 400, `tr_amount=${JSON.stringify(trAmount)}`)
      assert.equal(await response.text(), 'FALSE')
      assert.equal(payload.docs('orders').length, 0)
      assert.equal(payload.docs('transactions')[0].status, 'pending')
    }
  })

  it('N-1: an authenticated notification with a malformed tr_paid ends in TRUE without an order', async () => {
    const payload = new PayloadStub()
    seed(payload)

    const response = await call(payload, body({ tr_paid: 'twenty' }))

    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'TRUE', 'we do not force Tpay into endless retries')
    assert.equal(payload.docs('orders').length, 0)
    assert.equal(payload.docs('transactions')[0].status, 'pending')
    assert.match(String(payload.logs.error[0]), /unreadable tr_paid/)
  })

  it('a transaction in a currency with another minor unit does not get an order', async () => {
    const payload = new PayloadStub()
    seed(payload, { currency: 'JPY' })

    // tr_paid would compare equal to the stored 1999 minor units only because
    // this path scaled it by the two decimal places it assumed for everything.
    const response = await call(payload, body({ tr_paid: '19.99' }))

    assert.equal(await response.text(), 'TRUE')
    assert.equal(payload.docs('orders').length, 0)
    assert.equal(payload.docs('transactions')[0].status, 'pending')
    assert.match(String(payload.logs.error[0]), /two decimal currencies only/)
  })
})
