import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { notificationsEndpoint } from '../dist/endpoints/notifications.js'
import { notificationChecksum } from '../dist/verify.js'
import { makeReq, PayloadStub } from './helpers/payload-stub.js'

const MERCHANT_ID = '123456'
const SECURITY_CODE = 'kod-testowy'

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

const body = (fields, { sign = true, securityCode = SECURITY_CODE } = {}) => {
  const base = {
    id: MERCHANT_ID,
    test_mode: '0',
    tr_amount: '19.99',
    tr_crc: 'transactions-1',
    tr_date: '2026-09-04 20:00:00',
    tr_desc: 'Order carts-1',
    tr_email: 'klient@example.pl',
    tr_error: 'none',
    tr_id: 'TR-1',
    tr_paid: '19.99',
    tr_status: 'TRUE',
    ...fields,
  }

  const md5sum = sign ? notificationChecksum(base, { merchantId: MERCHANT_ID, securityCode }) : 'zle'

  return new URLSearchParams({ ...base, md5sum }).toString()
}

const call = async (payload, raw, props = {}) => {
  const endpoint = notificationsEndpoint({
    merchantId: MERCHANT_ID,
    securityCode: SECURITY_CODE,
    ...props,
  })

  return await endpoint.handler(makeReq(payload, { body: raw, headers: props.headers }))
}

describe('punkt odbioru powiadomien', () => {
  it('jest wystawiony jako POST /notifications', () => {
    const endpoint = notificationsEndpoint({ merchantId: MERCHANT_ID, securityCode: SECURITY_CODE })

    assert.equal(endpoint.method, 'post')
    assert.equal(endpoint.path, '/notifications')
  })

  it('znany-dobry: tworzy zamowienie i odpowiada TRUE', async () => {
    const payload = new PayloadStub()
    seed(payload)

    const response = await call(payload, body({}))

    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'TRUE')
    assert.equal(payload.docs('orders').length, 1)
    assert.equal(payload.docs('transactions')[0].status, 'succeeded')
    assert.equal(payload.docs('transactions')[0].order, payload.docs('orders')[0].id)
  })

  it('znany-zly: bledna suma kontrolna nie tworzy zamowienia', async () => {
    const payload = new PayloadStub()
    seed(payload)

    const response = await call(payload, body({}, { sign: false }))

    assert.equal(response.status, 400)
    assert.equal(payload.docs('orders').length, 0)
    assert.equal(payload.docs('transactions')[0].status, 'pending')
    assert.equal(payload.logs.error.length, 1)
  })

  it('znany-zly: suma policzona cudzym kodem bezpieczenstwa odpada', async () => {
    const payload = new PayloadStub()
    seed(payload)

    const response = await call(payload, body({}, { securityCode: 'cudzy-kod' }))

    assert.equal(response.status, 400)
    assert.equal(payload.docs('orders').length, 0)
  })

  it('znany-zly: podniesiona kwota po podpisaniu nie przechodzi', async () => {
    const payload = new PayloadStub()
    seed(payload)

    const raw = body({})
    const podmieniony = raw.replace('tr_amount=19.99', 'tr_amount=1.00')

    const response = await call(payload, podmieniony)

    assert.equal(response.status, 400)
    assert.equal(payload.docs('orders').length, 0)
  })

  it('brak konfiguracji to odmowa, nie ciche przyjecie', async () => {
    const payload = new PayloadStub()
    seed(payload)

    const bez = notificationsEndpoint({ merchantId: MERCHANT_ID })
    const response = await bez.handler(makeReq(payload, { body: body({}) }))

    assert.equal(response.status, 500)
    assert.equal(payload.docs('orders').length, 0)
  })

  it('niedoplata nie domyka zamowienia', async () => {
    const payload = new PayloadStub()
    seed(payload)

    const response = await call(payload, body({ tr_paid: '10.00' }))

    assert.equal(await response.text(), 'TRUE', 'powiadomienie jest autentyczne, wiec potwierdzamy odbior')
    assert.equal(payload.docs('orders').length, 0, 'ale zamowienie nie powstaje')
    assert.equal(payload.docs('transactions')[0].status, 'pending')
    assert.match(String(payload.logs.error[0]), /underpaid/)
  })

  it('nadplata domyka zamowienie', async () => {
    const payload = new PayloadStub()
    seed(payload)

    await call(payload, body({ tr_paid: '25.00' }))

    assert.equal(payload.docs('orders').length, 1)
  })

  it('wycofanie srodkow przestawia transakcje na zwrocona', async () => {
    const payload = new PayloadStub()
    seed(payload, { order: 'orders-1', status: 'succeeded' })
    payload.seed('orders', { id: 'orders-1' })

    await call(payload, body({ tr_status: 'CHARGEBACK' }))

    assert.equal(payload.docs('transactions')[0].status, 'refunded')
  })

  it('status inny niz oplacony nie tworzy zamowienia', async () => {
    const payload = new PayloadStub()
    seed(payload)

    const response = await call(payload, body({ tr_status: 'FALSE' }))

    assert.equal(await response.text(), 'TRUE')
    assert.equal(payload.docs('orders').length, 0)
    assert.equal(payload.docs('transactions')[0].status, 'pending')
  })

  it('transakcje odnajduje po tr_crc, gdy identyfikator Tpay nie zdazyl sie zapisac', async () => {
    const payload = new PayloadStub()
    seed(payload, { tpay: {} })

    await call(payload, body({}))

    assert.equal(payload.docs('orders').length, 1)
  })

  it('powiadomienie bez odpowiednika w bazie jest potwierdzane i logowane', async () => {
    const payload = new PayloadStub()

    const response = await call(payload, body({ tr_crc: 'transactions-nieznane', tr_id: 'TR-OBCE' }))

    assert.equal(await response.text(), 'TRUE')
    assert.equal(payload.docs('orders').length, 0)
    assert.match(String(payload.logs.error[0]), /no transaction found/)
  })

  it('powtorzone powiadomienie nie tworzy drugiego zamowienia', async () => {
    const payload = new PayloadStub()
    seed(payload)

    await call(payload, body({}))
    await call(payload, body({}))

    assert.equal(payload.docs('orders').length, 1)
  })

  it('przy wlaczonym JWS brak naglowka podpisu jest odmowa', async () => {
    const payload = new PayloadStub()
    seed(payload)

    const response = await call(payload, body({}), { verifyJws: true })

    assert.equal(response.status, 400)
    assert.equal(payload.docs('orders').length, 0)
    assert.match(String(payload.logs.error[0]), /X-JWS-Signature header is missing/)
  })

  it('przy wlaczonym JWS zly podpis jest odmowa mimo poprawnej sumy md5', async () => {
    const payload = new PayloadStub()
    seed(payload)

    const response = await call(payload, body({}), {
      headers: { 'x-jws-signature': 'nie-jest-podpisem' },
      verifyJws: true,
    })

    assert.equal(response.status, 400)
    assert.equal(payload.docs('orders').length, 0)
  })
})
