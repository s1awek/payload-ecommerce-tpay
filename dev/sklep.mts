/**
 * Sklep do przeklikania: ta sama zywa instancja Payloada i ten sam adapter co w
 * `serwer.mts`, plus jedna strona HTML z katalogiem, koszykiem i kasa, w ktorej
 * kupujacy wpisuje kod BLIK albo przechodzi na strone Tpay.
 *
 * Czego ten plik NIE robi: nie dotyka adaptera ani wtyczki. Wszystko, co jest
 * tutaj poza przekazywaniem zadan do `/api/*`, jest logika SKLEPU - dokladnie ta,
 * ktora README pakietu kaze napisac po stronie sklepu (zapamietanie identyfikatora
 * transakcji, jednorazowe wywolanie `confirm-order`, zdjecie stanu magazynowego po
 * BLIK-u). Dzieki temu ta strona jest zarazem wzorem integracji.
 *
 * Uruchomienie: jak `serwer.mts` (te same zmienne srodowiskowe, ten sam port), ale
 * zamiast niego. Oba sluchaja na 8099 i nie moga chodzic naraz.
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPayloadRequest, getPayload } from 'payload'
import config from './payload.config.js'

const PORT = Number(process.env.PORT || 8099)
const dirname = path.dirname(fileURLToPath(import.meta.url))

const payload = await getPayload({ config })
const sanitized = payload.config
const apiPrefix = sanitized.routes?.api || '/api'

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)

// --- zasiew: trzy produkty demo, zakladane raz -----------------------------------
const PRODUKTY_DEMO = [
  { title: 'Demo: podkładka PCB pod kubek', priceInPLN: 4900, inventory: 5 },
  { title: 'Demo: zestaw czterech podkładek', priceInPLN: 16900, inventory: 3 },
  { title: 'Demo: plakat z układem scalonym A3', priceInPLN: 8900, inventory: 8 },
]

const zasiej = async () => {
  const istniejace = await payload.find({
    collection: 'products',
    depth: 0,
    limit: 50,
    where: { title: { like: 'Demo:' } },
  })
  if (istniejace.totalDocs >= PRODUKTY_DEMO.length) return
  for (const p of PRODUKTY_DEMO) {
    if ((istniejace.docs as any[]).some((d) => d.title === p.title)) continue
    await payload.create({
      collection: 'products',
      data: { _status: 'published', enableVariants: false, priceInPLNEnabled: true, ...p } as any,
    })
    log('zasiew: produkt', p.title)
  }
}
await zasiej()

// --- pomocnicze ------------------------------------------------------------------
const czytajCialo = (req: http.IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const kawalki: Buffer[] = []
    req.on('data', (k) => kawalki.push(k))
    req.on('end', () => resolve(Buffer.concat(kawalki)))
    req.on('error', reject)
  })

const czytajJson = async (req: http.IncomingMessage): Promise<any> => {
  const b = await czytajCialo(req)
  if (!b.length) return {}
  return JSON.parse(b.toString('utf8'))
}

const json = (res: http.ServerResponse, status: number, dane: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(dane))
}

const html = (res: http.ServerResponse, plik: string) => {
  // Czytane przy kazdym zadaniu, zeby edycja strony nie wymagala restartu Payloada.
  const tresc = readFileSync(path.resolve(dirname, plik), 'utf8')
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(tresc)
}

const listaProduktow = async () => {
  const wynik = await payload.find({
    collection: 'products',
    depth: 0,
    limit: 50,
    sort: 'createdAt',
    where: { and: [{ title: { like: 'Demo:' } }, { _status: { equals: 'published' } }] },
  })
  return (wynik.docs as any[]).map((d) => ({
    cena: d.priceInPLN,
    id: d.id,
    stan: d.inventory,
    title: d.title,
  }))
}

/**
 * Stan bazy wokol jednej transakcji - panel „co sie stalo w bazie” na stronie.
 * To jest to, czego kupujacy nie widzi, a wlasciciel sklepu chce zobaczyc.
 */
const stanTransakcji = async (transactionID: number) => {
  const tx = (await payload.findByID({ collection: 'transactions', depth: 0, id: transactionID })) as any
  const zamowienie = tx.order
    ? ((await payload.findByID({ collection: 'orders', depth: 0, id: tx.order })) as any)
    : null
  const koszyk = tx.cart
    ? ((await payload.findByID({ collection: 'carts', depth: 0, id: tx.cart })) as any)
    : null
  return {
    koszyk: koszyk ? { id: koszyk.id, kupiony: Boolean(koszyk.purchasedAt) } : null,
    produkty: await listaProduktow(),
    transakcja: {
      id: tx.id,
      kwota: tx.amount,
      status: tx.status,
      tpayId: tx.tpay?.transactionId ?? null,
      waluta: tx.currency,
    },
    zamowienie: zamowienie ? { id: zamowienie.id, kwota: zamowienie.amount, status: zamowienie.status } : null,
  }
}

// Sciezka BLIK nie przechodzi przez `confirm-order`, wiec stanu magazynowego nie
// zdejmuje nikt - README kaze zrobic to sklepowi, raz, przy pierwszym `paid`.
// Pamiec „juz zdjete” jest tu w procesie; prawdziwy sklep zapisze to na zamowieniu.
const stanZdjetyDla = new Set<number>()

const zdejmijStan = async (body: any) => {
  const transactionID = Number(body.transactionID)
  if (!transactionID) return { powod: 'brak transactionID', zdjete: false }
  const tx = (await payload.findByID({ collection: 'transactions', depth: 0, id: transactionID })) as any
  if (!tx.order) return { powod: 'transakcja nie ma zamowienia, platnosc niedomknieta', zdjete: false }
  const koszyk = (await payload.findByID({ collection: 'carts', depth: 0, id: tx.cart })) as any
  if (!koszyk || koszyk.secret !== body.secret) return { powod: 'sekret koszyka nie pasuje', zdjete: false }
  if (stanZdjetyDla.has(transactionID)) return { powod: 'stan dla tej transakcji juz zdjety', zdjete: false }
  stanZdjetyDla.add(transactionID)
  for (const poz of koszyk.items ?? []) {
    const idProduktu = typeof poz.product === 'object' ? poz.product.id : poz.product
    const produkt = (await payload.findByID({ collection: 'products', depth: 0, id: idProduktu })) as any
    await payload.update({
      collection: 'products',
      data: { inventory: Math.max(0, Number(produkt.inventory ?? 0) - Number(poz.quantity ?? 1)) } as any,
      id: idProduktu,
    })
  }
  return { powod: 'zdjete po pierwszym odczycie paid', zdjete: true }
}

const utworzKoszyk = async (body: any) => {
  const pozycje = Array.isArray(body.items) ? body.items : []
  if (!pozycje.length) throw new Error('pusty koszyk')
  let suma = 0
  const items: any[] = []
  for (const p of pozycje) {
    const produkt = (await payload.findByID({ collection: 'products', depth: 0, id: p.product })) as any
    const ilosc = Math.max(1, Number(p.quantity) || 1)
    suma += Number(produkt.priceInPLN) * ilosc
    items.push({ product: produkt.id, quantity: ilosc })
  }
  const koszyk = (await payload.create({
    collection: 'carts',
    data: { currency: 'PLN', items, subtotal: suma } as any,
  })) as any
  return { id: koszyk.id, secret: koszyk.secret, subtotal: suma }
}

// --- przekazanie do endpointow wtyczki i adaptera (jak w serwer.mts) ---------------
const znajdzEndpoint = (method: string, sciezka: string) =>
  (sanitized.endpoints ?? []).find(
    (e: any) => e.method.toLowerCase() === method.toLowerCase() && e.path === sciezka,
  )

const przekazDoApi = async (nodeReq: http.IncomingMessage, nodeRes: http.ServerResponse, url: URL) => {
  const sciezka = url.pathname.slice(apiPrefix.length) || '/'
  const endpoint = znajdzEndpoint(nodeReq.method || 'GET', sciezka)
  if (!endpoint) {
    log('404', nodeReq.method, sciezka)
    nodeRes.writeHead(404, { 'Content-Type': 'text/plain' })
    nodeRes.end('brak endpointu')
    return
  }
  const cialo = ['GET', 'HEAD'].includes(nodeReq.method || 'GET') ? undefined : await czytajCialo(nodeReq)
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
  log(nodeReq.method, sciezka, `(cialo ${cialo?.length ?? 0} B)`)
  if (sciezka.includes('notifications') && cialo?.length) {
    log('CIALO POWIADOMIENIA:', cialo.toString('utf8'))
    log('X-JWS-Signature:', naglowki.get('x-jws-signature') || '(brak)')
  }
  const payloadReq = await createPayloadRequest({ config: sanitized, request })
  const odpowiedz = await endpoint.handler(payloadReq)
  const tresc = await odpowiedz.text()
  const wyjscioweNaglowki: Record<string, string> = {}
  odpowiedz.headers.forEach((v, k) => (wyjscioweNaglowki[k] = v))
  log('->', odpowiedz.status, tresc.slice(0, 300))
  nodeRes.writeHead(odpowiedz.status, wyjscioweNaglowki)
  nodeRes.end(tresc)
}

// --- serwer ----------------------------------------------------------------------
const serwer = http.createServer(async (nodeReq, nodeRes) => {
  const url = new URL(nodeReq.url || '/', `http://localhost:${PORT}`)
  const metoda = nodeReq.method || 'GET'
  try {
    if (url.pathname.startsWith(apiPrefix)) return await przekazDoApi(nodeReq, nodeRes, url)

    if (metoda === 'GET' && url.pathname === '/') return html(nodeRes, 'sklep.html')
    // Strony powrotu z Tpay - te same adresy, ktore payload.config.ts podaje adapterowi.
    if (metoda === 'GET' && (url.pathname === '/powrot' || url.pathname === '/blad')) {
      log('POWROT PRZEGLADARKI', url.pathname, url.search)
      return html(nodeRes, 'sklep.html')
    }

    if (metoda === 'GET' && url.pathname === '/sklep/konfiguracja') return json(nodeRes, 200, { adresPubliczny: (process.env.NEXT_PUBLIC_SERVER_URL || '').replace(/\/+$/, '') })
    if (metoda === 'GET' && url.pathname === '/sklep/produkty') return json(nodeRes, 200, { produkty: await listaProduktow() })
    if (metoda === 'POST' && url.pathname === '/sklep/koszyk') return json(nodeRes, 200, await utworzKoszyk(await czytajJson(nodeReq)))
    if (metoda === 'GET' && url.pathname === '/sklep/stan') {
      const t = Number(url.searchParams.get('t'))
      if (!t) return json(nodeRes, 400, { message: 'brak t' })
      return json(nodeRes, 200, await stanTransakcji(t))
    }
    if (metoda === 'POST' && url.pathname === '/sklep/zdejmij-stan') return json(nodeRes, 200, await zdejmijStan(await czytajJson(nodeReq)))

    nodeRes.writeHead(404, { 'Content-Type': 'text/plain' })
    nodeRes.end('nie ten serwer')
  } catch (blad) {
    console.error(new Date().toISOString(), 'WYJATEK', blad)
    if (!nodeRes.headersSent) json(nodeRes, 500, { message: blad instanceof Error ? blad.message : 'blad serwera' })
  }
})

serwer.listen(PORT, '127.0.0.1', () => {
  log(`Sklep demo: http://127.0.0.1:${PORT}/  (API pod ${apiPrefix})`)
  log('adres publiczny (powrot i powiadomienia):', process.env.NEXT_PUBLIC_SERVER_URL || '(BRAK - initiate odmowi)')
  log('Endpointy:', (sanitized.endpoints ?? []).map((e: any) => `${e.method} ${e.path}`).join(', '))
})
