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
