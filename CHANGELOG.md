# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-14

First public release.

### Added

- Tpay payment adapter implementing the `PaymentAdapter` contract of
  [`@payloadcms/plugin-ecommerce`](https://www.npmjs.com/package/@payloadcms/plugin-ecommerce),
  so it registers wherever the built-in Stripe adapter would.
- Redirect payment flow: `initiatePayment` creates a Tpay transaction and returns
  `paymentUrl`; the payer is sent to Tpay and returns to `payerSuccessUrl`.
- Notification endpoint `POST /api/payments/tpay/notifications` for the
  server-to-server payment result.
- BLIK level 0 endpoints `POST /api/payments/tpay/blik` and
  `POST /api/payments/tpay/blik-status`, so the six digit code can be entered in
  the shop's own checkout without a redirect.
- `confirmOrder` closes the order after the payer returns, and shares one
  idempotent path with the notification, so whichever arrives first wins and
  neither creates a second order.
- md5 checksum verification of every notification, with a refusal when the
  security code is not configured.
- JWS signature verification (`X-JWS-Signature`), **on by default**, covering the
  whole notification body. The certificate is fetched only from the Tpay host for
  the active environment, so a forged `x5u` is rejected before any outbound
  request is made. Optional chain verification against a supplied
  `jwsRootCertificate`.
- Access gate on `confirm-order`, `/blik` and `/blik-status`: the caller must be
  the logged in owner of the transaction or present the guest cart `secret`. An
  unknown transaction and somebody else's transaction get the same refusal, so the
  endpoints cannot be walked to learn which identifiers exist.
- Amount and currency of the payment are checked against the transaction document
  before an order is closed, and the payment state is always read from the Tpay
  API rather than from the returning browser.
- Two decimal minor units only: a currency with a different ISO 4217 exponent is
  refused by `initiatePayment` and by the checks on the way back, instead of being
  converted by the wrong power of ten.
- Underpayment and unreadable amounts fail closed: no order is created.
- `tpay.stockClaimedAt` on the transaction, a conditional write that hands the
  plugin's stock decrement trigger to at most one `confirm-order` call per
  transaction.
- Deadline on every outgoing request (15 s by default, configurable with
  `timeoutMs`), with a shorter one on the certificate fetch that runs while a
  notification is waiting.
- Exported helpers for amount conversion, BLIK token handling, checksum and
  signature verification, and order finalisation.
- Development host in `dev/`: a real Payload instance with the plugin installed,
  a click-through demo shop, and scripts that exercise the redirect and BLIK paths
  end to end against the Tpay sandbox.

### Known limitations

- Refunds through the API, recurring payments, card tokenisation and marketplace
  transactions are not implemented.
- A payment finished only by the notification adjusts no stock, and a BLIK-only
  checkout never reaches the plugin's decrement at all. Both cases are the shop's
  to reconcile; see "Known limitations" in the README.

[Unreleased]: https://github.com/s1awek/payload-ecommerce-tpay/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/s1awek/payload-ecommerce-tpay/releases/tag/v0.1.0
