/**
 * Kryterium „zly kod nie konczy zakupu": do platnosci, ktora dostala kod
 * odrzucony, idzie kolejny kod. Ma przejsc bez zakladania drugiej transakcji
 * i drugiego zamowienia.
 */
import { getPayload } from 'payload'
import config from './payload.config.js'

const PORT = Number(process.env.PORT || 8099)
const API = `http://127.0.0.1:${PORT}/api`
const TX = process.env.TX_ID
const payload = await getPayload({ config })
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

const tx = (await payload.findByID({ collection: 'transactions', id: TX!, depth: 0 })) as any
const koszyk = (await payload.findByID({ collection: 'carts', id: tx.cart, depth: 0 })) as any
log('stan przed:', 'transakcja', tx.status, '| zamowienie', tx.order ?? 'brak')
const przedTx = (await payload.find({ collection: 'transactions', depth: 0, limit: 0 })).totalDocs
const przedZam = (await payload.find({ collection: 'orders', depth: 0, limit: 0 })).totalDocs
log('dokumentow przed: transakcji', przedTx, '| zamowien', przedZam)

const post = async (s: string, c: unknown) => {
  const r = await fetch(`${API}${s}`, { body: JSON.stringify(c), headers: { 'Content-Type': 'application/json' }, method: 'POST' })
  return { status: r.status, tresc: await r.json() }
}

const drugi = await post('/payments/tpay/blik', { blikToken: '777123', secret: koszyk.secret, transactionID: TX })
log('drugi kod ->', drugi.status, JSON.stringify(drugi.tresc))

let ost: any = null
for (let i = 1; i <= 20; i++) {
  const st = await post('/payments/tpay/blik-status', { secret: koszyk.secret, transactionID: TX })
  ost = st.tresc
  if (st.tresc?.status !== 'pending') { log(`odczyt ${i} ->`, JSON.stringify(st.tresc)); break }
  await new Promise((r) => setTimeout(r, 2000))
}

const po = (await payload.findByID({ collection: 'transactions', id: TX!, depth: 0 })) as any
const poTx = (await payload.find({ collection: 'transactions', depth: 0, limit: 0 })).totalDocs
const poZam = (await payload.find({ collection: 'orders', depth: 0, limit: 0 })).totalDocs
log('stan po:', 'transakcja', po.status, '| zamowienie', po.order ?? 'brak')
log('dokumentow po: transakcji', poTx, '(bylo', przedTx + ') | zamowien', poZam, '(bylo', przedZam + ')')
log('wynik:', JSON.stringify(ost))
process.exit(0)
