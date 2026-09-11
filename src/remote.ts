import { apiAmountToMinor } from './amount.js'
import type { TpayTransaction } from './client.js'

type AnyDoc = Record<string, any>

export class RemoteMismatchError extends Error {
  public readonly status = 409

  constructor(message: string) {
    super(message)
    this.name = 'RemoteMismatchError'
  }
}

/**
 * A `correct` status on Tpay's side says that SOME transaction has been paid.
 * Before we close the order it has to be THIS transaction: the same amount and
 * the same currency as the document in our database. Without that comparison,
 * proof of payment for a cheap transaction could be substituted for an expensive
 * one (audit 11.09.2026, findings K-1 and W-4). The server-to-server
 * notification has its counterpart of this gate in the comparison of `tr_paid`
 * against the transaction amount.
 *
 * A missing amount or currency in the API response is a refusal, not something
 * to skip over: where money is involved, a change in the shape of the response
 * has to stop the sale loudly rather than let everything through quietly.
 */
export const assertRemoteMatchesTransaction = (args: {
  remote: TpayTransaction | undefined
  transaction: AnyDoc
}): void => {
  const { remote, transaction } = args

  const expectedMinor = Number(transaction.amount)
  const remoteMinor = apiAmountToMinor(remote?.amount)

  if (!Number.isFinite(expectedMinor) || remoteMinor === undefined || remoteMinor !== expectedMinor) {
    throw new RemoteMismatchError(
      `Tpay transaction amount does not match the transaction being confirmed (expected ${String(transaction.amount)} minor units, Tpay reports ${String(remote?.amount)}).`,
    )
  }

  const expectedCurrency = String(transaction.currency ?? '').toUpperCase()
  const remoteCurrency = String(remote?.currency ?? '').toUpperCase()

  if (!expectedCurrency || !remoteCurrency || expectedCurrency !== remoteCurrency) {
    throw new RemoteMismatchError(
      `Tpay transaction currency does not match the transaction being confirmed (expected ${expectedCurrency || '(none)'}, Tpay reports ${remoteCurrency || '(none)'}).`,
    )
  }
}
