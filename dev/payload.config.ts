/**
 * Minimal development host: real Payload + the e-commerce plugin + our Tpay
 * adapter. No Next.js - the admin panel is not needed here, because the run
 * goes through the local API and through the endpoints the plugin registers.
 *
 * Reason this directory exists: the adapter's unit tests measured our code
 * against a Payload stub. That is NOT the same as writing an order to the
 * real collection the plugin creates. The differences between a stub and
 * reality are exactly what a stub cannot show.
 */
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { ecommercePlugin } from '@payloadcms/plugin-ecommerce'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildConfig } from 'payload'

// The adapter is taken from the parent directory, straight from dist. It is
// plain JS with no runtime imports from payload or from the plugin (measured:
// grep over dist finds none), so it does not need to be installed as a package.
import { PLN, tpayAdapter } from '../dist/index.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const publicAddress = (process.env.NEXT_PUBLIC_SERVER_URL || '').replace(/\/+$/, '')

const isAdministrator = ({ req }: { req: { user?: unknown } }) => Boolean(req.user)

export default buildConfig({
  admin: { disable: true },
  collections: [
    {
      slug: 'users',
      auth: true,
      fields: [{ name: 'role', type: 'select', defaultValue: 'customer', options: ['admin', 'customer'] }],
    },
  ],
  db: sqliteAdapter({
    client: { url: process.env.DATABASE_URI || `file:${path.resolve(dirname, 'tpay-dev.db')}` },
    push: true,
  }),
  editor: lexicalEditor(),
  plugins: [
    ecommercePlugin({
      access: {
        adminOnlyFieldAccess: isAdministrator,
        adminOrPublishedStatus: () => true,
        isAdmin: isAdministrator,
        isDocumentOwner: () => true,
        publicAccess: () => true,
      },
      currencies: { defaultCurrency: 'PLN', supportedCurrencies: [PLN] },
      customers: { slug: 'users' },
      payments: {
        paymentMethods: [
          tpayAdapter({
            // Without these two addresses Tpay sends the payer back wherever the
            // merchant panel points - that is, outside our shop. The browser path
            // (`confirm-order`) never fires then, and that is EXACTLY what
            // decrements stock.
            payerErrorUrl: publicAddress ? `${publicAddress}/error` : undefined,
            payerSuccessUrl: publicAddress ? `${publicAddress}/return` : undefined,
            sandbox: true,
            // By default the adapter REQUIRES a JWS signature (the Tpay sandbox
            // sends one too). The knob exists only for `check-pipeline.mjs`:
            // without Tpay's private key a known-good signature cannot be
            // produced, so the md5 layer alone is measured separately, on a host
            // started with TPAY_VERIFY_JWS=false.
            verifyJws: process.env.TPAY_VERIFY_JWS !== 'false',
          }),
        ],
      },
      // `products` MUST be given explicitly, even though the type's documentation
      // says "Defaults to true". In 3.88.0 `sanitizePluginConfig` sets defaults for
      // customers, addresses, currencies, inventory, carts, orders, transactions and
      // payments, but for products it only does `if (config.products)`. Omitting the
      // field does not quietly disable products - it aborts Payload's ENTIRE
      // initialisation with `InvalidFieldRelationship: ... has invalid relationship
      // 'products'`, because the cart still holds a relationship to the missing
      // collection. The plugin's default products collection has no name field at
      // all (columns: price, stock, variants, status) - the demo shop needs a title,
      // so we add one field the way any real shop would: through
      // productsCollectionOverride.
      products: {
        productsCollectionOverride: ({ defaultCollection }) => ({
          ...defaultCollection,
          fields: [...defaultCollection.fields, { name: 'title', type: 'text' }],
        }),
      },
    }),
  ],
  secret: process.env.PAYLOAD_SECRET || 'development-host-not-production',
  typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
})
