/**
 * End-to-end run on the Tpay sandbox: creating a real transaction.
 *
 * Not part of `npm test` - requires panel credentials and network access. Run with:
 *   node --env-file=.env test/e2e/sandbox-transaction.mjs [--notification-url=https://...]
 *
 * Creates a transaction with the same request that `initiatePayment` builds, and
 * reads it back. The offline tests check the request shape against our idea of the
 * API; this run checks it against the API itself.
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
  console.error('Missing environment variables:', missing.join(', '))
  process.exit(1)
}

// Amount in cents, the way Payload's cart holds it.
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
  payer: { email: 'buyer@example.invalid', name: 'John Test' },
}

console.log('--- request ---')
console.log('amount (cents):', amountMinor, '-> sent to Tpay:', request.amount)
console.log('hiddenDescription (our id):', request.hiddenDescription)
console.log('notification url:', notificationUrl)

const created = await client.createTransaction(request)

console.log('\n--- Tpay response ---')
console.log('transactionId:', created.transactionId)
console.log('title (tr_id in the notification):', created.title)
console.log('status:', created.status)
console.log('paymentUrl:', created.transactionPaymentUrl)

const readBack = await client.getTransaction(created.transactionId)

console.log('\n--- read-back ---')
console.log('status:', readBack.status)
console.log('amount on their side:', readBack.amount, readBack.currency)
console.log('hiddenDescription came back:', readBack.hiddenDescription)

const problems = []
if (readBack.amount !== request.amount) {
  problems.push(`amount does not match: sent ${request.amount}, read back ${readBack.amount}`)
}
if (readBack.hiddenDescription !== localTransactionId) {
  problems.push(
    `hiddenDescription did not come back: sent ${localTransactionId}, read back ${readBack.hiddenDescription}`,
  )
}
if (!created.transactionPaymentUrl) {
  problems.push('missing transactionPaymentUrl - the buyer would have nowhere to pay')
}

console.log('\n--- result ---')
if (problems.length) {
  problems.forEach((p) => console.log('DEFECT:', p))
  process.exit(1)
}
console.log('OK: transaction created, read back, amount and our identifier match on both sides.')
