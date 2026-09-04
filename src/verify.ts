import { createHash, timingSafeEqual, X509Certificate, createVerify } from 'node:crypto'

import { normalizeAmountString } from './amount.js'

/**
 * Weryfikacja autentycznosci powiadomienia Tpay.
 *
 * Powiadomienie przychodzi jako POST z formularzem (application/x-www-form-urlencoded)
 * na adres podany przy tworzeniu transakcji. Kazdy moze pod ten adres strzelic,
 * wiec bez weryfikacji zamowienie da sie oplacic slowem honoru.
 *
 * Sa dwie niezalezne warstwy:
 *  1. Suma md5 z kodu bezpieczenstwa - obowiazkowa, liczona lokalnie.
 *  2. Podpis JWS w naglowku X-JWS-Signature - opcjonalna, wymaga pobrania
 *     certyfikatu Tpay. Wlaczana `verifyJws: true`.
 */

export type TpayNotification = {
  [key: string]: string | undefined
  id?: string
  md5sum?: string
  test_mode?: string
  tr_amount?: string
  tr_crc?: string
  tr_date?: string
  tr_desc?: string
  tr_email?: string
  tr_error?: string
  tr_id?: string
  tr_paid?: string
  tr_status?: string
}

/**
 * Suma kontrolna wg dokumentacji Tpay: md5(merchantId + tr_id + kwota + tr_crc + kod).
 * Kwota musi byc sformatowana do dwoch miejsc po kropce - identycznie jak robi to
 * oficjalne SDK (`number_format($amount, 2, '.', '')`).
 */
export function notificationChecksum(
  notification: TpayNotification,
  args: { merchantId: number | string; securityCode: string },
): string {
  const { merchantId, securityCode } = args
  const amount = normalizeAmountString(String(notification.tr_amount ?? '0'))

  return createHash('md5')
    .update(
      `${String(merchantId)}${String(notification.tr_id ?? '')}${amount}${String(
        notification.tr_crc ?? '',
      )}${securityCode}`,
      'utf8',
    )
    .digest('hex')
}

/**
 * Porownanie sum kontrolnych w czasie stalym. Zwykle `===` na napisach konczy sie
 * na pierwszym roznym znaku, co przy zdalnym probowaniu wycieka polozenie roznicy.
 */
export function isChecksumValid(
  notification: TpayNotification,
  args: { merchantId: number | string; securityCode: string },
): boolean {
  const expected = notificationChecksum(notification, args)
  const received = String(notification.md5sum ?? '').toLowerCase()

  if (received.length !== expected.length) {
    return false
  }

  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(received, 'utf8'))
}

/** Parsuje cialo powiadomienia (application/x-www-form-urlencoded) na obiekt. */
export function parseNotificationBody(body: string): TpayNotification {
  const params = new URLSearchParams(body)
  const out: TpayNotification = {}

  for (const [key, value] of params.entries()) {
    out[key] = value
  }

  return out
}

/**
 * Hosty, z ktorych wolno pobrac certyfikat wskazany w naglowku `x5u` podpisu.
 *
 * To nie jest ozdoba: `x5u` przychodzi od strony, ktora wlasnie weryfikujemy.
 * Bez tej listy napastnik podaje adres wlasnego certyfikatu, podpisuje nim
 * dowolne powiadomienie i przechodzi weryfikacje, a serwer przy okazji wykonuje
 * zadanie HTTP pod adres wskazany przez napastnika.
 */
export const TPAY_JWS_PRODUCTION_HOST = 'secure.tpay.com'
export const TPAY_JWS_SANDBOX_HOST = 'secure.sandbox.tpay.com'

export const DEFAULT_ALLOWED_X5U_HOSTS = [TPAY_JWS_PRODUCTION_HOST] as const

/**
 * Certyfikat podpisujacy sandboksu jest wystawiany pod innym hostem niz produkcyjny,
 * a lista jest rozlaczna celowo: powiadomienie podpisane certyfikatem sandboksu
 * nie ma prawa przejsc na produkcji.
 */
export function allowedX5uHostsFor(sandbox: boolean): readonly string[] {
  return sandbox ? [TPAY_JWS_SANDBOX_HOST] : [TPAY_JWS_PRODUCTION_HOST]
}

/** Adres certyfikatu glownego Tpay, do sprawdzenia lancucha podpisu. */
export function jwsRootCertificateUrl(sandbox: boolean): string {
  return `https://${sandbox ? TPAY_JWS_SANDBOX_HOST : TPAY_JWS_PRODUCTION_HOST}/x509/tpay-jws-root.pem`
}

type JwsVerifyArgs = {
  allowedX5uHosts?: readonly string[]
  /** Zrodlo certyfikatow, wstrzykiwalne w testach. */
  fetchCertificate?: (url: string) => Promise<string>
  header: string
  rawBody: string
  /** Certyfikat glowny (PEM) do sprawdzenia lancucha. Bez niego lancuch nie jest sprawdzany. */
  rootCertificate?: string
}

export type JwsVerifyResult = {
  ok: boolean
  reason?: string
}

const certificateCache = new Map<string, { fetchedAt: number; pem: string }>()
const CERT_CACHE_TTL_MS = 60 * 60 * 1000

async function defaultFetchCertificate(url: string): Promise<string> {
  const cached = certificateCache.get(url)

  if (cached && Date.now() - cached.fetchedAt < CERT_CACHE_TTL_MS) {
    return cached.pem
  }

  const response = await fetch(url)

  if (!response.ok) {
    throw new Error(`Certificate fetch failed with HTTP ${response.status}`)
  }

  const pem = await response.text()
  certificateCache.set(url, { fetchedAt: Date.now(), pem })

  return pem
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/**
 * Weryfikuje odlaczony podpis JWS (naglowek `X-JWS-Signature`) nad surowym cialem zadania.
 *
 * Naglowek ma postac `<protected>..<signature>` - czesc srodkowa jest pusta,
 * bo ladunkiem jest samo cialo zadania, ktore nie jest powtarzane w podpisie.
 */
export async function verifyJwsSignature(args: JwsVerifyArgs): Promise<JwsVerifyResult> {
  const {
    allowedX5uHosts = DEFAULT_ALLOWED_X5U_HOSTS,
    fetchCertificate = defaultFetchCertificate,
    header,
    rawBody,
    rootCertificate,
  } = args

  const parts = String(header || '').split('.')

  if (parts.length !== 3 || !parts[0] || !parts[2]) {
    return { ok: false, reason: 'Malformed JWS header: expected <protected>..<signature>' }
  }

  const [protectedB64, payloadB64, signatureB64] = parts as [string, string, string]

  if (payloadB64 !== '') {
    return { ok: false, reason: 'Expected a detached payload (empty middle segment)' }
  }

  let protectedHeader: { alg?: string; x5u?: string }

  try {
    protectedHeader = JSON.parse(base64UrlDecode(protectedB64).toString('utf8'))
  } catch {
    return { ok: false, reason: 'Protected header is not valid JSON' }
  }

  if (protectedHeader.alg !== 'RS256') {
    return { ok: false, reason: `Unsupported JWS algorithm: ${String(protectedHeader.alg)}` }
  }

  const x5u = String(protectedHeader.x5u || '')
  let certUrl: URL

  try {
    certUrl = new URL(x5u)
  } catch {
    return { ok: false, reason: 'Missing or malformed x5u in the protected header' }
  }

  if (certUrl.protocol !== 'https:' || !allowedX5uHosts.includes(certUrl.hostname)) {
    return { ok: false, reason: `Certificate URL not allowed: ${certUrl.href}` }
  }

  let leafPem: string

  try {
    leafPem = await fetchCertificate(certUrl.href)
  } catch (error) {
    return {
      ok: false,
      reason: `Could not fetch the signing certificate: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }

  let leaf: X509Certificate

  try {
    leaf = new X509Certificate(leafPem)
  } catch {
    return { ok: false, reason: 'Signing certificate could not be parsed' }
  }

  const now = Date.now()

  if (Date.parse(leaf.validFrom) > now || Date.parse(leaf.validTo) < now) {
    return { ok: false, reason: 'Signing certificate is outside its validity window' }
  }

  if (rootCertificate) {
    let root: X509Certificate

    try {
      root = new X509Certificate(rootCertificate)
    } catch {
      return { ok: false, reason: 'Root certificate could not be parsed' }
    }

    if (!leaf.checkIssued(root) || !leaf.verify(root.publicKey)) {
      return { ok: false, reason: 'Signing certificate was not issued by the configured root' }
    }
  }

  const signingInput = `${protectedB64}.${Buffer.from(rawBody, 'utf8').toString('base64url')}`
  const verifier = createVerify('RSA-SHA256')
  verifier.update(signingInput, 'utf8')
  verifier.end()

  const valid = verifier.verify(leaf.publicKey, base64UrlDecode(signatureB64))

  return valid ? { ok: true } : { ok: false, reason: 'Signature does not match the request body' }
}
