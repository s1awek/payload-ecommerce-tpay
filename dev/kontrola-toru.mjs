/**
 * Kontrola instrumentu PRZED czekaniem na powiadomienie Tpay.
 *
 * Bez tego brak powiadomienia jest nieodroznialny od zepsutego toru: nie wiadomo,
 * czy Tpay milczy, czy tunel nie dochodzi, czy handler sie wywraca. Mierzone dwie
 * strony, bo kontrola, ktora nigdy nie przepuszcza, jest tak samo bezuzyteczna jak
 * ta, ktora nigdy nie odrzuca.
 */
import { notificationChecksum, parseNotificationBody } from '../dist/verify.js'

const bazowy = process.argv[2]
if (!bazowy) {
  console.error('podaj publiczny adres jako argument')
  process.exit(1)
}
const cel = `${bazowy.replace(/\/+$/, '')}/api/payments/tpay/notifications`
const merchantId = process.env.TPAY_MERCHANT_ID
const securityCode = process.env.TPAY_SECURITY_CODE

const wyslij = async (etykieta, cialo) => {
  const odp = await fetch(cel, {
    body: cialo,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  })
  const tresc = await odp.text()
  console.log(`${etykieta}: HTTP ${odp.status}, tresc "${tresc}"`)
  return { status: odp.status, tresc }
}

// 1. Znany-zly: suma md5 nie moze sie zgadzac, bo jest wpisana z palca.
const zlyCialo =
  'id=' + merchantId +
  '&tr_id=TR-KONTROLA-ZLA&tr_crc=kontrola-instrumentu&tr_amount=1.00&tr_paid=1.00' +
  '&tr_status=TRUE&tr_error=none&tr_currency=PLN&md5sum=00000000000000000000000000000000'
const zly = await wyslij('ZNANY-ZLY (podrobiona suma md5)', zlyCialo)

// 2. Znany-dobry co do sumy md5, ale o transakcji, ktorej w bazie nie ma.
//    Ma przejsc kontrole kryptograficzna i odpasc dopiero na braku transakcji -
//    czyli warstwa md5 przepuszcza, a zamowienie z powietrza nie powstaje.
const podstawa = {
  id: merchantId,
  tr_amount: '1.00',
  tr_crc: 'kontrola-instrumentu-nieistniejaca',
  tr_id: 'TR-KONTROLA-DOBRA',
}
const suma = notificationChecksum(podstawa, { merchantId, securityCode })
const dobryCialo =
  'id=' + merchantId +
  '&tr_id=TR-KONTROLA-DOBRA&tr_crc=kontrola-instrumentu-nieistniejaca&tr_amount=1.00&tr_paid=1.00' +
  '&tr_status=TRUE&tr_error=none&tr_currency=PLN&md5sum=' + suma
const dobry = await wyslij('ZNANY-DOBRY co do md5 (transakcja nie istnieje)', dobryCialo)

console.log('\n--- werdykt kontroli toru ---')
const wady = []
if (zly.tresc !== 'FALSE') wady.push('podrobiona suma md5 NIE zostala odrzucona - kontrola jest slepa')
if (dobry.tresc === 'FALSE' && dobry.status === 400) {
  wady.push('poprawna suma md5 zostala odrzucona jako zla - kontrola jest zacisnieta na glucho')
}
if (wady.length) {
  wady.forEach((w) => console.log('WADA:', w))
  process.exit(1)
}
console.log('Tor przejezdny: zadanie dociera przez tunel do handlera.')
console.log('Suma md5 odrzuca podrobke i przepuszcza material policzony wlasciwym kodem.')
console.log('Brak powiadomienia od Tpay bedzie od tej chwili znaczyl cisze Tpay, nie awarie toru.')
