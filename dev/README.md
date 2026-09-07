# Development host

A minimal, real Payload instance used to exercise this adapter end to end: real
`@payloadcms/plugin-ecommerce` collections, a real SQLite database, real HTTP endpoints.
There is no Next.js here and none is needed.

Unit tests run the adapter against a Payload stub. A stub cannot tell you whether an order
is actually written to the collection the plugin creates, whether the plugin's own validation
lets your payload through, or whether the fields your adapter contributes survive schema
generation. That is what this host is for.

## Install and run

```bash
pnpm install                       # see pnpm-workspace.yaml for the build-script gate
export $(grep -v '^#' ../.env | xargs)   # TPAY_CLIENT_ID, TPAY_CLIENT_SECRET, TPAY_MERCHANT_ID, TPAY_SECURITY_CODE
export NEXT_PUBLIC_SERVER_URL=https://<a public tunnel to 127.0.0.1:8099>
node --import tsx serwer.mts
```

`NEXT_PUBLIC_SERVER_URL` must be reachable from the internet, because Tpay delivers the
payment result as a server to server request. A local address will never receive it. Any
tunnel works; `cloudflared tunnel --url http://127.0.0.1:8099` is what these scripts assume.

## The three scripts

| Script | What it does |
|---|---|
| `serwer.mts` | Translates `node:http` requests into `Request`, builds a `PayloadRequest` with `createPayloadRequest` (a public export of `payload`), and dispatches to the endpoints the plugin and the adapter registered. Also serves `/powrot`, standing in for a shop's checkout return page. |
| `kontrola-toru.mjs` | Instrument check. Run it **before** waiting for a real notification. |
| `zasiew-i-initiate.mts` | Seeds a product and a cart, then starts a payment through the live `initiate` endpoint and prints the payment URL. |

## Check the instrument before you trust silence

```bash
node kontrola-toru.mjs https://your-tunnel.example
```

It sends two requests to the notification endpoint through the public address:

- a body whose md5 checksum is wrong, which must be rejected with `FALSE` and HTTP 400;
- a body whose md5 checksum is correct but which names a transaction that does not exist,
  which must pass the cryptographic check and fail only on the missing transaction.

Both halves matter. A check that never rejects is blind; a check that never passes is
clamped shut, and the two are indistinguishable from the outside. Once both pass, a missing
notification means Tpay is quiet, rather than your tunnel being broken. Without this step
those two states look identical, and the second one wastes hours.

## Two things this host made visible

**`products` has no default.** The plugin's own type documents `products` as defaulting to
true, but `sanitizePluginConfig` supplies defaults for `customers`, `addresses`, `currencies`,
`inventory`, `carts`, `orders`, `transactions` and `payments` and does not touch `products`.
Omitting the field does not quietly disable products: it aborts Payload's initialisation with
`InvalidFieldRelationship: ... has invalid relationship 'products'`, because carts still hold
a relationship to the missing collection. Measured against 3.88.0, so `products: true` is
passed explicitly in `payload.config.ts`.

**Configure the payer return URLs or the browser path never runs.** The adapter only sends
`payerUrls` to Tpay when you set `payerSuccessUrl` or `payerErrorUrl`. Leave them out and Tpay
returns the payer wherever the merchant panel points, which is outside your shop, so
`confirm-order` is never called. That endpoint is where the plugin decrements stock, so a shop
missing these two settings takes payments and never adjusts inventory.

## The BLIK level 0 run

`blik-przebieg.mts` seeds a product and a guest cart, calls `initiate`, sends a six digit code to
`/payments/tpay/blik` and then polls `/payments/tpay/blik-status` until the payment stops being
pending. It prints the database state afterwards. `BLIK_TOKEN` picks the code, which is how the
same script measures both directions:

```bash
BLIK_TOKEN=777123 tsx blik-przebieg.mts   # accepted: pending, then paid, one order
BLIK_TOKEN=000000 tsx blik-przebieg.mts   # refused: rejected, error 63, payment left open
```

`blik-drugi-kod.mts` takes `TX_ID` of a payment that was refused and sends a good code to that same
payment, which is the case a checkout has to survive. It counts documents before and after, because
"the buyer retried" must not mean "a second transaction and a second order appeared".

No tunnel is needed for any of this. The BLIK path reads the payment state by asking Tpay, so it
does not wait for the server to server notification, and the run measures the BLIK path alone.
`NEXT_PUBLIC_SERVER_URL` still has to be set to something absolute, because the adapter refuses to
create a payment without a notification address, but that address is never reached during this run.

Two things worth repeating from the package README, because both were found here and neither is
visible from unit tests: Tpay answers `success` to a code that is not valid, and a refused code
leaves the transaction reading `pending` with the refusal recorded only in `payments.attempts`.
