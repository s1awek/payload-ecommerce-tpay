/**
 * Zasiew danych w prawdziwych kolekcjach wtyczki i zalozenie platnosci przez
 * ZYWY endpoint HTTP - nie przez bezposrednie wywolanie funkcji adaptera.
 * Roznica jest istotna: endpoint wtyczki sam waliduje ceny i stan magazynowy,
 * i to on decyduje, z czym w ogole dojdzie do adaptera.
 */
import { getPayload } from 'payload'
import config from './payload.config.js'

const bazowy = (process.argv[2] || '').replace(/\/+$/, '')
if (!bazowy) { console.error('podaj publiczny adres jako argument'); process.exit(1) }

const payload = await getPayload({ config })
const KWOTA_GROSZE = 12345

const produkt = await payload.create({
  collection: 'products',
  data: { _status: 'published', inventory: 5, priceInPLN: KWOTA_GROSZE, priceInPLNEnabled: true } as any,
})
console.log('produkt:', produkt.id, 'cena (grosze):', (produkt as any).priceInPLN, 'stan:', (produkt as any).inventory)

const koszyk = await payload.create({
  collection: 'carts',
  data: { currency: 'PLN', items: [{ product: produkt.id, quantity: 1 }], subtotal: KWOTA_GROSZE } as any,
})
console.log('koszyk:', koszyk.id, 'secret:', (koszyk as any).secret ? 'jest' : 'brak')

const cialo = {
  billingAddress: {
    addressLine1: 'Testowa 1', city: 'Warszawa', country: 'PL',
    firstName: 'Jan', lastName: 'Testowy', postalCode: '00-001',
  },
  cartID: koszyk.id,
  customerEmail: 'kupujacy@example.invalid',
  secret: (koszyk as any).secret,
}

const odp = await fetch(`${bazowy}/api/payments/tpay/initiate`, {
  body: JSON.stringify(cialo),
  headers: { 'Content-Type': 'application/json' },
  method: 'POST',
})
const wynik = await odp.json()
console.log('\n--- odpowiedz endpointu initiate ---')
console.log('HTTP', odp.status)
console.log(JSON.stringify(wynik, null, 2))

const transakcje = await payload.find({ collection: 'transactions', depth: 0, limit: 5 })
console.log('\n--- transakcje w bazie ---')
for (const t of transakcje.docs as any[]) {
  console.log(`  id=${t.id} status=${t.status} amount=${t.amount} ${t.currency} tpay.transactionId=${t.tpay?.transactionId} tpay.title=${t.tpay?.title}`)
}

const zamowienia = await payload.find({ collection: 'orders', depth: 0, limit: 5 })
console.log('zamowienia w bazie:', zamowienia.totalDocs)

console.log('\n=== ADRES DO ZAPLATY ===')
console.log((wynik as any).paymentUrl || (wynik as any).transactionPaymentUrl || '(brak w odpowiedzi)')
process.exit(0)
