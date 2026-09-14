import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { notificationSummary, redactSecrets } from '../dev/log-redact.mjs'

// --- audit round 2, 14.09.2026: the development host's log (W2-5, W2-16) ---
//
// The dev host logged whole responses and whole notification bodies. Those
// carry an order's `accessToken`, a guest cart's `secret` and the notification
// `md5sum`, and log files travel further than anyone expects.

describe('W2-16: secrets do not reach the development log', () => {
  it('W2-16 known-bad: a JSON answer loses its accessToken and secret', () => {
    const answer = JSON.stringify({
      accessToken: 'at_live_9f2c',
      message: 'Order confirmed successfully',
      orderID: 'orders-1',
      secret: 'cart-secret-abc',
    })

    const redacted = redactSecrets(answer)

    assert.ok(!redacted.includes('at_live_9f2c'), 'accessToken survived the redaction')
    assert.ok(!redacted.includes('cart-secret-abc'), 'cart secret survived the redaction')
    assert.match(redacted, /"accessToken":"\[redacted\]"/)
    assert.match(redacted, /"secret":"\[redacted\]"/)
    assert.ok(redacted.includes('Order confirmed successfully'), 'the useful part stays readable')
    assert.ok(redacted.includes('orders-1'))
  })

  it('W2-16 known-bad: a token response and a form body are redacted too', () => {
    assert.ok(!redactSecrets('{"access_token":"tok_123","expires_in":7200}').includes('tok_123'))
    assert.ok(!redactSecrets('tr_id=TR-1&md5sum=0badc0ffee&tr_status=TRUE').includes('0badc0ffee'))
    assert.ok(!redactSecrets('/api/cart?secret=abc123&cartID=7').includes('abc123'))

    // A cut after the redaction cannot leave half a secret behind.
    const long = `{"secret":"${'x'.repeat(400)}","id":1}`
    assert.ok(!redactSecrets(long).slice(0, 300).includes('xxxx'))
  })

  it('W2-16 known-good: ordinary text is not mangled', () => {
    const plain = '{"message":"Payment is not completed yet (Tpay status: pending).","status":409}'

    assert.equal(redactSecrets(plain), plain)
    assert.equal(redactSecrets(''), '')
    assert.equal(redactSecrets(undefined), '', 'a logger must not be the thing that throws')
  })
})

describe('W2-5: a notification leaves a summary, never its body', () => {
  const body =
    'id=123456&tr_id=TR-1&tr_amount=19.99&tr_paid=19.99&tr_status=TRUE&tr_crc=transactions-1&md5sum=6b1a2f'

  it('W2-5: the checksum does not appear, the field names and the verdict do', () => {
    const summary = notificationSummary(body, { signed: true })

    assert.ok(!summary.includes('6b1a2f'), 'md5sum must never reach the log')
    assert.match(summary, /tr_id=TR-1/)
    assert.match(summary, /tr_status=TRUE/)
    assert.match(summary, /fields=.*md5sum/, 'the name of the field is fine, its value is not')
    assert.match(summary, /X-JWS-Signature=present/)
  })

  it('W2-5: a missing signature is visible, and an empty body does not throw', () => {
    assert.match(notificationSummary(body, { signed: false }), /X-JWS-Signature=MISSING/)
    assert.match(notificationSummary(''), /tr_id=\(none\) tr_status=\(none\)/)
    assert.match(notificationSummary(undefined), /fields=\(none\)/)
  })
})
