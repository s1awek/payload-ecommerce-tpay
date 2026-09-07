/**
 * Przebieg BLIK 0 na zywej instancji Payloada, w piaskownicy Tpay.
 *
 * Sprawdza to, czego testy jednostkowe sprawdzic nie moga: ze kod wpisany
 * po stronie sklepu domyka platnosc BEZ przekierowania platnika gdziekolwiek.
 * Adres powrotu nie jest tu w ogole ustawiany - gdyby przebieg z niego korzystal,
 * nie bylby to BLIK 0.
 */
import { getPayload } from 'payload'
import config from './payload.config.js'

const PORT = Number(process.env.PORT || 8099)
const API = `http://127.0.0.1:${PORT}/api`
const KOD_BLIK = process.env.BLIK_TOKEN || '777123'

const payload = await getPayload({ config })
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

const post = async (sciezka: string, cialo: unknown) => {
  const r = await fetch(`${API}${sciezka}`, {
    body: JSON.stringify(cialo),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  let tresc: any
  try { tresc = await r.json() } catch { tresc = null }
  return { status: r.status, tresc }
}

// --- 1. zasiew: produkt ze stanem magazynowym i koszyk goscia ---
const produkt = (await payload.create({
  collection: 'products',
  data: {
    _status: 'published',
    title: `Produkt BLIK ${Date.now()}`,
    enableVariants: false,
    inventory: 5,
    priceInPLN: 12345,
    priceInPLNEnabled: true,
  },
})) as any
log('produkt', produkt.id, '| stan magazynowy', produkt.inventory)

const koszyk = (await payload.create({
  collection: 'carts',
  data: {
    currency: 'PLN',
    items: [{ product: produkt.id, quantity: 1 }],
    subtotal: 12345,
  },
})) as any
log('koszyk', koszyk.id, '| sekret', koszyk.secret ? 'jest' : 'BRAK')

// --- 2. platnosc zakladana normalna droga wtyczki ---
const init = await post('/payments/tpay/initiate', {
  billingAddress: { city: 'Warszawa', country: 'PL', firstName: 'Jan', lastName: 'Probny', postalCode: '00-001' },
  cartID: koszyk.id,
  customerEmail: 'kupujacy@example.invalid',
  secret: koszyk.secret,
})
log('initiate ->', init.status, JSON.stringify(init.tresc))
const transactionID = init.tresc?.transactionID
if (!transactionID) { log('BRAK transactionID - przerywam'); process.exit(1) }

// Adres platnosci Tpay dostajemy, ale w BLIK-u 0 NIKT go nie otwiera.
log('adres przekierowania zwrocony przez initiate:', init.tresc?.paymentUrl ? 'jest (nieuzywany)' : 'brak')

// --- 3. kod BLIK wpisany w kasie sklepu ---
const blik = await post('/payments/tpay/blik', {
  blikToken: KOD_BLIK,
  secret: koszyk.secret,
  transactionID,
})
log('wyslanie kodu ->', blik.status, JSON.stringify(blik.tresc))

// --- 4. kasa odpytuje stan, dokladnie tak jak robilaby to przegladarka ---
let ostatni: any = null
for (let i = 1; i <= 30; i++) {
  const st = await post('/payments/tpay/blik-status', { secret: koszyk.secret, transactionID })
  ostatni = st.tresc
  log(`odczyt ${i}/30 ->`, st.status, JSON.stringify(st.tresc))
  if (st.tresc?.status === 'paid' || st.tresc?.status === 'failed' || st.tresc?.status === 'rejected') { break }
  await new Promise((r) => setTimeout(r, 2000))
}

// --- 5. stan bazy po przebiegu ---
const tx = (await payload.findByID({ collection: 'transactions', id: transactionID, depth: 0 })) as any
const produktPo = (await payload.findByID({ collection: 'products', id: produkt.id, depth: 0 })) as any
const koszykPo = (await payload.findByID({ collection: 'carts', id: koszyk.id, depth: 0 })) as any

log('--- STAN PO PRZEBIEGU ---')
log('transakcja status:', tx.status, '| zamowienie:', tx.order ?? 'brak')
log('stan magazynowy produktu:', produktPo.inventory, '(przed przebiegiem: 5)')
log('koszyk kupiony:', koszykPo.purchasedAt ? 'tak' : 'nie')
if (tx.order) {
  const zam = (await payload.findByID({ collection: 'orders', id: tx.order, depth: 0 })) as any
  log('zamowienie', zam.id, '| status', zam.status, '| kwota', zam.amount, zam.currency)
}
log('wynik ostatniego odczytu stanu:', JSON.stringify(ostatni))
process.exit(0)
