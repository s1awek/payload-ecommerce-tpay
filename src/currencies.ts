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
