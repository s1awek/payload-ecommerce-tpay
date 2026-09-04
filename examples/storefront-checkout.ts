/**
 * Przykład po stronie frontu sklepu: dwa wywołania, między nimi przekierowanie.
 *
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
 * Krok 1. Wołane, gdy klient klika „Zapłać”. Zapamiętaj `transactionID`
 * (sessionStorage, parametr w adresie powrotu, cokolwiek przeżyje przekierowanie),
 * bo bez niego nie ma czym potwierdzić zamówienia po powrocie.
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
 * Krok 2. Wołane na stronie powrotu (`payerSuccessUrl`).
 *
 * Powiadomienie serwer-serwer mogło już domknąć zamówienie i to jest normalne:
 * odpowiedź niesie wtedy ten sam identyfikator zamówienia, nie drugie zamówienie.
 * Błąd „not completed yet” znaczy, że Tpay jeszcze nie zaksięgował płatności -
 * warto wtedy ponowić za kilka sekund, zamiast pokazywać klientowi porażkę.
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
