import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { assertBlikToken, normalizeBlikToken } from '../dist/blik.js'
import { blikEndpoint, blikStatusEndpoint } from '../dist/endpoints/blik.js'
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

/** Tpay client stub that counts calls to both relevant methods. */
const makeClient = (status = 'pending', payments = undefined) => {
  const sent = []
  const polled = []

  return {
    client: {
      getTransaction: async (id) => {
        polled.push(id)

        return { amount: 19.99, currency: 'PLN', status, transactionId: id, ...(payments ? { payments } : {}) }
      },
      payByTransactionId: async (id, fields) => {
        sent.push({ fields, id })

        // Tpay responds `success` even for a code that is wrong -
        // measured on the sandbox 07.09.2026.
        return { result: 'success', status: 'pending' }
      },
    },
    polled,
    sent,
  }
}

const call = async (endpoint, payload, data, extra = {}) => {
  const response = await endpoint.handler(makeReq(payload, { data, ...extra }))

  return { body: await response.json(), status: response.status }
}

describe('BLIK code: shape and length', () => {
  it('strips everything except digits from the code', () => {
    assert.equal(normalizeBlikToken('123 456'), '123456')
    assert.equal(normalizeBlikToken('123-456'), '123456')
  })

  it('rejects a code of the wrong length with a length message', () => {
    assert.throws(() => assertBlikToken('12345'), /exactly 6 digits/)
    assert.throws(() => assertBlikToken('1234567'), /exactly 6 digits/)
    assert.throws(() => assertBlikToken(''), /BLIK code is required/)
  })
})

describe('submitting a BLIK code', () => {
  it('does not send a code of the wrong length to Tpay', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client, sent } = makeClient()

    const { body, status } = await call(blikEndpoint({ client }), payload, {
      blikToken: '12345',
      secret: SECRET,
      transactionID: 'transactions-1',
    })

    assert.equal(status, 400)
    assert.match(body.message, /exactly 6 digits/)
    assert.equal(sent.length, 0, 'a bad code must not use up an attempt with the intermediary')
  })

  it('sends the code with the BLIK channel and does not announce payment even though Tpay responds success', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client, sent } = makeClient()

    const { body, status } = await call(blikEndpoint({ client }), payload, {
      blikToken: '777 123',
      secret: SECRET,
      transactionID: 'transactions-1',
    })

    assert.equal(status, 200)
    assert.equal(body.status, 'pending')
    assert.match(body.message, /banking app/)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].id, 'TR-1')
    assert.equal(sent[0].fields.channelId, 64)
    assert.equal(sent[0].fields.method, 'pay_by_link')
    assert.deepEqual(sent[0].fields.blikPaymentData, { blikToken: '777123', type: 0 })
  })

  it('allows submitting another code for the same payment after a failed attempt', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client, sent } = makeClient()
    const endpoint = blikEndpoint({ client })

    await call(endpoint, payload, { blikToken: '111111', secret: SECRET, transactionID: 'transactions-1' })
    const second = await call(endpoint, payload, { blikToken: '222222', secret: SECRET, transactionID: 'transactions-1' })

    assert.equal(second.status, 200)
    assert.equal(sent.length, 2, 'the second attempt goes to the same transaction')
    assert.equal(sent[1].id, 'TR-1')
    assert.equal(payload.docs('transactions').length, 1, 'no second transaction is created')
  })

  it('does not send a code for a payment already closed', async () => {
    const payload = new PayloadStub()
    seed(payload, { order: 'orders-1', status: 'succeeded' })
    const { client, sent } = makeClient('correct')

    const { body } = await call(blikEndpoint({ client }), payload, {
      blikToken: '777123',
      secret: SECRET,
      transactionID: 'transactions-1',
    })

    assert.equal(body.status, 'paid')
    assert.equal(sent.length, 0)
  })
})

describe("access to someone else's payment", () => {
  it('rejects a request without a cart secret and without a logged-in owner', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client, sent } = makeClient()

    const { body, status } = await call(blikEndpoint({ client }), payload, {
      blikToken: '777123',
      transactionID: 'transactions-1',
    })

    assert.equal(status, 403)
    assert.match(body.message, /not allowed/)
    assert.equal(sent.length, 0)
  })

  it('rejects a wrong cart secret', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = makeClient()

    const { status } = await call(blikEndpoint({ client }), payload, {
      blikToken: '777123',
      secret: 'not-this-secret',
      transactionID: 'transactions-1',
    })

    assert.equal(status, 403)
  })

  it('lets through the logged-in owner of the transaction without a secret', async () => {
    const payload = new PayloadStub()
    seed(payload, { customer: 'users-1' })
    const { client, sent } = makeClient()

    const response = await blikEndpoint({ client }).handler(
      makeReq(payload, {
        data: { blikToken: '777123', transactionID: 'transactions-1' },
        user: { id: 'users-1' },
      }),
    )

    assert.equal(response.status, 200)
    assert.equal(sent.length, 1)
  })

  it('does not reveal which identifiers exist', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = makeClient()

    const nonexistent = await call(blikEndpoint({ client }), payload, {
      blikToken: '777123',
      secret: SECRET,
      transactionID: 'transactions-999',
    })
    const someoneElses = await call(blikEndpoint({ client }), payload, {
      blikToken: '777123',
      secret: 'wrong',
      transactionID: 'transactions-1',
    })

    assert.equal(nonexistent.status, someoneElses.status)
    assert.equal(nonexistent.body.message, someoneElses.body.message)
  })
})

describe('reading payment status', () => {
  it('reports pending until Tpay resolves', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = makeClient('pending')

    const { body } = await call(blikStatusEndpoint({ client }), payload, {
      secret: SECRET,
      transactionID: 'transactions-1',
    })

    assert.equal(body.status, 'pending')
    assert.equal(payload.docs('orders').length, 0)
  })

  it('closes the order when the payment is settled', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = makeClient('correct')

    const { body } = await call(blikStatusEndpoint({ client }), payload, {
      secret: SECRET,
      transactionID: 'transactions-1',
    })

    assert.equal(body.status, 'paid')
    assert.ok(body.orderID)
    assert.equal(payload.docs('orders').length, 1)
  })

  it('queried repeatedly creates exactly one order', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = makeClient('correct')
    const endpoint = blikStatusEndpoint({ client })

    const first = await call(endpoint, payload, { secret: SECRET, transactionID: 'transactions-1' })
    const second = await call(endpoint, payload, { secret: SECRET, transactionID: 'transactions-1' })
    const third = await call(endpoint, payload, { secret: SECRET, transactionID: 'transactions-1' })

    assert.equal(payload.docs('orders').length, 1, 'polling status must not multiply orders')
    assert.equal(first.body.status, 'paid')
    assert.equal(second.body.status, 'paid')
    assert.equal(third.body.status, 'paid')
    assert.equal(String(second.body.orderID), String(first.body.orderID))
    assert.equal(String(third.body.orderID), String(first.body.orderID))
  })

  it('two simultaneous reads create one order, even though neither sees the other one write', async () => {
    // A sibling test to the one above, and deliberately different. That one ends
    // at the gate right at this point: the second request already sees the saved
    // order and returns earlier. Here both requests start before either managed
    // to write anything, so the layer below is being tested - the one that
    // resolves the race between reading the status and a notification from the
    // intermediary.
    const payload = new PayloadStub()
    seed(payload)
    const { client } = makeClient('correct')
    const endpoint = blikStatusEndpoint({ client })

    const [a, b] = await Promise.all([
      call(endpoint, payload, { secret: SECRET, transactionID: 'transactions-1' }),
      call(endpoint, payload, { secret: SECRET, transactionID: 'transactions-1' }),
    ])

    assert.equal(payload.docs('orders').length, 1, 'a race must not spawn a second order')
    assert.equal(a.body.status, 'paid')
    assert.equal(b.body.status, 'paid')
    assert.equal(String(a.body.orderID), String(b.body.orderID))
  })

  it('distinguishes a rejected code from waiting for the bank, even though the transaction status is the same', async () => {
    const payload = new PayloadStub()
    seed(payload)
    // This is what a decline looks like at the intermediary: the transaction is
    // still `pending`, and the only trace is the error code on the last attempt.
    const { client } = makeClient('pending', { attempts: [{ date: '07.09.2026 17:55', paymentErrorCode: '63' }] })

    const { body } = await call(blikStatusEndpoint({ client }), payload, {
      secret: SECRET,
      transactionID: 'transactions-1',
    })

    assert.equal(body.status, 'rejected')
    assert.equal(body.tpayErrorCode, '63')
    assert.match(body.message, /new one/)
    assert.equal(
      payload.collection('transactions').get('transactions-1').status,
      'pending',
      'a rejected code must not close the payment - the buyer submits another one',
    )
  })

  it('an attempt without an error code is still a plain pending', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = makeClient('pending', { attempts: [{ date: '07.09.2026 17:55', paymentErrorCode: null }] })

    const { body } = await call(blikStatusEndpoint({ client }), payload, {
      secret: SECRET,
      transactionID: 'transactions-1',
    })

    assert.equal(body.status, 'pending')
  })

  it('announces failure only once the decline is settled', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = makeClient('rejected')

    const { body } = await call(blikStatusEndpoint({ client }), payload, {
      secret: SECRET,
      transactionID: 'transactions-1',
    })

    assert.equal(body.status, 'failed')
    assert.equal(payload.collection('transactions').get('transactions-1').status, 'failed')
  })

  it('reads the body even when the layer above did not unpack it', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = makeClient('pending')

    const response = await blikStatusEndpoint({ client }).handler(
      makeReq(payload, { json: { secret: SECRET, transactionID: 'transactions-1' } }),
    )

    assert.equal(response.status, 200)
    assert.equal((await response.json()).status, 'pending')
  })
})

describe('identity of the payment proof and error content in the BLIK endpoints', () => {
  it('a paid status with a different amount does not close the order and responds 409 with a fixed message', async () => {
    const payload = new PayloadStub()
    seed(payload) // 1999 cents
    const client = {
      getTransaction: async () => ({ amount: 1.0, currency: 'PLN', status: 'correct' }),
      payByTransactionId: async () => ({ result: 'success' }),
    }

    const response = await blikStatusEndpoint({ client }).handler(
      makeReq(payload, { data: { secret: SECRET, transactionID: 'transactions-1' } }),
    )

    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { message: 'The payment does not match this transaction.' })
    assert.equal(payload.docs('orders').length, 0)
    assert.equal(payload.docs('transactions')[0].status, 'pending')
    assert.equal(payload.logs.error.length, 1, 'the details go to the log')
  })

  it('an error outside BlikError does not leak the exception content to the outside', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const client = {
      getTransaction: async () => {
        throw new Error('GET https://api.tpay.com/transactions/TR-1 failed with 502: upstream')
      },
      payByTransactionId: async () => ({ result: 'success' }),
    }

    const response = await blikStatusEndpoint({ client }).handler(
      makeReq(payload, { data: { secret: SECRET, transactionID: 'transactions-1' } }),
    )
    const body = await response.json()

    assert.equal(response.status, 500)
    assert.equal(body.message, 'Payment could not be processed.')
    assert.doesNotMatch(JSON.stringify(body), /api\.tpay\.com|502/)
    assert.match(String(payload.logs.error[0]?.err?.message), /502/, 'and the details are in the log')
  })
})
