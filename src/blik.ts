import type { PayloadRequest } from 'payload'

type AnyDoc = Record<string, any>

/**
 * Identyfikator kanalu BLIK w Tpay. Zmierzone 07.09.2026 odczytem
 * `GET /transactions/channels` na piaskownicy: kanal `id: "64"`, grupa `id: "150"`,
 * `instantRedirection: false`.
 */
export const BLIK_CHANNEL_ID = 64

/** Tpay przyjmuje kod BLIK wylacznie jako metode pay-by-link z kanalem 64. */
export const BLIK_METHOD = 'pay_by_link'

/** Kod BLIK ma dokladnie tyle cyfr. */
export const BLIK_TOKEN_LENGTH = 6

export class BlikError extends Error {
  public readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'BlikError'
    this.status = status
  }
}

/**
 * Kupujacy wpisuje kod z aplikacji banku, wiec bywa w nim spacja albo myslnik.
 * Zdejmujemy wszystko poza cyframi, zanim cokolwiek sprawdzimy.
 */
export const normalizeBlikToken = (raw: unknown): string =>
  typeof raw === 'string' || typeof raw === 'number' ? String(raw).replace(/\D/g, '') : ''

/**
 * Dlugosc sprawdzamy u siebie, a nie dopiero po odpowiedzi Tpay, bo kod BLIK
 * jest jednorazowy i wazny okolo dwoch minut: kazde niepotrzebne zadanie zjada
 * czas, ktory kupujacy ma na potwierdzenie w aplikacji.
 */
export const assertBlikToken = (raw: unknown): string => {
  const token = normalizeBlikToken(raw)

  if (!token) {
    throw new BlikError('A BLIK code is required.')
  }

  if (token.length !== BLIK_TOKEN_LENGTH) {
    throw new BlikError(`A BLIK code must be exactly ${BLIK_TOKEN_LENGTH} digits long.`)
  }

  return token
}

/**
 * Rozstrzyga, czy zadanie ma prawo dotknac tej platnosci.
 *
 * Sam identyfikator transakcji NIE wystarcza. Jest przewidywalny na tyle, ze
 * bez tego sprawdzenia obcy moglby odpytywac stan cudzych platnosci, a przy
 * okazji wysylac do nich wlasne kody. Uznajemy dwa dowody, te same, na ktorych
 * stoi reszta wtyczki e-commerce: zalogowanego wlasciciela transakcji oraz
 * sekret koszyka, ktory zna wylacznie przegladarka, ktora ten koszyk zalozyla.
 */
export const assertTransactionAccess = async (args: {
  cartsSlug: string
  req: PayloadRequest
  secret?: unknown
  transaction: AnyDoc
}): Promise<void> => {
  const { cartsSlug, req, secret, transaction } = args

  const customerID =
    typeof transaction.customer === 'object' ? transaction.customer?.id : transaction.customer

  if (req.user && customerID && String(req.user.id) === String(customerID)) {
    return
  }

  const cartID = typeof transaction.cart === 'object' ? transaction.cart?.id : transaction.cart

  if (cartID && typeof secret === 'string' && secret.length > 0) {
    const cart = (await req.payload.findByID({
      id: cartID,
      collection: cartsSlug,
      depth: 0,
      overrideAccess: true,
      req,
      select: { secret: true },
    })) as AnyDoc | undefined

    // Porownanie o stalym czasie nie jest tu potrzebne: sekret jest losowy
    // i dlugi, a kazda proba wymaga osobnego zadania sieciowego.
    if (cart?.secret && String(cart.secret) === secret) {
      return
    }
  }

  throw new BlikError('You are not allowed to access this payment.', 403)
}
