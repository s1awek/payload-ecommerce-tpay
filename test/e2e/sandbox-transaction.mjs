/**
 * Przebieg end-to-end na piaskownicy Tpay: zalozenie prawdziwej transakcji.
 *
 * Nie wchodzi do `npm test` - wymaga danych z panelu i sieci. Uruchomienie:
 *   node --env-file=.env test/e2e/sandbox-transaction.mjs [--notification-url=https://...]
 *
 * Zaklada transakcje takim samym zadaniem, jakie buduje `initiatePayment`, i czyta
 * ja z powrotem. Testy offline sprawdzaja ksztalt zadania wobec naszego wyobrazenia
 * o API; ten przebieg sprawdza je wobec API.
 */
import { TpayClient } from '../../dist/client.js'
import { minorToDecimalString } from '../../dist/amount.js'

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const required = ['TPAY_CLIENT_ID', 'TPAY_CLIENT_SECRET', 'TPAY_MERCHANT_ID', 'TPAY_SECURITY_CODE']
const missing = required.filter((k) => !process.env[k])
if (missing.length) {
  console.error('Brak zmiennych srodowiskowych:', missing.join(', '))
  process.exit(1)
}

// Kwota w groszach, tak jak trzyma ja koszyk Payloada.
const amountMinor = Number(arg('amount-minor', '12345'))
const notificationUrl = arg('notification-url', 'https://example.invalid/api/tpay/notifications')
const localTransactionId = arg('local-id', `e2e-${Date.now()}`)

const client = new TpayClient({
  clientId: process.env.TPAY_CLIENT_ID,
  clientSecret: process.env.TPAY_CLIENT_SECRET,
  sandbox: process.env.TPAY_SANDBOX !== 'false',
})

const request = {
  amount: Number(minorToDecimalString(amountMinor, 2)),
  callbacks: {
    notification: { url: notificationUrl },
    payerUrls: {
      error: 'https://example.invalid/order/failed',
      success: 'https://example.invalid/order/confirmation',
    },
  },
  currency: 'PLN',
  description: `Order ${localTransactionId}`,
  hiddenDescription: localTransactionId,
  lang: 'pl',
  payer: { email: 'kupujacy@example.invalid', name: 'Jan Testowy' },
}

console.log('--- zadanie ---')
console.log('kwota (grosze):', amountMinor, '-> wyslana do Tpay:', request.amount)
console.log('hiddenDescription (nasze id):', request.hiddenDescription)
console.log('notification url:', notificationUrl)

const created = await client.createTransaction(request)

console.log('\n--- odpowiedz Tpay ---')
console.log('transactionId:', created.transactionId)
console.log('title (tr_id w powiadomieniu):', created.title)
console.log('status:', created.status)
console.log('paymentUrl:', created.transactionPaymentUrl)

const readBack = await client.getTransaction(created.transactionId)

console.log('\n--- odczyt zwrotny ---')
console.log('status:', readBack.status)
console.log('kwota u nich:', readBack.amount, readBack.currency)
console.log('hiddenDescription wrocilo:', readBack.hiddenDescription)

const problems = []
if (readBack.amount !== request.amount) {
  problems.push(`kwota nie zgadza sie: wyslano ${request.amount}, odczytano ${readBack.amount}`)
}
if (readBack.hiddenDescription !== localTransactionId) {
  problems.push(
    `hiddenDescription nie wrocilo: wyslano ${localTransactionId}, odczytano ${readBack.hiddenDescription}`,
  )
}
if (!created.transactionPaymentUrl) {
  problems.push('brak transactionPaymentUrl - kupujacy nie mialby gdzie zaplacic')
}

console.log('\n--- wynik ---')
if (problems.length) {
  problems.forEach((p) => console.log('WADA:', p))
  process.exit(1)
}
console.log('OK: transakcja zalozona, odczytana, kwota i nasz identyfikator zgadzaja sie po obu stronach.')
