/**
 * Najmniejszy serwer HTTP wystawiajacy endpointy Payloada bez Next.js.
 *
 * Payload 3 nie ma wlasnego serwera - w normalnym sklepie routing robi
 * `@payloadcms/next`. Do przebiegu e2e Next jest zbedny: potrzebny jest wylacznie
 * kanal, ktorym Tpay dosiegnie endpointu powiadomien, i ktorym przegladarka wroci
 * na `confirm-order`. `createPayloadRequest` jest publicznie eksportowany z
 * `payload`, wiec tlumaczenie zadania node:http na PayloadRequest nie wymaga
 * niczego prywatnego.
 */
import http from 'node:http'
import { createPayloadRequest, getPayload } from 'payload'
import config from './payload.config.js'

const PORT = Number(process.env.PORT || 8099)

const payload = await getPayload({ config })
const sanitized = payload.config
const apiPrefix = sanitized.routes?.api || '/api'

const znajdzEndpoint = (method: string, sciezka: string) =>
  (sanitized.endpoints ?? []).find(
    (e: any) => e.method.toLowerCase() === method.toLowerCase() && e.path === sciezka,
  )

const czytajCialo = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const kawalki: Buffer[] = []
    req.on('data', (k) => kawalki.push(k))
    req.on('end', () => resolve(Buffer.concat(kawalki)))
    req.on('error', reject)
  })

const serwer = http.createServer(async (nodeReq, nodeRes) => {
  const stempel = new Date().toISOString()
  const url = new URL(nodeReq.url || '/', `http://localhost:${PORT}`)

  try {
    // Powrot przegladarki po platnosci: sklepu tu nie ma, wiec strona zastepcza,
    // ktora sama wola confirm-order - dokladnie to, co robi kasa prawdziwego sklepu.
    if (nodeReq.method === 'GET' && (url.pathname === '/powrot' || url.pathname === '/blad')) {
      console.log(`${stempel} POWROT PRZEGLADARKI ${url.pathname} ${url.search}`)

      if (url.pathname === '/blad') {
        nodeRes.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        nodeRes.end('<!doctype html><meta charset="utf-8"><title>Platnosc nieudana</title><p>Platnosc nieudana.</p>')
        return
      }

      // Kasa prawdziwego sklepu zna identyfikator transakcji z wlasnej sesji.
      // Tutaj go nie ma, wiec bierzemy najswiezsza transakcje - to ATRAPA logiki
      // kasy, nie czesc adaptera. Mierzona jest sciezka `confirm-order`, nie sposob
      // wyboru transakcji.
      const idZUrl = url.searchParams.get('t')
      let transactionID: unknown = idZUrl ? Number(idZUrl) : undefined

      if (!transactionID) {
        const ostatnie = await payload.find({
          collection: 'transactions',
          depth: 0,
          limit: 1,
          sort: '-createdAt',
        })
        transactionID = (ostatnie.docs[0] as any)?.id
      }

      console.log(`${stempel} POWROT: wolam confirm-order dla transakcji ${String(transactionID)}`)

      const odp = await fetch(`http://127.0.0.1:${PORT}${apiPrefix}/payments/tpay/confirm-order`, {
        body: JSON.stringify({ customerEmail: 'kupujacy@example.invalid', transactionID }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const tresc = await odp.text()
      console.log(`${stempel} POWROT: confirm-order -> HTTP ${odp.status} ${tresc}`)

      nodeRes.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      nodeRes.end(
        `<!doctype html><meta charset="utf-8"><title>Powrot ze Tpay</title>` +
          `<p>confirm-order: HTTP ${odp.status}</p><pre>${tresc.replace(/</g, '&lt;')}</pre>`,
      )
      return
    }

    if (!url.pathname.startsWith(apiPrefix)) {
      nodeRes.writeHead(404, { 'Content-Type': 'text/plain' })
      nodeRes.end('nie ten serwer')
      return
    }

    const sciezka = url.pathname.slice(apiPrefix.length) || '/'
    const endpoint = znajdzEndpoint(nodeReq.method || 'GET', sciezka)

    if (!endpoint) {
      console.log(`${stempel} 404 ${nodeReq.method} ${sciezka}`)
      nodeRes.writeHead(404, { 'Content-Type': 'text/plain' })
      nodeRes.end('brak endpointu')
      return
    }

    const cialo = ['GET', 'HEAD'].includes(nodeReq.method || 'GET')
      ? undefined
      : await czytajCialo(nodeReq)

    const naglowki = new Headers()
    for (const [k, v] of Object.entries(nodeReq.headers)) {
      if (typeof v === 'string') naglowki.set(k, v)
      else if (Array.isArray(v)) naglowki.set(k, v.join(', '))
    }

    const request = new Request(`http://localhost:${PORT}${nodeReq.url}`, {
      body: cialo && cialo.length ? cialo : undefined,
      headers: naglowki,
      method: nodeReq.method,
    })

    console.log(`${stempel} ${nodeReq.method} ${sciezka} (cialo ${cialo?.length ?? 0} B)`)
    if (sciezka.includes('notifications') && cialo?.length) {
      console.log(`${stempel} CIALO POWIADOMIENIA: ${cialo.toString('utf8')}`)
      console.log(`${stempel} X-JWS-Signature: ${naglowki.get('x-jws-signature') || '(brak)'}`)
    }

    const payloadReq = await createPayloadRequest({ config: sanitized, request })
    const odpowiedz = await endpoint.handler(payloadReq)

    const tresc = await odpowiedz.text()
    const wyjscioweNaglowki: Record<string, string> = {}
    odpowiedz.headers.forEach((v, k) => (wyjscioweNaglowki[k] = v))

    console.log(`${stempel} -> ${odpowiedz.status} ${tresc.slice(0, 300)}`)
    nodeRes.writeHead(odpowiedz.status, wyjscioweNaglowki)
    nodeRes.end(tresc)
  } catch (blad) {
    console.error(`${stempel} WYJATEK`, blad)
    nodeRes.writeHead(500, { 'Content-Type': 'text/plain' })
    nodeRes.end('blad serwera')
  }
})

serwer.listen(PORT, '127.0.0.1', () => {
  console.log(`Serwer gospodarza slucha na http://127.0.0.1:${PORT}${apiPrefix}`)
  console.log('Endpointy:', (sanitized.endpoints ?? []).map((e: any) => `${e.method} ${e.path}`).join(', '))
})
