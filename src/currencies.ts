import type { Currency } from '@payloadcms/plugin-ecommerce/types'

/**
 * Payload's ecommerce plugin ships EUR, USD and GBP - there is no zloty, and
 * that is Tpay's primary currency. The definition lives here so that a shop does
 * not have to rewrite it by hand on every installation.
 */
export const PLN: Currency = {
  code: 'PLN',
  decimals: 2,
  label: 'Polish zloty',
  symbol: 'zł',
}

/**
 * The only minor unit exponent this package works with, and the ISO 4217
 * default. Tpay settles in two decimal currencies (PLN, EUR, USD, GBP), and
 * every conversion here assumes it.
 */
export const TPAY_CURRENCY_DECIMALS = 2

/**
 * Currencies whose ISO 4217 minor unit is NOT two decimal places. Listing the
 * exceptions rather than every currency is both shorter and less likely to go
 * stale: two is the standard's default and holds for the overwhelming majority.
 *
 * Why the table exists at all. The package converts between minor units and the
 * decimal strings Tpay signs, and it used to assume two decimal places at both
 * ends of the trip. For a currency with a different exponent both ends make the
 * SAME mistake, so the amount gate compares two equally wrong numbers, finds
 * them equal and reports a match - on a shop that just charged a hundredth of
 * the price. Guessing the exponent would not fix that; refusing the currency
 * does.
 */
const MINOR_UNIT_EXCEPTIONS: Readonly<Record<string, number>> = {
  BHD: 3,
  BIF: 0,
  CLF: 4,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  IQD: 3,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  PYG: 0,
  RWF: 0,
  TND: 3,
  UGX: 0,
  UYI: 0,
  UYW: 4,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
}

/**
 * Minor unit decimal places for a currency code. Anything outside the exception
 * table is two, which is the ISO 4217 default - and if that default is ever
 * wrong for some code, the caller still refuses everything that is not two, so
 * the mistake cannot become a wrong amount.
 */
export function minorUnitDecimals(code: unknown): number {
  const normalized = String(code ?? '')
    .trim()
    .toUpperCase()

  return MINOR_UNIT_EXCEPTIONS[normalized] ?? TPAY_CURRENCY_DECIMALS
}

/** Whether this package can represent amounts in the given currency at all. */
export function isSupportedCurrency(code: unknown): boolean {
  return minorUnitDecimals(code) === TPAY_CURRENCY_DECIMALS
}
