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
 * after coming back.
 */
export async function startPayment(args: {
  billingAddress: Record<string, unknown>
  cartID: string
  customerEmail: string
  serverUrl: string
  shippingAddress?: Record<string, unknown>
}): Promise<InitiateResponse> {
  const response = await fetch(`${args.serverUrl}/api/payments/tpay/initiate`, {
    body: JSON.stringify({
      billingAddress: args.billingAddress,
      cartID: args.cartID,
      customerEmail: args.customerEmail,
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
 */
export async function confirmPayment(args: {
  cartID: string
  customerEmail: string
  serverUrl: string
}): Promise<{ accessToken?: string; message: string; orderID: string }> {
  const transactionID = sessionStorage.getItem('tpay:transactionID')

  if (!transactionID) {
    throw new Error('No transaction to confirm')
  }

  const response = await fetch(`${args.serverUrl}/api/payments/tpay/confirm-order`, {
    body: JSON.stringify({
      cartID: args.cartID,
      customerEmail: args.customerEmail,
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

  return data
}
