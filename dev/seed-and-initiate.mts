/**
 * Seed data in the plugin's real collections and start a payment through a
 * LIVE HTTP endpoint - not by calling the adapter's function directly. The
 * difference matters: the plugin's endpoint validates prices and stock itself,
 * and it decides what reaches the adapter at all.
 */
import { getPayload } from 'payload'
import config from './payload.config.js'

const base = (process.argv[2] || '').replace(/\/+$/, '')
if (!base) { console.error('pass the public address as an argument'); process.exit(1) }

const payload = await getPayload({ config })
const AMOUNT_CENTS = 12345

const product = await payload.create({
  collection: 'products',
  data: { _status: 'published', inventory: 5, priceInPLN: AMOUNT_CENTS, priceInPLNEnabled: true } as any,
})
console.log('product:', product.id, 'price (cents):', (product as any).priceInPLN, 'stock:', (product as any).inventory)

const cart = await payload.create({
  collection: 'carts',
  data: { currency: 'PLN', items: [{ product: product.id, quantity: 1 }], subtotal: AMOUNT_CENTS } as any,
})
console.log('cart:', cart.id, 'secret:', (cart as any).secret ? 'present' : 'missing')

const body = {
  billingAddress: {
    addressLine1: 'Test St 1', city: 'Warsaw', country: 'PL',
    firstName: 'John', lastName: 'Tester', postalCode: '00-001',
  },
  cartID: cart.id,
  customerEmail: 'buyer@example.invalid',
  secret: (cart as any).secret,
}

const resp = await fetch(`${base}/api/payments/tpay/initiate`, {
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
  method: 'POST',
})
const result = await resp.json()
console.log('\n--- initiate endpoint response ---')
console.log('HTTP', resp.status)
console.log(JSON.stringify(result, null, 2))

const transactions = await payload.find({ collection: 'transactions', depth: 0, limit: 5 })
console.log('\n--- transactions in the database ---')
for (const t of transactions.docs as any[]) {
  console.log(`  id=${t.id} status=${t.status} amount=${t.amount} ${t.currency} tpay.transactionId=${t.tpay?.transactionId} tpay.title=${t.tpay?.title}`)
}

const orders = await payload.find({ collection: 'orders', depth: 0, limit: 5 })
console.log('orders in the database:', orders.totalDocs)

console.log('\n=== PAYMENT ADDRESS ===')
console.log((result as any).paymentUrl || (result as any).transactionPaymentUrl || '(missing in the response)')
process.exit(0)
