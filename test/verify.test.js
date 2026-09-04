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
const SECURITY_CODE = 'tajny-kod-testowy'

const notification = {
  id: MERCHANT_ID,
  tr_amount: '19.99',
  tr_crc: 'transactions-1',
  tr_id: 'TR-ABC-123',
  tr_paid: '19.99',
  tr_status: 'TRUE',
}

describe('suma kontrolna powiadomienia', () => {
  it('liczy md5 wg wzoru z dokumentacji Tpay', () => {
    // md5(merchantId + tr_id + kwota_2dp + tr_crc + kod)
    const expected = createHash('md5')
      .update(`${MERCHANT_ID}TR-ABC-12319.99transactions-1${SECURITY_CODE}`)
      .digest('hex')

    assert.equal(
      notificationChecksum(notification, { merchantId: MERCHANT_ID, securityCode: SECURITY_CODE }),
      expected,
    )
  })

  it('kwota jest formatowana do dwoch miejsc przed policzeniem sumy', () => {
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

  it('znany-dobry przechodzi', () => {
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

  it('znany-zly odpada: podmieniona kwota, podmieniony numer, zly kod, brak sumy', () => {
    const md5sum = notificationChecksum(notification, {
      merchantId: MERCHANT_ID,
      securityCode: SECURITY_CODE,
    })

    const args = { merchantId: MERCHANT_ID, securityCode: SECURITY_CODE }

    assert.equal(isChecksumValid({ ...notification, md5sum, tr_amount: '1.00' }, args), false)
    assert.equal(isChecksumValid({ ...notification, md5sum, tr_id: 'TR-INNE' }, args), false)
    assert.equal(isChecksumValid({ ...notification, md5sum, tr_crc: 'transactions-9' }, args), false)
    assert.equal(
      isChecksumValid({ ...notification, md5sum }, { ...args, securityCode: 'zly-kod' }),
      false,
    )
    assert.equal(isChecksumValid({ ...notification }, args), false)
    assert.equal(isChecksumValid({ ...notification, md5sum: 'krotkie' }, args), false)
  })

  it('suma zapisana wielkimi literami tez przechodzi', () => {
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

describe('parsowanie ciala powiadomienia', () => {
  it('czyta formularz i rozkodowuje wartosci', () => {
    const parsed = parseNotificationBody(
      'id=123456&tr_id=TR-ABC&tr_amount=19.99&tr_desc=Zam%C3%B3wienie+7&tr_status=TRUE',
    )

    assert.equal(parsed.tr_id, 'TR-ABC')
    assert.equal(parsed.tr_desc, 'Zamówienie 7')
    assert.equal(parsed.tr_status, 'TRUE')
  })
})

describe('zrodla certyfikatu podpisu', () => {
  it('listy hostow sa rozlaczne miedzy sandboksem a produkcja', () => {
    assert.deepEqual(allowedX5uHostsFor(false), ['secure.tpay.com'])
    assert.deepEqual(allowedX5uHostsFor(true), ['secure.sandbox.tpay.com'])
  })

  it('adres certyfikatu glownego zalezy od srodowiska', () => {
    assert.equal(jwsRootCertificateUrl(false), 'https://secure.tpay.com/x509/tpay-jws-root.pem')
    assert.equal(
      jwsRootCertificateUrl(true),
      'https://secure.sandbox.tpay.com/x509/tpay-jws-root.pem',
    )
  })
})
