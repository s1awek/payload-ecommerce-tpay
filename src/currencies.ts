import type { Currency } from '@payloadcms/plugin-ecommerce/types'

/**
 * Wtyczka e-commerce Payloada dostarcza EUR, USD i GBP - zlotowki nie ma,
 * a to podstawowa waluta Tpay. Definicja jest tutaj, zeby sklep nie musial jej
 * przepisywac recznie przy kazdej instalacji.
 */
export const PLN: Currency = {
  code: 'PLN',
  decimals: 2,
  label: 'Polski złoty',
  symbol: 'zł',
}
