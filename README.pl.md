# @wellmade/payload-ecommerce-tpay

Adapter płatności Tpay dla [`@payloadcms/plugin-ecommerce`](https://payloadcms.com). Daje sklepowi na Payload CMS 3 metody płatności, z których realnie korzystają polscy klienci: BLIK, przelewy online (pay-by-link) i karty, na jednym koncie [Tpay](https://tpay.com).

Napisany pod oficjalny kontrakt `PaymentAdapter` z wtyczki, więc wpina się dokładnie tam, gdzie wbudowany adapter Stripe.

## Wymagania

- Payload CMS 3.83 lub nowszy z `@payloadcms/plugin-ecommerce`
- Node 20.9 lub nowszy
- Konto sprzedawcy w Tpay (sandbox: [register.sandbox.tpay.com](https://register.sandbox.tpay.com/))

## Instalacja

```bash
npm install @wellmade/payload-ecommerce-tpay
```

## Konfiguracja

Po stronie serwera, w konfiguracji Payloada:

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
            // każda wartość poniżej ma odpowiednik w zmiennych środowiskowych
            clientId: process.env.TPAY_CLIENT_ID,
            clientSecret: process.env.TPAY_CLIENT_SECRET,
            merchantId: process.env.TPAY_MERCHANT_ID,
            securityCode: process.env.TPAY_SECURITY_CODE,
            sandbox: process.env.TPAY_SANDBOX === 'true',
            payerSuccessUrl: 'https://twoj-sklep.pl/zamowienie/potwierdzenie',
            payerErrorUrl: 'https://twoj-sklep.pl/zamowienie/nieudane',
          }),
        ],
      },
    }),
  ],
})
```

Po stronie przeglądarki, tam gdzie konfigurujesz front sklepu:

```ts
import { tpayAdapterClient } from '@wellmade/payload-ecommerce-tpay'

const paymentMethods = [tpayAdapterClient({ label: 'BLIK, przelew, karta' })]
```

### Zmienne środowiskowe

| Zmienna | Znaczenie |
|---|---|
| `TPAY_CLIENT_ID` | Identyfikator klienta OAuth, panel Tpay: Integracja > API |
| `TPAY_CLIENT_SECRET` | Sekret OAuth |
| `TPAY_MERCHANT_ID` | Numeryczny identyfikator sprzedawcy, wchodzi do sumy kontrolnej powiadomień |
| `TPAY_SECURITY_CODE` | Kod bezpieczeństwa powiadomień, panel Tpay: Powiadomienia > Bezpieczeństwo |
| `TPAY_SANDBOX` | `true` kieruje wszystkie wywołania do API sandboksa |
| `NEXT_PUBLIC_SERVER_URL` | Służy do zbudowania adresu powiadomień, gdy nie podasz go wprost |

### Adres powiadomień

Adapter wystawia punkt:

```
POST /api/payments/tpay/notifications
```

Pełny publiczny adres tego punktu ustaw jako adres powiadomień: albo per transakcja (adapter wysyła go z każdą tworzoną transakcją), albo w panelu Tpay. Musi być osiągalny z internetu, więc przy pracy lokalnej potrzebny jest tunel.

## Jak przebiega płatność

1. Front sklepu woła `POST /api/payments/tpay/initiate`. Adapter zapisuje transakcję w stanie `pending`, tworzy odpowiadającą jej transakcję w Tpay i zwraca `paymentUrl`.
2. Front przekierowuje klienta na `paymentUrl`.
3. Tpay pobiera płatność i wysyła powiadomienie serwer-serwer na punkt powyżej. Adapter je weryfikuje i tworzy zamówienie.
4. Klient wraca na `payerSuccessUrl`, a front woła `POST /api/payments/tpay/confirm-order` z `transactionID` zwróconym w kroku 1.

Kroki 3 i 4 domykają zamówienie niezależnie od siebie, w dowolnej kolejności, i żaden nie tworzy drugiego. To nie jest szczegół: przy płatności z przekierowaniem nie ma gwarancji, że przeglądarka w ogóle wróci. Klient potrafi zapłacić BLIKiem i zamknąć kartę.

## Czego adapter nie przyjmuje

Punkt odbioru powiadomień to publiczny adres, więc wszystko w nim jest napisane przy założeniu, że ktoś spróbuje podszyć się pod zapłaconą transakcję.

- **Suma kontrolna.** Każde powiadomienie niesie md5 policzone z identyfikatora sprzedawcy, numeru transakcji, kwoty i kodu bezpieczeństwa. Powiadomienie bez zgodnej sumy dostaje HTTP 400 i nie tworzy zamówienia. Brak konfiguracji też jest odmową, nigdy cichym przepuszczeniem.
- **Podpis JWS.** Opcjonalna druga warstwa, włączana przez `verifyJws: true`. Certyfikat pobierany jest wyłącznie z hosta Tpay właściwego dla środowiska, więc podstawiony `x5u` wskazujący gdziekolwiek indziej odpada, zanim poleci jakiekolwiek żądanie wychodzące. Podanie `jwsRootCertificate` dokłada sprawdzenie łańcucha do korzenia Tpay.
- **Niedopłata.** Przy zwykłym przelewie kwotę wpisuje płatnik. Jeśli wpłynie mniej, niż wynosi zamówienie, zamówienie nie powstaje, a transakcja zostaje w stanie `pending` z wpisem w logu.
- **Stan płatności bierzemy z API Tpay, nigdy z przeglądarki.** Adres powrotu jest po stronie klienta i da się go otworzyć ręcznie, więc `confirm-order` pyta Tpay, co się faktycznie stało.

## Kwoty

Payload trzyma pieniądze w jednostkach podrzędnych (grosze, liczba całkowita), Tpay oczekuje wartości dziesiętnych. Konwersja idzie wyłącznie na liczbach całkowitych i napisach, nigdy przez zmiennoprzecinkowe, bo rozjazd o jeden grosz zmienia sumę kontrolną i płatność zostaje odrzucona bez czytelnego powodu.

```ts
import { minorToDecimalString, decimalStringToMinor } from '@wellmade/payload-ecommerce-tpay'

minorToDecimalString(1999) // '19.99'
decimalStringToMinor('19.99') // 1999
```

## Znane ograniczenia

- **Stan magazynowy zdejmuje punkt `confirm-order` z wtyczki, nie adapter.** Jeśli zamówienie domknie powiadomienie, a klient nigdy nie wróci do sklepu, stan magazynowy nie zostanie dla niego skorygowany. Adapter świadomie też go nie rusza, bo wtedy ścieżka przeglądarki zdjęłaby towar drugi raz. Na dziś domknięcie tego przypadku jest po stronie sklepu.
- **Domknięcie zamówienia nie jest atomowym compare-and-swap.** `payload.update` z warunkiem `where` to wyszukanie, a dopiero potem zapis po dokumencie, więc zostaje wąskie okno, w którym powiadomienie i przeglądarka uznają się jednocześnie za tego, kto domknął zamówienie. Skutkiem jest osierocony dokument zamówienia, nigdy podwójne obciążenie, bo płatność jest jedna. Domknięcie okna oznaczałoby ominięcie haków kolekcji, co jest gorszym wyborem.
- Płatności cykliczne, tokenizacja kart, transakcje marketplace i zwroty przez API nie są zaimplementowane.

## Praca nad pakietem

```bash
npm install
npm test     # najpierw budowanie, potem suita
```

Suita chodzi offline, na atrapach i danych testowych: konto Tpay nie jest do niej potrzebne. Certyfikaty do testów podpisu powstają w trakcie testu przez `openssl`, więc żaden klucz prywatny nie leży w repozytorium.

## Licencja

MIT
