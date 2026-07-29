import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceCart, tierFor, MIN_PINTS, MAX_PINTS } from '../src/catalog.js';

const cart = (...pairs) => pairs.map(([id, qty]) => ({ id, qty }));

test('tier boundaries match the storefront', () => {
  assert.equal(tierFor(3).rate, 0);
  assert.equal(tierFor(4).rate, 0.08);
  assert.equal(tierFor(7).rate, 0.08);
  assert.equal(tierFor(8).rate, 0.14);
  assert.equal(tierFor(11).rate, 0.14);
  assert.equal(tierFor(12).rate, 0.20);
  assert.equal(tierFor(40).rate, 0.20);
});

test('prices a 4-pint cart at the 8% tier', () => {
  const r = priceCart(cart(['vanilla', 2], ['chocolate', 2]));
  assert.equal(r.ok, true);
  assert.equal(r.qty, 4);
  assert.equal(r.lines[0].unit, 874);          // 950 - 8%
  assert.equal(r.subtotal, 874 * 4);
  assert.equal(r.shipping, 1299);              // below the free threshold
});

test('12 pints hit 20% and clear free shipping', () => {
  const r = priceCart(cart(['vanilla', 12]));
  assert.equal(r.ok, true);
  assert.equal(r.lines[0].unit, 760);
  assert.equal(r.subtotal, 9120);              // $91.20
  assert.equal(r.shipping, 0);
});

test('8 pints stay under the free-shipping threshold', () => {
  const r = priceCart(cart(['vanilla', 8]));
  assert.equal(r.subtotal, 817 * 8);           // $65.36
  assert.equal(r.shipping, 1299);
});

test('rejects orders below the pack minimum', () => {
  const r = priceCart(cart(['vanilla', 3]));
  assert.equal(r.ok, false);
  assert.match(r.error, /Minimum order is 4/);
});

test('rejects an unknown product id', () => {
  const r = priceCart(cart(['not-a-flavour', 8]));
  assert.equal(r.ok, false);
  assert.match(r.error, /Unknown product/);
});

test('rejects an empty cart', () => {
  assert.equal(priceCart([]).ok, false);
  assert.equal(priceCart(null).ok, false);
  assert.equal(priceCart('vanilla').ok, false);
});

test('rejects non-integer, negative and absurd quantities', () => {
  for (const qty of [0, -5, 1.5, NaN, Infinity, MAX_PINTS + 1]) {
    const r = priceCart([{ id: 'vanilla', qty }]);
    assert.equal(r.ok, false, `qty ${String(qty)} should be rejected`);
  }
});

test('rejects quantities of the wrong type', () => {
  // Number() would coerce these into valid-looking counts.
  for (const qty of [true, ['5'], {}, null, undefined, '4.0', ' 4', '4e0']) {
    const r = priceCart([{ id: 'vanilla', qty }]);
    assert.equal(r.ok, false, `qty ${JSON.stringify(qty)} should be rejected`);
  }
});

test('accepts a plain digit string, since JSON clients send them', () => {
  const r = priceCart([{ id: 'vanilla', qty: '4' }]);
  assert.equal(r.ok, true);
  assert.equal(r.qty, 4);
});

test('a negative quantity cannot be used to drain the total', () => {
  const r = priceCart(cart(['vanilla', 12], ['chocolate', -8]));
  assert.equal(r.ok, false);
});

test('client-supplied prices are ignored entirely', () => {
  // A tampered cart claiming a 1-cent pint must still be charged full price.
  const r = priceCart([
    { id: 'vanilla', qty: 4, unit: 1, cents: 1, price: 0.01, name: 'FREE' }
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.lines[0].unit, 874);
  assert.equal(r.lines[0].name, 'Toasted Milk & Vanilla Bean');
});

test('duplicate line items are merged before tiering', () => {
  // Four separate 1-pint lines must still earn the 4-pint tier, once.
  const r = priceCart(cart(['vanilla', 1], ['vanilla', 1], ['vanilla', 1], ['vanilla', 1]));
  assert.equal(r.ok, true);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].qty, 4);
  assert.equal(r.lines[0].unit, 874);
});

test('quantity is capped even when split across lines', () => {
  const r = priceCart(cart(['vanilla', 40], ['chocolate', 40]));
  assert.equal(r.ok, false);
  assert.match(r.error, /Maximum order/);
});

test('prototype-pollution style ids are rejected', () => {
  for (const id of ['__proto__', 'constructor', 'toString']) {
    assert.equal(priceCart([{ id, qty: 4 }]).ok, false, `${id} should be rejected`);
  }
});

test('every unit price is a whole number of cents', () => {
  for (const qty of [4, 8, 12, 20]) {
    const r = priceCart(cart(['pistachio', qty]));
    assert.ok(Number.isInteger(r.lines[0].unit), 'unit must be integer cents');
    assert.ok(Number.isInteger(r.subtotal), 'subtotal must be integer cents');
  }
});
