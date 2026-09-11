/**
 * Instrument check BEFORE waiting for a Tpay notification.
 *
 * Without this, a missing notification is indistinguishable from a broken
 * pipeline: it is not known whether Tpay is silent, the tunnel does not reach
 * through, or the handler is throwing. Both sides are measured, because a
 * check that never passes is just as useless as one that never rejects.
 */
import { notificationChecksum } from '../dist/verify.js'

// Does the host check the JWS signature? By default yes (that is the adapter's
// default). Without Tpay's private key a known-good signature cannot be built
// here, so with JWS on both attempts MUST come back as FALSE/400; the positive
// half of the check is then a real, signed notification from the sandbox
// (`NOTIFICATION ... X-JWS-Signature: present` and `-> 200 TRUE` in the host
// log after a BLIK payment). The md5 layer alone is measured on a host started
// with TPAY_VERIFY_JWS=false.
const jwsOn = process.env.TPAY_VERIFY_JWS !== 'false'

const base = process.argv[2]
if (!base) {
  console.error('pass the public address as an argument')
  process.exit(1)
}
const target = `${base.replace(/\/+$/, '')}/api/payments/tpay/notifications`
const merchantId = process.env.TPAY_MERCHANT_ID
const securityCode = process.env.TPAY_SECURITY_CODE

const send = async (label, body) => {
  const resp = await fetch(target, {
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  })
  const text = await resp.text()
  console.log(`${label}: HTTP ${resp.status}, content "${text}"`)
  return { status: resp.status, text }
}

// 1. Known-bad: the md5 checksum cannot match, because it is written by hand.
const badBody =
  'id=' + merchantId +
  '&tr_id=TR-CHECK-BAD&tr_crc=instrument-check&tr_amount=1.00&tr_paid=1.00' +
  '&tr_status=TRUE&tr_error=none&tr_currency=PLN&md5sum=00000000000000000000000000000000'
const bad = await send('KNOWN-BAD (forged md5 checksum)', badBody)

// 2. Known-good as far as the md5 checksum goes, but for a transaction that is
//    not in the database. It should pass the cryptographic check and only fail
//    on the missing transaction - that is, the md5 layer lets it through and no
//    order is created out of thin air.
const basis = {
  id: merchantId,
  tr_amount: '1.00',
  tr_crc: 'instrument-check-nonexistent',
  tr_id: 'TR-CHECK-GOOD',
}
const checksum = notificationChecksum(basis, { merchantId, securityCode })
const goodBody =
  'id=' + merchantId +
  '&tr_id=TR-CHECK-GOOD&tr_crc=instrument-check-nonexistent&tr_amount=1.00&tr_paid=1.00' +
  '&tr_status=TRUE&tr_error=none&tr_currency=PLN&md5sum=' + checksum
const good = await send('KNOWN-GOOD md5 (transaction does not exist)', goodBody)

console.log('\n--- pipeline check verdict ---')
const faults = []
const reachedHandler = (o) => o.text === 'FALSE' || o.text === 'TRUE'
if (!reachedHandler(bad) || !reachedHandler(good)) {
  faults.push('the response does not come from the notification handler (tunnel, route or server) - content: ' + JSON.stringify([bad.text.slice(0, 80), good.text.slice(0, 80)]))
}
if (bad.text !== 'FALSE') faults.push('the forged md5 checksum was NOT rejected - the check is blind')
if (jwsOn) {
  if (good.text !== 'FALSE' || good.status !== 400) {
    faults.push('a body without a JWS signature was accepted despite JWS being on - the signature layer is not working')
  }
} else if (good.text === 'FALSE' && good.status === 400) {
  faults.push('a correct md5 checksum was rejected as bad - the check is clamped shut')
}
if (faults.length) {
  faults.forEach((w) => console.log('FAULT:', w))
  process.exit(1)
}
console.log('Pipeline is passable: the request reaches the notification handler through the tunnel.')
if (jwsOn) {
  console.log('JWS is on: both unsigned bodies were rejected. Whether the md5 layer passes the correct code,')
  console.log('this run does NOT measure - the positive proof is a signed notification from the sandbox')
  console.log('(in the host log: "NOTIFICATION tr_id=... X-JWS-Signature: present" then "-> 200 TRUE").')
  console.log('The md5 layer alone: start the host with TPAY_VERIFY_JWS=false and repeat the check with that variable.')
} else {
  console.log('The md5 checksum rejects the forgery and passes material computed with the real code.')
}
console.log('From this point, a missing notification means Tpay is quiet, not that the pipeline is broken.')
