import type { PayloadRequest } from 'payload'

type AnyDoc = Record<string, any>

type FinalizeArgs = {
  cartsSlug?: string
  customerEmail?: string
  ordersSlug?: string
  req: PayloadRequest
  /** Dokument transakcji z kolekcji `transactions`. */
  transaction: AnyDoc
  transactionsSlug: string
}

export type FinalizeResult = {
  /** Czy zamowienie powstalo w tym wywolaniu (false = bylo juz wczesniej). */
  created: boolean
  order: AnyDoc | null
  /** Powod, dla ktorego zamowienia nie ma, gdy `order` jest puste. */
  reason?: string
}

const idOf = (value: unknown): string | undefined => {
  if (!value) {
    return undefined
  }

  if (typeof value === 'object') {
    return (value as AnyDoc).id ? String((value as AnyDoc).id) : undefined
  }

  return String(value)
}

/**
 * Zamyka zamowienie na podstawie transakcji, dokladnie raz.
 *
 * Wywoluja to dwie niezalezne sciezki: powiadomienie serwer-serwer od Tpay
 * i powrot przegladarki klienta (`confirmOrder`). Obie moga dojsc jednoczesnie,
 * a nawet czesto dochodza, bo Tpay wysyla powiadomienie w tej samej chwili,
 * w ktorej przeglada klienta wraca na strone sklepu.
 *
 * Kolejnosc jest odwrotna do intuicyjnej i to jest w niej najwazniejsze:
 * zamowienie powstaje PRZED przestawieniem statusu transakcji. Warunkowa
 * aktualizacja (`status: pending` -> `succeeded`) rozstrzyga, kto wygral;
 * przegrany kasuje swoje swiezo utworzone zamowienie, ktorego nikt jeszcze nie
 * widzial, i zwraca zamowienie zwyciezcy. Gdyby bylo odwrotnie (najpierw status,
 * potem zamowienie), awaria miedzy jednym a drugim zostawialaby transakcje
 * oplacona bez zamowienia i bez sciezki wyjscia - stan, z ktorego nie ma
 * automatycznego powrotu.
 *
 * Czego to NIE gwarantuje. `payload.update` z `where` nie jest atomowym
 * compare-and-swap: Payload wykonuje `db.find`, a dopiero potem zapis po
 * dokumencie (`node_modules/payload/dist/collections/operations/update.js`).
 * Zostaje wiec waskie okno, w ktorym oba wywolania widza status `pending`
 * i oba uznaja sie za zwyciezce. Skutkiem jest osierocony dokument zamowienia,
 * do ktorego nic nie prowadzi - nie podwojne obciazenie platnika, bo platnosc
 * jest jedna. Domkniecie tego okna wymaga `payload.db.updateOne` z warunkiem,
 * co z kolei omija haki kolekcji, na ktorych sklepy potrafia polegac. Wybor
 * pada na haki; reszta jest opisana w README jako znane ograniczenie.
 */
export async function finalizeOrder(args: FinalizeArgs): Promise<FinalizeResult> {
  const {
    cartsSlug = 'carts',
    customerEmail,
    ordersSlug = 'orders',
    req,
    transaction,
    transactionsSlug,
  } = args

  const payload = req.payload

  const existingOrderID = idOf(transaction.order)

  if (existingOrderID) {
    const existing = await payload.findByID({
      id: existingOrderID,
      collection: ordersSlug,
      req,
    })

    return { created: false, order: existing as AnyDoc }
  }

  const customerID = idOf(transaction.customer)
  const email = customerEmail || transaction.customerEmail

  const order = (await payload.create({
    collection: ordersSlug,
    data: {
      amount: transaction.amount,
      currency: transaction.currency,
      ...(customerID ? { customer: customerID } : email ? { customerEmail: email } : {}),
      items: transaction.items,
      ...(transaction.tpay?.shippingAddress
        ? { shippingAddress: transaction.tpay.shippingAddress }
        : {}),
      status: 'processing',
      transactions: [transaction.id],
    },
    req,
  })) as AnyDoc

  const claimed = await payload.update({
    collection: transactionsSlug,
    data: {
      order: order.id,
      status: 'succeeded',
    },
    req,
    where: {
      and: [{ id: { equals: transaction.id } }, { status: { equals: 'pending' } }],
    },
  })

  const won = Array.isArray(claimed?.docs) && claimed.docs.length > 0

  if (!won) {
    // Ktos inny domknal te transakcje w tej samej chwili. Kasujemy wlasne
    // zamowienie, zanim ktokolwiek je zobaczy, i zwracamy to, ktore zostalo.
    try {
      await payload.delete({ id: order.id, collection: ordersSlug, req })
    } catch (error) {
      payload.logger.error({
        err: error,
        msg: `Tpay: could not remove the duplicate order ${String(order.id)} after losing the finalisation race`,
      })
    }

    const fresh = (await payload.findByID({
      id: transaction.id,
      collection: transactionsSlug,
      req,
    })) as AnyDoc

    const winnerOrderID = idOf(fresh?.order)

    if (!winnerOrderID) {
      return {
        created: false,
        order: null,
        reason: 'Transaction was finalised concurrently but carries no order',
      }
    }

    const winnerOrder = await payload.findByID({
      id: winnerOrderID,
      collection: ordersSlug,
      req,
    })

    return { created: false, order: winnerOrder as AnyDoc }
  }

  const cartID = idOf(transaction.cart)

  if (cartID) {
    try {
      await payload.update({
        id: cartID,
        collection: cartsSlug,
        data: { purchasedAt: new Date().toISOString() },
        req,
      })
    } catch (error) {
      // Koszyk oznaczony jako kupiony to wygoda, nie warunek zamowienia.
      payload.logger.error({
        err: error,
        msg: `Tpay: could not mark cart ${cartID} as purchased`,
      })
    }
  }

  return { created: true, order }
}

/**
 * Ustawia koncowy status transakcji, ktora nie konczy sie zamowieniem
 * (odmowa, wycofanie srodkow). Nigdy nie cofa transakcji juz udanej -
 * poza wycofaniem srodkow, ktore jest wlasnie zmiana po udanej platnosci.
 */
export async function markTransactionStatus(args: {
  req: PayloadRequest
  status: 'cancelled' | 'expired' | 'failed' | 'refunded'
  transaction: AnyDoc
  transactionsSlug: string
}): Promise<void> {
  const { req, status, transaction, transactionsSlug } = args

  if (transaction.status === status) {
    return
  }

  if (transaction.status === 'succeeded' && status !== 'refunded') {
    return
  }

  await req.payload.update({
    id: transaction.id,
    collection: transactionsSlug,
    data: { status },
    req,
  })
}
