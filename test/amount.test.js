import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { decimalStringToMinor, minorToDecimalString, normalizeAmountString } from '../dist/amount.js'

describe('konwersja kwot', () => {
  it('grosze na napis dziesietny, takze tam gdzie float klamie', () => {
    assert.equal(minorToDecimalString(1999), '19.99')
    assert.equal(minorToDecimalString(1000), '10.00')
    assert.equal(minorToDecimalString(1), '0.01')
    assert.equal(minorToDecimalString(0), '0.00')
    assert.equal(minorToDecimalString(100000000), '1000000.00')
    // 8.15 i 1.005 to klasyczne przypadki, w ktorych dzielenie przez 100
    // i toFixed daja wynik zalezny od reprezentacji binarnej.
    assert.equal(minorToDecimalString(815), '8.15')
    assert.equal(minorToDecimalString(1005), '10.05')
  })

  it('napis dziesietny na grosze', () => {
    assert.equal(decimalStringToMinor('19.99'), 1999)
    assert.equal(decimalStringToMinor('10'), 1000)
    assert.equal(decimalStringToMinor('0.01'), 1)
    assert.equal(decimalStringToMinor(' 8.15 '), 815)
  })

  it('normalizacja do postaci z sumy kontrolnej', () => {
    assert.equal(normalizeAmountString('10.9'), '10.90')
    assert.equal(normalizeAmountString('10'), '10.00')
    assert.equal(normalizeAmountString('1234.56'), '1234.56')
  })

  it('zbyt dokladna kwota jest bledem, nie cichym zaokragleniem', () => {
    assert.throws(() => decimalStringToMinor('19.999'), /more than 2 decimal places/)
  })

  it('odrzuca to, co nie jest kwota', () => {
    assert.throws(() => decimalStringToMinor('19,99'), /Not a decimal amount/)
    assert.throws(() => decimalStringToMinor('abc'), /Not a decimal amount/)
    assert.throws(() => decimalStringToMinor(''), /Not a decimal amount/)
    assert.throws(() => minorToDecimalString(Number.NaN), /finite number/)
  })

  it('obieg tam i z powrotem jest stratny na zero groszy', () => {
    for (let minor = 0; minor < 5000; minor += 7) {
      assert.equal(decimalStringToMinor(minorToDecimalString(minor)), minor)
    }
  })
})
