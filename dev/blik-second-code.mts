/**
 * The "a bad code does not end the purchase" criterion: a payment that got a
 * refused code receives another code. It must pass without creating a second
 * transaction and a second order.
 */
import { getPayload } from 'payload'
import config from './payload.config.js'

const PORT = Number(process.env.PORT || 8099)
const API = `http://127.0.0.1:${PORT}/api`
const TX = process.env.TX_ID
const payload = await getPayload({ config })
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

const tx = (await payload.findByID({ collection: 'transactions', id: TX!, depth: 0 })) as any
const cart = (await payload.findByID({ collection: 'carts', id: tx.cart, depth: 0 })) as any
log('state before:', 'transaction', tx.status, '| order', tx.order ?? 'none')
const beforeTx = (await payload.find({ collection: 'transactions', depth: 0, limit: 0 })).totalDocs
const beforeOrd = (await payload.find({ collection: 'orders', depth: 0, limit: 0 })).totalDocs
log('documents before: transactions', beforeTx, '| orders', beforeOrd)

const post = async (s: string, c: unknown) => {
  const r = await fetch(`${API}${s}`, { body: JSON.stringify(c), headers: { 'Content-Type': 'application/json' }, method: 'POST' })
  return { status: r.status, content: await r.json() }
}

const second = await post('/payments/tpay/blik', { blikToken: '777123', secret: cart.secret, transactionID: TX })
log('second code ->', second.status, JSON.stringify(second.content))

let last: any = null
for (let i = 1; i <= 20; i++) {
  const st = await post('/payments/tpay/blik-status', { secret: cart.secret, transactionID: TX })
  last = st.content
  if (st.content?.status !== 'pending') { log(`read ${i} ->`, JSON.stringify(st.content)); break }
  await new Promise((r) => setTimeout(r, 2000))
}

const after = (await payload.findByID({ collection: 'transactions', id: TX!, depth: 0 })) as any
const afterTx = (await payload.find({ collection: 'transactions', depth: 0, limit: 0 })).totalDocs
const afterOrd = (await payload.find({ collection: 'orders', depth: 0, limit: 0 })).totalDocs
log('state after:', 'transaction', after.status, '| order', after.order ?? 'none')
log('documents after: transactions', afterTx, '(was', beforeTx + ') | orders', afterOrd, '(was', beforeOrd + ')')
log('result:', JSON.stringify(last))
process.exit(0)
