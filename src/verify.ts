import { createHash, timingSafeEqual, X509Certificate, createVerify } from 'node:crypto'

import { normalizeAmountString } from './amount.js'

/**
 * Verification of the authenticity of a Tpay notification.
 *
 * The notification arrives as a form POST (application/x-www-form-urlencoded)
 * to the URL given when the transaction was created. Anyone can fire at that
 * URL, so without verification an order could be paid for on one's word of
 * honour.
 *
 * There are two independent layers:
 *  1. The md5 checksum over the security code - mandatory, computed locally.
 *  2. The JWS signature in the X-JWS-Signature header - optional, requires
 *     fetching the Tpay certificate. Turned on with `verifyJws: true`.
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
 * Checksum as per the Tpay documentation: md5(merchantId + tr_id + amount + tr_crc + code).
 * The amount must be formatted to two decimal places - exactly as the official
 * SDK does it (`number_format($amount, 2, '.', '')`).
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
 * Constant-time comparison of checksums. A plain `===` on strings stops at the
 * first differing character, which under remote probing leaks the position of
 * the difference.
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

/** Parses a notification body (application/x-www-form-urlencoded) into an object. */
export function parseNotificationBody(body: string): TpayNotification {
  const params = new URLSearchParams(body)
  const out: TpayNotification = {}

  for (const [key, value] of params.entries()) {
    out[key] = value
  }

  return out
}

/**
 * Hosts the certificate named in the signature's `x5u` header may be fetched
 * from.
 *
 * This is not decoration: `x5u` comes from the very party we are verifying.
 * Without this list an attacker supplies the URL of their own certificate,
 * signs an arbitrary notification with it and passes verification, while the
 * server makes an HTTP request to a URL of the attacker's choosing along the
 * way.
 */
export const TPAY_JWS_PRODUCTION_HOST = 'secure.tpay.com'
export const TPAY_JWS_SANDBOX_HOST = 'secure.sandbox.tpay.com'

export const DEFAULT_ALLOWED_X5U_HOSTS = [TPAY_JWS_PRODUCTION_HOST] as const

/**
 * The sandbox signing certificate is issued under a different host than the
 * production one, and the lists are disjoint on purpose: a notification signed
 * with the sandbox certificate must not pass in production.
 */
export function allowedX5uHostsFor(sandbox: boolean): readonly string[] {
  return sandbox ? [TPAY_JWS_SANDBOX_HOST] : [TPAY_JWS_PRODUCTION_HOST]
}

/** URL of the Tpay root certificate, used to check the signature chain. */
export function jwsRootCertificateUrl(sandbox: boolean): string {
  return `https://${sandbox ? TPAY_JWS_SANDBOX_HOST : TPAY_JWS_PRODUCTION_HOST}/x509/tpay-jws-root.pem`
}

type JwsVerifyArgs = {
  allowedX5uHosts?: readonly string[]
  /** Certificate source, injectable in tests. */
  fetchCertificate?: (url: string) => Promise<string>
  header: string
  rawBody: string
  /** Root certificate (PEM) used to check the chain. Without it the chain is not checked. */
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
 * Verifies a detached JWS signature (the `X-JWS-Signature` header) over the raw
 * request body.
 *
 * The header has the form `<protected>..<signature>` - the middle part is empty,
 * because the payload is the request body itself, which is not repeated in the
 * signature.
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
