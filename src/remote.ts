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
 * Status `correct` po stronie Tpay mowi, ze JAKAS transakcja zostala oplacona.
 * Zanim domkniemy zamowienie, musi to byc TA transakcja: o tej samej kwocie
 * i w tej samej walucie, co dokument w naszej bazie. Bez tego porownania dowod
 * zaplaty za tania transakcje daloby sie podstawic pod droga (audyt 11.09.2026,
 * ustalenia K-1 i W-4). Powiadomienie serwer-serwer ma odpowiednik tej bramki
 * w postaci porownania `tr_paid` z kwota transakcji.
 *
 * Brak kwoty albo waluty w odpowiedzi API jest odmowa, nie pominieciem: przy
 * pieniadzach zmiana ksztaltu odpowiedzi ma zatrzymac sprzedaz glosno, a nie
 * przepuszczac wszystko po cichu.
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
