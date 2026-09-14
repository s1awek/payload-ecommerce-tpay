/**
 * Storefront example: two calls with a redirect in between.
 */

type InitiateResponse = {
  message: string
  paymentUrl?: string
  title?: string
  tpayTransactionID?: string
  transactionID: string
}

/**
 * Step 1. Called when the customer clicks "Pay". Remember the `transactionID`
 * (sessionStorage, a parameter on the return URL, anything that survives the
 * redirect), because without it there is nothing to confirm the order with
 * after coming back. Remember the cart `secret` the same way.
 *
 * `secret` is what a guest cart is proved with. A logged in customer is
 * identified by their session and can leave it out; a guest who does gets HTTP
 * 403 from the adapter's access gate, because a transaction identifier alone is
 * a consecutive integer and proves nothing. The plugin issues the secret once,
 * when the cart is created, so keep it from there.
 */
export async function startPayment(args: {
  billingAddress: Record<string, unknown>
  cartID: string
  customerEmail: string
  /** Cart secret from the plugin. Required for a guest cart. */
  secret?: string
  serverUrl: string
  shippingAddress?: Record<string, unknown>
}): Promise<InitiateResponse> {
  const response = await fetch(`${args.serverUrl}/api/payments/tpay/initiate`, {
    body: JSON.stringify({
      billingAddress: args.billingAddress,
      cartID: args.cartID,
      customerEmail: args.customerEmail,
      ...(args.secret ? { secret: args.secret } : {}),
      shippingAddress: args.shippingAddress,
    }),
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    throw new Error(`Payment could not be initiated: HTTP ${response.status}`)
  }

  const data = (await response.json()) as InitiateResponse

  if (!data.paymentUrl) {
    throw new Error('Tpay did not return a payment URL')
  }

  sessionStorage.setItem('tpay:transactionID', data.transactionID)

  if (args.secret) {
    sessionStorage.setItem('tpay:cartSecret', args.secret)
  }

  window.location.href = data.paymentUrl

  return data
}

/**
 * Step 2. Called on the return page (`payerSuccessUrl`).
 *
 * The server-to-server notification may have closed the order already, and that
 * is normal: the response then carries the same order identifier, not a second
 * order. The error "not completed yet" means Tpay has not settled the payment
 * yet - it is then worth retrying in a few seconds instead of showing the
 * customer a failure.
 *
 * Calling this twice is safe, and the safety is on the server: the adapter hands
 * out the stock decrement trigger at most once per transaction (it claims
 * `tpay.stockClaimedAt` on the transaction document), so a reload of this page,
 * a second tab or a retry cannot take a second unit off the shelf. A guard in
 * the browser - a flag in sessionStorage, a disabled button - is still worth
 * having for the user's sake, but it is not what protects the stock.
 */
export async function confirmPayment(args: {
  cartID: string
  customerEmail: string
  /** Cart secret from the plugin. Required for a guest cart, exactly as in step 1. */
  secret?: string
  serverUrl: string
}): Promise<{ accessToken?: string; message: string; orderID: string }> {
  const transactionID = sessionStorage.getItem('tpay:transactionID')

  if (!transactionID) {
    throw new Error('No transaction to confirm')
  }

  const secret = args.secret ?? sessionStorage.getItem('tpay:cartSecret') ?? undefined

  const response = await fetch(`${args.serverUrl}/api/payments/tpay/confirm-order`, {
    body: JSON.stringify({
      cartID: args.cartID,
      customerEmail: args.customerEmail,
      ...(secret ? { secret } : {}),
      transactionID,
    }),
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error(data?.message || `Order could not be confirmed: HTTP ${response.status}`)
  }

  sessionStorage.removeItem('tpay:transactionID')
  sessionStorage.removeItem('tpay:cartSecret')

  return data
}
