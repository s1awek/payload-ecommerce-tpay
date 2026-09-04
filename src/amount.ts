/**
 * Konwersje kwot miedzy Payloadem a Tpay.
 *
 * Payload trzyma kwoty w jednostkach podrzednych (grosze) jako liczbe calkowita.
 * Tpay przyjmuje i odsyla kwoty dziesietne ("10.99"), a suma kontrolna md5
 * powiadomienia liczona jest na napisie sformatowanym do dwoch miejsc.
 *
 * Wszystkie konwersje ida na liczbach calkowitych i napisach - nigdy przez
 * float. Podzielenie 1999 przez 100 w arytmetyce zmiennoprzecinkowej daje
 * wartosc, ktora po zaokragleniu bywa inna niz "19.99", a rozjazd o jeden grosz
 * wywraca sume kontrolna i platnosc jest odrzucana bez czytelnego powodu.
 */

const DECIMAL_RE = /^-?\d+(\.\d+)?$/

/**
 * Jednostki podrzedne (grosze) na napis dziesietny: 1999 -> "19.99".
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
 * Napis dziesietny na jednostki podrzedne: "19.99" -> 1999.
 * Czesc ulamkowa dluzsza niz `decimals` jest bledem, nie zaokragleniem -
 * cicho ucieta koncowka to zgubione pieniadze.
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
 * Doprowadza napis kwoty do postaci, na ktorej Tpay liczy sume kontrolna:
 * dokladnie `decimals` miejsc po kropce, bez separatora tysiecy.
 * "10.9" -> "10.90", "10" -> "10.00".
 */
export function normalizeAmountString(value: string, decimals = 2): string {
  return minorToDecimalString(decimalStringToMinor(value, decimals), decimals)
}
