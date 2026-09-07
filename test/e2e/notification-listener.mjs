/**
 * Nasluch przechwytujacy PRAWDZIWE powiadomienie od Tpay.
 *
 * Zapisuje surowe cialo i naglowki do `test/e2e/captures/`, zeby dalo sie je pozniej
 * odtworzyc offline i sprawdzic nasza weryfikacje sumy kontrolnej oraz podpisu JWS.
 * Odpowiada `TRUE`, bo tego oczekuje Tpay - inaczej ponawia powiadomienie.
 */
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, 'captures')
const logFile = join(outDir, 'listener.log')
mkdirSync(outDir, { recursive: true })

const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}\n`
  process.stdout.write(line)
  appendFileSync(logFile, line)
}

let n = 0
const started = Date.now()

createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    if (req.method !== 'POST') {
      log(`heartbeat ${req.method} ${req.url} (${Math.round((Date.now() - started) / 1000)} s pracy, przechwycono ${n})`)
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end('listener alive')
    }
    n += 1
    const body = Buffer.concat(chunks)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(join(outDir, `notification-${stamp}.body.txt`), body)
    writeFileSync(
      join(outDir, `notification-${stamp}.headers.json`),
      JSON.stringify(req.headers, null, 2),
    )
    log(`PRZECHWYCONO #${n}: ${body.length} bajtow, naglowkow ${Object.keys(req.headers).length}, plik notification-${stamp}`)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('TRUE')
  })
}).listen(8099, '127.0.0.1', () => log('nasluch na 127.0.0.1:8099, zapis do test/e2e/captures/'))
