import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, describe, it } from 'node:test'

import { verifyJwsSignature } from '../dist/verify.js'

/**
 * We generate certificates for the test here, instead of keeping them in the repo:
 * a private key in the repository sets off secret scanners, and sooner or later
 * someone will mistake it for a real one.
 */
const openssl = (args, cwd) => {
  const result = spawnSync('openssl', args, { cwd, encoding: 'utf8' })

  if (result.status !== 0) {
    throw new Error(
      `openssl ${args.join(' ')} failed: ${result.stderr || result.stdout || 'no output'}`,
    )
  }

  return result
}

let dir
let rootPem
let leafPem
let leafKey
let roguePem
let rogueKey

before(() => {
  const probe = spawnSync('openssl', ['version'], { encoding: 'utf8' })

  // Skipping the signature test would be worse than not having it: the suite
  // would shine green without having measured the layer that protects the money.
  assert.equal(probe.status, 0, 'test requires the `openssl` command to be available')

  dir = mkdtempSync(join(tmpdir(), 'tpay-jws-'))

  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.pem', '-days', '3650', '-subj', '/CN=Test Root CA'], dir)
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=notifications.example'], dir)
  openssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '3650'], dir)
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'rogue.key', '-out', 'rogue.pem', '-days', '3650', '-subj', '/CN=rogue.example'], dir)

  rootPem = readFileSync(join(dir, 'root.pem'), 'utf8')
  leafPem = readFileSync(join(dir, 'leaf.pem'), 'utf8')
  leafKey = readFileSync(join(dir, 'leaf.key'), 'utf8')
  roguePem = readFileSync(join(dir, 'rogue.pem'), 'utf8')
  rogueKey = readFileSync(join(dir, 'rogue.key'), 'utf8')
})

const sign = (body, key, x5u) => {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', x5u }), 'utf8').toString('base64url')
  const payload = Buffer.from(body, 'utf8').toString('base64url')
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`, 'utf8')
  signer.end()

  return `${header}..${signer.sign(key).toString('base64url')}`
}

const BODY = 'id=123456&tr_id=TR-ABC&tr_amount=19.99&tr_status=TRUE'
const X5U = 'https://secure.tpay.com/x509/notifications-jws.pem'

const certs = (pem) => async () => pem

describe('JWS signature of the notification', () => {
  it('known-good: signature over this body, certificate from the right host, chain to the root', async () => {
    const result = await verifyJwsSignature({
      fetchCertificate: certs(leafPem),
      header: sign(BODY, leafKey, X5U),
      rawBody: BODY,
      rootCertificate: rootPem,
    })

    assert.deepEqual(result, { ok: true })
  })

  it('known-bad: body swapped after signing', async () => {
    const header = sign(BODY, leafKey, X5U)
    const result = await verifyJwsSignature({
      fetchCertificate: certs(leafPem),
      header,
      rawBody: BODY.replace('19.99', '1.00'),
      rootCertificate: rootPem,
    })

    assert.equal(result.ok, false)
    assert.match(String(result.reason), /does not match/)
  })

  it('known-bad: a certificate from outside the allowed host is not even fetched', async () => {
    let fetched = false

    const result = await verifyJwsSignature({
      fetchCertificate: async () => {
        fetched = true

        return roguePem
      },
      header: sign(BODY, rogueKey, 'https://attacker.example/my-certificate.pem'),
      rawBody: BODY,
      rootCertificate: rootPem,
    })

    assert.equal(result.ok, false)
    assert.match(String(result.reason), /not allowed/)
    assert.equal(fetched, false, 'an address outside the list must not trigger an outgoing request')
  })

  it('known-bad: certificate from the right host, but outside the Tpay chain', async () => {
    const result = await verifyJwsSignature({
      fetchCertificate: certs(roguePem),
      header: sign(BODY, rogueKey, X5U),
      rawBody: BODY,
      rootCertificate: rootPem,
    })

    assert.equal(result.ok, false)
    assert.match(String(result.reason), /not issued by the configured root/)
  })

  it('known-bad: header without a signature, with an attached payload, or with a different algorithm', async () => {
    const malformed = await verifyJwsSignature({
      fetchCertificate: certs(leafPem),
      header: 'not-a-jws',
      rawBody: BODY,
    })
    assert.equal(malformed.ok, false)

    const withPayload = await verifyJwsSignature({
      fetchCertificate: certs(leafPem),
      header: sign(BODY, leafKey, X5U).replace('..', `.${Buffer.from(BODY).toString('base64url')}.`),
      rawBody: BODY,
    })
    assert.equal(withPayload.ok, false)
    assert.match(String(withPayload.reason), /detached payload/)

    const noneAlg = Buffer.from(JSON.stringify({ alg: 'none', x5u: X5U })).toString('base64url')
    const downgraded = await verifyJwsSignature({
      fetchCertificate: certs(leafPem),
      header: `${noneAlg}..cG9kcGlz`,
      rawBody: BODY,
    })
    assert.equal(downgraded.ok, false)
    assert.match(String(downgraded.reason), /Unsupported JWS algorithm/)
  })

  it("without a given root only the signature itself is checked - and it still rejects someone else's key", async () => {
    const ok = await verifyJwsSignature({
      fetchCertificate: certs(leafPem),
      header: sign(BODY, leafKey, X5U),
      rawBody: BODY,
    })
    assert.equal(ok.ok, true)

    const mismatched = await verifyJwsSignature({
      fetchCertificate: certs(leafPem),
      header: sign(BODY, rogueKey, X5U),
      rawBody: BODY,
    })
    assert.equal(mismatched.ok, false)
  })
})
