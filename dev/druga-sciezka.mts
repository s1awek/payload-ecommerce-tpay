/**
 * Sciezka przegladarki na transakcji JUZ domknietej powiadomieniem.
 * Mierzone dwie rzeczy: idempotencja miedzy dwoma torami oraz to, czy i ile razy
 * `confirm-order` zdejmuje stan magazynowy.
 */
import { getPayload } from 'payload'
import config from './payload.config.js'

const bazowy = 'http://127.0.0.1:8099'
const payload = await getPayload({ config })

const stanProduktu = async () => {
  const p = await payload.findByID({ collection: 'products', depth: 0, id: 1 })
  return (p as any).inventory
}
const liczbaZamowien = async () =>
  (await payload.find({ collection: 'orders', depth: 0, limit: 0 })).totalDocs

const koszyk = await payload.findByID({ collection: 'carts', depth: 0, id: 1 })
const secret = (koszyk as any).secret

const wolaj = async (etykieta: string) => {
  const przedStan = await stanProduktu()
  const przedZam = await liczbaZamowien()
  const odp = await fetch(`${bazowy}/api/payments/tpay/confirm-order`, {
    body: JSON.stringify({
      cartID: 1,
      customerEmail: 'kupujacy@example.invalid',
      secret,
      transactionID: 1,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  const tresc = await odp.text()
  const poStan = await stanProduktu()
  const poZam = await liczbaZamowien()
  console.log(`\n--- ${etykieta} ---`)
  console.log('HTTP', odp.status, tresc)
  console.log(`stan magazynowy: ${przedStan} -> ${poStan}`)
  console.log(`zamowienia: ${przedZam} -> ${poZam}`)
  return { poStan, poZam, tresc }
}

const a = await wolaj('WYWOLANIE 1 (transakcja juz domknieta powiadomieniem)')
const b = await wolaj('WYWOLANIE 2 (to samo zadanie powtorzone)')

console.log('\n=== WERDYKT ===')
console.log(
  a.poZam === b.poZam && b.poZam === 1
    ? 'Zamowienie NIE zostalo zdublowane: nadal dokladnie jedno.'
    : `WADA: liczba zamowien zmienila sie na ${b.poZam}`,
)
if (a.poStan === b.poStan) {
  console.log(`Stan magazynowy stabilny przy powtorzeniu: ${b.poStan}.`)
} else {
  console.log(`UWAGA: powtorzenie zmienilo stan magazynowy ${a.poStan} -> ${b.poStan} - dekrementacja bez bramki idempotencji.`)
}
process.exit(0)
