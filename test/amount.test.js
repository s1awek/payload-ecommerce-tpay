import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  apiAmountToMinor,
  decimalStringToMinor,
  minorToDecimalString,
  normalizeAmountString,
} from '../dist/amount.js'

describe('amount conversion', () => {
  it('minor units to decimal string, even where float lies', () => {
    assert.equal(minorToDecimalString(1999), '19.99')
    assert.equal(minorToDecimalString(1000), '10.00')
    assert.equal(minorToDecimalString(1), '0.01')
    assert.equal(minorToDecimalString(0), '0.00')
    assert.equal(minorToDecimalString(100000000), '1000000.00')
    // 8.15 and 1.005 are classic cases where dividing by 100 and toFixed
    // give a result that depends on the binary representation.
    assert.equal(minorToDecimalString(815), '8.15')
    assert.equal(minorToDecimalString(1005), '10.05')
  })

  it('decimal string to minor units', () => {
    assert.equal(decimalStringToMinor('19.99'), 1999)
    assert.equal(decimalStringToMinor('10'), 1000)
    assert.equal(decimalStringToMinor('0.01'), 1)
    assert.equal(decimalStringToMinor(' 8.15 '), 815)
  })

  it('normalization to the checksum-ready form', () => {
    assert.equal(normalizeAmountString('10.9'), '10.90')
    assert.equal(normalizeAmountString('10'), '10.00')
    assert.equal(normalizeAmountString('1234.56'), '1234.56')
  })

  it('too many decimal places is an error, not a silent rounding', () => {
    assert.throws(() => decimalStringToMinor('19.999'), /more than 2 decimal places/)
  })

  it('rejects anything that is not an amount', () => {
    assert.throws(() => decimalStringToMinor('19,99'), /Not a decimal amount/)
    assert.throws(() => decimalStringToMinor('abc'), /Not a decimal amount/)
    assert.throws(() => decimalStringToMinor(''), /Not a decimal amount/)
    assert.throws(() => minorToDecimalString(Number.NaN), /finite number/)
  })

  it('round trip loses nothing down to zero cents', () => {
    for (let minor = 0; minor < 5000; minor += 7) {
      assert.equal(decimalStringToMinor(minorToDecimalString(minor)), minor)
    }
  })
})

// --- the one place where a float is scaled ---

describe('amounts from the Tpay REST API', () => {
  it('a number with two decimal places becomes minor units with no drift', () => {
    const cases = [
      [19.99, 1999],
      [4.35, 435],
      [8.15, 815],
      [0.01, 1],
      [1000, 100000],
      [0, 0],
      [99999.99, 9999999],
    ]

    for (const [value, minor] of cases) {
      assert.equal(apiAmountToMinor(value), minor, `${value} -> ${minor}`)
    }
  })

  it('a string takes the exact path - too many places is a refusal, not a rounding', () => {
    assert.equal(apiAmountToMinor('19.99'), 1999)
    assert.equal(apiAmountToMinor('19.999'), undefined)
    assert.equal(apiAmountToMinor('19,99'), undefined)
  })

  it('what cannot be read does not pretend to be zero', () => {
    for (const value of [undefined, null, '', {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(apiAmountToMinor(value), undefined, String(value))
    }
  })

  it('the number of decimal places is a parameter, and two is the whole package assumption', () => {
    // The known-bad for the two decimal rule: with a zero decimal currency both ends of the trip
    // make the same mistake, so the amount gate reports a match across a
    // hundredfold difference. The currency table is what stops that, not this
    // function.
    assert.equal(apiAmountToMinor(10, 0), 10)
    assert.equal(apiAmountToMinor(10), 1000)
  })
})
