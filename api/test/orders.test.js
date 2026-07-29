import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  orderKey, orderFromSession, listMetadata, canTransition,
  saveOrder, listOrders, getOrder, setStatus, safeEqual, PREFIX
} from '../src/orders.js';

/** Minimal in-memory stand-in for a KV namespace. */
function fakeKV() {
  const store = new Map();
  return {
    store,
    async put(key, value, opts) { store.set(key, { value, metadata: opts?.metadata || null }); },
    async get(key, type) {
      const hit = store.get(key);
      if (!hit) return null;
      return type === 'json' ? JSON.parse(hit.value) : hit.value;
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...store.keys()].filter(k => k.startsWith(prefix)).sort()
        .slice(0, limit)
        .map(name => ({ name, metadata: store.get(name).metadata }));
      return { keys, list_complete: true, cursor: null };
    }
  };
}

const session = (over = {}) => ({
  id: 'cs_test_abc123',
  created: 1750000000,
  amount_total: 3495,
  currency: 'usd',
  payment_status: 'paid',
  customer_details: { email: 'a@b.com', name: 'Dana Reyes', phone: '+15551234567' },
  collected_information: { shipping_details: {
    name: 'Dana Reyes',
    address: { line1: '12 Cold St', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' }
  } },
  metadata: { pints: '4', volume_discount: '8%' },
  ...over
});

test('keys sort newest-first under a plain prefix list', () => {
  const older = orderKey('cs_1', 1750000000);
  const newer = orderKey('cs_2', 1760000000);
  assert.ok(newer < older, 'a newer order must sort before an older one');
  assert.ok(older.startsWith(PREFIX) && newer.startsWith(PREFIX));
});

test('the same session always produces the same key', () => {
  assert.equal(orderKey('cs_x', 1750000000), orderKey('cs_x', 1750000000));
});

test('shapes a session into an order record', () => {
  const o = orderFromSession(session());
  assert.equal(o.id, 'cs_test_abc123');
  assert.equal(o.status, 'new');
  assert.equal(o.email, 'a@b.com');
  assert.equal(o.shipping.city, 'Austin');
  assert.equal(o.shipping.state, 'TX');
  assert.equal(o.pints, 4);
  assert.equal(o.total_cents, 3495);
  assert.equal(o.history.length, 1);
});

test('survives a session with no shipping details', () => {
  const o = orderFromSession(session({ collected_information: undefined, shipping_details: undefined }));
  assert.equal(o.shipping, null);
  assert.equal(o.status, 'new');
});

test('list metadata stays inside the 1 KiB KV budget', () => {
  const meta = listMetadata(orderFromSession(session()));
  assert.ok(JSON.stringify(meta).length < 1024);
  assert.equal(meta.status, 'new');
  assert.equal(meta.total_cents, 3495);
});

test('a replayed webhook does not duplicate or reset the order', async () => {
  const kv = fakeKV();
  const first = await saveOrder(kv, session());
  assert.equal(first.duplicate, false);

  await setStatus(kv, first.key, 'packed');

  const replay = await saveOrder(kv, session());
  assert.equal(replay.duplicate, true, 'retry must be recognised');
  assert.equal(replay.order.status, 'packed', 'must not reset a packed order to new');
  assert.equal(kv.store.size, 1, 'must not create a second record');
});

test('lists newest first and filters by status', async () => {
  const kv = fakeKV();
  await saveOrder(kv, session({ id: 'cs_old', created: 1750000000 }));
  await saveOrder(kv, session({ id: 'cs_new', created: 1760000000 }));

  const all = await listOrders(kv, { status: 'all' });
  assert.equal(all.orders.length, 2);
  assert.ok(all.orders[0].key.endsWith('cs_new'), 'newest order should come first');

  const key = all.orders[0].key;
  await setStatus(kv, key, 'packed');

  assert.equal((await listOrders(kv, { status: 'new' })).orders.length, 1);
  assert.equal((await listOrders(kv, { status: 'packed' })).orders.length, 1);
});

test('status transitions follow the allowed graph', () => {
  assert.equal(canTransition('new', 'packed'), true);
  assert.equal(canTransition('packed', 'shipped'), true);
  assert.equal(canTransition('packed', 'new'), true);
  assert.equal(canTransition('new', 'shipped'), false, 'cannot skip packing');
  assert.equal(canTransition('shipped', 'new'), false, 'shipped is terminal');
  assert.equal(canTransition('cancelled', 'packed'), false, 'cancelled is terminal');
  assert.equal(canTransition('new', 'nonsense'), false);
});

test('setStatus rejects an illegal move and records history', async () => {
  const kv = fakeKV();
  const { key } = await saveOrder(kv, session());

  const bad = await setStatus(kv, key, 'shipped');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Cannot move/);

  assert.equal((await setStatus(kv, key, 'packed')).ok, true);
  const after = await setStatus(kv, key, 'shipped');
  assert.equal(after.ok, true);
  assert.deepEqual(after.order.history.map(h => h.status), ['new', 'packed', 'shipped']);
});

test('setStatus reports a missing order rather than throwing', async () => {
  const kv = fakeKV();
  const r = await setStatus(kv, 'order:0000000000000:cs_nope', 'packed');
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/i);
});

test('getOrder refuses keys outside the order prefix', async () => {
  const kv = fakeKV();
  await kv.put('secret:thing', JSON.stringify({ nope: true }));
  assert.equal(await getOrder(kv, 'secret:thing'), null);
});

test('safeEqual matches only identical strings', () => {
  assert.equal(safeEqual('hunter2', 'hunter2'), true);
  assert.equal(safeEqual('hunter2', 'hunter3'), false);
  assert.equal(safeEqual('hunter2', 'hunter'), false, 'a prefix must not pass');
  assert.equal(safeEqual('hunter', 'hunter2'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual(null, ''), true);
  assert.equal(safeEqual(undefined, 'x'), false);
  assert.equal(safeEqual('ünïcode', 'ünïcode'), true);
});
