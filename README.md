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

**Leave the plugin's `access` configuration alone unless you know what each function guards.** The
development host in [`dev/`](dev/README.md) sets `isDocumentOwner: () => true` and
`publicAccess: () => true` so that scripts can drive it without logging in. Copied into a shop, that
configuration lets any signed in customer create an order with a plain `POST /api/orders`, without
paying anything: the plugin gives `orders` and `transactions` `create: isAdmin`, and the host's
`isAdmin` is "any logged in user". Nothing in this adapter can defend a shop whose own collections
accept orders from anyone. Keep the plugin defaults, or write access functions that check a role.

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
4. The customer comes back to `payerSuccessUrl`, and the storefront calls `POST /api/payments/tpay/confirm-order` with the `transactionID` returned in step 1 **and the `cartID`** (plus the cart `secret` for a guest cart). The plugin's handler rejects the request with `Cart ID is required.` before the adapter is ever reached, and the adapter then checks that same `secret` (or the logged in owner) against the transaction being confirmed, so send all of them.

Steps 3 and 4 both finish the order, whichever arrives first, and neither creates a second one. That matters because a redirect payment has no guarantee the browser ever comes back: the customer can pay with BLIK and close the tab.

Both paths are exercised against a real Payload instance with the plugin installed, using a real sandbox notification signed by Tpay, in [`dev/`](dev/README.md). Confirming an already confirmed transaction twice answers `Order already confirmed` and leaves exactly one order, which is measured rather than asserted.

## BLIK in your own checkout (BLIK level 0)

The flow above sends the customer to Tpay to pick a method. BLIK level 0 keeps them where they already are: they type the six digit code from their banking app into your checkout, and nothing redirects anywhere. The adapter registers two endpoints for it.

| Endpoint | Body | Answers |
| --- | --- | --- |
| `POST /api/payments/tpay/blik` | `transactionID`, `blikToken`, and `secret` for a guest cart | the code has been sent |
| `POST /api/payments/tpay/blik-status` | `transactionID`, and `secret` for a guest cart | `pending`, `rejected`, `paid` or `failed` |

A logged in customer who owns the transaction may omit `secret`. Anything else is answered with HTTP 403, and so is an unknown `transactionID`, so the endpoints do not tell an attacker which identifiers exist.

1. Call `initiate` exactly as before. Keep `transactionID`; ignore `paymentUrl`, nobody opens it.
2. Show a six digit field. The adapter strips spaces and dashes, and rejects anything that is not six digits **before** contacting Tpay, because a BLIK code is single use and lives about two minutes.
3. `POST /blik` with the code, then poll `/blik-status` every second or two until it stops answering `pending`.

Three things here are measured against a live sandbox rather than assumed, and each of them will bite an integration that guesses instead:

- **Tpay answers `success` to a code that cannot possibly be valid.** The literal code `abcdef` came back as `result: success` with the payment pending. The response to `/blik` therefore means "your request arrived", never "the customer paid". This adapter never reports a payment on the strength of it.
- **A rejected code does not change the transaction status.** It stays `pending`, and the only trace of the refusal is `paymentErrorCode` on the last entry of `payments.attempts`. Measured with code `000000`, which produced error `63` while the transaction still read `pending`. `/blik-status` reads that entry and answers `rejected`, so your checkout can ask for another code instead of leaving the buyer watching a spinner forever. The payment stays open and the next code goes to the same transaction, with no second order and no second transaction.
- **These endpoints deliberately bypass the plugin's `confirm-order`.** That handler decrements inventory on every single call, and BLIK level 0 requires polling, so using it here would take a unit of stock per poll. `/blik-status` finishes the order through the same idempotent path the server to server notification uses. The flip side is in Known limitations: a checkout that only ever uses BLIK never triggers the plugin's decrement, so it has to adjust stock itself.

The whole path runs against a real Payload instance with the plugin installed in [`dev/`](dev/README.md), including the refusal: a good code moves the payment to `paid` with one order, a refused code answers `rejected` and leaves the payment open, and a second code sent to that same payment completes it.

## What the adapter refuses to accept

A notification endpoint is a public URL, so everything about it assumes someone will try to fake a payment.

- **Checksum.** Every notification carries an md5 computed from the merchant ID, transaction ID, amount, `tr_crc` and your security code. A notification without a matching checksum is answered with HTTP 400 and no order is created. Missing configuration is a refusal too, never a silent pass.
- **What the checksum does not cover.** Those five inputs are the whole recipe, so `tr_status`, `tr_paid`, `tr_currency`, `tr_email` and `test_mode` sit outside it: change any of them and the same md5 still matches. Two of those, `tr_status` and `tr_paid`, are exactly the fields this adapter reads to decide that an order is paid. The checksum therefore authenticates *which* transaction a message is about, not *what it says happened* to it. Measured against a real sandbox notification and pinned in `test/notification-shape.test.js`.
- **JWS signature.** Second layer, **on by default**, and the only one that covers the whole body including the fields above. A notification without a valid `X-JWS-Signature` header is answered with HTTP 400. The certificate is fetched only from the Tpay host for the current environment, so a forged `x5u` pointing anywhere else is rejected before any outbound request is made. Pass `jwsRootCertificate` to also verify the chain against Tpay's root. `verifyJws: false` switches the layer off, which leaves a paid order one leaked notification body away from anyone who can reach the endpoint; do that knowingly.
- **`test_mode` is not an environment marker.** A sandbox notification arrives with `test_mode=0`. Do not branch on it to tell test traffic from real traffic; use your own configuration.
- **Underpayment.** With a plain bank transfer the payer types the amount themselves. If less arrives than the order is worth, the order is not created and the transaction stays pending with an error in the log. A transaction whose own amount cannot be read as a positive number is refused in the same way: a comparison that cannot be made must not report that nothing is owing.
- **Payment state comes from the Tpay API, never from the browser.** The return URL is client side and anyone can open it by hand, so `confirm-order` asks Tpay what actually happened.
- **The proof of payment has to be about this transaction.** `confirm-order` and `/blik-status` ask Tpay about the transaction ID stored on the document, never about one supplied in the request, and a `correct` answer only counts if Tpay reports the same amount and currency as the document. Without that, a buyer could pay for a cheap transaction and present that payment as proof for an expensive one. A mismatch is refused, and so is an API answer with no amount at all: a change in the API's shape stops sales loudly instead of waving everything through.
- **Nobody confirms a transaction they cannot prove is theirs.** Transaction IDs are sequential integers, and Payload's local API bypasses collection access, so `confirm-order` applies the same gate as the BLIK endpoints: the request has to come from the logged in owner of the transaction or carry the cart `secret`. That gate sits in front of the "already confirmed" answer too, so an order's `accessToken` is never handed to a stranger who guessed the ID. An identifier that matches nothing is refused with the same message and the same HTTP 403 as one that belongs to somebody else, so the endpoint cannot be walked to learn which transactions exist; the same holds when the cart the transaction points at has been deleted - a caller who cannot prove the payment is theirs gets the refusal, not a 500.
- **The address on the transaction wins.** The customer email recorded at `initiate` is what the order is created with. An email in a later request only fills the gap when the transaction has none, so knowing someone's transaction ID does not let you become the owner of their order.
- **Errors leave the details in the log.** Anything that is not a deliberate answer (`403`, `409`) comes back from the BLIK endpoints as a fixed message; the text of the underlying exception, including Tpay API paths and status codes, is written to the Payload logger only.

## Amounts

Payload stores money in minor units (integer grosze), Tpay expects decimals. On the way out, and for every value that arrives as a string - a notification body, `tr_paid`, `tr_amount` - the conversion is digit shuffling only: strings padded and sliced, nothing divided or multiplied, because a one grosz drift changes the checksum and the payment is rejected with no readable reason.

The REST API is the exception, and it is worth knowing about. `GET /transactions/{id}` returns `amount` as a JSON number, so by the time the value reaches this package it is already a float; `apiAmountToMinor` scales it with `Math.round(value * 10 ** decimals)`. That is rounding rather than exact arithmetic, and for two decimal places it is exact for every amount a shop can realistically charge - the error of the product stays far below the half unit that would round to the wrong integer. `test/amount.test.js` pins the values instead of asking you to take that on trust.

```ts
import { minorToDecimalString, decimalStringToMinor } from '@wellmade/payload-ecommerce-tpay'

minorToDecimalString(1999) // '19.99'
decimalStringToMinor('19.99') // 1999
```

**Two decimal currencies only.** Every conversion here assumes a minor unit of two decimal places, which is the ISO 4217 default and holds for everything Tpay settles (PLN, EUR, USD, GBP). A currency with a different exponent - JPY has none, KWD has three - is refused by `initiatePayment` with a loud error rather than converted by the wrong power of ten, and the same table guards the checks on the way back, so such a currency cannot pass the amount gate by both ends making the same mistake. Take it out of the plugin's `supportedCurrencies`.

## Known limitations

- **Inventory is decremented by the plugin's `confirm-order` endpoint, and only when the buyer comes
  back.** The plugin's handler decrements stock whenever the adapter's answer carries a
  `transactionID`, and it has no idempotency gate of its own: measured against plugin-ecommerce
  3.88.0 on a live instance, two identical `confirm-order` calls for one already confirmed
  transaction took stock from 5 to 4 to 3. The adapter now hands that trigger out **at most once per
  transaction**. The claim is a conditional write of `tpay.stockClaimedAt` on the transaction
  document, so only the call that wins it gets `transactionID` back; a reloaded return page, a second
  browser tab or a hand written `curl` all get the same answer with no trigger in it, and stock stays
  put. Which path closed the order makes no difference: the buyer's first `confirm-order`, a repeated
  one, and a notification that finished the order before the browser returned all go through the same
  claim.

- **The flip side of that is deliberate: a payment finished only by the notification adjusts no
  stock.** If the customer pays and never returns to the shop, nothing calls `confirm-order`, so the
  plugin's decrement never runs. The adapter does not decrement on the notification path either,
  because then a buyer who did come back would take a second unit off the shelf. Reconciling that
  case is on the shop, and `tpay.stockClaimedAt` is the field to look at: a succeeded transaction
  with an order and no `stockClaimedAt` is one whose stock nobody adjusted.
- **A BLIK checkout adjusts no stock at all unless you do it.** The two limitations above are about
  `confirm-order` running too often; this one is the opposite. BLIK level 0 never returns the browser
  anywhere, so a checkout built on `/blik` and `/blik-status` alone never calls `confirm-order` and
  therefore never reaches the plugin's decrement. Measured on a live instance: a completed BLIK
  payment created the order and left stock at 5. Adjust inventory yourself once, when `/blik-status`
  first answers `paid`.
- **Record "stock already adjusted" on the order, not in memory.** The demo shop keeps that marker in
  a process level set, which is fine for a demo and wrong for a shop: a restart forgets it, and the
  next `paid` answer decrements the same transaction again. Persist it on the order document.
- **A chargeback changes the transaction, not the order.** A `CHARGEBACK` notification sets the
  transaction to `refunded` and leaves the order in `processing`. A shop that watches orders alone
  will not see that the money went back; watch the transaction status, or add a hook that mirrors it.
- **Finishing an order is not an atomic compare and swap.** `payload.update` with a `where` clause is a find followed by a per-document write, so there is a narrow window in which the notification and the browser both believe they finished the order. The result is an orphaned order document, never a double charge, since there is only ever one payment. Closing the window would mean bypassing collection hooks, which is the worse trade. The race is decided by whoever attaches an order first, not by the transaction status: a transaction that already has an order gets that same order back, and a transaction with no order gets one on a verified paid notification even when its status has already moved somewhere else, because a settled refusal followed by a late transfer must not cost the buyer their order.
- Recurring payments, card tokenisation, marketplace transactions and refunds through the API are not implemented.

## Development

```bash
npm install
npm test     # builds, then runs the suite
```

The suite runs offline against fixtures and a Payload stub: no Tpay account is needed. Certificates for the signature tests are generated at test time with `openssl`, so no private key is checked in.

## Who built this

Built by [Wellmade](https://wellmade.online/en), a one person studio working on Payload, headless
commerce and WordPress. The adapter came out of running a real Payload shop in production and needing
Polish payment methods that Stripe does not cover.

If this adapter is close to what your shop needs but not quite there, the gaps are listed under
Limitations above. Extensions, other Polish providers and paid work on this package are all possible.

## License

MIT
