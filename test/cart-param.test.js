import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { escapeHtml, MAX_QUANTITY, parseCartParam } from '../dev/cart-param.mjs'

// --- audit round 2, 14.09.2026: the demo shop's `?cart=` parameter (W2-6) ---
//
// The parameter carries the cart across the hop to the public tunnel address,
// and the page dropped the quantity straight into `innerHTML`. A link written by
// somebody else therefore decided what ran in the shop's origin - the origin
// holding the cart secret and the order access token. The functional test would
// need a browser, which this repository does not have; these pin the two pure
// functions the page now stands on.

describe('W2-6: the cart from a URL is reduced to numbers', () => {
  it('W2-6 known-bad: markup in a quantity does not survive parsing', () => {
    const attack = JSON.stringify({ 1: '<img src=x onerror=alert(document.domain)>' })

    assert.deepEqual(parseCartParam(attack), {}, 'the entry is dropped, not repaired')
  })

  it('W2-6 known-bad: keys that are not product identifiers are dropped', () => {
    const attack = JSON.stringify({
      '2': 3,
      '<script>': 1,
      __proto__: { polluted: true },
      'constructor': 2,
    })

    const cart = parseCartParam(attack)

    assert.deepEqual(cart, { 2: 3 })
    assert.equal({}.polluted, undefined, 'nothing was written onto Object.prototype')
  })

  it('W2-6: quantities outside 1..99 and non integers are dropped', () => {
    const cart = parseCartParam(
      JSON.stringify({ 1: 0, 2: -5, 3: 2.5, 4: MAX_QUANTITY + 1, 5: MAX_QUANTITY, 6: '4' }),
    )

    assert.deepEqual(cart, { 5: MAX_QUANTITY, 6: 4 }, 'a numeric string is still a number')
  })

  it('W2-6: anything that is not an object of entries yields an empty cart', () => {
    for (const raw of ['', 'not json', '[]', '"7"', 'null', '42', undefined, null]) {
      assert.deepEqual(parseCartParam(raw), {}, String(raw))
    }
  })

  it('W2-6 known-good: an ordinary cart passes through unchanged', () => {
    assert.deepEqual(parseCartParam(JSON.stringify({ 1: 2, 17: 1 })), { 1: 2, 17: 1 })
  })
})

describe('W2-6: escaping for everything that goes into markup', () => {
  it('W2-6: the five characters that break out of HTML are replaced', () => {
    assert.equal(
      escapeHtml('<img src=x onerror="alert(\'x\')">'),
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;',
    )
    assert.equal(escapeHtml('Tea & coffee'), 'Tea &amp; coffee')
  })

  it('W2-6: numbers and empty values come back as harmless text', () => {
    assert.equal(escapeHtml(3), '3')
    assert.equal(escapeHtml(undefined), '')
    assert.equal(escapeHtml(null), '')
  })
})
