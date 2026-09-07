/**
 * Atrapa `payload` na potrzeby testow: kolekcje w pamieci, z prawdziwa semantyka
 * warunkowej aktualizacji (`update` z `where`). To ta semantyka rozstrzyga wyscig
 * miedzy powiadomieniem a powrotem przegladarki, wiec atrapa, ktora zawsze
 * przepuszcza aktualizacje, nie zmierzylaby niczego.
 */

const getPath = (doc, path) =>
  String(path)
    .split('.')
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), doc)

const matches = (doc, where) => {
  if (!where || typeof where !== 'object') {
    return true
  }

  if (Array.isArray(where.and)) {
    return where.and.every((clause) => matches(doc, clause))
  }

  if (Array.isArray(where.or)) {
    return where.or.some((clause) => matches(doc, clause))
  }

  return Object.entries(where).every(([field, condition]) => {
    const value = getPath(doc, field)

    if (condition && typeof condition === 'object') {
      if ('equals' in condition) {
        return String(value) === String(condition.equals)
      }
      if ('exists' in condition) {
        return condition.exists ? value != null : value == null
      }
    }

    return String(value) === String(condition)
  })
}

export class PayloadStub {
  constructor() {
    this.collections = new Map()
    this.logs = { error: [], warn: [] }
    this.calls = []
    this.nextId = 1
    this.logger = {
      error: (entry) => this.logs.error.push(entry),
      info: () => {},
      warn: (entry) => this.logs.warn.push(entry),
    }
  }

  collection(slug) {
    if (!this.collections.has(slug)) {
      this.collections.set(slug, new Map())
    }

    return this.collections.get(slug)
  }

  seed(slug, doc) {
    const id = doc.id ?? `seed-${this.nextId++}`
    const stored = { ...doc, id }
    this.collection(slug).set(String(id), stored)

    return stored
  }

  docs(slug) {
    return [...this.collection(slug).values()]
  }

  async create({ collection, data }) {
    this.calls.push({ collection, op: 'create' })
    const id = `${collection}-${this.nextId++}`
    const doc = { ...data, id }
    this.collection(collection).set(String(id), doc)

    return { ...doc }
  }

  async findByID({ collection, id }) {
    const doc = this.collection(collection).get(String(id))

    if (!doc) {
      throw new Error(`Not found: ${collection}/${String(id)}`)
    }

    return { ...doc }
  }

  async find({ collection, limit = 10, where }) {
    const found = this.docs(collection).filter((doc) => matches(doc, where))

    return { docs: found.slice(0, limit).map((doc) => ({ ...doc })), totalDocs: found.length }
  }

  async update({ collection, data, id, where }) {
    this.calls.push({ collection, op: 'update' })

    if (id !== undefined) {
      const doc = this.collection(collection).get(String(id))

      if (!doc) {
        throw new Error(`Not found: ${collection}/${String(id)}`)
      }

      const updated = { ...doc, ...data }
      this.collection(collection).set(String(id), updated)

      return { ...updated }
    }

    const targets = this.docs(collection).filter((doc) => matches(doc, where))

    for (const doc of targets) {
      this.collection(collection).set(String(doc.id), { ...doc, ...data })
    }

    return {
      docs: targets.map((doc) => ({ ...this.collection(collection).get(String(doc.id)) })),
      errors: [],
    }
  }

  async delete({ collection, id }) {
    this.calls.push({ collection, op: 'delete' })
    const doc = this.collection(collection).get(String(id))
    this.collection(collection).delete(String(id))

    return doc ? { ...doc } : null
  }
}

export const makeReq = (payload, extra = {}) => ({
  headers: new Headers(extra.headers || {}),
  payload,
  user: extra.user,
  ...(extra.body === undefined ? {} : { text: async () => extra.body }),
  // `data` odwzorowuje zadanie, ktore warstwa wyzej zdazyla juz rozpakowac,
  // `json` - takie, ktore trzeba przeczytac samemu. Punkty BLIK-a musza radzic
  // sobie z obiema postaciami, wiec atrapa umie podac kazda z nich osobno.
  ...(extra.data === undefined ? {} : { data: extra.data }),
  ...(extra.json === undefined ? {} : { json: async () => extra.json }),
})
