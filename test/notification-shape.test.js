/**
 * Ksztalt powiadomienia i zasieg sumy md5, zmierzone na powiadomieniu, ktore
 * Tpay wystawil naprawde w piaskownicy.
 *
 * Pozostale testy sprawdzaja nasz kod wobec powiadomien, ktore sami zbudowalismy,
 * czyli wobec naszego wyobrazenia o tym, co przysyla Tpay. Tutaj przypiete jest
 * to, co przyszlo. Atrapa `test/fixtures/powiadomienie-piaskownica.txt` ma ten sam
 * zestaw i te sama kolejnosc pol; wartosci wrazliwe podmienione, suma przeliczona
 * atrapowym kodem (prawdziwy przechwyt to md5(znany prefiks + kod bezpieczenstwa),
 * czyli material do lamania kodu offline - nie wchodzi do repozytorium).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { isChecksumValid, parseNotificationBody } from '../dist/verify.js'

const RAW = readFileSync(new URL('./fixtures/powiadomienie-piaskownica.txt', import.meta.url), 'utf8')
const ARGS = { merchantId: '12345', securityCode: 'atrapa-kodu-bezpieczenstwa' }

test('powiadomienie niesie pola, ktorych nasz typ nie wymienial', () => {
  const n = parseNotificationBody(RAW)

  // Zmierzone na zywym powiadomieniu: przychodzi tez `tr_currency`, ktorego
  // `TpayNotification` nie wymienia z nazwy (przechodzi przez indeks napisowy).
  assert.equal(n.tr_currency, 'PLN')
  assert.deepEqual(Object.keys(n).sort(), [
    'id', 'md5sum', 'test_mode', 'tr_amount', 'tr_crc', 'tr_currency',
    'tr_date', 'tr_desc', 'tr_email', 'tr_error', 'tr_id', 'tr_paid', 'tr_status',
  ])
})

test('pole id w ciele to identyfikator sprzedawcy, ale suma liczy sie z konfiguracji', () => {
  const n = parseNotificationBody(RAW)

  assert.equal(n.id, ARGS.merchantId)
  // Gdyby suma brala merchantId z ciala, napastnik podawalby wlasny i sam
  // ustalalby, co jest poprawne. Podmiana `id` nie moze niczego zmienic.
  assert.equal(isChecksumValid({ ...n, id: '99999' }, ARGS), true)
})

test('test_mode NIE odroznia piaskownicy od produkcji', () => {
  const n = parseNotificationBody(RAW)

  // Zmierzone: powiadomienie z PIASKOWNICY przyszlo z test_mode=0.
  // Kod, ktory bralby to pole za znacznik srodowiska, mylilby sie zawsze.
  assert.equal(n.test_mode, '0')
})

test('suma md5 chroni tylko tr_id, tr_amount i tr_crc', () => {
  const n = parseNotificationBody(RAW)
  const chronione = { tr_amount: '1.00', tr_crc: 'cudze-zamowienie', tr_id: 'TR-000-INNY' }
  const niechronione = {
    test_mode: '1',
    tr_currency: 'EUR',
    tr_email: 'napastnik@example.invalid',
    tr_paid: '0.01',
    tr_status: 'FALSE',
  }

  assert.equal(isChecksumValid(n, ARGS), true, 'material nietkniety musi przechodzic')

  for (const [pole, wartosc] of Object.entries(chronione)) {
    assert.equal(isChecksumValid({ ...n, [pole]: wartosc }, ARGS), false, `${pole} ma byc chronione suma`)
  }

  // To NIE jest opis wady naszego kodu, tylko zasiegu mechanizmu Tpay: suma to
  // md5(merchantId + tr_id + kwota + tr_crc + kod), wiec status platnosci, kwota
  // faktycznie zaplacona, waluta i adres kupujacego zostaja poza nia. Decyzje
  // o pieniadzach opieraja sie na `tr_status` i `tr_paid`, czyli na polach spoza
  // sumy - dlatego druga warstwa (podpis JWS nad CALYM cialem) nie jest ozdoba.
  for (const [pole, wartosc] of Object.entries(niechronione)) {
    assert.equal(isChecksumValid({ ...n, [pole]: wartosc }, ARGS), true, `${pole} jest poza suma`)
  }
})
