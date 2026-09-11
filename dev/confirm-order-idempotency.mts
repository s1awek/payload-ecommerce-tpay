/**
 * The browser path on a transaction ALREADY closed by a notification.
 * Two things are measured: idempotency between the two paths, and whether and
 * how many times `confirm-order` decrements stock.
 */
import { getPayload } from 'payload'
import config from './payload.config.js'

const base = 'http://127.0.0.1:8099'
const payload = await getPayload({ config })

const productStock = async () => {
  const p = await payload.findByID({ collection: 'products', depth: 0, id: 1 })
  return (p as any).inventory
}
const orderCount = async () =>
  (await payload.find({ collection: 'orders', depth: 0, limit: 0 })).totalDocs

const cart = await payload.findByID({ collection: 'carts', depth: 0, id: 1 })
const secret = (cart as any).secret

const call = async (label: string) => {
  const stockBefore = await productStock()
  const ordersBefore = await orderCount()
  const resp = await fetch(`${base}/api/payments/tpay/confirm-order`, {
    body: JSON.stringify({
      cartID: 1,
      customerEmail: 'buyer@example.invalid',
      secret,
      transactionID: 1,
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  const text = await resp.text()
  const stockAfter = await productStock()
  const ordersAfter = await orderCount()
  console.log(`\n--- ${label} ---`)
  console.log('HTTP', resp.status, text)
  console.log(`stock: ${stockBefore} -> ${stockAfter}`)
  console.log(`orders: ${ordersBefore} -> ${ordersAfter}`)
  return { stockAfter, ordersAfter, text }
}

const a = await call('CALL 1 (transaction already closed by a notification)')
const b = await call('CALL 2 (the same request repeated)')

console.log('\n=== VERDICT ===')
console.log(
  a.ordersAfter === b.ordersAfter && b.ordersAfter === 1
    ? 'The order was NOT duplicated: still exactly one.'
    : `FAULT: order count changed to ${b.ordersAfter}`,
)
if (a.stockAfter === b.stockAfter) {
  console.log(`Stock stable on repeat: ${b.stockAfter}.`)
} else {
  console.log(`WARNING: repeating the call changed stock ${a.stockAfter} -> ${b.stockAfter} - decrement without an idempotency gate.`)
}
process.exit(0)
