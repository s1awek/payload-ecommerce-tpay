/**
 * Amount conversions between Payload and Tpay.
 *
 * Payload keeps amounts in minor units (grosze) as an integer.
 * Tpay accepts and returns decimal amounts ("10.99"), and the md5 checksum of a
 * notification is computed over a string formatted to two decimal places.
 *
 * Where the arithmetic is exact and where it is not:
 *
 * - `minorToDecimalString`, `decimalStringToMinor` and `normalizeAmountString`
 *   move the decimal point by padding and slicing digit strings. Nothing is
 *   divided or multiplied, so nothing can arrive at the checksum as
 *   19.990000000000002 - and a discrepancy of one grosz breaks the md5, after
 *   which the payment is rejected with no readable reason.
 * - `apiAmountToMinor` cannot work that way for a REST API response, which
 *   carries `amount` as a JSON number: the value is already a float by the time
 *   it reaches this package, so it is scaled by `Math.round(value * 10 **
 *   decimals)`. That is rounding, not exact arithmetic. For two decimal places
 *   it is safe across every amount a shop can charge, because the error of the
 *   product stays orders of magnitude below the half unit `Math.round` would
 *   need to land on the wrong integer; it is pinned by tests rather than left
 *   to the reader's trust.
 * - The amount sent to Tpay is a JSON number too (`Number(minorToDecimalString(...))`
 *   in `initiatePayment`) - the string is built exactly, and the float only
 *   exists because that is the shape the API takes.
 *
 * All of this assumes a minor unit of two decimal places; `src/currencies.ts`
 * is what keeps a currency with another exponent out of the package.
 */

const DECIMAL_RE = /^-?\d+(\.\d+)?$/

/**
 * Minor units (grosze) to a decimal string: 1999 -> "19.99".
 */
export function minorToDecimalString(minor: number, decimals = 2): string {
  if (!Number.isFinite(minor)) {
    throw new TypeError(`Amount must be a finite number, got: ${String(minor)}`)
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 8) {
    throw new RangeError(`Unsupported decimals: ${String(decimals)}`)
  }

  const rounded = Math.round(minor)
  const negative = rounded < 0
  const digits = Math.abs(rounded).toString().padStart(decimals + 1, '0')

  if (decimals === 0) {
    return `${negative ? '-' : ''}${digits}`
  }

  const cut = digits.length - decimals
  return `${negative ? '-' : ''}${digits.slice(0, cut)}.${digits.slice(cut)}`
}

/**
 * Decimal string to minor units: "19.99" -> 1999.
 * A fractional part longer than `decimals` is an error, not a rounding case -
 * a silently truncated tail is lost money.
 */
export function decimalStringToMinor(value: string, decimals = 2): number {
  const raw = String(value).trim()

  if (!DECIMAL_RE.test(raw)) {
    throw new TypeError(`Not a decimal amount: ${JSON.stringify(value)}`)
  }

  const negative = raw.startsWith('-')
  const [intPart = '0', fracPart = ''] = raw.replace(/^-/, '').split('.')

  if (fracPart.length > decimals) {
    throw new RangeError(`Amount ${raw} has more than ${decimals} decimal places`)
  }

  const padded = fracPart.padEnd(decimals, '0')
  const minor = Number(`${intPart}${padded}`)

  return negative ? -minor : minor
}

/**
 * Brings an amount string into the form Tpay computes its checksum on:
 * exactly `decimals` places after the dot, with no thousands separator.
 * "10.9" -> "10.90", "10" -> "10.00".
 */
export function normalizeAmountString(value: string, decimals = 2): string {
  return minorToDecimalString(decimalStringToMinor(value, decimals), decimals)
}

/**
 * Amount from a Tpay REST API response (`GET /transactions/{id}`) to minor
 * units. The API returns `amount` as a JSON number (19.99), not a string, so the
 * string arithmetic used for notifications does not reach here: rounding to the
 * minor unit of the currency is the only sensible interpretation of a
 * floating-point number with two decimal places. A string goes down the same
 * path as `tr_paid`.
 * A value that cannot be read yields `undefined` - the caller decides what
 * follows from that, and where money is involved it should be a refusal.
 */
export function apiAmountToMinor(value: unknown, decimals = 2): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return undefined
    }

    return Math.round(value * 10 ** decimals)
  }

  if (typeof value === 'string' && value.trim() !== '') {
    try {
      return decimalStringToMinor(value, decimals)
    } catch {
      return undefined
    }
  }

  return undefined
}
