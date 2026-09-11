import type { PaymentAdapterArgs, PaymentAdapterClientArgs } from '@payloadcms/plugin-ecommerce/types'

import type { TpayPayer } from './client.js'

export type TpayAdapterArgs = {
  /**
   * Identyfikator klienta OAuth z panelu Tpay (Integracja > API).
   * Domyslnie `process.env.TPAY_CLIENT_ID`.
   */
  clientId?: string
  /** Sekret OAuth. Domyslnie `process.env.TPAY_CLIENT_SECRET`. */
  clientSecret?: string
  /**
   * Jezyk strony platnosci Tpay ('pl', 'en', ...). Domyslnie 'pl'.
   */
  lang?: string
  /**
   * Identyfikator sprzedawcy - liczba z panelu. Wchodzi do sumy kontrolnej
   * powiadomienia. Domyslnie `process.env.TPAY_MERCHANT_ID`.
   */
  merchantId?: number | string
  /**
   * Bezwzgledny adres, pod ktory Tpay wysle powiadomienie o zmianie statusu.
   * Zwykle `https://twoj-sklep.pl/api/payments/tpay/notifications`.
   * Domyslnie budowany z `process.env.NEXT_PUBLIC_SERVER_URL` albo
   * `process.env.PAYLOAD_PUBLIC_SERVER_URL`.
   */
  notificationUrl?: string
  /** Adres powrotu po nieudanej platnosci. */
  payerErrorUrl?: string
  /** Adres powrotu po udanej platnosci. */
  payerSuccessUrl?: string
  /**
   * Wymusza sandbox. Domyslnie `process.env.TPAY_SANDBOX === 'true'`.
   */
  sandbox?: boolean
  /**
   * Kod bezpieczenstwa powiadomien z panelu Tpay. Bez niego powiadomienia
   * sa odrzucane, bo nie ma czym potwierdzic ich autentycznosci.
   * Domyslnie `process.env.TPAY_SECURITY_CODE`.
   */
  securityCode?: string
  /**
   * Sprawdzanie podpisu JWS (naglowek X-JWS-Signature) obok sumy md5.
   * Domyslnie `true`; `false` wylacza jawnie. Wymaga polaczenia wychodzacego
   * po certyfikat Tpay. Suma md5 nie obejmuje `tr_status` ani `tr_paid`,
   * wiec bez JWS jedno prawdziwe cialo powiadomienia da sie przerobic na
   * „zaplacone" bez znajomosci kodu bezpieczenstwa.
   */
  verifyJws?: boolean
  /**
   * Certyfikat glowny Tpay w PEM, do sprawdzenia lancucha przy `verifyJws`.
   * Bez niego sprawdzany jest sam podpis i okno waznosci certyfikatu.
   */
  jwsRootCertificate?: string
} & PaymentAdapterArgs

export type TpayAdapterClientArgs = PaymentAdapterClientArgs

export type { TpayPayer }
