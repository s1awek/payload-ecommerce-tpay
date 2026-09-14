/**
 * Shape of the notification and the reach of the md5 checksum, measured on a
 * notification that Tpay really issued on the sandbox.
 *
 * The other tests check our code against notifications we built ourselves,
 * i.e. against our own idea of what Tpay sends. Here what is pinned is
 * what actually arrived. The stub `test/fixtures/sandbox-notification.txt` has the
 * same field set and the same order; sensitive values are swapped out, the checksum
 * recomputed with a stub code (the real capture is md5(known prefix + security code),
 * i.e. material for offline code cracking - it does not go into the repository).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { isChecksumValid, parseNotificationBody } from '../dist/verify.js'

const RAW = readFileSync(new URL('./fixtures/sandbox-notification.txt', import.meta.url), 'utf8')
const ARGS = { merchantId: '12345', securityCode: 'dummy-security-code' }

test('the notification carries fields that our type did not list', () => {
  const n = parseNotificationBody(RAW)

  // Measured on a live notification: `tr_currency` also arrives, which
  // `TpayNotification` does not list by name (it goes through the string index).
  assert.equal(n.tr_currency, 'PLN')
  assert.deepEqual(Object.keys(n).sort(), [
    'id', 'md5sum', 'test_mode', 'tr_amount', 'tr_crc', 'tr_currency',
    'tr_date', 'tr_desc', 'tr_email', 'tr_error', 'tr_id', 'tr_paid', 'tr_status',
  ])
})

test('the id field in the body is the merchant identifier, but the checksum is computed from configuration', () => {
  const n = parseNotificationBody(RAW)

  assert.equal(n.id, ARGS.merchantId)
  // If the checksum took merchantId from the body, an attacker could supply
  // their own and decide themselves what counts as valid. Swapping `id` must change nothing.
  assert.equal(isChecksumValid({ ...n, id: '99999' }, ARGS), true)
})

test('test_mode does NOT distinguish the sandbox from production', () => {
  const n = parseNotificationBody(RAW)

  // Measured: the notification from the SANDBOX arrived with test_mode=0.
  // Code that treated this field as an environment marker would always be wrong.
  assert.equal(n.test_mode, '0')
})

test('the md5 checksum protects only tr_id, tr_amount and tr_crc', () => {
  const n = parseNotificationBody(RAW)
  const protectedFields = { tr_amount: '1.00', tr_crc: 'someone-elses-order', tr_id: 'TR-000-OTHER' }
  const unprotectedFields = {
    test_mode: '1',
    tr_currency: 'EUR',
    tr_email: 'attacker@example.invalid',
    tr_paid: '0.01',
    tr_status: 'FALSE',
  }

  assert.equal(isChecksumValid(n, ARGS), true, 'untouched material must pass')

  for (const [field, value] of Object.entries(protectedFields)) {
    assert.equal(isChecksumValid({ ...n, [field]: value }, ARGS), false, `${field} is supposed to be protected by the checksum`)
  }

  // This is NOT a description of a flaw in our code, only of the reach of Tpay's
  // mechanism: the checksum is md5(merchantId + tr_id + amount + tr_crc + code),
  // so the payment status, the amount actually paid, the currency and the buyer's
  // address stay outside it. Decisions about money rest on `tr_status` and `tr_paid`,
  // i.e. on fields outside the checksum - that is why the second layer (the JWS
  // signature over the WHOLE body) is not decoration.
  for (const [field, value] of Object.entries(unprotectedFields)) {
    assert.equal(isChecksumValid({ ...n, [field]: value }, ARGS), true, `${field} is outside the checksum`)
  }
})
