/**
 * Order storage on Cloudflare KV.
 *
 * Key scheme:  order:<invertedTimestamp>:<sessionId>
 *
 * KV lists keys in ascending lexicographic order, so the timestamp is inverted
 * (MAX - t) to make a plain prefix list return newest-first with no sorting.
 * The timestamp comes from Stripe's session.created, not Date.now(), so a
 * webhook retry regenerates the *same* key and overwrites rather than
 * duplicating the order.
 *
 * The list view reads KV metadata only — one operation for a whole page —
 * while the full record (including the shipping address) lives in the value.
 */

const MAX_TS = 9999999999999;   // ms, comfortably past any real order
export const PREFIX = 'order:';

export const STATUSES = ['new', 'packed', 'shipped', 'cancelled'];

/** Transitions we allow. Shipped and cancelled are terminal. */
const NEXT = {
  new:       ['packed', 'cancelled'],
  packed:    ['shipped', 'cancelled', 'new'],
  shipped:   [],
  cancelled: []
};

export function canTransition(from, to) {
  if (!STATUSES.includes(to)) return false;
  return (NEXT[from] || []).includes(to);
}

export function orderKey(sessionId, createdSeconds) {
  const ms = Number(createdSeconds) * 1000;
  const stamp = String(MAX_TS - ms).padStart(13, '0');
  return `${PREFIX}${stamp}:${sessionId}`;
}

/** Shape a Stripe session into the record we actually keep. */
export function orderFromSession(session) {
  const d = session.customer_details || {};
  const ship = session.collected_information?.shipping_details
            ?? session.shipping_details
            ?? null;

  return {
    id: session.id,
    status: 'new',
    created: new Date((session.created || 0) * 1000).toISOString(),
    email: d.email || null,
    name: d.name || null,
    phone: d.phone || null,
    shipping: ship ? {
      name: ship.name || d.name || null,
      line1: ship.address?.line1 || null,
      line2: ship.address?.line2 || null,
      city: ship.address?.city || null,
      state: ship.address?.state || null,
      postal_code: ship.address?.postal_code || null,
      country: ship.address?.country || null
    } : null,
    pints: Number(session.metadata?.pints) || null,
    discount: session.metadata?.volume_discount || null,
    total_cents: session.amount_total ?? null,
    currency: session.currency || 'usd',
    history: [{ status: 'new', at: new Date().toISOString() }]
  };
}

/** Small enough for KV's 1 KiB metadata budget; drives the list view. */
export function listMetadata(order) {
  return {
    status: order.status,
    created: order.created,
    email: order.email,
    name: order.name,
    pints: order.pints,
    total_cents: order.total_cents,
    state: order.shipping?.state || null
  };
}

export async function saveOrder(kv, session) {
  const order = orderFromSession(session);
  const key = orderKey(order.id, session.created);

  // A retry of an already-processed event must not reset a packed order.
  const existing = await kv.get(key, 'json');
  if (existing) return { key, order: existing, duplicate: true };

  await kv.put(key, JSON.stringify(order), { metadata: listMetadata(order) });
  return { key, order, duplicate: false };
}

export async function listOrders(kv, { status, limit = 50, cursor } = {}) {
  const page = await kv.list({ prefix: PREFIX, limit, cursor });
  const orders = page.keys
    .map(k => ({ key: k.name, ...(k.metadata || {}) }))
    .filter(o => !status || status === 'all' || o.status === status);
  return { orders, cursor: page.list_complete ? null : page.cursor };
}

export async function getOrder(kv, key) {
  if (!key.startsWith(PREFIX)) return null;
  return kv.get(key, 'json');
}

export async function setStatus(kv, key, to) {
  const order = await getOrder(kv, key);
  if (!order) return { ok: false, error: 'Order not found.' };
  if (order.status === to) return { ok: true, order };
  if (!canTransition(order.status, to)) {
    return { ok: false, error: `Cannot move an order from ${order.status} to ${to}.` };
  }

  order.status = to;
  order.history = [...(order.history || []), { status: to, at: new Date().toISOString() }];
  await kv.put(key, JSON.stringify(order), { metadata: listMetadata(order) });
  return { ok: true, order };
}

/**
 * Constant-time string comparison.
 * A plain === leaks the length of the matching prefix through timing, which is
 * enough to recover a token byte by byte given enough attempts.
 */
export function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(String(a || ''));
  const y = enc.encode(String(b || ''));
  // Compare lengths without branching out early.
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}
