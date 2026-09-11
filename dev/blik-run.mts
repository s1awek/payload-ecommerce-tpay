/**
 * BLIK level 0 run against a live Payload instance, in the Tpay sandbox.
 *
 * This checks what unit tests cannot: that the code typed on the shop side
 * closes the payment WITHOUT redirecting the payer anywhere. The return
 * address is not set at all here - if the run relied on it, it would not be
 * BLIK level 0.
 */
import { getPayload } from 'payload'
import config from './payload.config.js'

const PORT = Number(process.env.PORT || 8099)
const API = `http://127.0.0.1:${PORT}/api`
const BLIK_CODE = process.env.BLIK_TOKEN || '777123'

const payload = await getPayload({ config })
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

const post = async (route: string, body: unknown) => {
  const r = await fetch(`${API}${route}`, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })
  let content: any
  try { content = await r.json() } catch { content = null }
  return { status: r.status, content }
}

// --- 1. seed: a product with stock and a guest cart ---
const product = (await payload.create({
  collection: 'products',
  data: {
    _status: 'published',
    title: `BLIK product ${Date.now()}`,
    enableVariants: false,
    inventory: 5,
    priceInPLN: 12345,
    priceInPLNEnabled: true,
  },
})) as any
log('product', product.id, '| stock', product.inventory)

const cart = (await payload.create({
  collection: 'carts',
  data: {
    currency: 'PLN',
    items: [{ product: product.id, quantity: 1 }],
    subtotal: 12345,
  },
})) as any
log('cart', cart.id, '| secret', cart.secret ? 'present' : 'MISSING')

// --- 2. payment created the normal way, through the plugin ---
const init = await post('/payments/tpay/initiate', {
  billingAddress: { city: 'Warsaw', country: 'PL', firstName: 'John', lastName: 'Tester', postalCode: '00-001' },
  cartID: cart.id,
  customerEmail: 'buyer@example.invalid',
  secret: cart.secret,
})
log('initiate ->', init.status, JSON.stringify(init.content))
const transactionID = init.content?.transactionID
if (!transactionID) { log('MISSING transactionID - aborting'); process.exit(1) }

// initiate returns a Tpay payment address, but in BLIK level 0 NOBODY opens it.
log('redirect address returned by initiate:', init.content?.paymentUrl ? 'present (unused)' : 'missing')

// --- 3. BLIK code typed at the shop's checkout ---
const blik = await post('/payments/tpay/blik', {
  blikToken: BLIK_CODE,
  secret: cart.secret,
  transactionID,
})
log('sending the code ->', blik.status, JSON.stringify(blik.content))

// --- 4. the checkout polls the status, exactly as a browser would ---
let last: any = null
for (let i = 1; i <= 30; i++) {
  const st = await post('/payments/tpay/blik-status', { secret: cart.secret, transactionID })
  last = st.content
  log(`read ${i}/30 ->`, st.status, JSON.stringify(st.content))
  if (st.content?.status === 'paid' || st.content?.status === 'failed' || st.content?.status === 'rejected') { break }
  await new Promise((r) => setTimeout(r, 2000))
}

// --- 5. database state after the run ---
const tx = (await payload.findByID({ collection: 'transactions', id: transactionID, depth: 0 })) as any
const productAfter = (await payload.findByID({ collection: 'products', id: product.id, depth: 0 })) as any
const cartAfter = (await payload.findByID({ collection: 'carts', id: cart.id, depth: 0 })) as any

log('--- STATE AFTER THE RUN ---')
log('transaction status:', tx.status, '| order:', tx.order ?? 'none')
log('product stock:', productAfter.inventory, '(before the run: 5)')
log('cart purchased:', cartAfter.purchasedAt ? 'yes' : 'no')
if (tx.order) {
  const ord = (await payload.findByID({ collection: 'orders', id: tx.order, depth: 0 })) as any
  log('order', ord.id, '| status', ord.status, '| amount', ord.amount, ord.currency)
}
log('result of the last status read:', JSON.stringify(last))
process.exit(0)
