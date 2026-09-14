/**
 * Tpay Open API client.
 *
 * Authentication: OAuth client credentials. The token lives for 7200 s, so we
 * keep it in process memory and refresh it with a margin. Without that, every
 * transaction creation would be two requests instead of one.
 */

export const TPAY_PRODUCTION_URL = 'https://api.tpay.com'
export const TPAY_SANDBOX_URL = 'https://openapi.sandbox.tpay.com'

export type TpayClientOptions = {
  /** Overrides the API URL. Setting this field wins over `sandbox`. */
  baseUrl?: string
  clientId: string
  clientSecret: string
  /** Injectable fetch - used in tests instead of the network. */
  fetchImpl?: typeof fetch
  /** Margin for refreshing the token before it expires, in seconds. */
  refreshMarginSeconds?: number
  sandbox?: boolean
  /**
   * Ceiling on a single request to Tpay, in milliseconds. Defaults to 15000.
   * Without it a provider that accepts the connection and then says nothing
   * holds a checkout request open for as long as the host allows, and BLIK
   * status polling turns that into a pile of stuck requests. `0` turns the
   * timeout off, which means the host's own limits are the only ones left.
   */
  timeoutMs?: number
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

/**
 * Body of the `POST /transactions/{id}/pay` request. Note: here the fields sit
 * FLAT, while on transaction creation the same fields sit under the `pay` key.
 * Source: tpay-com/tpay-woocommerce, includes/TpayBlik.php.
 */
export type TpayPayRequest = {
  blikPaymentData?: {
    aliases?: { label?: string; type: string; value: string }
    blikToken?: string
    type?: number
  }
  channelId?: number
  method?: string
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
  private readonly timeoutMs: number
  private token: null | { expiresAt: number; value: string } = null

  constructor(options: TpayClientOptions) {
    const {
      baseUrl,
      clientId,
      clientSecret,
      fetchImpl,
      refreshMarginSeconds,
      sandbox,
      timeoutMs,
    } = options

    if (!clientId || !clientSecret) {
      throw new Error('Tpay clientId and clientSecret are required.')
    }

    this.baseUrl = (baseUrl || (sandbox ? TPAY_SANDBOX_URL : TPAY_PRODUCTION_URL)).replace(/\/+$/, '')
    this.clientId = clientId
    this.clientSecret = clientSecret
    this.fetchImpl = fetchImpl || globalThis.fetch
    this.refreshMarginSeconds = refreshMarginSeconds ?? 60
    this.timeoutMs = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 15_000
  }

  /**
   * Abort signal for a single outgoing request. Every call to Tpay carries one:
   * a socket that connects and then goes quiet would otherwise keep a checkout
   * request, or a BLIK status poll, waiting for whatever the host permits.
   */
  private abortSignal(): AbortSignal | undefined {
    if (!(this.timeoutMs > 0)) {
      return undefined
    }

    return AbortSignal.timeout(this.timeoutMs)
  }

  /** Returns a valid token, taking it from memory or fetching a new one. */
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
      signal: this.abortSignal(),
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

  /**
   * Sends payment data to an existing transaction. This is how BLIK 0 works:
   * the transaction is created without a method, and the code from the shop
   * checkout goes in a separate request, so a rejected or expired code can be
   * retried without creating a new transaction.
   *
   * NOTE: `result: success` in the response means only that Tpay accepted the
   * request. It does NOT mean the code is correct - measured 07.09.2026 on the
   * sandbox, where the code `abcdef` went through as `success`/`pending`.
   * The verdict comes later, in the transaction status and the notification.
   */
  public async payByTransactionId(
    transactionId: string,
    fields: TpayPayRequest,
  ): Promise<TpayTransaction> {
    if (!transactionId) {
      throw new Error('A transaction ID is required.')
    }

    return await this.request<TpayTransaction>(
      'POST',
      `/transactions/${encodeURIComponent(transactionId)}/pay`,
      fields,
    )
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
   * A single retry after a 401: the token can expire between the check and the
   * request reaching Tpay, and also after a restart on the provider's side.
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
        // A fresh signal per attempt: the retry after a 401 is a new request and
        // must not inherit a clock that has already been running.
        signal: this.abortSignal(),
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
