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
import { randomBytes, timingSafeEqual } from 'node:crypto'
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

// --- access gate -----------------------------------------------------------------
// This host is reachable from the internet whenever it runs behind a tunnel, because Tpay
// delivers the payment result as a server to server request and a local address never gets
// one. That same tunnel lets anyone who learns the address call `initiate` and mint sandbox
// transactions on OUR credentials. A random tunnel hostname is obscurity, not a control, so
// the shop asks for a password and keeps the answer in a session cookie.
//
// Two routes stay open by design:
//   - the notification endpoint, because Tpay has no password and authenticates itself with
//     the JWS signature and the md5 checksum the adapter already verifies;
//   - `/health`, so a tunnel check does not need the password.
// Everything else - the page, the catalogue, the cart, initiate, blik - is behind the gate.
//
// DEV_SHOP_PASSWORD unset means the gate is off. That is fine on a local address and logged
// as a warning when a public one is configured.
const SHOP_PASSWORD = process.env.DEV_SHOP_PASSWORD || ''
const SESSION_COOKIE = 'dev_shop_session'
// New secret on every start: a restart invalidates old cookies, and nothing is written to disk.
const SESSION_SECRET = randomBytes(32).toString('hex')

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const hasSession = (req: http.IncomingMessage) => {
  const raw = req.headers.cookie || ''
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === SESSION_COOKIE) return sameSecret(rest.join('='), SESSION_SECRET)
  }
  return false
}

const isPublicRoute = (method: string, pathname: string) =>
  (method === 'POST' && pathname === `${apiPrefix}/payments/tpay/notifications`) ||
  (method === 'GET' && pathname === '/health')

const LOGIN_PAGE = (wrong: boolean) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Demo shop</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f6f7}
form{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 1px 4px #0002;display:grid;gap:.75rem;width:min(22rem,90vw)}
h1{font-size:1.1rem;margin:0}p{margin:0;color:#666;font-size:.85rem}
input,button{font:inherit;padding:.6rem;border-radius:8px;border:1px solid #ccc}
button{background:#111;color:#fff;border:0;cursor:pointer}.bad{color:#b00}</style></head>
<body><form method="POST" action="/shop/login"><h1>Demo shop (Tpay sandbox)</h1>
<p>Development host. The password is in <code>DEV_SHOP_PASSWORD</code>.</p>
${wrong ? '<p class="bad">Wrong password.</p>' : ''}
<input type="password" name="password" autocomplete="current-password" autofocus required>
<button type="submit">Enter</button></form></body></html>`

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

const script = (res: http.ServerResponse, file: string) => {
  const content = readFileSync(path.resolve(dirname, file), 'utf8')
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
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
    if (method === 'GET' && url.pathname === '/health') return json(nodeRes, 200, { ok: true })

    // The gate runs before routing, so a new route cannot be added outside it by accident.
    if (SHOP_PASSWORD && !isPublicRoute(method, url.pathname) && !hasSession(nodeReq)) {
      if (method === 'POST' && url.pathname === '/shop/login') {
        const form = new URLSearchParams((await readBody(nodeReq)).toString('utf8'))
        if (sameSecret(form.get('password') || '', SHOP_PASSWORD)) {
          log('LOGIN ok')
          // Lax, so the browser still carries the cookie when Tpay sends the buyer back.
          nodeRes.writeHead(303, {
            Location: '/',
            'Set-Cookie': `${SESSION_COOKIE}=${SESSION_SECRET}; Path=/; HttpOnly; SameSite=Lax`,
          })
          return nodeRes.end()
        }
        log('LOGIN refused')
        nodeRes.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
        return nodeRes.end(LOGIN_PAGE(true))
      }
      log('GATE', method, url.pathname)
      // A form for a browser, a plain 401 for anything calling the API.
      if (method === 'GET' && !url.pathname.startsWith(apiPrefix)) {
        nodeRes.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
        return nodeRes.end(LOGIN_PAGE(false))
      }
      return json(nodeRes, 401, { message: 'this development shop is password protected' })
    }

    if (url.pathname.startsWith(apiPrefix)) return await forwardToApi(nodeReq, nodeRes, url)

    if (method === 'GET' && url.pathname === '/') return html(nodeRes, 'shop.html')
    // Return pages from Tpay - the same addresses payload.config.ts gives the adapter.
    if (method === 'GET' && (url.pathname === '/return' || url.pathname === '/error')) {
      log('BROWSER RETURN', url.pathname, url.search)
      return html(nodeRes, 'shop.html')
    }

    // The page is a module now, and this is the module it imports.
    if (method === 'GET' && url.pathname === '/shop/cart-param.mjs') return script(nodeRes, 'cart-param.mjs')
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
  const publicAddress = process.env.NEXT_PUBLIC_SERVER_URL || ''
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(publicAddress)
  if (SHOP_PASSWORD) log('access gate: ON (DEV_SHOP_PASSWORD set); open routes: POST /api/payments/tpay/notifications, GET /health')
  else if (publicAddress && !isLocal) log('access gate: OFF and the address above is PUBLIC - anyone who learns it can mint sandbox transactions on your Tpay credentials; set DEV_SHOP_PASSWORD')
  else log('access gate: OFF (no public address configured)')
  log('Endpoints:', (sanitized.endpoints ?? []).map((e: any) => `${e.method} ${e.path}`).join(', '))
})
