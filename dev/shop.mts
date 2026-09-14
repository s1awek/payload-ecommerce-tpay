/**
 * Click-through shop: the same live Payload instance and the same adapter as in
 * `server.mts`, plus one HTML page with a catalogue, a cart and a checkout, where
 * the buyer types a BLIK code or goes to the Tpay page.
 *
 * What this file does NOT do: it does not touch the adapter or the plugin.
 * Everything here beyond forwarding requests to `/api/*` is SHOP logic -
 * exactly what the package README tells a shop to write itself (remembering
 * the transaction id, calling `confirm-order` exactly once, decrementing
 * stock after a BLIK payment). That makes this page a working example of the
 * integration too.
 *
 * Run it like `server.mts` (same environment variables, same port), but
 * instead of it. Both listen on 8099 and cannot run at the same time.
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPayloadRequest, getPayload } from 'payload'
import config from './payload.config.js'
import { notificationSummary, redactSecrets } from './log-redact.mjs'

const PORT = Number(process.env.PORT || 8099)
const dirname = path.dirname(fileURLToPath(import.meta.url))

const payload = await getPayload({ config })
const sanitized = payload.config
const apiPrefix = sanitized.routes?.api || '/api'

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)

// --- seed: three demo products, created once -------------------------------------
const DEMO_PRODUCTS = [
  { title: 'Demo: PCB mug coaster', priceInPLN: 4900, inventory: 5 },
  { title: 'Demo: set of four coasters', priceInPLN: 16900, inventory: 3 },
  { title: 'Demo: A3 integrated circuit poster', priceInPLN: 8900, inventory: 8 },
]

const seed = async () => {
  const existing = await payload.find({
    collection: 'products',
    depth: 0,
    limit: 50,
    where: { title: { like: 'Demo:' } },
  })
  if (existing.totalDocs >= DEMO_PRODUCTS.length) return
  for (const p of DEMO_PRODUCTS) {
    if ((existing.docs as any[]).some((d) => d.title === p.title)) continue
    await payload.create({
      collection: 'products',
      data: { _status: 'published', enableVariants: false, priceInPLNEnabled: true, ...p } as any,
    })
    log('seed: product', p.title)
  }
}
await seed()

// --- helpers -----------------------------------------------------------------------
const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (k) => chunks.push(k))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

const readJson = async (req: http.IncomingMessage): Promise<any> => {
  const b = await readBody(req)
  if (!b.length) return {}
  return JSON.parse(b.toString('utf8'))
}

const json = (res: http.ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

const html = (res: http.ServerResponse, file: string) => {
  // Read on every request, so editing the page does not require restarting Payload.
  const content = readFileSync(path.resolve(dirname, file), 'utf8')
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(content)
}

const listProducts = async () => {
  const result = await payload.find({
    collection: 'products',
    depth: 0,
    limit: 50,
    sort: 'createdAt',
    where: { and: [{ title: { like: 'Demo:' } }, { _status: { equals: 'published' } }] },
  })
  return (result.docs as any[]).map((d) => ({
    id: d.id,
    price: d.priceInPLN,
    stock: d.inventory,
    title: d.title,
  }))
}

/**
 * Database state around one transaction - the "what happened in the database"
 * panel on the page. This is what the buyer does not see and what the shop
 * owner wants to see.
 */
// Reading state requires the cart secret: without it anyone could see amounts,
// Tpay addresses and orders of other people's transactions (ids are sequential
// numbers). An unknown id and a wrong secret give the same response, so as not
// to reveal which ones exist.
const transactionStateForOwner = async (body: any) => {
  const transactionID = Number(body.transactionID)
  if (!transactionID || typeof body.secret !== 'string' || !body.secret) return null
  let tx: any
  try { tx = await payload.findByID({ collection: 'transactions', depth: 0, id: transactionID }) } catch { return null }
  const cart = (await payload.findByID({ collection: 'carts', depth: 0, id: tx.cart }).catch(() => null)) as any
  if (!cart || cart.secret !== body.secret) return null
  return await transactionState(transactionID)
}

const transactionState = async (transactionID: number) => {
  const tx = (await payload.findByID({ collection: 'transactions', depth: 0, id: transactionID })) as any
  const order = tx.order
    ? ((await payload.findByID({ collection: 'orders', depth: 0, id: tx.order })) as any)
    : null
  const cart = tx.cart
    ? ((await payload.findByID({ collection: 'carts', depth: 0, id: tx.cart })) as any)
    : null
  return {
    cart: cart ? { id: cart.id, purchased: Boolean(cart.purchasedAt) } : null,
    products: await listProducts(),
    transaction: {
      amount: tx.amount,
      currency: tx.currency,
      id: tx.id,
      status: tx.status,
      tpayId: tx.tpay?.transactionId ?? null,
    },
    order: order ? { amount: order.amount, id: order.id, status: order.status } : null,
  }
}

// The BLIK path does not go through `confirm-order`, so nothing decrements stock -
// the README tells the shop to do it itself, once, on the first `paid`. The
// "already decremented" memory is in process here; a real shop would record it on
// the order.
const stockDecrementedFor = new Set<number>()

const decrementStock = async (body: any) => {
  const transactionID = Number(body.transactionID)
  if (!transactionID) return { decremented: false, reason: 'no transactionID' }
  const tx = (await payload.findByID({ collection: 'transactions', depth: 0, id: transactionID })) as any
  if (!tx.order) return { decremented: false, reason: 'transaction has no order, payment not closed' }
  const cart = (await payload.findByID({ collection: 'carts', depth: 0, id: tx.cart })) as any
  if (!cart || cart.secret !== body.secret) return { decremented: false, reason: 'cart secret does not match' }
  if (stockDecrementedFor.has(transactionID)) return { decremented: false, reason: 'stock for this transaction already decremented' }
  stockDecrementedFor.add(transactionID)
  for (const item of cart.items ?? []) {
    const productId = typeof item.product === 'object' ? item.product.id : item.product
    const product = (await payload.findByID({ collection: 'products', depth: 0, id: productId })) as any
    await payload.update({
      collection: 'products',
      data: { inventory: Math.max(0, Number(product.inventory ?? 0) - Number(item.quantity ?? 1)) } as any,
      id: productId,
    })
  }
  return { decremented: true, reason: 'decremented on first paid read' }
}

const createCart = async (body: any) => {
  const items = Array.isArray(body.items) ? body.items : []
  if (!items.length) throw new Error('empty cart')
  let subtotal = 0
  const cartItems: any[] = []
  for (const p of items) {
    const product = (await payload.findByID({ collection: 'products', depth: 0, id: p.product })) as any
    // Quantity: an integer 1..99. A fraction or a huge number from DevTools has
    // nothing to spoil in the amount (the plugin's hook computes it from the same
    // quantity), but the integration example is meant to show input validation,
    // not its absence.
    const quantity = Math.min(99, Math.max(1, Math.floor(Number(p.quantity)) || 1))
    subtotal += Number(product.priceInPLN) * quantity
    cartItems.push({ product: product.id, quantity })
  }
  const cart = (await payload.create({
    collection: 'carts',
    data: { currency: 'PLN', items: cartItems, subtotal } as any,
  })) as any
  return { id: cart.id, secret: cart.secret, subtotal }
}

// --- forwarding to the plugin and adapter endpoints (as in server.mts) -------------
const findEndpoint = (method: string, route: string) =>
  (sanitized.endpoints ?? []).find(
    (e: any) => e.method.toLowerCase() === method.toLowerCase() && e.path === route,
  )

const forwardToApi = async (nodeReq: http.IncomingMessage, nodeRes: http.ServerResponse, url: URL) => {
  const route = url.pathname.slice(apiPrefix.length) || '/'
  const endpoint = findEndpoint(nodeReq.method || 'GET', route)
  if (!endpoint) {
    log('404', nodeReq.method, route)
    nodeRes.writeHead(404, { 'Content-Type': 'text/plain' })
    nodeRes.end('no such endpoint')
    return
  }
  const body = ['GET', 'HEAD'].includes(nodeReq.method || 'GET') ? undefined : await readBody(nodeReq)
  const headers = new Headers()
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v)
    else if (Array.isArray(v)) headers.set(k, v.join(', '))
  }
  const request = new Request(`http://localhost:${PORT}${nodeReq.url}`, {
    body: body && body.length ? body : undefined,
    headers,
    method: nodeReq.method,
  })
  log(nodeReq.method, route, `(body ${body?.length ?? 0} B)`)
  if (route.includes('notifications') && body?.length) {
    // The transaction, what the message claims happened, the NAMES of the
    // fields it carried, and whether it was signed. Never the body: `md5sum` is
    // what an offline attack on the security code starts from - the same thing
    // `.gitignore` keeps out of the repository, and it has no business going
    // into dev/*.log either.
    log('NOTIFICATION', notificationSummary(body.toString('utf8'), { signed: headers.has('x-jws-signature') }))
  }
  const payloadReq = await createPayloadRequest({ config: sanitized, request })
  const response = await endpoint.handler(payloadReq)
  const text = await response.text()
  const responseHeaders: Record<string, string> = {}
  response.headers.forEach((v, k) => (responseHeaders[k] = v))
  // The answers from `/api/*` carry an order's `accessToken` and a guest cart's
  // `secret`; a log file is not the place for either. Redaction runs before the
  // cut, so half a secret cannot survive it.
  log('->', response.status, redactSecrets(text).slice(0, 300))
  nodeRes.writeHead(response.status, responseHeaders)
  nodeRes.end(text)
}

// --- server --------------------------------------------------------------------
const server = http.createServer(async (nodeReq, nodeRes) => {
  const url = new URL(nodeReq.url || '/', `http://localhost:${PORT}`)
  const method = nodeReq.method || 'GET'
  try {
    if (url.pathname.startsWith(apiPrefix)) return await forwardToApi(nodeReq, nodeRes, url)

    if (method === 'GET' && url.pathname === '/') return html(nodeRes, 'shop.html')
    // Return pages from Tpay - the same addresses payload.config.ts gives the adapter.
    if (method === 'GET' && (url.pathname === '/return' || url.pathname === '/error')) {
      log('BROWSER RETURN', url.pathname, url.search)
      return html(nodeRes, 'shop.html')
    }

    if (method === 'GET' && url.pathname === '/shop/config') return json(nodeRes, 200, { publicAddress: (process.env.NEXT_PUBLIC_SERVER_URL || '').replace(/\/+$/, '') })
    if (method === 'GET' && url.pathname === '/shop/products') return json(nodeRes, 200, { products: await listProducts() })
    if (method === 'POST' && url.pathname === '/shop/cart') return json(nodeRes, 200, await createCart(await readJson(nodeReq)))
    if (method === 'POST' && url.pathname === '/shop/state') {
      const state = await transactionStateForOwner(await readJson(nodeReq))
      return state ? json(nodeRes, 200, state) : json(nodeRes, 403, { message: 'no access to this transaction' })
    }
    if (method === 'POST' && url.pathname === '/shop/decrement-stock') return json(nodeRes, 200, await decrementStock(await readJson(nodeReq)))

    nodeRes.writeHead(404, { 'Content-Type': 'text/plain' })
    nodeRes.end('not this server')
  } catch (error) {
    console.error(new Date().toISOString(), 'EXCEPTION', error)
    if (!nodeRes.headersSent) json(nodeRes, 500, { message: error instanceof Error ? error.message : 'server error' })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  log(`Demo shop: http://127.0.0.1:${PORT}/  (API at ${apiPrefix})`)
  log('public address (return and notifications):', process.env.NEXT_PUBLIC_SERVER_URL || '(MISSING - initiate will refuse)')
  log('Endpoints:', (sanitized.endpoints ?? []).map((e: any) => `${e.method} ${e.path}`).join(', '))
})
