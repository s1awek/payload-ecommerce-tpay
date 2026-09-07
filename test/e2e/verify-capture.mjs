/**
 * Weryfikacja PRZECHWYCONEGO powiadomienia Tpay - offline, na pliku z dysku.
 *
 * Sens tego przebiegu: testy jednostkowe sprawdzaja nasza weryfikacje na powiadomieniach,
 * ktore sami zbudowalismy - a wiec na naszym wyobrazeniu o tym, co przysyla Tpay.
 * Tutaj wchodzi ich powiadomienie, ich suma md5 i ich podpis.
 *
 *   node --env-file=.env test/e2e/verify-capture.mjs <plik.body.txt>
 *
 * Kazda kontrola jest uruchamiana dwa razy: na materiale nietkniętym (ma przejsc)
 * i na materiale z podmieniona jedna wartoscia (ma odpasc). Kontrola, ktora nigdy
 * nie zglasza bledu, jest nieodroznialna od zepsutej.
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
  console.error('Podaj sciezke do pliku *.body.txt')
  process.exit(1)
}
const headersPath = bodyPath.replace(/\.body\.txt$/, '.headers.json')

const rawBody = readFileSync(bodyPath, 'utf8')
const headers = JSON.parse(readFileSync(headersPath, 'utf8'))
const sandbox = process.env.TPAY_SANDBOX !== 'false'

const merchantId = process.env.TPAY_MERCHANT_ID
const securityCode = process.env.TPAY_SECURITY_CODE
if (!merchantId || !securityCode) {
  console.error('Brak TPAY_MERCHANT_ID albo TPAY_SECURITY_CODE')
  process.exit(1)
}

const n = parseNotificationBody(rawBody)

console.log('=== przechwycone powiadomienie ===')
console.log('plik:              ', bodyPath)
console.log('dlugosc ciala:     ', rawBody.length, 'B')
console.log('pola:              ', Object.keys(n).sort().join(', '))
console.log('tr_id:             ', n.tr_id)
console.log('tr_amount / tr_paid:', n.tr_amount, '/', n.tr_paid)
console.log('tr_status:         ', n.tr_status)
console.log('tr_crc (nasze id): ', n.tr_crc)
console.log('test_mode:         ', n.test_mode)
console.log('md5sum od Tpay:    ', n.md5sum)

// --- warstwa 1: suma md5 -----------------------------------------------------
const wyliczona = notificationChecksum(n, { merchantId, securityCode })
const md5Ok = isChecksumValid(n, { merchantId, securityCode })
console.log('\n=== warstwa 1: suma md5 ===')
console.log('wyliczona u nas:   ', wyliczona)
console.log('werdykt:           ', md5Ok ? 'PRZESZLA' : 'ODPADLA')

// kontrola znanym-zlym: ta sama suma po podmianie kwoty musi odpasc
const podrobione = { ...n, tr_amount: String(Number(n.tr_amount ?? '0') + 1) }
const md5Podrobione = isChecksumValid(podrobione, { merchantId, securityCode })
console.log('kontrola (kwota +1):', md5Podrobione ? 'PRZESZLA - WADA, suma nie chroni kwoty' : 'odpadla, jak ma byc')

// --- warstwa 2: podpis JWS ---------------------------------------------------
const jwsHeader = headers['x-jws-signature'] ?? headers['X-JWS-Signature']
console.log('\n=== warstwa 2: podpis JWS ===')
let jwsOk = null
let jwsPodrobioneOdpadl = null
if (!jwsHeader) {
  console.log('naglowek X-JWS-Signature: BRAK w przechwycie (Tpay go nie przyslal)')
} else {
  const rootUrl = jwsRootCertificateUrl(sandbox)
  const root = await fetch(rootUrl).then((r) => (r.ok ? r.text() : null)).catch(() => null)
  console.log('certyfikat glowny: ', root ? `pobrany z ${rootUrl}` : `NIE POBRANY z ${rootUrl} - lancuch niesprawdzany`)
  console.log('dozwolone hosty x5u:', allowedX5uHostsFor(sandbox).join(', '))

  const wynik = await verifyJwsSignature({
    allowedX5uHosts: allowedX5uHostsFor(sandbox),
    header: jwsHeader,
    rawBody,
    rootCertificate: root ?? undefined,
  })
  jwsOk = wynik.ok
  console.log('werdykt:           ', wynik.ok ? 'PRZESZEDL' : `ODPADL: ${wynik.reason}`)

  // kontrola znanym-zlym: jeden znak wiecej w ciele musi wywrocic podpis
  const wynikPodrobiony = await verifyJwsSignature({
    allowedX5uHosts: allowedX5uHostsFor(sandbox),
    header: jwsHeader,
    rawBody: rawBody + '&x=1',
    rootCertificate: root ?? undefined,
  })
  jwsPodrobioneOdpadl = !wynikPodrobiony.ok
  console.log(
    'kontrola (cialo +"&x=1"):',
    wynikPodrobiony.ok ? 'PRZESZEDL - WADA, podpis nie chroni ciala' : `odpadl, jak ma byc (${wynikPodrobiony.reason})`,
  )
}

// --- wynik -------------------------------------------------------------------
const wady = []
if (!md5Ok) wady.push('suma md5 nie zgadza sie z ta, ktora przyslal Tpay')
if (md5Podrobione) wady.push('suma md5 przechodzi po podmianie kwoty - kontrola nie dziala')
if (jwsHeader && jwsOk === false) wady.push('podpis JWS Tpay nie przechodzi naszej weryfikacji')
if (jwsHeader && jwsPodrobioneOdpadl === false) wady.push('podpis JWS przechodzi po zmianie ciala - kontrola nie dziala')

console.log('\n=== wynik ===')
if (wady.length) {
  wady.forEach((w) => console.log('WADA:', w))
  process.exit(1)
}
console.log('Suma md5: przeszla na materiale nietknietym, odpadla na podmienionej kwocie.')
if (!jwsHeader) {
  // Brak naglowka nie jest sukcesem warstwy 2 - to znaczy, ze jej nie zmierzono wcale.
  console.log('Podpis JWS: NIEZMIERZONY - w przechwycie nie bylo naglowka X-JWS-Signature.')
  console.log('\nWYNIK CZESCIOWY: zweryfikowana jedna warstwa z dwoch.')
  process.exit(2)
}
console.log('Podpis JWS: przeszedl na ciele nietknietym, odpadl po dopisaniu jednego pola.')
console.log('\nWYNIK PELNY: obie warstwy zweryfikowane na materiale wystawionym przez Tpay.')
