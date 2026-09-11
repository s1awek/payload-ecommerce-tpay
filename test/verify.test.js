import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import {
  isChecksumValid,
  notificationChecksum,
  parseNotificationBody,
  allowedX5uHostsFor,
  jwsRootCertificateUrl,
} from '../dist/verify.js'

const MERCHANT_ID = '123456'
const SECURITY_CODE = 'secret-test-code'

const notification = {
  id: MERCHANT_ID,
  tr_amount: '19.99',
  tr_crc: 'transactions-1',
  tr_id: 'TR-ABC-123',
  tr_paid: '19.99',
  tr_status: 'TRUE',
}

describe('notification checksum', () => {
  it('computes md5 per the formula from Tpay documentation', () => {
    // md5(merchantId + tr_id + amount_2dp + tr_crc + code)
    const expected = createHash('md5')
      .update(`${MERCHANT_ID}TR-ABC-12319.99transactions-1${SECURITY_CODE}`)
      .digest('hex')

    assert.equal(
      notificationChecksum(notification, { merchantId: MERCHANT_ID, securityCode: SECURITY_CODE }),
      expected,
    )
  })

  it('the amount is formatted to two decimal places before computing the checksum', () => {
    const short = notificationChecksum(
      { ...notification, tr_amount: '19.9' },
      { merchantId: MERCHANT_ID, securityCode: SECURITY_CODE },
    )
    const padded = notificationChecksum(
      { ...notification, tr_amount: '19.90' },
      { merchantId: MERCHANT_ID, securityCode: SECURITY_CODE },
    )

    assert.equal(short, padded)
  })

  it('known-good passes', () => {
    const md5sum = notificationChecksum(notification, {
      merchantId: MERCHANT_ID,
      securityCode: SECURITY_CODE,
    })

    assert.equal(
      isChecksumValid(
        { ...notification, md5sum },
        { merchantId: MERCHANT_ID, securityCode: SECURITY_CODE },
      ),
      true,
    )
  })

  it('known-bad is rejected: swapped amount, swapped number, wrong code, missing checksum', () => {
    const md5sum = notificationChecksum(notification, {
      merchantId: MERCHANT_ID,
      securityCode: SECURITY_CODE,
    })

    const args = { merchantId: MERCHANT_ID, securityCode: SECURITY_CODE }

    assert.equal(isChecksumValid({ ...notification, md5sum, tr_amount: '1.00' }, args), false)
    assert.equal(isChecksumValid({ ...notification, md5sum, tr_id: 'TR-OTHER' }, args), false)
    assert.equal(isChecksumValid({ ...notification, md5sum, tr_crc: 'transactions-9' }, args), false)
    assert.equal(
      isChecksumValid({ ...notification, md5sum }, { ...args, securityCode: 'wrong-code' }),
      false,
    )
    assert.equal(isChecksumValid({ ...notification }, args), false)
    assert.equal(isChecksumValid({ ...notification, md5sum: 'short' }, args), false)
  })

  it('a checksum written in uppercase also passes', () => {
    const md5sum = notificationChecksum(notification, {
      merchantId: MERCHANT_ID,
      securityCode: SECURITY_CODE,
    }).toUpperCase()

    assert.equal(
      isChecksumValid(
        { ...notification, md5sum },
        { merchantId: MERCHANT_ID, securityCode: SECURITY_CODE },
      ),
      true,
    )
  })
})

describe('parsing the notification body', () => {
  it('reads the form and decodes values', () => {
    const parsed = parseNotificationBody(
      'id=123456&tr_id=TR-ABC&tr_amount=19.99&tr_desc=Caf%C3%A9+order+7&tr_status=TRUE',
    )

    assert.equal(parsed.tr_id, 'TR-ABC')
    assert.equal(parsed.tr_desc, 'Café order 7')
    assert.equal(parsed.tr_status, 'TRUE')
  })
})

describe('sources of the signature certificate', () => {
  it('the host lists are disjoint between sandbox and production', () => {
    assert.deepEqual(allowedX5uHostsFor(false), ['secure.tpay.com'])
    assert.deepEqual(allowedX5uHostsFor(true), ['secure.sandbox.tpay.com'])
  })

  it('the root certificate address depends on the environment', () => {
    assert.equal(jwsRootCertificateUrl(false), 'https://secure.tpay.com/x509/tpay-jws-root.pem')
    assert.equal(
      jwsRootCertificateUrl(true),
      'https://secure.sandbox.tpay.com/x509/tpay-jws-root.pem',
    )
  })
})
