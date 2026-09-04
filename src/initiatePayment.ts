import type { PayloadRequest } from 'payload'

import { minorToDecimalString } from './amount.js'
import { TpayClient, type TpayPayer, type TpayTransactionRequest } from './client.js'
import type { TpayAdapterArgs } from './types.js'

type AnyDoc = Record<string, any>

/**
 * Tpay rozlicza w walutach dwucyfrowych (PLN, EUR, USD, GBP), a wtyczka
 * e-commerce trzyma kwoty w jednostkach podrzednych. Stala jest tu jawna,
 * zeby przy dokladaniu waluty o innej liczbie miejsc bylo widac, gdzie zajrzec.
 */
const CURRENCY_DECIMALS = 2

export const buildPayer = (args: {
  billingAddress?: AnyDoc
  customerEmail: string
}): TpayPayer => {
  const { billingAddress, customerEmail } = args
  const address = billingAddress || {}

  const personName = [address.firstName, address.lastName].filter(Boolean).join(' ').trim()
  const name = personName || String(address.company || '').trim() || customerEmail

  return {
    ...(address.addressLine1 ? { address: String(address.addressLine1) } : {}),
    ...(address.city ? { city: String(address.city) } : {}),
    ...(address.postalCode ? { code: String(address.postalCode) } : {}),
    ...(address.country ? { country: String(address.country).toUpperCase() } : {}),
    email: customerEmail,
    name,
    ...(address.phone ? { phone: String(address.phone) } : {}),
  }
}

/** Splaszcza pozycje koszyka do postaci zapisywanej na transakcji i zamowieniu. */
export const flattenCartItems = (items: AnyDoc[]): AnyDoc[] =>
  items.map((item) => {
    const productID = typeof item.product === 'object' ? item.product?.id : item.product
    const variantID = item.variant
      ? typeof item.variant === 'object'
        ? item.variant?.id
        : item.variant
      : undefined

    const { product: _product, variant: _variant, ...customProperties } = item

    return {
      ...customProperties,
      product: productID,
      quantity: item.quantity,
      ...(variantID ? { variant: variantID } : {}),
    }
  })

export const initiatePayment =
  (props: TpayAdapterArgs & { client: TpayClient }) =>
  async ({
    data,
    req,
    transactionsSlug,
  }: {
    customersSlug?: string
    data: {
      billingAddress: any
      cart: any
      currency: string
      customerEmail: string
      shippingAddress?: any
    }
    req: PayloadRequest
    transactionsSlug: string
  }) => {
    const payload = req.payload
    const { client, lang, notificationUrl, payerErrorUrl, payerSuccessUrl } = props

    const { billingAddress, cart, currency, customerEmail, shippingAddress } = data
    const amount = cart?.subtotal

    if (!currency) {
      throw new Error('Currency is required.')
    }

    if (!cart || !cart.items || cart.items.length === 0) {
      throw new Error('Cart is empty or not provided.')
    }

    if (!customerEmail || typeof customerEmail !== 'string') {
      throw new Error('A valid customer email is required to make a purchase.')
    }

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      throw new Error('A valid amount is required to initiate a payment.')
    }

    if (!notificationUrl) {
      throw new Error(
        'A notification URL is required. Set `notificationUrl` on the adapter or NEXT_PUBLIC_SERVER_URL in the environment.',
      )
    }

    const items = flattenCartItems(cart.items)

    // Dokument transakcji powstaje PRZED zadaniem do Tpay, zeby powiadomienie
    // mialo w co trafic nawet wtedy, gdy zapis identyfikatora Tpay sie nie uda.
    // Jego identyfikator jedzie do Tpay jako `hiddenDescription` i wraca
    // w powiadomieniu jako `tr_crc`.
    const transaction = (await payload.create({
      collection: transactionsSlug,
      data: {
        ...(req.user ? { customer: req.user.id } : { customerEmail }),
        amount,
        billingAddress,
        cart: cart.id,
        currency: String(currency).toUpperCase(),
        items,
        paymentMethod: 'tpay',
        status: 'pending',
        tpay: {
          ...(shippingAddress ? { shippingAddress } : {}),
        },
      },
      req,
    })) as AnyDoc

    try {
      const request: TpayTransactionRequest = {
        amount: Number(minorToDecimalString(amount, CURRENCY_DECIMALS)),
        callbacks: {
          notification: { url: notificationUrl },
          ...(payerSuccessUrl || payerErrorUrl
            ? {
                payerUrls: {
                  ...(payerErrorUrl ? { error: payerErrorUrl } : {}),
                  ...(payerSuccessUrl ? { success: payerSuccessUrl } : {}),
                },
              }
            : {}),
        },
        currency: String(currency).toUpperCase(),
        description: `Order ${String(cart.id)}`,
        hiddenDescription: String(transaction.id),
        lang: lang || 'pl',
        payer: buildPayer({ billingAddress, customerEmail }),
      }

      const tpayTransaction = await client.createTransaction(request)

      if (!tpayTransaction?.transactionId) {
        throw new Error('Tpay did not return a transaction ID.')
      }

      await payload.update({
        id: transaction.id,
        collection: transactionsSlug,
        data: {
          tpay: {
            ...(shippingAddress ? { shippingAddress } : {}),
            paymentUrl: tpayTransaction.transactionPaymentUrl,
            title: tpayTransaction.title,
            transactionId: tpayTransaction.transactionId,
          },
        },
        req,
      })

      return {
        message: 'Payment initiated successfully',
        paymentUrl: tpayTransaction.transactionPaymentUrl,
        title: tpayTransaction.title,
        tpayTransactionID: tpayTransaction.transactionId,
        transactionID: transaction.id,
      }
    } catch (error) {
      // Transakcja bez odpowiednika w Tpay nigdy nie zostanie oplacona.
      // Zostawienie jej w stanie `pending` zasmiecaloby panel pozycjami,
      // ktore czekaja na powiadomienie, ktore nie ma prawa przyjsc.
      try {
        await payload.update({
          id: transaction.id,
          collection: transactionsSlug,
          data: { status: 'failed' },
          req,
        })
      } catch (updateError) {
        payload.logger.error({
          err: updateError,
          msg: `Tpay: could not mark transaction ${String(transaction.id)} as failed`,
        })
      }

      payload.logger.error({ err: error, msg: 'Error initiating payment with Tpay' })

      throw new Error(
        error instanceof Error ? error.message : 'Unknown error initiating payment with Tpay',
      )
    }
  }
