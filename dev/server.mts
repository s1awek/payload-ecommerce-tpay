/**
 * The smallest HTTP server that exposes Payload's endpoints without Next.js.
 *
 * Payload 3 has no server of its own - in a normal shop, routing is done by
 * `@payloadcms/next`. For the e2e run, Next is unnecessary: the only thing
 * needed is a channel that Tpay can reach for the notification endpoint, and
 * that the browser returns to on `confirm-order`. `createPayloadRequest` is a
 * public export of `payload`, so translating a node:http request into a
 * PayloadRequest requires nothing private.
 */
import http from 'node:http'
import { createPayloadRequest, getPayload } from 'payload'
import config from './payload.config.js'

const PORT = Number(process.env.PORT || 8099)

const payload = await getPayload({ config })
const sanitized = payload.config
const apiPrefix = sanitized.routes?.api || '/api'

const findEndpoint = (method: string, route: string) =>
  (sanitized.endpoints ?? []).find(
    (e: any) => e.method.toLowerCase() === method.toLowerCase() && e.path === route,
  )

const readBody = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (k) => chunks.push(k))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

const server = http.createServer(async (nodeReq, nodeRes) => {
  const stamp = new Date().toISOString()
  const url = new URL(nodeReq.url || '/', `http://localhost:${PORT}`)

  try {
    // Browser return after payment: there is no shop here, so a stand in page
    // calls confirm-order itself - exactly what a real shop's checkout does.
    if (nodeReq.method === 'GET' && (url.pathname === '/return' || url.pathname === '/error')) {
      console.log(`${stamp} BROWSER RETURN ${url.pathname} ${url.search}`)

      if (url.pathname === '/error') {
        nodeRes.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        nodeRes.end('<!doctype html><meta charset="utf-8"><title>Payment failed</title><p>Payment failed.</p>')
        return
      }

      // A real shop's checkout knows the transaction id from its own session.
      // Here there is none, so we take the most recent transaction - this is a
      // STAND IN for checkout logic, not part of the adapter. What is being
      // measured is the `confirm-order` path, not the way the transaction is picked.
      const idFromUrl = url.searchParams.get('t')
      let transactionID: unknown = idFromUrl ? Number(idFromUrl) : undefined

      if (!transactionID) {
        const latest = await payload.find({
          collection: 'transactions',
          depth: 0,
          limit: 1,
          sort: '-createdAt',
        })
        transactionID = (latest.docs[0] as any)?.id
      }

      console.log(`${stamp} RETURN: calling confirm-order for transaction ${String(transactionID)}`)

      const resp = await fetch(`http://127.0.0.1:${PORT}${apiPrefix}/payments/tpay/confirm-order`, {
        body: JSON.stringify({ customerEmail: 'buyer@example.invalid', transactionID }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const text = await resp.text()
      console.log(`${stamp} RETURN: confirm-order -> HTTP ${resp.status} ${text}`)

      nodeRes.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      nodeRes.end(
        `<!doctype html><meta charset="utf-8"><title>Return from Tpay</title>` +
          `<p>confirm-order: HTTP ${resp.status}</p><pre>${text.replace(/</g, '&lt;')}</pre>`,
      )
      return
    }

    if (!url.pathname.startsWith(apiPrefix)) {
      nodeRes.writeHead(404, { 'Content-Type': 'text/plain' })
      nodeRes.end('not this server')
      return
    }

    const route = url.pathname.slice(apiPrefix.length) || '/'
    const endpoint = findEndpoint(nodeReq.method || 'GET', route)

    if (!endpoint) {
      console.log(`${stamp} 404 ${nodeReq.method} ${route}`)
      nodeRes.writeHead(404, { 'Content-Type': 'text/plain' })
      nodeRes.end('no such endpoint')
      return
    }

    const body = ['GET', 'HEAD'].includes(nodeReq.method || 'GET')
      ? undefined
      : await readBody(nodeReq)

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

    console.log(`${stamp} ${nodeReq.method} ${route} (body ${body?.length ?? 0} B)`)
    if (route.includes('notifications') && body?.length) {
      console.log(`${stamp} NOTIFICATION BODY: ${body.toString('utf8')}`)
      console.log(`${stamp} X-JWS-Signature: ${headers.get('x-jws-signature') || '(none)'}`)
    }

    const payloadReq = await createPayloadRequest({ config: sanitized, request })
    const response = await endpoint.handler(payloadReq)

    const text = await response.text()
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((v, k) => (responseHeaders[k] = v))

    console.log(`${stamp} -> ${response.status} ${text.slice(0, 300)}`)
    nodeRes.writeHead(response.status, responseHeaders)
    nodeRes.end(text)
  } catch (error) {
    console.error(`${stamp} EXCEPTION`, error)
    nodeRes.writeHead(500, { 'Content-Type': 'text/plain' })
    nodeRes.end('server error')
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Development host listening on http://127.0.0.1:${PORT}${apiPrefix}`)
  console.log('Endpoints:', (sanitized.endpoints ?? []).map((e: any) => `${e.method} ${e.path}`).join(', '))
})
