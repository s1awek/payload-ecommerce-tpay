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
 * Tpay payment adapter for @payloadcms/plugin-ecommerce.
 *
 * Tpay is a redirect method: the shop creates a transaction, sends the payer to
 * the Tpay page, and the result comes back by two independent routes - a
 * server-to-server notification and the return of the browser. Both paths close
 * the order through the same race-resistant code (`finalizeOrder`).
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

  const client = new TpayClient({
    clientId,
    clientSecret,
    sandbox,
    ...(props.timeoutMs === undefined ? {} : { timeoutMs: props.timeoutMs }),
  })

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
    {
      name: 'stockClaimedAt',
      type: 'date',
      admin: { readOnly: true },
      // The plugin's `confirm-order` handler decrements inventory whenever the
      // adapter's answer carries `transactionID`, and it does so on every call.
      // This field is the adapter's claim on that trigger: the first
      // confirmation to write it is the only one that gets `transactionID`
      // back. See `claimStockTrigger` in `src/confirmOrder.ts`.
      label: 'Stock decrement trigger handed out at',
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
    // The plugin's `ConfirmOrderReturnType` declares `transactionID` required,
    // but that key is what makes its handler decrement inventory, so an answer
    // that must not decrement anything a second time has to omit it (W2-1).
    // The handler itself reads the field as `if (paymentResponse.transactionID)`,
    // so an absent key is a case it already handles. The cast sits here, once,
    // with the reason next to it.
    confirmOrder: confirmOrder(resolved) as PaymentAdapter['confirmOrder'],
    // The BLIK endpoints stand ALONGSIDE the plugin's endpoints, not instead
    // of them, and deliberately do not go through its `confirm-order`: that one
    // decrements stock on every call, while BLIK 0 requires polling the state
    // in a loop.
    endpoints: [notificationsEndpoint(resolved), blikEndpoint(resolved), blikStatusEndpoint(resolved)],
    group: groupField,
    initiatePayment: initiatePayment(resolved),
    label,
  }
}

/** Browser-side counterpart of the adapter. */
export const tpayAdapterClient = (props: TpayAdapterClientArgs = {}): PaymentAdapterClient => ({
  name: TPAY_PAYMENT_METHOD,
  confirmOrder: true,
  initiatePayment: true,
  label: props.label || 'BLIK, bank transfer, card (Tpay)',
})

export {
  apiAmountToMinor,
  decimalStringToMinor,
  minorToDecimalString,
  normalizeAmountString,
} from './amount.js'
export { assertRemoteMatchesTransaction, RemoteMismatchError } from './remote.js'
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
export {
  isSupportedCurrency,
  minorUnitDecimals,
  PLN,
  TPAY_CURRENCY_DECIMALS,
} from './currencies.js'
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
