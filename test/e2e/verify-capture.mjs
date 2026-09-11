/**
 * Verification of a CAPTURED Tpay notification - offline, from a file on disk.
 *
 * The point of this run: the unit tests check our verification against notifications
 * we built ourselves - i.e. against our own idea of what Tpay sends.
 * Here their notification, their md5 checksum and their signature come in.
 *
 *   node --env-file=.env test/e2e/verify-capture.mjs <file.body.txt>
 *
 * Each check is run twice: on untouched material (must pass) and on material
 * with one value swapped (must fail). A check that never reports an error is
 * indistinguishable from a broken one.
 */
import { readFileSync } from 'node:fs'

import {
  allowedX5uHostsFor,
  isChecksumValid,
  jwsRootCertificateUrl,
  notificationChecksum,
  parseNotificationBody,
  verifyJwsSignature,
} from '../../dist/verify.js'

const bodyPath = process.argv[2]
if (!bodyPath) {
  console.error('Provide the path to a *.body.txt file')
  process.exit(1)
}
const headersPath = bodyPath.replace(/\.body\.txt$/, '.headers.json')

const rawBody = readFileSync(bodyPath, 'utf8')
const headers = JSON.parse(readFileSync(headersPath, 'utf8'))
const sandbox = process.env.TPAY_SANDBOX !== 'false'

const merchantId = process.env.TPAY_MERCHANT_ID
const securityCode = process.env.TPAY_SECURITY_CODE
if (!merchantId || !securityCode) {
  console.error('Missing TPAY_MERCHANT_ID or TPAY_SECURITY_CODE')
  process.exit(1)
}

const n = parseNotificationBody(rawBody)

console.log('=== captured notification ===')
console.log('file:               ', bodyPath)
console.log('body length:        ', rawBody.length, 'B')
console.log('fields:             ', Object.keys(n).sort().join(', '))
console.log('tr_id:              ', n.tr_id)
console.log('tr_amount / tr_paid:', n.tr_amount, '/', n.tr_paid)
console.log('tr_status:          ', n.tr_status)
console.log('tr_crc (our id):    ', n.tr_crc)
console.log('test_mode:          ', n.test_mode)
console.log('md5sum from Tpay:   ', n.md5sum)

// --- layer 1: md5 checksum ---------------------------------------------------
const computed = notificationChecksum(n, { merchantId, securityCode })
const md5Ok = isChecksumValid(n, { merchantId, securityCode })
console.log('\n=== layer 1: md5 checksum ===')
console.log('computed by us:    ', computed)
console.log('verdict:           ', md5Ok ? 'PASSED' : 'FAILED')

// known-bad check: the same checksum after swapping the amount must fail
const tampered = { ...n, tr_amount: String(Number(n.tr_amount ?? '0') + 1) }
const md5Tampered = isChecksumValid(tampered, { merchantId, securityCode })
console.log('control (amount +1):', md5Tampered ? 'PASSED - DEFECT, the checksum does not protect the amount' : 'failed, as expected')

// --- layer 2: JWS signature ---------------------------------------------------
const jwsHeader = headers['x-jws-signature'] ?? headers['X-JWS-Signature']
console.log('\n=== layer 2: JWS signature ===')
let jwsOk = null
let jwsTamperedFailed = null
if (!jwsHeader) {
  console.log('X-JWS-Signature header: MISSING from the capture (Tpay did not send it)')
} else {
  const rootUrl = jwsRootCertificateUrl(sandbox)
  const root = await fetch(rootUrl).then((r) => (r.ok ? r.text() : null)).catch(() => null)
  console.log('root certificate:  ', root ? `fetched from ${rootUrl}` : `NOT FETCHED from ${rootUrl} - chain unverified`)
  console.log('allowed x5u hosts: ', allowedX5uHostsFor(sandbox).join(', '))

  const result = await verifyJwsSignature({
    allowedX5uHosts: allowedX5uHostsFor(sandbox),
    header: jwsHeader,
    rawBody,
    rootCertificate: root ?? undefined,
  })
  jwsOk = result.ok
  console.log('verdict:           ', result.ok ? 'PASSED' : `FAILED: ${result.reason}`)

  // known-bad check: one extra character in the body must break the signature
  const tamperedResult = await verifyJwsSignature({
    allowedX5uHosts: allowedX5uHostsFor(sandbox),
    header: jwsHeader,
    rawBody: rawBody + '&x=1',
    rootCertificate: root ?? undefined,
  })
  jwsTamperedFailed = !tamperedResult.ok
  console.log(
    'control (body +"&x=1"):',
    tamperedResult.ok ? 'PASSED - DEFECT, the signature does not protect the body' : `failed, as expected (${tamperedResult.reason})`,
  )
}

// --- result --------------------------------------------------------------------
const defects = []
if (!md5Ok) defects.push('the md5 checksum does not match the one Tpay sent')
if (md5Tampered) defects.push('the md5 checksum passes after swapping the amount - the check does not work')
if (jwsHeader && jwsOk === false) defects.push("Tpay's JWS signature does not pass our verification")
if (jwsHeader && jwsTamperedFailed === false) defects.push('the JWS signature passes after changing the body - the check does not work')

console.log('\n=== result ===')
if (defects.length) {
  defects.forEach((d) => console.log('DEFECT:', d))
  process.exit(1)
}
console.log('md5 checksum: passed on untouched material, failed on the swapped amount.')
if (!jwsHeader) {
  // A missing header is not a success for layer 2 - it means it was not measured at all.
  console.log('JWS signature: NOT MEASURED - the capture had no X-JWS-Signature header.')
  console.log('\nPARTIAL RESULT: one layer out of two verified.')
  process.exit(2)
}
console.log('JWS signature: passed on the untouched body, failed after appending one field.')
console.log('\nFULL RESULT: both layers verified on material issued by Tpay.')
