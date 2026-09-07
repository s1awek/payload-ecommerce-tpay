/**
 * Minimalny gospodarz deweloperski: prawdziwy Payload + wtyczka e-commerce
 * + nasz adapter Tpay. Bez Next.js - panel administracyjny nie jest tu do
 * niczego potrzebny, bo przebieg idzie przez API lokalne i przez endpointy
 * zarejestrowane przez wtyczke.
 *
 * Powod istnienia tego katalogu: testy jednostkowe adaptera mierzyly nasz kod
 * na atrapie Payloada. To NIE jest to samo co zapis zamowienia do prawdziwej
 * kolekcji utworzonej przez wtyczke. Roznice miedzy atrapa a rzeczywistoscia
 * sa dokladnie tym, czego atrapa nie moze pokazac.
 */
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { ecommercePlugin } from '@payloadcms/plugin-ecommerce'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildConfig } from 'payload'

// Adapter bierzemy z katalogu nadrzednego, wprost z dist. Jest tam czysty JS
// bez runtime'owych importow z payload ani z wtyczki (zmierzone: grep po dist
// nie znajduje ani jednego), wiec nie wymaga instalacji jako paczka.
import { PLN, tpayAdapter } from '../dist/index.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const adresPubliczny = (process.env.NEXT_PUBLIC_SERVER_URL || '').replace(/\/+$/, '')

const jestAdministratorem = ({ req }: { req: { user?: unknown } }) => Boolean(req.user)

export default buildConfig({
  admin: { disable: true },
  collections: [
    {
      slug: 'users',
      auth: true,
      fields: [{ name: 'rola', type: 'select', defaultValue: 'klient', options: ['admin', 'klient'] }],
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
        adminOnlyFieldAccess: jestAdministratorem,
        adminOrPublishedStatus: () => true,
        isAdmin: jestAdministratorem,
        isDocumentOwner: () => true,
        publicAccess: () => true,
      },
      currencies: { defaultCurrency: 'PLN', supportedCurrencies: [PLN] },
      customers: { slug: 'users' },
      payments: {
        paymentMethods: [
          tpayAdapter({
            // Bez tych dwoch adresow Tpay odsyla platnika tam, gdzie wskazuje panel
            // sprzedawcy - czyli poza nasz sklep. Sciezka przegladarki (`confirm-order`)
            // nie odpala sie wtedy wcale, a to WLASNIE ona zdejmuje stan magazynowy.
            payerErrorUrl: adresPubliczny ? `${adresPubliczny}/blad` : undefined,
            payerSuccessUrl: adresPubliczny ? `${adresPubliczny}/powrot` : undefined,
            sandbox: true,
          }),
        ],
      },
      // `products` MUSI byc podane jawnie, mimo ze dokumentacja typu mowi
      // "Defaults to true". W 3.88.0 `sanitizePluginConfig` ustawia domyslne
      // wartosci dla customers, addresses, currencies, inventory, carts, orders,
      // transactions i payments, ale dla products robi tylko `if (config.products)`.
      // Pominiecie pola nie wylacza produktow po cichu - wywraca CALA inicjalizacje
      // Payloada bledem `InvalidFieldRelationship: ... has invalid relationship
      // 'products'`, bo koszyk i tak trzyma relacje do nieistniejacej kolekcji.
      products: true,
    }),
  ],
  secret: process.env.PAYLOAD_SECRET || 'gospodarz-deweloperski-nie-produkcja',
  typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
})
