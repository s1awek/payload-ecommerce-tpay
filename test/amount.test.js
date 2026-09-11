import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { decimalStringToMinor, minorToDecimalString, normalizeAmountString } from '../dist/amount.js'

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
