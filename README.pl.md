# @wellmade-online/payload-ecommerce-tpay

[![npm](https://img.shields.io/npm/v/@wellmade-online/payload-ecommerce-tpay.svg)](https://www.npmjs.com/package/@wellmade-online/payload-ecommerce-tpay)
[![license](https://img.shields.io/npm/l/@wellmade-online/payload-ecommerce-tpay.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@wellmade-online/payload-ecommerce-tpay.svg)](https://nodejs.org)

Adapter płatności Tpay dla [`@payloadcms/plugin-ecommerce`](https://payloadcms.com). Daje sklepowi na Payload CMS 3 metody płatności, z których realnie korzystają polscy klienci: BLIK, przelewy online (pay-by-link) i karty, na jednym koncie [Tpay](https://tpay.com).

Napisany pod oficjalny kontrakt `PaymentAdapter` z wtyczki, więc wpina się dokładnie tam, gdzie wbudowany adapter Stripe.

*Documentation in English: [README.md](./README.md).*

## Wymagania

- Payload CMS 3.83 lub nowszy z `@payloadcms/plugin-ecommerce`
- Node 20.9 lub nowszy
- Konto sprzedawcy w Tpay (sandbox: [register.sandbox.tpay.com](https://register.sandbox.tpay.com/))

Pakiet powstał i był sprawdzany na Payloadzie i `@payloadcms/plugin-ecommerce` 3.88.0. Wtyczka przypina `payload` do dokładnej wersji we własnych zależnościach peer, więc obie idą razem; ten pakiet przyjmuje linię 3.x i nie deklaruje zgodności z 4.x.

## Instalacja

```bash
npm install @wellmade-online/payload-ecommerce-tpay
```

## Konfiguracja

Po stronie serwera, w konfiguracji Payloada:

```ts
import { ecommercePlugin } from '@payloadcms/plugin-ecommerce'
import { tpayAdapter, PLN } from '@wellmade-online/payload-ecommerce-tpay'

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

**Konfigurację `access` wtyczki zostaw w spokoju, dopóki nie wiesz, czego pilnuje każda funkcja.**
Gospodarz deweloperski w [`dev/`](dev/README.md) ustawia `isDocumentOwner: () => true` i
`publicAccess: () => true`, żeby skrypty mogły go obsłużyć bez logowania. Przeniesiona do sklepu
taka konfiguracja pozwala dowolnemu zalogowanemu klientowi założyć zamówienie samym `POST /api/orders`,
bez płacenia: wtyczka daje `orders` i `transactions` uprawnienie `create: isAdmin`, a `isAdmin` tego
gospodarza to "dowolny zalogowany użytkownik". Nic w tym adapterze nie obroni sklepu, którego własne
kolekcje przyjmują zamówienia od każdego. Zostaw domyślne ustawienia wtyczki albo napisz funkcje
access sprawdzające rolę.

Po stronie przeglądarki, tam gdzie konfigurujesz front sklepu:

```ts
import { tpayAdapterClient } from '@wellmade-online/payload-ecommerce-tpay'

const paymentMethods = [tpayAdapterClient({ label: 'BLIK, przelew, karta' })]
```

### Opcje adaptera

Każda opcja jest opcjonalna; dane dostępowe schodzą do zmiennych środowiskowych, a adapter przerywa start, jeśli `clientId` albo `clientSecret` zostanie pusty.

| Opcja | Typ | Domyślnie | Co robi |
| --- | --- | --- | --- |
| `clientId` | `string` | `TPAY_CLIENT_ID` | Identyfikator klienta OAuth z panelu Tpay (Integracja > API). |
| `clientSecret` | `string` | `TPAY_CLIENT_SECRET` | Sekret OAuth. |
| `merchantId` | `number \| string` | `TPAY_MERCHANT_ID` | Numer sprzedawcy z panelu. Wchodzi do sumy kontrolnej powiadomień. |
| `securityCode` | `string` | `TPAY_SECURITY_CODE` | Kod bezpieczeństwa powiadomień. Bez niego powiadomienia są odrzucane, nigdy przepuszczane. |
| `sandbox` | `boolean` | `TPAY_SANDBOX === 'true'` | Kieruje wszystkie wywołania do API sandboksa. |
| `notificationUrl` | `string` | z `NEXT_PUBLIC_SERVER_URL` albo `PAYLOAD_PUBLIC_SERVER_URL` | Publiczny adres, pod który Tpay wysyła wynik. |
| `payerSuccessUrl` | `string` | brak | Dokąd Tpay odsyła płatnika po udanej płatności. **Ustaw go** - patrz uwaga niżej. |
| `payerErrorUrl` | `string` | brak | Dokąd Tpay odsyła płatnika po nieudanej płatności. |
| `verifyJws` | `boolean` | `true` | Sprawdza nagłówek `X-JWS-Signature` obejmujący całe ciało powiadomienia. `false` wyłącza warstwę świadomie. |
| `jwsRootCertificate` | `string` (PEM) | brak | Certyfikat główny Tpay, żeby sprawdzać też łańcuch, nie sam podpis. |
| `timeoutMs` | `number` | `15000` | Sufit na jedno wywołanie API Tpay. `0` wyłącza. |
| `cartsSlug` | `string` | `'carts'` | Slug kolekcji koszyków. Ustaw, jeśli zmieniłeś jej nazwę - wtyczka podaje własny slug do `confirmOrder`, ale nie do `initiatePayment`. |
| `lang` | `string` | `'pl'` | Język strony płatności Tpay. |
| `label` | `string` | `'Tpay'` | Czytelna nazwa metody płatności. |
| `groupOverrides` | `object` | brak | Nadpisania grupy pól, którą adapter dokłada do `transactions`. |

**`payerSuccessUrl` i `payerErrorUrl` ustaw świadomie.** Adapter wysyła do Tpay adresy powrotu tylko wtedy, gdy je podasz. Bez nich Tpay odeśle płatnika tam, gdzie wskazuje panel sprzedawcy, czyli poza Twój sklep, więc `confirm-order` nigdy nie zostanie wywołane - a to w tym punkcie wtyczka zdejmuje stan magazynowy. Sklep bez tych dwóch ustawień przyjmuje płatności i nie rusza magazynu.

### Zmiana schematu

Adapter dokłada do kolekcji `transactions` grupę pól `tpay`: `transactionId`, `title`, `paymentUrl`, `shippingAddress` i `stockClaimedAt`. Dodanie adaptera zmienia więc schemat bazy - po instalacji uruchom swój zwykły krok migracji Payloada (`payload migrate:create`, potem `payload migrate`, albo push na dev).

Warto znać `tpay.stockClaimedAt`: to nim adapter wydaje wyzwalacz zdjęcia stanu magazynowego najwyżej raz na transakcję. Po tym polu szuka się też rozjazdów w magazynie, bo transakcja zakończona sukcesem, która ma zamówienie, a nie ma `stockClaimedAt`, to taka, której stanu nikt nie zdjął. Patrz sekcja o ograniczeniach.

### Zmienne środowiskowe

| Zmienna | Znaczenie |
|---|---|
| `TPAY_CLIENT_ID` | Identyfikator klienta OAuth, panel Tpay: Integracja > API |
| `TPAY_CLIENT_SECRET` | Sekret OAuth |
| `TPAY_MERCHANT_ID` | Numeryczny identyfikator sprzedawcy, wchodzi do sumy kontrolnej powiadomień |
| `TPAY_SECURITY_CODE` | Kod bezpieczeństwa powiadomień, panel Tpay: Powiadomienia > Bezpieczeństwo |
| `TPAY_SANDBOX` | `true` kieruje wszystkie wywołania do API sandboksa |
| `NEXT_PUBLIC_SERVER_URL` | Służy do zbudowania adresu powiadomień, gdy nie podasz go wprost |

### Limity czasu

Każde wywołanie API Tpay ma termin 15 sekund, a pobranie certyfikatu na potrzeby weryfikacji JWS krótszy, 5 sekund - ten request idzie, gdy powiadomienie czeka na odpowiedź. Dostawca, który przyjmie połączenie i zamilknie, trzymałby inaczej żądanie z kasy albo odpytanie o status BLIK tak długo, jak pozwoli hosting. Pułap dla API zmienia `timeoutMs` na adapterze; `timeoutMs: 0` wyłącza go i zostawia same limity hostingu.

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
4. Klient wraca na `payerSuccessUrl`, a front woła `POST /api/payments/tpay/confirm-order` z `transactionID` zwróconym w kroku 1 **oraz z `cartID`** (a przy koszyku gościa dodatkowo z jego `secret`). Handler wtyczki odrzuca żądanie komunikatem `Cart ID is required.`, zanim w ogóle dojdzie do adaptera, a adapter potem sprawdza ten sam `secret` (albo zalogowanego właściciela) wobec potwierdzanej transakcji, więc wyślij komplet.

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
- **Te punkty świadomie omijają `confirm-order` wtyczki.** Tamten handler jest napisany pod kupującego, który wraca raz, nie pod pętlę: zdejmuje stan magazynowy zawsze, gdy odpowiedź adaptera niesie `transactionID`, a BLIK 0 wymaga odpytywania, aż kod zostanie przyjęty albo odrzucony. Rezerwacja opisana w znanych ograniczeniach utrzymałaby to zdjęcie na jednym, ale odpytanie o status w ogóle nie powinno decydować o stanie magazynu. `/blik-status` domyka zamówienie tą samą, idempotentną drogą, którą robi to powiadomienie serwer-serwer. Druga strona tego medalu jest w znanych ograniczeniach: kasa oparta wyłącznie na BLIK-u nigdy nie uruchomi zdejmowania stanu we wtyczce, więc musi zrobić to sama.

Cała ścieżka przechodzi na prawdziwej instancji Payloada z wpiętą wtyczką w [`dev/`](dev/README.md), razem z odmową: dobry kod przestawia płatność na `paid` z jednym zamówieniem, kod odrzucony daje `rejected` i zostawia płatność otwartą, a kolejny kod wysłany do tej samej płatności domyka ją.

## Czego adapter nie przyjmuje

Punkt odbioru powiadomień to publiczny adres, więc wszystko w nim jest napisane przy założeniu, że ktoś spróbuje podszyć się pod zapłaconą transakcję.

- **Suma kontrolna.** Każde powiadomienie niesie md5 policzone z identyfikatora sprzedawcy, numeru transakcji, kwoty, pola `tr_crc` i kodu bezpieczeństwa. Powiadomienie bez zgodnej sumy dostaje HTTP 400 i nie tworzy zamówienia. Brak konfiguracji też jest odmową, nigdy cichym przepuszczeniem.
- **Czego suma NIE obejmuje.** Te pięć składników to cały przepis, więc `tr_status`, `tr_paid`, `tr_currency`, `tr_email` i `test_mode` zostają poza nim: zmiana któregokolwiek z nich nie psuje sumy. Dwa z nich, `tr_status` i `tr_paid`, to dokładnie te pola, z których adapter odczytuje, że zamówienie jest opłacone. Suma potwierdza więc, **której** transakcji dotyczy wiadomość, a nie **co się z nią stało**. Zmierzone na prawdziwym powiadomieniu z piaskownicy, przypięte testem `test/notification-shape.test.js`.
- **Podpis JWS.** Druga warstwa, **włączona domyślnie**, i jedyna obejmująca całe ciało razem z polami wymienionymi wyżej. Powiadomienie bez poprawnego nagłówka `X-JWS-Signature` dostaje HTTP 400. Certyfikat pobierany jest wyłącznie z hosta Tpay właściwego dla bieżącego środowiska, więc podstawiony `x5u` wskazujący gdziekolwiek indziej odpada, zanim poleci jakiekolwiek żądanie wychodzące. Podanie `jwsRootCertificate` dokłada sprawdzenie łańcucha do korzenia Tpay. `verifyJws: false` wyłącza tę warstwę, przez co opłacone zamówienie dzieli od każdego, kto trafi na ten punkt, tylko jedno wyciekłe ciało powiadomienia - rób to świadomie.
- **`test_mode` nie jest znacznikiem środowiska.** Powiadomienie z piaskownicy przychodzi z `test_mode=0`. Nie rozstrzygaj po tym polu, czy ruch jest testowy - do tego służy własna konfiguracja.
- **Niedopłata.** Przy zwykłym przelewie kwotę wpisuje płatnik. Jeśli wpłynie mniej, niż wynosi zamówienie, zamówienie nie powstaje, a transakcja zostaje w stanie `pending` z wpisem w logu. Tak samo odrzucana jest transakcja, której własnej kwoty nie da się odczytać jako liczby dodatniej: porównanie, którego nie da się wykonać, nie może meldować, że nic nie zalega.
- **Stan płatności bierzemy z API Tpay, nigdy z przeglądarki.** Adres powrotu jest po stronie klienta i da się go otworzyć ręcznie, więc `confirm-order` pyta Tpay, co się faktycznie stało.
- **Dowód zapłaty musi dotyczyć tej konkretnej transakcji.** `confirm-order` i `/blik-status` pytają Tpay o identyfikator transakcji zapisany na dokumencie, nigdy o ten podany w żądaniu, a odpowiedź `correct` liczy się tylko wtedy, gdy Tpay zgłasza tę samą kwotę i walutę co dokument. Bez tego kupujący mógłby zapłacić za tanią transakcję i przedstawić tę zapłatę jako dowód dla drogiej. Niezgodność jest odrzucana, tak samo jak odpowiedź API bez podanej kwoty w ogóle: zmiana kształtu API głośno zatrzymuje sprzedaż, zamiast przepuszczać wszystko bez sprawdzenia.
- **Nikt nie potwierdza transakcji, której nie potrafi udowodnić, że jest jego.** Identyfikatory transakcji to kolejne liczby całkowite, a lokalne API Payloada omija kontrolę dostępu kolekcji, więc `confirm-order` stosuje tę samą bramkę co punkty BLIK: żądanie musi pochodzić od zalogowanego właściciela transakcji albo nieść `secret` koszyka. Ta bramka stoi też przed odpowiedzią "already confirmed", więc `accessToken` zamówienia nigdy nie trafia do obcego, który zgadł identyfikator. Identyfikator, który do niczego nie pasuje, dostaje ten sam komunikat i ten sam HTTP 403 co cudzy, więc po punkcie nie da się przejść zakresem i ustalić, które transakcje istnieją; tak samo jest, gdy koszyk wskazany przez transakcję został skasowany - kto nie potrafi udowodnić, że płatność jest jego, dostaje odmowę, a nie 500.
- **Adres z transakcji wygrywa.** Zamówienie powstaje z e-mailem klienta zapisanym przy `initiate`. E-mail podany w późniejszym żądaniu uzupełnia lukę tylko wtedy, gdy transakcja go nie ma, więc znajomość czyjegoś identyfikatora transakcji nie pozwala przejąć jego zamówienia.
- **Za koszyk płaci się raz.** `initiatePayment` odmawia koszykowi, który ma ustawione `purchasedAt`, bo stojący za nim towar jest już sprzedany, a druga płatność byłaby pobrana za to samo zamówienie. Flagę czytamy z bazy, nie z przekazanego obiektu koszyka: punkt wtyczki wczytuje koszyk bez `purchasedAt`, więc kontrola na tym, co przekazuje, nigdy by nie zadziałała. Jeśli kolekcja koszyków ma inną nazwę, podaj adapterowi jej slug w `cartsSlug` - wtyczka przekazuje swój slug do `confirmOrder`, ale nie do `initiatePayment`. Koszyk, którego nie da się odczytać, zostawia ostrzeżenie w logu i nie blokuje zakupu; to nie jest dowód drugiej płatności.
- **Błędy zostawiają szczegóły w logu.** Wszystko, co nie jest zamierzoną odpowiedzią (`403`, `409`), wraca z punktów BLIK jako stały komunikat; treść wyjątku źródłowego, łącznie ze ścieżkami API Tpay i kodami statusów, trafia wyłącznie do loggera Payloada.

## Kwoty

Payload trzyma pieniądze w jednostkach podrzędnych (grosze, liczba całkowita), Tpay oczekuje wartości dziesiętnych. W drodze na zewnątrz i dla każdej wartości, która przychodzi napisem - treść powiadomienia, `tr_paid`, `tr_amount` - konwersja to samo przestawianie cyfr: napisy dopełniane i cięte, nic nie jest dzielone ani mnożone, bo rozjazd o jeden grosz zmienia sumę kontrolną i płatność zostaje odrzucona bez czytelnego powodu.

Wyjątkiem jest REST API i warto o nim wiedzieć. `GET /transactions/{id}` zwraca `amount` jako liczbę JSON, więc do pakietu wartość trafia już zmiennoprzecinkowa; `apiAmountToMinor` skaluje ją przez `Math.round(value * 10 ** decimals)`. To zaokrąglanie, nie arytmetyka ścisła, i przy dwóch miejscach po przecinku jest dokładne dla każdej kwoty, jaką sklep realnie policzy - błąd iloczynu zostaje daleko poniżej połowy jednostki, która zaokrągliłaby się do złej liczby całkowitej. `test/amount.test.js` przypina te wartości, zamiast kazać brać to na słowo.

```ts
import { minorToDecimalString, decimalStringToMinor } from '@wellmade-online/payload-ecommerce-tpay'

minorToDecimalString(1999) // '19.99'
decimalStringToMinor('19.99') // 1999
```

**Tylko waluty dwucyfrowe.** Każda konwersja zakłada tu jednostkę podrzędną o dwóch miejscach po przecinku - to domyślna wartość ISO 4217 i tak jest dla wszystkiego, co rozlicza Tpay (PLN, EUR, USD, GBP). Waluta o innym wykładniku - jen nie ma miejsc po przecinku, dinar kuwejcki ma trzy - zostaje odrzucona przez `initiatePayment` głośnym błędem, zamiast zostać przeliczona o rząd wielkości za nisko; ta sama tabela pilnuje kontroli na drodze powrotnej, więc taka waluta nie przejdzie przez bramkę kwoty dzięki temu, że obie strony pomyliły się tak samo. Usuń ją z `supportedCurrencies` wtyczki.

## Znane ograniczenia

- **Stan magazynowy zdejmuje punkt `confirm-order` z wtyczki i tylko wtedy, gdy kupujący wróci.**
  Handler wtyczki zdejmuje towar zawsze, gdy odpowiedź adaptera niesie `transactionID`, i sam nie ma
  żadnego zabezpieczenia przed powtórzeniem: zmierzone na żywej instancji z plugin-ecommerce 3.88.0,
  dwa identyczne wywołania `confirm-order` dla jednej, już domkniętej transakcji zdjęły stan z 5 na 4,
  a potem na 3. Adapter wydaje teraz ten wyzwalacz **najwyżej raz na transakcję**. Rezerwacja to
  warunkowy zapis `tpay.stockClaimedAt` na dokumencie transakcji, więc `transactionID` dostaje
  wyłącznie to wywołanie, które ją wygrało; odświeżona strona powrotu, druga karta przeglądarki
  i ręcznie napisany `curl` dostają tę samą odpowiedź bez wyzwalacza, a stan zostaje na miejscu. Nie
  ma przy tym znaczenia, która droga domknęła zamówienie: pierwsze `confirm-order` kupującego,
  powtórzone i powiadomienie, które zamknęło zamówienie przed powrotem przeglądarki, przechodzą przez
  tę samą rezerwację.

- **Druga strona tego jest świadoma: płatność domknięta wyłącznie powiadomieniem nie rusza stanu.**
  Jeśli klient zapłaci i nigdy nie wróci do sklepu, nic nie wywoła `confirm-order`, więc zdejmowanie
  stanu we wtyczce się nie wykona. Adapter nie zdejmuje stanu również w torze powiadomień, bo wtedy
  kupujący, który jednak wrócił, zabrałby drugą sztukę. Domknięcie tego przypadku jest po stronie
  sklepu, a polem do sprawdzenia jest `tpay.stockClaimedAt`: transakcja `succeeded` z zamówieniem
  i bez `stockClaimedAt` to taka, której stanu nikt nie skorygował.
- **Kasa na BLIK-u nie rusza stanu magazynowego w ogóle, dopóki sklep nie zrobi tego sam.** Dwa
  ograniczenia wyżej mówią o `confirm-order` wywoływanym zbyt często, to jest odwrotne. BLIK 0 nigdy
  nie odsyła przeglądarki nigdzie, więc kasa zbudowana wyłącznie na `/blik` i `/blik-status` nie
  wywołuje `confirm-order` i nie dociera do zdejmowania stanu we wtyczce. Zmierzone na żywej
  instancji: domknięta płatność BLIK-iem utworzyła zamówienie i zostawiła stan na 5. Stan trzeba
  zdjąć samodzielnie, raz, przy pierwszej odpowiedzi `paid` z `/blik-status`.
- **Znacznik "stan już skorygowany" zapisuj na zamówieniu, nie w pamięci procesu.** Sklep demo
  trzyma ten znacznik w zbiorze na poziomie procesu, co wystarcza do demo, ale jest błędem w sklepie:
  restart go zapomina, a kolejna odpowiedź `paid` zdejmie stan z tej samej transakcji jeszcze raz.
  Zapisz go na dokumencie zamówienia.
- **Chargeback zmienia transakcję, nie zamówienie.** Powiadomienie `CHARGEBACK` ustawia transakcję
  na `refunded`, a zamówienie zostawia w stanie `processing`. Sklep, który obserwuje wyłącznie
  zamówienia, nie zobaczy, że pieniądze wróciły - obserwuj status transakcji albo dodaj hak, który
  go odzwierciedla.
- **Domknięcie zamówienia nie jest atomowym compare-and-swap.** `payload.update` z warunkiem `where` to wyszukanie, a dopiero potem zapis po dokumencie, więc zostaje wąskie okno, w którym powiadomienie i przeglądarka uznają się jednocześnie za tego, kto domknął zamówienie. Skutkiem jest osierocony dokument zamówienia, nigdy podwójne obciążenie, bo płatność jest jedna. Domknięcie okna oznaczałoby ominięcie haków kolekcji, co jest gorszym wyborem. O zwycięstwie decyduje to, kto pierwszy przypnie zamówienie, a nie status transakcji: transakcja, która już ma zamówienie, dostaje z powrotem to samo, a transakcja bez zamówienia dostaje je na zweryfikowane powiadomienie o zapłacie także wtedy, gdy jej status zdążył się zmienić, bo rozliczona odmowa i późniejsza wpłata nie mogą kosztować kupującego zamówienia.
- **Sklep demo koryguje stan z koszyka, a zamówienie powstaje z transakcji.** Jego trasa
  `/shop/decrement-stock` czyta `cart.items`, podczas gdy zamówienie tworzone tutaj bierze się
  z `transaction.items` - z migawki zrobionej w chwili rozpoczęcia płatności. W demo te dwie listy
  są takie same, w sklepie mogą się różnić, bo koszyk daje się edytować po `initiate` (druga karta,
  powolny kupujący). Stan zdejmuj z pozycji transakcji, czyli z tej listy, z której naprawdę powstaje
  zamówienie.
- **`secret` koszyka gościa wydaje wtyczka raz, przy zakładaniu koszyka.** Nie ma rotacji i adapter
  jej nie dokłada: kto ma kopię, udowodni ten koszyk aż do zakupu - i właśnie dlatego sekret nie może
  wędrować w adresie URL, w linii logu ani w zdarzeniu analitycznym. Trzymaj go tam, gdzie żyje
  koszyk, i wysyłaj wyłącznie w ciele żądania.
- Płatności cykliczne, tokenizacja kart, transakcje marketplace i zwroty przez API nie są zaimplementowane.

## Praca nad pakietem

```bash
npm install
npm test     # najpierw budowanie, potem suita
```

Suita chodzi offline, na atrapach i danych testowych: konto Tpay nie jest do niej potrzebne. Certyfikaty do testów podpisu powstają w trakcie testu przez `openssl`, więc żaden klucz prywatny nie leży w repozytorium.

### Sklep demo

W [`dev/`](dev/README.md) stoi prawdziwa instancja Payloada z `@payloadcms/plugin-ecommerce` i tym adapterem, a obok sklep do przeklikania: katalog, koszyk i kasa z polem na sześciocyfrowy kod BLIK obok przycisku „zapłać na stronie Tpay". Panel z boku pokazuje, co każdy krok realnie zapisał w bazie. Na tym mierzono zachowania opisane w tym pliku i tędy najszybciej zobaczyć adapter w działaniu przed wpięciem go do własnego sklepu.

```bash
npm install && npm run build          # host importuje zbudowane ../dist
cd dev
pnpm install
export TPAY_CLIENT_ID=... TPAY_CLIENT_SECRET=... TPAY_MERCHANT_ID=... TPAY_SECURITY_CODE=...
export NEXT_PUBLIC_SERVER_URL=https://<publiczny tunel na 127.0.0.1:8099>
node --import tsx shop.mts            # potem otwórz http://127.0.0.1:8099/
```

Wystarczą dane z sandboksa; host sam ustawia `sandbox: true`. Ścieżka BLIK nie potrzebuje tunelu, bo stan płatności odczytuje pytaniem do Tpay, a nie czekaniem na powiadomienie; ścieżka z przekierowaniem potrzebuje, bo Tpay dostarcza wynik żądaniem serwer-serwer, które nigdy nie trafi pod adres lokalny. `dev/README.md` opisuje tunel, gotowe przebiegi dla przyjętego i odrzuconego kodu BLIK oraz kontrolę instrumentu, którą robi się, zanim uzna się ciszę na punkcie powiadomień za wynik.

Konfiguracja `access` w `dev/payload.config.ts` jest świadomie otwarta na oścież, żeby skrypty mogły sterować instancją bez logowania. Nie kopiuj jej do sklepu; sekcja o konfiguracji wyżej mówi dlaczego.

## Kto to napisał

Adapter napisało i utrzymuje [Wellmade](https://wellmade.online), studio budujące sklepy na Payloadzie i w headless commerce. Powstał z potrzeby: sklep na Payloadzie stoi na produkcji, a Stripe nie daje metod płatności, z których realnie korzystają polscy kupujący.

Braki są wypisane wyżej w sekcji o ograniczeniach; zgłoszenia i pull requesty są mile widziane, praca zlecona nad tym pakietem też jest możliwa.

## Licencja

MIT - patrz [LICENSE](./LICENSE). Copyright (c) 2026 Wellmade.
