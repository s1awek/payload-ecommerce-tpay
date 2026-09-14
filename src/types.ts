import type { PaymentAdapterArgs, PaymentAdapterClientArgs } from '@payloadcms/plugin-ecommerce/types'

import type { TpayPayer } from './client.js'

export type TpayAdapterArgs = {
  /**
   * Slug of the carts collection, used to read the cart's `purchasedAt` flag
   * before a payment is started. The plugin passes its own slug to
   * `confirmOrder` but not to `initiatePayment`, so a shop that renamed the
   * collection has to name it here. Defaults to `'carts'`.
   */
  cartsSlug?: string
  /**
   * OAuth client identifier from the Tpay panel (Integration > API).
   * Defaults to `process.env.TPAY_CLIENT_ID`.
   */
  clientId?: string
  /** OAuth secret. Defaults to `process.env.TPAY_CLIENT_SECRET`. */
  clientSecret?: string
  /**
   * Language of the Tpay payment page ('pl', 'en', ...). Defaults to 'pl'.
   */
  lang?: string
  /**
   * Merchant identifier - the number from the panel. It goes into the
   * notification checksum. Defaults to `process.env.TPAY_MERCHANT_ID`.
   */
  merchantId?: number | string
  /**
   * Absolute URL that Tpay will send status change notifications to.
   * Usually `https://your-shop.example.com/api/payments/tpay/notifications`.
   * Built by default from `process.env.NEXT_PUBLIC_SERVER_URL` or
   * `process.env.PAYLOAD_PUBLIC_SERVER_URL`.
   */
  notificationUrl?: string
  /** Return URL after a failed payment. */
  payerErrorUrl?: string
  /** Return URL after a successful payment. */
  payerSuccessUrl?: string
  /**
   * Forces the sandbox. Defaults to `process.env.TPAY_SANDBOX === 'true'`.
   */
  sandbox?: boolean
  /**
   * Notification security code from the Tpay panel. Without it notifications
   * are rejected, because there is nothing to confirm their authenticity with.
   * Defaults to `process.env.TPAY_SECURITY_CODE`.
   */
  securityCode?: string
  /**
   * Ceiling on a single request to the Tpay API, in milliseconds. Defaults to
   * 15000; `0` turns it off. A provider that accepts the connection and then
   * stops answering would otherwise hold a checkout request open for as long as
   * the host allows. The certificate fetch used by JWS verification has its own,
   * shorter ceiling, because it runs while a notification waits for an answer.
   */
  timeoutMs?: number
  /**
   * Verification of the JWS signature (X-JWS-Signature header) alongside the
   * md5 checksum. Defaults to `true`; `false` turns it off explicitly. Requires
   * an outgoing connection to fetch the Tpay certificate. The md5 checksum
   * covers neither `tr_status` nor `tr_paid`, so without JWS a single genuine
   * notification body can be reworked into "paid" without knowing the security
   * code.
   */
  verifyJws?: boolean
  /**
   * Tpay root certificate in PEM, used to check the chain when `verifyJws` is
   * on. Without it only the signature itself and the certificate validity
   * window are checked.
   */
  jwsRootCertificate?: string
} & PaymentAdapterArgs

export type TpayAdapterClientArgs = PaymentAdapterClientArgs

export type { TpayPayer }
