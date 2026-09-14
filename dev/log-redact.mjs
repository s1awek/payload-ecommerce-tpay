/**
 * Redaction for the request log of the development host.
 *
 * Both scripts here log what they answer, and those answers carry material that
 * has no business sitting in `dev/*.log`: `accessToken` is a guest's key to
 * somebody's order, `secret` is the key to a guest cart, `md5sum` on a
 * notification is where an offline attack on the security code starts, and
 * `access_token` is a live Tpay credential. Log files get tailed into chats and
 * pasted into tickets, so the redaction sits on the logging path rather than in
 * a rule about who may open the file.
 *
 * Plain JavaScript on purpose: the same module is imported by the TypeScript dev
 * scripts through tsx and by `test/log-redact.test.js` under plain node.
 */

/** Keys whose value never goes into the log. */
export const SENSITIVE_KEYS = [
  'accessToken',
  'access_token',
  'client_secret',
  'clientSecret',
  'md5sum',
  'secret',
  'securityCode',
]

export const REDACTED = '[redacted]'

const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Replaces the value of every sensitive key in a JSON body, a form encoded body
 * or a query string. Anything that is not a string comes back as an empty
 * string: a logger must not be the thing that throws.
 */
export const redactSecrets = (input) => {
  if (typeof input !== 'string' || input === '') {
    return typeof input === 'string' ? input : ''
  }

  let out = input

  for (const key of SENSITIVE_KEYS) {
    const name = escapeForRegExp(key)

    // JSON: "secret":"abc" and "secret": "abc"
    out = out.replace(new RegExp(`("${name}"\\s*:\\s*)"[^"]*"`, 'gi'), `$1"${REDACTED}"`)
    // JSON with a non-string value: "secret":123, "secret":null
    out = out.replace(new RegExp(`("${name}"\\s*:\\s*)(?!")[^,}\\s]+`, 'gi'), `$1"${REDACTED}"`)
    // Form encoded and query strings: secret=abc&...
    out = out.replace(new RegExp(`(^|[?&;\\s])(${name}=)[^&;\\s]*`, 'gi'), `$1$2${REDACTED}`)
  }

  return out
}

/**
 * What a notification may leave in the log: which transaction it is about, what
 * it claims happened, and whether it was signed. Never the body, because the
 * body carries `md5sum`.
 */
export const notificationSummary = (rawBody, { signed } = {}) => {
  const params = new URLSearchParams(String(rawBody ?? ''))

  return [
    `tr_id=${params.get('tr_id') || '(none)'}`,
    `tr_status=${params.get('tr_status') || '(none)'}`,
    `fields=${[...params.keys()].join(',') || '(none)'}`,
    `X-JWS-Signature=${signed ? 'present' : 'MISSING'}`,
  ].join(' ')
}
