import type { PayloadRequest } from 'payload'

type AnyDoc = Record<string, any>

/**
 * Tpay's BLIK channel identifier. Measured 07.09.2026 by reading
 * `GET /transactions/channels` on the sandbox: channel `id: "64"`, group `id: "150"`,
 * `instantRedirection: false`.
 */
export const BLIK_CHANNEL_ID = 64

/** Tpay accepts a BLIK code only as a pay-by-link method with channel 64. */
export const BLIK_METHOD = 'pay_by_link'

/** A BLIK code has exactly this many digits. */
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
 * The buyer types the code out of their banking app, so it sometimes contains a
 * space or a hyphen. We strip everything but digits before checking anything.
 */
export const normalizeBlikToken = (raw: unknown): string =>
  typeof raw === 'string' || typeof raw === 'number' ? String(raw).replace(/\D/g, '') : ''

/**
 * We check the length here rather than waiting for Tpay's response, because a
 * BLIK code is single-use and valid for about two minutes: every needless
 * request eats into the time the buyer has to confirm it in the app.
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
 * Decides whether a request is allowed to touch this payment.
 *
 * The transaction identifier alone is NOT enough. It is predictable enough that
 * without this check a stranger could poll the state of other people's payments
 * and, while at it, send their own codes to them. We accept two proofs, the same
 * ones the rest of the ecommerce plugin stands on: the logged-in owner of the
 * transaction, and the cart secret, known only to the browser that created that
 * cart.
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

    // A constant-time comparison is not needed here: the secret is random and
    // long, and every attempt requires a separate network request.
    if (cart?.secret && String(cart.secret) === secret) {
      return
    }
  }

  throw new BlikError('You are not allowed to access this payment.', 403)
}
