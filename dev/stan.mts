import { getPayload } from 'payload'
import config from './payload.config.js'
const payload = await getPayload({ config })

const t = await payload.find({ collection: 'transactions', depth: 0, limit: 10 })
console.log('=== TRANSAKCJE ===')
for (const d of t.docs as any[]) {
  console.log(`id=${d.id} status=${d.status} amount=${d.amount} ${d.currency} order=${JSON.stringify(d.order)} cart=${JSON.stringify(d.cart)}`)
  console.log(`   tpay.transactionId=${d.tpay?.transactionId} tpay.title=${d.tpay?.title}`)
}

const o = await payload.find({ collection: 'orders', depth: 0, limit: 10 })
console.log(`\n=== ZAMOWIENIA (${o.totalDocs}) ===`)
for (const d of o.docs as any[]) {
  console.log(`id=${d.id} status=${d.status} amount=${d.amount} ${d.currency} email=${d.customerEmail}`)
  console.log(`   transactions=${JSON.stringify(d.transactions)} items=${JSON.stringify(d.items)}`)
}

const p = await payload.find({ collection: 'products', depth: 0, limit: 10 })
console.log('\n=== PRODUKTY (stan magazynowy) ===')
for (const d of p.docs as any[]) console.log(`id=${d.id} inventory=${d.inventory} priceInPLN=${d.priceInPLN}`)

const c = await payload.find({ collection: 'carts', depth: 0, limit: 10 })
console.log('\n=== KOSZYKI ===')
for (const d of c.docs as any[]) console.log(`id=${d.id} status=${d.status} purchasedAt=${d.purchasedAt} subtotal=${d.subtotal}`)
process.exit(0)
