import type { PayloadRequest } from 'payload'

import { minorToDecimalString } from './amount.js'
import { TpayClient, type TpayPayer, type TpayTransactionRequest } from './client.js'
import { minorUnitDecimals, TPAY_CURRENCY_DECIMALS } from './currencies.js'
import type { TpayAdapterArgs } from './types.js'

type AnyDoc = Record<string, any>

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

/** Flattens cart items into the shape stored on the transaction and the order. */
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

/**
 * Refuses a cart that has already been paid for.
 *
 * `purchasedAt` is written by whoever closed the order (the plugin's own
 * `confirm-order` handler, `finalizeOrder` here), and a cart carrying it has
 * goods behind it that are already sold. Starting a second payment from the
 * same cart takes money for them twice, and the customer has no way of telling
 * the two checkouts apart.
 *
 * The flag has to be read from the database rather than trusted to be on the
 * object handed in: the plugin's `initiate-payment` endpoint loads the cart with
 * `select: { id, currency, customerEmail, items, subtotal }` (measured on
 * plugin-ecommerce 3.88.0), so `purchasedAt` is simply not there, and a check
 * against the passed object alone would never fire.
 *
 * A cart that cannot be read at all is not evidence of a second payment, so it
 * does not block the checkout; it leaves a warning in the log instead. The
 * plugin loaded the same cart moments earlier, so a failure here is a transient
 * one, and refusing a real payment over it would be the worse mistake.
 */
export const assertCartNotPurchased = async (args: {
  cart: AnyDoc
  cartsSlug: string
  req: PayloadRequest
}): Promise<void> => {
  const { cart, cartsSlug, req } = args

  const refuse = (purchasedAt: unknown): never => {
    throw new Error(
      `Cart ${String(cart?.id)} was already paid for (purchasedAt: ${String(purchasedAt)}). Create a new cart instead of paying for this one twice.`,
    )
  }

  if (cart?.purchasedAt) {
    refuse(cart.purchasedAt)
  }

  if (!cart?.id) {
    return
  }

  let stored: AnyDoc | undefined

  try {
    stored = (await req.payload.findByID({
      id: cart.id,
      collection: cartsSlug,
      depth: 0,
      overrideAccess: true,
      req,
      select: { purchasedAt: true },
    })) as AnyDoc | undefined
  } catch (error) {
    req.payload.logger.warn({
      err: error,
      msg: `Tpay: cart ${String(cart.id)} could not be read before starting a payment, so its purchasedAt flag was not checked`,
    })

    return
  }

  if (stored?.purchasedAt) {
    refuse(stored.purchasedAt)
  }
}

export const initiatePayment =
  (props: TpayAdapterArgs & { client: TpayClient }) =>
  async ({
    cartsSlug,
    data,
    req,
    transactionsSlug,
  }: {
    cartsSlug?: string
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
    // The plugin hands `cartsSlug` to `confirmOrder` but not here, so the
    // adapter option is what a renamed collection travels through.
    const carts = cartsSlug || props.cartsSlug || 'carts'

    const { billingAddress, cart, currency, customerEmail, shippingAddress } = data
    const amount = cart?.subtotal

    if (!currency) {
      throw new Error('Currency is required.')
    }

    const currencyCode = String(currency).toUpperCase()
    const decimals = minorUnitDecimals(currencyCode)

    // Refuse loudly instead of scaling by the wrong power of ten. The gate that
    // compares the amount coming back from Tpay uses the same table, so a
    // currency slipping through here could not be caught later either: both
    // sides would be wrong by exactly the same factor and would agree.
    if (decimals !== TPAY_CURRENCY_DECIMALS) {
      throw new Error(
        `Tpay settles in two decimal currencies only. ${currencyCode} has ${decimals} minor unit decimal places, so sending it would charge an amount wrong by a power of ten. Remove it from the plugin's supportedCurrencies.`,
      )
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

    await assertCartNotPurchased({ cart, cartsSlug: carts, req })

    const items = flattenCartItems(cart.items)

    // The transaction document is created BEFORE the request to Tpay, so that
    // the notification has something to land on even when writing the Tpay
    // identifier fails. Its identifier travels to Tpay as `hiddenDescription`
    // and comes back in the notification as `tr_crc`.
    const transaction = (await payload.create({
      collection: transactionsSlug,
      data: {
        ...(req.user ? { customer: req.user.id } : { customerEmail }),
        amount,
        billingAddress,
        cart: cart.id,
        currency: currencyCode,
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
        amount: Number(minorToDecimalString(amount, TPAY_CURRENCY_DECIMALS)),
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
        currency: currencyCode,
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
      // A transaction with no counterpart in Tpay will never be paid. Leaving
      // it in `pending` would litter the panel with entries waiting for a
      // notification that cannot arrive.
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
