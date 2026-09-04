/**
 * Klient Tpay Open API.
 *
 * Uwierzytelnienie: OAuth client credentials. Token zyje 7200 s, wiec trzymamy go
 * w pamieci procesu i odswiezamy z zapasem. Bez tego kazde utworzenie transakcji
 * to dwa zadania zamiast jednego.
 */

export const TPAY_PRODUCTION_URL = 'https://api.tpay.com'
export const TPAY_SANDBOX_URL = 'https://openapi.sandbox.tpay.com'

export type TpayClientOptions = {
  /** Nadpisuje adres API. Podanie tego pola wygrywa z `sandbox`. */
  baseUrl?: string
  clientId: string
  clientSecret: string
  /** Wstrzykiwalny fetch - w testach zamiast sieci. */
  fetchImpl?: typeof fetch
  /** Margines odswiezenia tokenu przed jego wygasnieciem, w sekundach. */
  refreshMarginSeconds?: number
  sandbox?: boolean
}

export type TpayPayer = {
  address?: string
  city?: string
  code?: string
  country?: string
  email: string
  name: string
  phone?: string
}

export type TpayTransactionRequest = {
  amount: number | string
  callbacks?: {
    notification?: {
      email?: string
      url?: string
    }
    payerUrls?: {
      error?: string
      success?: string
    }
  }
  currency?: string
  description: string
  hiddenDescription?: string
  lang?: string
  pay?: Record<string, unknown>
  payer: TpayPayer
}

export type TpayTransaction = {
  [key: string]: unknown
  amount?: number
  currency?: string
  hiddenDescription?: string
  status?: string
  title?: string
  transactionId?: string
  transactionPaymentUrl?: string
}

export class TpayApiError extends Error {
  public readonly body: unknown
  public readonly status: number

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = 'TpayApiError'
    this.status = status
    this.body = body
  }
}

export class TpayClient {
  private readonly baseUrl: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly fetchImpl: typeof fetch
  private readonly refreshMarginSeconds: number
  private token: null | { expiresAt: number; value: string } = null

  constructor(options: TpayClientOptions) {
    const { baseUrl, clientId, clientSecret, fetchImpl, refreshMarginSeconds, sandbox } = options

    if (!clientId || !clientSecret) {
      throw new Error('Tpay clientId and clientSecret are required.')
    }

    this.baseUrl = (baseUrl || (sandbox ? TPAY_SANDBOX_URL : TPAY_PRODUCTION_URL)).replace(/\/+$/, '')
    this.clientId = clientId
    this.clientSecret = clientSecret
    this.fetchImpl = fetchImpl || globalThis.fetch
    this.refreshMarginSeconds = refreshMarginSeconds ?? 60
  }

  /** Zwraca wazny token, biorac go z pamieci albo pobierajac nowy. */
  public async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.token && this.token.expiresAt > Date.now()) {
      return this.token.value
    }

    const response = await this.fetchImpl(`${this.baseUrl}/oauth/auth`, {
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }).toString(),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
    })

    const body = (await this.readBody(response)) as { access_token?: string; expires_in?: number }

    if (!response.ok || !body?.access_token) {
      throw new TpayApiError('Tpay authentication failed', response.status, body)
    }

    const expiresIn = Number(body.expires_in) > 0 ? Number(body.expires_in) : 7200

    this.token = {
      expiresAt: Date.now() + Math.max(0, expiresIn - this.refreshMarginSeconds) * 1000,
      value: body.access_token,
    }

    return this.token.value
  }

  public async createTransaction(payload: TpayTransactionRequest): Promise<TpayTransaction> {
    return await this.request<TpayTransaction>('POST', '/transactions', payload)
  }

  public async getTransaction(transactionId: string): Promise<TpayTransaction> {
    if (!transactionId) {
      throw new Error('A transaction ID is required.')
    }

    return await this.request<TpayTransaction>(
      'GET',
      `/transactions/${encodeURIComponent(transactionId)}`,
    )
  }

  private async readBody(response: Response): Promise<unknown> {
    const text = await response.text()

    if (!text) {
      return undefined
    }

    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  /**
   * Jedno ponowienie po 401: token moze wygasnac miedzy sprawdzeniem a dotarciem
   * zadania do Tpay, a takze po restarcie po stronie dostawcy.
   */
  private async request<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const send = async (token: string): Promise<Response> =>
      await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        method,
      })

    let response = await send(await this.getAccessToken())

    if (response.status === 401) {
      response = await send(await this.getAccessToken(true))
    }

    const body = await this.readBody(response)

    if (!response.ok) {
      throw new TpayApiError(
        `Tpay request failed: ${method} ${path}`,
        response.status,
        body,
      )
    }

    return body as T
  }
}
