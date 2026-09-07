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
4. Klient wraca na `payerSuccessUrl`, a front woła `POST /api/payments/tpay/confirm-order` z `transactionID` zwróconym w kroku 1 **oraz z `cartID`** (a przy koszyku gościa dodatkowo z jego `secret`). Sam adapter potrzebuje wyłącznie transakcji, ale handler wtyczki odrzuca żądanie komunikatem `Cart ID is required.`, zanim w ogóle dojdzie do adaptera, więc trzeba wysłać oba.

Kroki 3 i 4 domykają zamówienie niezależnie od siebie, w dowolnej kolejności, i żaden nie tworzy drugiego. To nie jest szczegół: przy płatności z przekierowaniem nie ma gwarancji, że przeglądarka w ogóle wróci. Klient potrafi zapłacić BLIKiem i zamknąć kartę.

Obie ścieżki są przejechane na prawdziwej instancji Payloada z wpiętą wtyczką, na prawdziwym powiadomieniu z piaskownicy podpisanym przez Tpay - patrz [`dev/`](dev/README.md). Dwukrotne potwierdzenie już domkniętej transakcji odpowiada `Order already confirmed` i zostawia dokładnie jedno zamówienie, co jest zmierzone, a nie założone.

## BLIK na stronie sklepu (BLIK 0)

Przebieg opisany wyżej wyprowadza kupującego do Tpay, żeby tam wybrał metodę. BLIK 0 zostawia go tam, gdzie jest: sześciocyfrowy kod z aplikacji banku wpisuje w kasie sklepu i nic go nigdzie nie przenosi. Adapter rejestruje do tego dwa punkty.

| Punkt | Ciało | Odpowiada |
| --- | --- | --- |
| `POST /api/payments/tpay/blik` | `transactionID`, `blikToken`, a przy koszyku gościa `secret` | kod został wysłany |
| `POST /api/payments/tpay/blik-status` | `transactionID`, a przy koszyku gościa `secret` | `pending`, `rejected`, `paid` albo `failed` |

Zalogowany właściciel transakcji może pominąć `secret`. Każde inne żądanie dostaje HTTP 403, tak samo jak żądanie o nieznanym `transactionID`, więc punkty nie zdradzają, które identyfikatory istnieją.

1. Wywołaj `initiate` dokładnie tak jak dotąd. Zatrzymaj `transactionID`, a `paymentUrl` zignoruj, nikt go nie otwiera.
2. Pokaż pole na sześć cyfr. Adapter zdejmuje spacje i myślniki, a kod o innej długości odrzuca **zanim** cokolwiek pójdzie do Tpay, bo kod BLIK jest jednorazowy i żyje około dwóch minut.
3. Wyślij `POST /blik` z kodem, a potem odpytuj `/blik-status` co sekundę albo dwie, aż przestanie odpowiadać `pending`.

Trzy rzeczy są tu zmierzone na żywej piaskownicy, a nie założone, i każda z nich ugryzie integrację, która zgaduje:

- **Tpay odpowiada `success` na kod, który nie ma prawa być poprawny.** Dosłowny kod `abcdef` wrócił jako `result: success` z płatnością w toku. Odpowiedź na `/blik` znaczy więc „żądanie doszło", nigdy „klient zapłacił". Ten adapter nigdy nie ogłasza na jej podstawie zapłaty.
- **Odrzucony kod nie zmienia statusu transakcji.** Zostaje `pending`, a jedynym śladem odmowy jest `paymentErrorCode` przy ostatniej pozycji `payments.attempts`. Zmierzone kodem `000000`, który dał błąd `63` przy transakcji nadal opisanej jako `pending`. `/blik-status` czyta tę pozycję i odpowiada `rejected`, dzięki czemu kasa może poprosić o kolejny kod zamiast zostawiać kupującego przy kręcącym się kółku. Płatność zostaje otwarta, a następny kod idzie do tej samej transakcji, bez drugiego zamówienia i bez drugiej transakcji.
- **Te punkty świadomie omijają `confirm-order` wtyczki.** Tamten handler zdejmuje stan magazynowy przy każdym wywołaniu, a BLIK 0 wymaga odpytywania, więc użycie go tutaj zabierałoby sztukę przy każdym sprawdzeniu. `/blik-status` domyka zamówienie tą samą, idempotentną drogą, którą robi to powiadomienie serwer-serwer. Druga strona tego medalu jest w znanych ograniczeniach: kasa oparta wyłącznie na BLIK-u nigdy nie uruchomi zdejmowania stanu we wtyczce, więc musi zrobić to sama.

Cała ścieżka przechodzi na prawdziwej instancji Payloada z wpiętą wtyczką w [`dev/`](dev/README.md), razem z odmową: dobry kod przestawia płatność na `paid` z jednym zamówieniem, kod odrzucony daje `rejected` i zostawia płatność otwartą, a kolejny kod wysłany do tej samej płatności domyka ją.

## Czego adapter nie przyjmuje

Punkt odbioru powiadomień to publiczny adres, więc wszystko w nim jest napisane przy założeniu, że ktoś spróbuje podszyć się pod zapłaconą transakcję.

- **Suma kontrolna.** Każde powiadomienie niesie md5 policzone z identyfikatora sprzedawcy, numeru transakcji, kwoty, pola `tr_crc` i kodu bezpieczeństwa. Powiadomienie bez zgodnej sumy dostaje HTTP 400 i nie tworzy zamówienia. Brak konfiguracji też jest odmową, nigdy cichym przepuszczeniem.
- **Czego suma NIE obejmuje.** Te pięć składników to cały przepis, więc `tr_status`, `tr_paid`, `tr_currency`, `tr_email` i `test_mode` zostają poza nim: zmiana któregokolwiek z nich nie psuje sumy. Dwa z nich, `tr_status` i `tr_paid`, to dokładnie te pola, z których adapter odczytuje, że zamówienie jest opłacone. Suma potwierdza więc, **której** transakcji dotyczy wiadomość, a nie **co się z nią stało**. Zmierzone na prawdziwym powiadomieniu z piaskownicy, przypięte testem `test/notification-shape.test.js`.
- **Podpis JWS.** Druga warstwa, włączana przez `verifyJws: true`, i jedyna obejmująca całe ciało razem z polami wymienionymi wyżej. Na produkcji włączać. Certyfikat pobierany jest wyłącznie z hosta Tpay właściwego dla środowiska, więc podstawiony `x5u` wskazujący gdziekolwiek indziej odpada, zanim poleci jakiekolwiek żądanie wychodzące. Podanie `jwsRootCertificate` dokłada sprawdzenie łańcucha do korzenia Tpay.
- **`test_mode` nie jest znacznikiem środowiska.** Powiadomienie z piaskownicy przychodzi z `test_mode=0`. Nie rozstrzygaj po tym polu, czy ruch jest testowy - do tego służy własna konfiguracja.
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

- **Stan magazynowy zdejmuje punkt `confirm-order` z wtyczki, nie adapter.** Jeśli zamówienie domknie
  powiadomienie, a klient nigdy nie wróci do sklepu, stan magazynowy nie zostanie dla niego
  skorygowany. Adapter świadomie też go nie rusza, bo wtedy ścieżka przeglądarki zdjęłaby towar
  drugi raz. Na dziś domknięcie tego przypadku jest po stronie sklepu.

- **To zdejmowanie nie ma zabezpieczenia przed powtórzeniem, więc stronę powrotu trzeba osłonić
  samemu.** Zmierzone na żywej instancji z plugin-ecommerce 3.88.0: dwa identyczne wywołania
  `confirm-order` dla jednej, już domkniętej transakcji zdjęły stan z 5 na 4, a potem na 3. Adapter
  w obu wywołaniach zachowuje się poprawnie, odpowiada `Order already confirmed` i nie tworzy
  drugiego zamówienia; handler wtyczki i tak zdejmuje towar raz na każde wywołanie, bo działa na
  zwróconym `transactionID`. Klient, który odświeży stronę powrotu z kasy, za każdym razem zabiera
  więc kolejną sztukę ze stanu. Dopóki nie zostanie to naprawione w samej wtyczce, sklep powinien
  wołać `confirm-order` najwyżej raz na transakcję: na przykład przekierowując z adresu powrotu po
  pierwszej odpowiedzi albo zapisując na zamówieniu, że ścieżka powrotu już się wykonała.
- **Kasa na BLIK-u nie rusza stanu magazynowego w ogóle, dopóki sklep nie zrobi tego sam.** Dwa
  ograniczenia wyżej mówią o `confirm-order` wywoływanym zbyt często, to jest odwrotne. BLIK 0 nigdy
  nie odsyła przeglądarki nigdzie, więc kasa zbudowana wyłącznie na `/blik` i `/blik-status` nie
  wywołuje `confirm-order` i nie dociera do zdejmowania stanu we wtyczce. Zmierzone na żywej
  instancji: domknięta płatność BLIK-iem utworzyła zamówienie i zostawiła stan na 5. Stan trzeba
  zdjąć samodzielnie, raz, przy pierwszej odpowiedzi `paid` z `/blik-status`.
- **Domknięcie zamówienia nie jest atomowym compare-and-swap.** `payload.update` z warunkiem `where` to wyszukanie, a dopiero potem zapis po dokumencie, więc zostaje wąskie okno, w którym powiadomienie i przeglądarka uznają się jednocześnie za tego, kto domknął zamówienie. Skutkiem jest osierocony dokument zamówienia, nigdy podwójne obciążenie, bo płatność jest jedna. Domknięcie okna oznaczałoby ominięcie haków kolekcji, co jest gorszym wyborem.
- Płatności cykliczne, tokenizacja kart, transakcje marketplace i zwroty przez API nie są zaimplementowane.

## Praca nad pakietem

```bash
npm install
npm test     # najpierw budowanie, potem suita
```

Suita chodzi offline, na atrapach i danych testowych: konto Tpay nie jest do niej potrzebne. Certyfikaty do testów podpisu powstają w trakcie testu przez `openssl`, więc żaden klucz prywatny nie leży w repozytorium.

## Kto to napisał

Adapter napisało [Wellmade](https://wellmade.online), jednoosobowe studio pracujące na Payloadzie,
headless commerce i WordPressie. Powstał z potrzeby: sklep na Payloadzie stoi na produkcji, a Stripe
nie daje metod płatności, z których realnie korzystają polscy kupujący.

Jeśli adapter jest blisko tego, czego potrzebuje Twój sklep, ale nie do końca, to braki są wypisane
wyżej w sekcji o ograniczeniach. Rozszerzenia, inni polscy dostawcy i praca zlecona nad tym pakietem
są możliwe.

## Licencja

MIT
