import type { Field, GroupField } from 'payload'

import type { PaymentAdapter, PaymentAdapterClient } from '@payloadcms/plugin-ecommerce/types'

import { TpayClient } from './client.js'
import { confirmOrder } from './confirmOrder.js'
import { blikEndpoint, blikStatusEndpoint } from './endpoints/blik.js'
import { notificationsEndpoint } from './endpoints/notifications.js'
import { initiatePayment } from './initiatePayment.js'
import type { TpayAdapterArgs, TpayAdapterClientArgs } from './types.js'

export const TPAY_PAYMENT_METHOD = 'tpay'

const firstDefined = (...values: (string | undefined)[]): string | undefined =>
  values.find((value) => typeof value === 'string' && value.length > 0)

/**
 * Adapter platnosci Tpay dla @payloadcms/plugin-ecommerce.
 *
 * Tpay jest metoda z przekierowaniem: sklep tworzy transakcje, odsyla platnika
 * na strone Tpay, a wynik przychodzi dwiema niezaleznymi droga - powiadomieniem
 * serwer-serwer i powrotem przegladarki. Obie sciezki domykaja zamowienie przez
 * ten sam, odporny na wyscig kod (`finalizeOrder`).
 */
export const tpayAdapter = (props: TpayAdapterArgs = {}): PaymentAdapter => {
  const label = props.label || 'Tpay'
  const groupOverrides = props.groupOverrides

  const clientId = firstDefined(props.clientId, process.env.TPAY_CLIENT_ID)
  const clientSecret = firstDefined(props.clientSecret, process.env.TPAY_CLIENT_SECRET)
  const securityCode = firstDefined(props.securityCode, process.env.TPAY_SECURITY_CODE)
  const merchantId = props.merchantId ?? process.env.TPAY_MERCHANT_ID
  const sandbox = props.sandbox ?? process.env.TPAY_SANDBOX === 'true'

  const serverUrl = firstDefined(
    process.env.NEXT_PUBLIC_SERVER_URL,
    process.env.PAYLOAD_PUBLIC_SERVER_URL,
  )

  const notificationUrl = firstDefined(
    props.notificationUrl,
    serverUrl ? `${serverUrl.replace(/\/+$/, '')}/api/payments/${TPAY_PAYMENT_METHOD}/notifications` : undefined,
  )

  if (!clientId || !clientSecret) {
    throw new Error(
      'Tpay adapter requires clientId and clientSecret (or TPAY_CLIENT_ID and TPAY_CLIENT_SECRET in the environment).',
    )
  }

  const client = new TpayClient({ clientId, clientSecret, sandbox })

  const resolved: TpayAdapterArgs & { client: TpayClient } = {
    ...props,
    client,
    clientId,
    clientSecret,
    merchantId,
    ...(notificationUrl ? { notificationUrl } : {}),
    sandbox,
    ...(securityCode ? { securityCode } : {}),
  }

  const baseFields: Field[] = [
    {
      name: 'transactionId',
      type: 'text',
      admin: { readOnly: true },
      label: 'Tpay transaction ID',
    },
    {
      name: 'title',
      type: 'text',
      admin: { readOnly: true },
      label: 'Tpay transaction title',
    },
    {
      name: 'paymentUrl',
      type: 'text',
      admin: { readOnly: true },
      label: 'Tpay payment URL',
    },
    {
      name: 'shippingAddress',
      type: 'json',
      admin: { readOnly: true },
      label: 'Shipping address snapshot',
    },
  ]

  const groupField: GroupField = {
    name: TPAY_PAYMENT_METHOD,
    type: 'group',
    ...groupOverrides,
    admin: {
      condition: (data) => data?.paymentMethod === TPAY_PAYMENT_METHOD,
      ...groupOverrides?.admin,
    },
    fields:
      groupOverrides?.fields && typeof groupOverrides.fields === 'function'
        ? groupOverrides.fields({ defaultFields: baseFields })
        : baseFields,
  }

  return {
    name: TPAY_PAYMENT_METHOD,
    confirmOrder: confirmOrder(resolved),
    // Punkty BLIK-a stoja OBOK punktow wtyczki, a nie zamiast nich, i celowo
    // nie przechodza przez jej `confirm-order`: ten zdejmuje stan magazynowy
    // przy kazdym wywolaniu, a BLIK 0 wymaga odpytywania stanu w petli.
    endpoints: [notificationsEndpoint(resolved), blikEndpoint(resolved), blikStatusEndpoint(resolved)],
    group: groupField,
    initiatePayment: initiatePayment(resolved),
    label,
  }
}

/** Odpowiednik adaptera po stronie przegladarki. */
export const tpayAdapterClient = (props: TpayAdapterClientArgs = {}): PaymentAdapterClient => ({
  name: TPAY_PAYMENT_METHOD,
  confirmOrder: true,
  initiatePayment: true,
  label: props.label || 'BLIK, przelew, karta (Tpay)',
})

export { minorToDecimalString, decimalStringToMinor, normalizeAmountString } from './amount.js'
export {
  TpayApiError,
  TpayClient,
  TPAY_PRODUCTION_URL,
  TPAY_SANDBOX_URL,
  type TpayClientOptions,
  type TpayPayer,
  type TpayPayRequest,
  type TpayTransaction,
  type TpayTransactionRequest,
} from './client.js'
export {
  assertBlikToken,
  assertTransactionAccess,
  BLIK_CHANNEL_ID,
  BLIK_METHOD,
  BLIK_TOKEN_LENGTH,
  BlikError,
  normalizeBlikToken,
} from './blik.js'
export { PLN } from './currencies.js'
export { finalizeOrder, markTransactionStatus, type FinalizeResult } from './finalize.js'
export type { TpayAdapterArgs, TpayAdapterClientArgs } from './types.js'
export {
  allowedX5uHostsFor,
  isChecksumValid,
  jwsRootCertificateUrl,
  notificationChecksum,
  parseNotificationBody,
  verifyJwsSignature,
  type TpayNotification,
} from './verify.js'
