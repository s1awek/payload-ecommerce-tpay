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
node --import tsx server.mts
```

`NEXT_PUBLIC_SERVER_URL` must be reachable from the internet, because Tpay delivers the
payment result as a server to server request. A local address will never receive it. Any
tunnel works; `cloudflared tunnel --url http://127.0.0.1:8099` is what these scripts assume.

## Password gate (`shop.mts`)

A tunnel makes this host public, and `POST /api/payments/tpay/initiate` mints sandbox
transactions on **your** Tpay credentials. A random tunnel hostname is obscurity, not a
control, so set a password before you open the tunnel:

```bash
export DEV_SHOP_PASSWORD='something-long'
```

The shop then answers 401 to everything until the password is typed on the page, and keeps
the answer in a session cookie (`HttpOnly`, `SameSite=Lax`, new secret on every start, so a
restart logs everyone out and nothing lands on disk). Two routes stay open on purpose:

| Route | Why it is open |
|---|---|
| `POST /api/payments/tpay/notifications` | Tpay has no password; it authenticates with the JWS signature and the md5 checksum, both verified by the adapter |
| `GET /health` | so a tunnel check does not need the password |

Leaving `DEV_SHOP_PASSWORD` unset turns the gate off. That is fine on a local address; with a
public one the startup line says the gate is off and what it means. `server.mts` has no gate
and is meant for a local address only.

## The three scripts

| Script | What it does |
|---|---|
| `server.mts` | Translates `node:http` requests into `Request`, builds a `PayloadRequest` with `createPayloadRequest` (a public export of `payload`), and dispatches to the endpoints the plugin and the adapter registered. Also serves `/return`, standing in for a shop's checkout return page. |
| `check-pipeline.mjs` | Instrument check. Run it **before** waiting for a real notification. |
| `seed-and-initiate.mts` | Seeds a product and a cart, then starts a payment through the live `initiate` endpoint and prints the payment URL. |

## Check the instrument before you trust silence

```bash
node check-pipeline.mjs https://your-tunnel.example
```

It sends two requests to the notification endpoint through the public address:

- a body whose md5 checksum is wrong, which must be rejected with `FALSE` and HTTP 400;
- a body whose md5 checksum is correct but which names a transaction that does not exist,
  which must pass the cryptographic check and fail only on the missing transaction.

Both halves matter. A check that never rejects is blind; a check that never passes is
clamped shut, and the two are indistinguishable from the outside. Once both pass, a missing
notification means Tpay is quiet, rather than your tunnel being broken. Without this step
those two states look identical, and the second one wastes hours.

**With JWS verification on, which is the adapter's default, the second half cannot pass.** The
script has no Tpay private key, so an unsigned body with a correct md5 is rejected exactly like a
forged one, and the script then only proves that both requests reached the handler through the
tunnel (the literal `FALSE`, rather than a tunnel error page or a 404). The positive proof of the
whole pipeline is a real, signed sandbox notification: after a BLIK payment the host log shows
`NOTIFICATION tr_id=... X-JWS-Signature: present` followed by `-> 200 TRUE`. To measure the md5 layer
on its own, start the host with `TPAY_VERIFY_JWS=false` and run the check with the same variable;
that switch exists only in this host's `payload.config.ts`, not in the adapter.

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

`blik-run.mts` seeds a product and a guest cart, calls `initiate`, sends a six digit code to
`/payments/tpay/blik` and then polls `/payments/tpay/blik-status` until the payment stops being
pending. It prints the database state afterwards. `BLIK_TOKEN` picks the code, which is how the
same script measures both directions:

```bash
BLIK_TOKEN=777123 tsx blik-run.mts   # accepted: pending, then paid, one order
BLIK_TOKEN=000000 tsx blik-run.mts   # refused: rejected, error 63, payment left open
```

`blik-second-code.mts` takes `TX_ID` of a payment that was refused and sends a good code to that same
payment, which is the case a checkout has to survive. It counts documents before and after, because
"the buyer retried" must not mean "a second transaction and a second order appeared".

No tunnel is needed for any of this. The BLIK path reads the payment state by asking Tpay, so it
does not wait for the server to server notification, and the run measures the BLIK path alone.
`NEXT_PUBLIC_SERVER_URL` still has to be set to something absolute, because the adapter refuses to
create a payment without a notification address, but that address is never reached during this run.

Two things worth repeating from the package README, because both were found here and neither is
visible from unit tests: Tpay answers `success` to a code that is not valid, and a refused code
leaves the transaction reading `pending` with the refusal recorded only in `payments.attempts`.

## The access configuration here is for scripts, not for shops

`payload.config.ts` sets `isDocumentOwner: () => true` and `publicAccess: () => true`, and treats any
logged in user as an admin. That lets the scripts in this directory read and write every collection
without a session. Copied into a real shop it lets any customer create orders with `POST /api/orders`
and never touch Tpay; the package README says the same in the configure section. Do not copy it.

## The click-through shop

`shop.mts` serves the same Payload instance as `server.mts`, plus one HTML page (`shop.html`):
a catalogue of three demo products, a cart, and a checkout with a six digit BLIK field next to a
"pay on the Tpay page" button. Run it **instead of** `server.mts`, with the same environment
variables; both listen on 8099.

```bash
node --import tsx shop.mts          # then open http://127.0.0.1:8099/
```

Everything the page does beyond forwarding `/api/*` is shop logic, and deliberately the logic the
package README says a shop must write itself: it remembers the transaction id across the redirect,
calls `confirm-order` at most once per transaction (a reload of the return page is refused, because
the plugin decrements stock on every call), and after a BLIK payment decrements stock once itself
(`/shop/decrement-stock`), since the BLIK path never reaches the plugin's decrement. The right hand
panel shows what happened in the database after each step, read through the local API; that read
(`POST /shop/state`) and the stock decrement both require the cart `secret`, and answer an unknown
transaction and a wrong secret identically, so a browser cannot enumerate other people's payments.
Prices and quantities are taken from the server, never from the page. The process log records a
notification's `tr_id`, status and whether it was signed, never the body: the body carries the md5
that the security code can be brute forced from.

The products collection gets a `title` field through `productsCollectionOverride` in
`payload.config.ts`, because the plugin's default collection has no name field at all. The redirect
path must be started under the public tunnel address, since Tpay returns the browser there and
`sessionStorage` is per origin; the page offers to jump there when you pick that method locally.
