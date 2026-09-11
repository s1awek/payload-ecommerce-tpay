import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { TpayApiError, TpayClient, TPAY_PRODUCTION_URL, TPAY_SANDBOX_URL } from '../dist/client.js'

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, status })

const recorder = (responses) => {
  const calls = []
  const queue = [...responses]

  const fetchImpl = async (url, init) => {
    calls.push({ body: init?.body, headers: init?.headers, method: init?.method, url })
    const next = queue.shift()

    if (!next) {
      throw new Error(`No prepared response for ${String(url)}`)
    }

    return typeof next === 'function' ? next() : next
  }

  return { calls, fetchImpl }
}

const AUTH = { access_token: 'token-1', expires_in: 7200 }

describe('Tpay client', () => {
  it('base address depends on the mode, and an explicit baseUrl wins', async () => {
    assert.equal(TPAY_PRODUCTION_URL, 'https://api.tpay.com')
    assert.equal(TPAY_SANDBOX_URL, 'https://openapi.sandbox.tpay.com')

    const where = async (options) => {
      const { calls, fetchImpl } = recorder([json(AUTH), json({ transactionId: 'TR' })])
      const client = new TpayClient({ clientId: 'id', clientSecret: 'secret', fetchImpl, ...options })
      await client.getTransaction('TR')

      return calls.map((call) => call.url)
    }

    // A mistake in this direction means real money on the sandbox account,
    // or a test transaction sent to production, so we measure the address
    // the request actually goes to, not the field on the object.
    assert.deepEqual(await where({}), [
      'https://api.tpay.com/oauth/auth',
      'https://api.tpay.com/transactions/TR',
    ])
    assert.deepEqual(await where({ sandbox: true }), [
      'https://openapi.sandbox.tpay.com/oauth/auth',
      'https://openapi.sandbox.tpay.com/transactions/TR',
    ])
    assert.deepEqual(await where({ baseUrl: 'https://proxy.example/tpay/', sandbox: true }), [
      'https://proxy.example/tpay/oauth/auth',
      'https://proxy.example/tpay/transactions/TR',
    ])
  })

  it('without credentials the client cannot be created', () => {
    assert.throws(() => new TpayClient({ clientId: '', clientSecret: 'b' }), /required/)
  })

  it('authenticates with a form and holds the token between requests', async () => {
    const { calls, fetchImpl } = recorder([
      json(AUTH),
      json({ transactionId: 'TR-1' }),
      json({ transactionId: 'TR-1', status: 'correct' }),
    ])

    const client = new TpayClient({ clientId: 'id', clientSecret: 'secret', fetchImpl, sandbox: true })

    await client.createTransaction({ amount: 19.99, description: 'x', payer: { email: 'a@b.pl', name: 'A' } })
    await client.getTransaction('TR-1')

    assert.equal(calls.length, 3, 'the second request must not fetch the token again')
    assert.equal(calls[0].url, 'https://openapi.sandbox.tpay.com/oauth/auth')
    assert.equal(calls[0].headers['Content-Type'], 'application/x-www-form-urlencoded')
    assert.equal(calls[0].body, 'client_id=id&client_secret=secret')
    assert.equal(calls[1].url, 'https://openapi.sandbox.tpay.com/transactions')
    assert.equal(calls[1].headers.Authorization, 'Bearer token-1')
    assert.equal(calls[2].method, 'GET')
  })

  it('a short-lived token is refreshed, not used past its expiry', async () => {
    const { calls, fetchImpl } = recorder([
      json({ access_token: 'short', expires_in: 1 }),
      json({ transactionId: 'TR-1' }),
      json({ access_token: 'new', expires_in: 7200 }),
      json({ transactionId: 'TR-2' }),
    ])

    const client = new TpayClient({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl,
      refreshMarginSeconds: 60,
    })

    await client.createTransaction({ amount: 1, description: 'x', payer: { email: 'a@b.pl', name: 'A' } })
    await client.createTransaction({ amount: 1, description: 'x', payer: { email: 'a@b.pl', name: 'A' } })

    assert.equal(calls.length, 4)
    assert.equal(calls[3].headers.Authorization, 'Bearer new')
  })

  it('after a 401 refusal it retries once with a fresh token', async () => {
    const { calls, fetchImpl } = recorder([
      json(AUTH),
      json({ message: 'expired' }, 401),
      json({ access_token: 'token-2', expires_in: 7200 }),
      json({ transactionId: 'TR-9' }),
    ])

    const client = new TpayClient({ clientId: 'id', clientSecret: 'secret', fetchImpl })
    const result = await client.createTransaction({
      amount: 1,
      description: 'x',
      payer: { email: 'a@b.pl', name: 'A' },
    })

    assert.equal(result.transactionId, 'TR-9')
    assert.equal(calls.length, 4)
    assert.equal(calls[3].headers.Authorization, 'Bearer token-2')
  })

  it('an API error carries the status code and response body, not just "something went wrong"', async () => {
    const { fetchImpl } = recorder([json(AUTH), json({ errors: [{ errorCode: 'bad_amount' }] }, 422)])

    const client = new TpayClient({ clientId: 'id', clientSecret: 'secret', fetchImpl })

    await assert.rejects(
      client.createTransaction({ amount: -1, description: 'x', payer: { email: 'a@b.pl', name: 'A' } }),
      (error) => {
        assert.ok(error instanceof TpayApiError)
        assert.equal(error.status, 422)
        assert.deepEqual(error.body, { errors: [{ errorCode: 'bad_amount' }] })

        return true
      },
    )
  })

  it('a failed authentication does not pretend to succeed', async () => {
    const { fetchImpl } = recorder([json({ error: 'invalid_client' }, 401)])
    const client = new TpayClient({ clientId: 'id', clientSecret: 'wrong', fetchImpl })

    await assert.rejects(client.getAccessToken(), /authentication failed/)
  })
})
