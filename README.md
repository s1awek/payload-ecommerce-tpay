# @wellmade/payload-ecommerce-tpay

Tpay payment adapter for [`@payloadcms/plugin-ecommerce`](https://payloadcms.com). Gives a Payload CMS 3 shop the payment methods Polish customers actually use: BLIK, online bank transfers (pay-by-link) and cards, through a single [Tpay](https://tpay.com) account.

Written for the plugin's official `PaymentAdapter` contract, so it plugs in exactly where the built-in Stripe adapter would.

## Requirements

- Payload CMS 3.83 or newer with `@payloadcms/plugin-ecommerce`
- Node 20.9 or newer
- A Tpay merchant account (sandbox account: [register.sandbox.tpay.com](https://register.sandbox.tpay.com/))

## Install

```bash
npm install @wellmade/payload-ecommerce-tpay
```

## Configure

Server side, in your Payload config:

```ts
import { ecommercePlugin } from '@payloadcms/plugin-ecommerce'
import { tpayAdapter, PLN } from '@wellmade/payload-ecommerce-tpay'

export default buildConfig({
  plugins: [
    ecommercePlugin({
      currencies: {
        defaultCurrency: 'PLN',
        supportedCurrencies: [PLN],
      },
      payments: {
        paymentMethods: [
          tpayAdapter({
            // every value below falls back to an environment variable
            clientId: process.env.TPAY_CLIENT_ID,
            clientSecret: process.env.TPAY_CLIENT_SECRET,
            merchantId: process.env.TPAY_MERCHANT_ID,
            securityCode: process.env.TPAY_SECURITY_CODE,
            sandbox: process.env.TPAY_SANDBOX === 'true',
            payerSuccessUrl: 'https://your-shop.example/order/confirmation',
            payerErrorUrl: 'https://your-shop.example/order/failed',
          }),
        ],
      },
    }),
  ],
})
```

Client side, wherever you configure the storefront:

```ts
import { tpayAdapterClient } from '@wellmade/payload-ecommerce-tpay'

const paymentMethods = [tpayAdapterClient({ label: 'BLIK, transfer, card' })]
```

### Environment variables

| Variable | Meaning |
|---|---|
| `TPAY_CLIENT_ID` | OAuth client ID, Tpay panel: Integration > API |
| `TPAY_CLIENT_SECRET` | OAuth client secret |
| `TPAY_MERCHANT_ID` | Numeric merchant ID, part of the notification checksum |
| `TPAY_SECURITY_CODE` | Notification security code, Tpay panel: Notifications > Security |
| `TPAY_SANDBOX` | `true` routes every call to the sandbox API |
| `NEXT_PUBLIC_SERVER_URL` | Used to derive the notification URL when you do not set one |

### Notification URL

The adapter mounts an endpoint at:

```
POST /api/payments/tpay/notifications
```

Set that full public URL as the notification address, either per transaction (the adapter sends it with every transaction it creates) or in the Tpay panel. It has to be reachable from the public internet, so a tunnel is needed while developing locally.

## How a payment runs

1. The storefront calls `POST /api/payments/tpay/initiate`. The adapter writes a `pending` transaction, creates the matching transaction in Tpay and returns `paymentUrl`.
2. The storefront redirects the customer to `paymentUrl`.
3. Tpay charges the customer and sends a server to server notification to the endpoint above. The adapter verifies it and creates the order.
4. The customer comes back to `payerSuccessUrl`, and the storefront calls `POST /api/payments/tpay/confirm-order` with the `transactionID` returned in step 1.

Steps 3 and 4 both finish the order, whichever arrives first, and neither creates a second one. That matters because a redirect payment has no guarantee the browser ever comes back: the customer can pay with BLIK and close the tab.

## What the adapter refuses to accept

A notification endpoint is a public URL, so everything about it assumes someone will try to fake a payment.

- **Checksum.** Every notification carries an md5 computed from the merchant ID, transaction ID, amount and your security code. A notification without a matching checksum is answered with HTTP 400 and no order is created. Missing configuration is a refusal too, never a silent pass.
- **JWS signature.** Optional second layer, enabled with `verifyJws: true`. The certificate is fetched only from the Tpay host for the current environment, so a forged `x5u` pointing anywhere else is rejected before any outbound request is made. Pass `jwsRootCertificate` to also verify the chain against Tpay's root.
- **Underpayment.** With a plain bank transfer the payer types the amount themselves. If less arrives than the order is worth, the order is not created and the transaction stays pending with an error in the log.
- **Payment state comes from the Tpay API, never from the browser.** The return URL is client side and anyone can open it by hand, so `confirm-order` asks Tpay what actually happened.

## Amounts

Payload stores money in minor units (integer grosze), Tpay expects decimals. The conversion is integer and string arithmetic only, never floating point, because a one grosz drift changes the checksum and the payment is rejected with no readable reason.

```ts
import { minorToDecimalString, decimalStringToMinor } from '@wellmade/payload-ecommerce-tpay'

minorToDecimalString(1999) // '19.99'
decimalStringToMinor('19.99') // 1999
```

## Known limitations

- **Inventory is decremented by the plugin's `confirm-order` endpoint, not by the adapter.** If the notification finishes an order and the customer never returns to the shop, stock is not adjusted for that order. The adapter deliberately does not adjust it either, because the browser path would then decrement a second time. Reconciling that case is on the shop for now.
- **Finishing an order is not an atomic compare and swap.** `payload.update` with a `where` clause is a find followed by a per-document write, so there is a narrow window in which the notification and the browser both believe they finished the order. The result is an orphaned order document, never a double charge, since there is only ever one payment. Closing the window would mean bypassing collection hooks, which is the worse trade.
- Recurring payments, card tokenisation, marketplace transactions and refunds through the API are not implemented.

## Development

```bash
npm install
npm test     # builds, then runs the suite
```

The suite runs offline against fixtures and a Payload stub: no Tpay account is needed. Certificates for the signature tests are generated at test time with `openssl`, so no private key is checked in.

## License

MIT
