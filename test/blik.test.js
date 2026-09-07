import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { assertBlikToken, normalizeBlikToken } from '../dist/blik.js'
import { blikEndpoint, blikStatusEndpoint } from '../dist/endpoints/blik.js'
import { makeReq, PayloadStub } from './helpers/payload-stub.js'

const SEKRET = 'sekret-koszyka-abc'

const seed = (payload, overrides = {}) => {
  payload.seed('carts', { id: 'carts-1', secret: SEKRET })

  return payload.seed('transactions', {
    id: 'transactions-1',
    amount: 1999,
    cart: 'carts-1',
    currency: 'PLN',
    customerEmail: 'klient@example.pl',
    items: [{ product: 'products-1', quantity: 1 }],
    paymentMethod: 'tpay',
    status: 'pending',
    tpay: { transactionId: 'TR-1' },
    ...overrides,
  })
}

/** Atrapa klienta Tpay, ktora zlicza wywolania obu istotnych metod. */
const makeClient = (status = 'pending', payments = undefined) => {
  const wyslane = []
  const odpytane = []

  return {
    client: {
      getTransaction: async (id) => {
        odpytane.push(id)

        return { status, transactionId: id, ...(payments ? { payments } : {}) }
      },
      payByTransactionId: async (id, fields) => {
        wyslane.push({ fields, id })

        // Tpay odpowiada `success` takze na kod, ktory jest bledny -
        // zmierzone na piaskownicy 07.09.2026.
        return { result: 'success', status: 'pending' }
      },
    },
    odpytane,
    wyslane,
  }
}

const wywolaj = async (endpoint, payload, ciało, extra = {}) => {
  const response = await endpoint.handler(makeReq(payload, { data: ciało, ...extra }))

  return { body: await response.json(), status: response.status }
}

describe('kod BLIK: postac i dlugosc', () => {
  it('zdejmuje z kodu wszystko poza cyframi', () => {
    assert.equal(normalizeBlikToken('123 456'), '123456')
    assert.equal(normalizeBlikToken('123-456'), '123456')
  })

  it('odrzuca kod o zlej dlugosci komunikatem o dlugosci', () => {
    assert.throws(() => assertBlikToken('12345'), /exactly 6 digits/)
    assert.throws(() => assertBlikToken('1234567'), /exactly 6 digits/)
    assert.throws(() => assertBlikToken(''), /BLIK code is required/)
  })
})

describe('wyslanie kodu BLIK', () => {
  it('nie wysyla do Tpay kodu o zlej dlugosci', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client, wyslane } = makeClient()

    const { body, status } = await wywolaj(blikEndpoint({ client }), payload, {
      blikToken: '12345',
      secret: SEKRET,
      transactionID: 'transactions-1',
    })

    assert.equal(status, 400)
    assert.match(body.message, /exactly 6 digits/)
    assert.equal(wyslane.length, 0, 'zly kod nie moze zajac proby u posrednika')
  })

  it('wysyla kod z kanalem BLIK i nie oglasza zaplaty, mimo ze Tpay odpowiada success', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client, wyslane } = makeClient()

    const { body, status } = await wywolaj(blikEndpoint({ client }), payload, {
      blikToken: '777 123',
      secret: SEKRET,
      transactionID: 'transactions-1',
    })

    assert.equal(status, 200)
    assert.equal(body.status, 'pending')
    assert.match(body.message, /banking app/)
    assert.equal(wyslane.length, 1)
    assert.equal(wyslane[0].id, 'TR-1')
    assert.equal(wyslane[0].fields.channelId, 64)
    assert.equal(wyslane[0].fields.method, 'pay_by_link')
    assert.deepEqual(wyslane[0].fields.blikPaymentData, { blikToken: '777123', type: 0 })
  })

  it('pozwala podac kolejny kod do tej samej platnosci po nieudanej probie', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client, wyslane } = makeClient()
    const endpoint = blikEndpoint({ client })

    await wywolaj(endpoint, payload, { blikToken: '111111', secret: SEKRET, transactionID: 'transactions-1' })
    const druga = await wywolaj(endpoint, payload, { blikToken: '222222', secret: SEKRET, transactionID: 'transactions-1' })

    assert.equal(druga.status, 200)
    assert.equal(wyslane.length, 2, 'druga proba idzie do tej samej transakcji')
    assert.equal(wyslane[1].id, 'TR-1')
    assert.equal(payload.docs('transactions').length, 1, 'nie powstaje druga transakcja')
  })

  it('nie wysyla kodu do platnosci juz domknietej', async () => {
    const payload = new PayloadStub()
    seed(payload, { order: 'orders-1', status: 'succeeded' })
    const { client, wyslane } = makeClient('correct')

    const { body } = await wywolaj(blikEndpoint({ client }), payload, {
      blikToken: '777123',
      secret: SEKRET,
      transactionID: 'transactions-1',
    })

    assert.equal(body.status, 'paid')
    assert.equal(wyslane.length, 0)
  })
})

describe('dostep do cudzej platnosci', () => {
  it('odrzuca zadanie bez sekretu koszyka i bez zalogowanego wlasciciela', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client, wyslane } = makeClient()

    const { body, status } = await wywolaj(blikEndpoint({ client }), payload, {
      blikToken: '777123',
      transactionID: 'transactions-1',
    })

    assert.equal(status, 403)
    assert.match(body.message, /not allowed/)
    assert.equal(wyslane.length, 0)
  })

  it('odrzuca zly sekret koszyka', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = makeClient()

    const { status } = await wywolaj(blikEndpoint({ client }), payload, {
      blikToken: '777123',
      secret: 'nie-ten-sekret',
      transactionID: 'transactions-1',
    })

    assert.equal(status, 403)
  })

  it('przepuszcza zalogowanego wlasciciela transakcji bez sekretu', async () => {
    const payload = new PayloadStub()
    seed(payload, { customer: 'users-1' })
    const { client, wyslane } = makeClient()

    const response = await blikEndpoint({ client }).handler(
      makeReq(payload, {
        data: { blikToken: '777123', transactionID: 'transactions-1' },
        user: { id: 'users-1' },
      }),
    )

    assert.equal(response.status, 200)
    assert.equal(wyslane.length, 1)
  })

  it('nie zdradza, ktore identyfikatory istnieja', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = makeClient()

    const nieistniejaca = await wywolaj(blikEndpoint({ client }), payload, {
      blikToken: '777123',
      secret: SEKRET,
      transactionID: 'transactions-999',
    })
    const cudza = await wywolaj(blikEndpoint({ client }), payload, {
      blikToken: '777123',
      secret: 'zly',
      transactionID: 'transactions-1',
    })

    assert.equal(nieistniejaca.status, cudza.status)
    assert.equal(nieistniejaca.body.message, cudza.body.message)
  })
})

describe('odczyt stanu platnosci', () => {
  it('mowi o oczekiwaniu, dopoki Tpay nie rozstrzygnie', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = makeClient('pending')

    const { body } = await wywolaj(blikStatusEndpoint({ client }), payload, {
      secret: SEKRET,
      transactionID: 'transactions-1',
    })

    assert.equal(body.status, 'pending')
    assert.equal(payload.docs('orders').length, 0)
  })

  it('domyka zamowienie, gdy platnosc jest zaksiegowana', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = makeClient('correct')

    const { body } = await wywolaj(blikStatusEndpoint({ client }), payload, {
      secret: SEKRET,
      transactionID: 'transactions-1',
    })

    assert.equal(body.status, 'paid')
    assert.ok(body.orderID)
    assert.equal(payload.docs('orders').length, 1)
  })

  it('odpytany wielokrotnie tworzy dokladnie jedno zamowienie', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = makeClient('correct')
    const endpoint = blikStatusEndpoint({ client })

    const pierwsze = await wywolaj(endpoint, payload, { secret: SEKRET, transactionID: 'transactions-1' })
    const drugie = await wywolaj(endpoint, payload, { secret: SEKRET, transactionID: 'transactions-1' })
    const trzecie = await wywolaj(endpoint, payload, { secret: SEKRET, transactionID: 'transactions-1' })

    assert.equal(payload.docs('orders').length, 1, 'odpytywanie stanu nie moze mnozyc zamowien')
    assert.equal(pierwsze.body.status, 'paid')
    assert.equal(drugie.body.status, 'paid')
    assert.equal(trzecie.body.status, 'paid')
    assert.equal(String(drugie.body.orderID), String(pierwsze.body.orderID))
    assert.equal(String(trzecie.body.orderID), String(pierwsze.body.orderID))
  })

  it('dwa odczyty naraz tworza jedno zamowienie, mimo ze zaden nie widzi zapisu drugiego', async () => {
    // Test siostrzany do tego wyzej, i celowo inny. Tamten konczy sie na bramce
    // w samym punkcie: drugie zadanie widzi juz zapisane zamowienie i wraca
    // wczesniej. Tutaj oba zadania startuja, zanim ktorekolwiek zdazylo zapisac
    // cokolwiek, wiec sprawdzana jest warstwa nizej - ta, ktora rozstrzyga
    // wyscig miedzy odczytem stanu a powiadomieniem od posrednika.
    const payload = new PayloadStub()
    seed(payload)
    const { client } = makeClient('correct')
    const endpoint = blikStatusEndpoint({ client })

    const [a, b] = await Promise.all([
      wywolaj(endpoint, payload, { secret: SEKRET, transactionID: 'transactions-1' }),
      wywolaj(endpoint, payload, { secret: SEKRET, transactionID: 'transactions-1' }),
    ])

    assert.equal(payload.docs('orders').length, 1, 'wyscig nie moze zrodzic drugiego zamowienia')
    assert.equal(a.body.status, 'paid')
    assert.equal(b.body.status, 'paid')
    assert.equal(String(a.body.orderID), String(b.body.orderID))
  })

  it('odroznia odrzucony kod od czekania na bank, mimo ze status transakcji jest ten sam', async () => {
    const payload = new PayloadStub()
    seed(payload)
    // Tak wyglada odmowa u posrednika: transakcja nadal `pending`, a jedynym
    // sladem jest kod bledu na ostatniej probie.
    const { client } = makeClient('pending', { attempts: [{ date: '07.09.2026 17:55', paymentErrorCode: '63' }] })

    const { body } = await wywolaj(blikStatusEndpoint({ client }), payload, {
      secret: SEKRET,
      transactionID: 'transactions-1',
    })

    assert.equal(body.status, 'rejected')
    assert.equal(body.tpayErrorCode, '63')
    assert.match(body.message, /new one/)
    assert.equal(
      payload.collection('transactions').get('transactions-1').status,
      'pending',
      'odrzucony kod nie moze zamykac platnosci - kupujacy podaje kolejny',
    )
  })

  it('proba bez kodu bledu to nadal zwykle oczekiwanie', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = makeClient('pending', { attempts: [{ date: '07.09.2026 17:55', paymentErrorCode: null }] })

    const { body } = await wywolaj(blikStatusEndpoint({ client }), payload, {
      secret: SEKRET,
      transactionID: 'transactions-1',
    })

    assert.equal(body.status, 'pending')
  })

  it('oglasza niepowodzenie dopiero przy rozstrzygnietej odmowie', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = makeClient('rejected')

    const { body } = await wywolaj(blikStatusEndpoint({ client }), payload, {
      secret: SEKRET,
      transactionID: 'transactions-1',
    })

    assert.equal(body.status, 'failed')
    assert.equal(payload.collection('transactions').get('transactions-1').status, 'failed')
  })

  it('czyta cialo takze wtedy, gdy warstwa wyzej go nie rozpakowala', async () => {
    const payload = new PayloadStub()
    seed(payload)
    const { client } = makeClient('pending')

    const response = await blikStatusEndpoint({ client }).handler(
      makeReq(payload, { json: { secret: SEKRET, transactionID: 'transactions-1' } }),
    )

    assert.equal(response.status, 200)
    assert.equal((await response.json()).status, 'pending')
  })
})
