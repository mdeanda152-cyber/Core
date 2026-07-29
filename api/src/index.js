/**
 * Guiltless payments — Cloudflare Worker.
 *
 *   POST /checkout   cart -> Stripe Checkout Session -> { url }
 *   POST /webhook    Stripe events (signature verified) -> fulfilment
 *   GET  /health     liveness
 *
 * Card details never touch our code or this Worker. The shopper is redirected
 * to Stripe's hosted Checkout page, which is what keeps us out of PCI scope.
 */

import Stripe from 'stripe';
import { priceCart, CURRENCY, MIN_PINTS } from './catalog.js';
import { saveOrder, listOrders, getOrder, setStatus, safeEqual, STATUSES } from './orders.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Only the configured storefront may call this Worker from a browser. */
function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0] || '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...(extra || {}) }
  });
}

function stripeClient(env) {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20',
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2
  });
}

/* ------------------------------------------------------------------ */
/* POST /checkout                                                      */
/* ------------------------------------------------------------------ */

async function handleCheckout(request, env) {
  const cors = corsHeaders(request, env);

  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: 'Payments are not configured.' }, 503, cors);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Malformed request.' }, 400, cors);
  }

  // Price the cart from our own catalog. Anything the client said about
  // money is discarded here.
  const priced = priceCart(payload?.items);
  if (!priced.ok) {
    return json({ error: priced.error }, 400, cors);
  }

  const stripe = stripeClient(env);

  const line_items = priced.lines.map(line => ({
    quantity: line.qty,
    price_data: {
      currency: CURRENCY,
      unit_amount: line.unit,
      product_data: {
        name: line.name,
        description: '1 pint (473 mL) · 42 g protein',
        metadata: { sku: line.id }
      }
    }
  }));

  const shipping_options = [{
    shipping_rate_data: {
      type: 'fixed_amount',
      display_name: priced.shipping === 0
        ? 'Free shipping — frozen, 2-day'
        : 'Frozen shipping — dry ice, 2-day',
      fixed_amount: { amount: priced.shipping, currency: CURRENCY },
      delivery_estimate: {
        minimum: { unit: 'business_day', value: 2 },
        maximum: { unit: 'business_day', value: 3 }
      }
    }
  }];

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      shipping_options,
      // Frozen shipping is domestic-only until the cold chain is proven.
      shipping_address_collection: { allowed_countries: ['US'] },
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: true },
      // Stripe Tax must be activated and an origin address registered before
      // this can be turned on. Food taxability varies by state — see docs.
      ...(env.ENABLE_STRIPE_TAX === 'true'
        ? { automatic_tax: { enabled: true } }
        : {}),
      success_url: `${env.SITE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.SITE_URL}/shop.html`,
      metadata: {
        pints: String(priced.qty),
        volume_discount: `${Math.round(priced.rate * 100)}%`,
        merch_subtotal_cents: String(priced.subtotal)
      }
    }, {
      // Guards against a double-click creating two sessions.
      idempotencyKey: await cartFingerprint(priced)
    });

    return json({ url: session.url, id: session.id }, 200, cors);
  } catch (err) {
    console.error('checkout_session_failed', err?.message);
    return json({ error: 'Could not start checkout.' }, 502, cors);
  }
}

/** Stable key for an identical cart submitted within the same minute. */
async function cartFingerprint(priced) {
  const basis = priced.lines
    .map(l => `${l.id}:${l.qty}:${l.unit}`).sort().join('|')
    + `|${Math.floor(Date.now() / 60000)}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(basis));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ */
/* POST /webhook                                                       */
/* ------------------------------------------------------------------ */

async function handleWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return new Response('Webhook not configured.', { status: 503 });
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) return new Response('Missing signature.', { status: 400 });

  const raw = await request.text();
  const stripe = stripeClient(env);

  let event;
  try {
    // Async variant + SubtleCrypto: required in Workers, where the sync
    // Node crypto path is unavailable.
    event = await stripe.webhooks.constructEventAsync(
      raw, signature, env.STRIPE_WEBHOOK_SECRET, undefined,
      Stripe.createSubtleCryptoProvider()
    );
  } catch (err) {
    console.error('bad_webhook_signature', err?.message);
    return new Response('Invalid signature.', { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Only act on money actually captured.
    if (session.payment_status === 'paid') {
      const order = {
        id: session.id,
        email: session.customer_details?.email,
        name: session.customer_details?.name,
        phone: session.customer_details?.phone,
        shipping: session.collected_information?.shipping_details
                  ?? session.shipping_details ?? null,
        pints: session.metadata?.pints,
        discount: session.metadata?.volume_discount,
        total_cents: session.amount_total,
        currency: session.currency,
        created: new Date(event.created * 1000).toISOString()
      };

      // Persist first, so the order survives even if the forward below fails.
      // Keyed by Stripe's session.created, so a webhook retry overwrites the
      // same key rather than creating a second order.
      if (env.ORDERS) {
        try {
          const { duplicate } = await saveOrder(env.ORDERS, session);
          console.log(duplicate ? 'order_replayed' : 'order_stored', session.id);
          if (duplicate) return new Response('ok', { status: 200 });
        } catch (err) {
          // Do not 500 — Stripe would retry, and we would rather log a gap
          // than reprocess. The Stripe dashboard remains the source of truth.
          console.error('order_store_failed', session.id, err?.message);
        }
      }

      console.log('order_paid', JSON.stringify(order));

      // Optional extra hop for anyone wiring a 3PL or a spreadsheet.
      // Failure here must not 500 back to Stripe, or it will retry a
      // fulfilment that already happened.
      if (env.FULFILMENT_WEBHOOK) {
        try {
          await fetch(env.FULFILMENT_WEBHOOK, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(order)
          });
        } catch (err) {
          console.error('fulfilment_forward_failed', session.id, err?.message);
        }
      }
    }
  }

  // 2xx quickly, always — Stripe retries anything else.
  return new Response('ok', { status: 200 });
}

/* ------------------------------------------------------------------ */
/* /admin/*  — order desk                                              */
/* ------------------------------------------------------------------ */

/**
 * Admin requests carry a bearer token. Orders hold customer names, addresses
 * and phone numbers, so every route below is gated and none of it is cached.
 */
function adminAuthed(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return safeEqual(token, env.ADMIN_TOKEN);
}

const NO_STORE = { 'Cache-Control': 'no-store' };

async function handleAdmin(request, env, pathname) {
  const cors = corsHeaders(request, env);

  if (!env.ADMIN_TOKEN) {
    return json({ error: 'Admin is not configured.' }, 503, cors);
  }
  if (!adminAuthed(request, env)) {
    return json({ error: 'Not authorised.' }, 401, { ...cors, ...NO_STORE });
  }
  if (!env.ORDERS) {
    return json({ error: 'Order storage is not configured.' }, 503, cors);
  }

  const headers = { ...cors, ...NO_STORE };
  const url = new URL(request.url);

  // GET /admin/orders?status=new
  if (pathname === '/admin/orders' && request.method === 'GET') {
    const status = url.searchParams.get('status') || 'all';
    const cursor = url.searchParams.get('cursor') || undefined;
    const { orders, cursor: next } = await listOrders(env.ORDERS, { status, cursor });
    return json({ orders, cursor: next }, 200, headers);
  }

  // GET /admin/order?key=order:...
  if (pathname === '/admin/order' && request.method === 'GET') {
    const key = url.searchParams.get('key') || '';
    const order = await getOrder(env.ORDERS, key);
    if (!order) return json({ error: 'Order not found.' }, 404, headers);
    return json({ order }, 200, headers);
  }

  // POST /admin/order/status  { key, status }
  if (pathname === '/admin/order/status' && request.method === 'POST') {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Malformed request.' }, 400, headers); }

    const { key, status } = body || {};
    if (typeof key !== 'string' || !STATUSES.includes(status)) {
      return json({ error: 'Invalid key or status.' }, 400, headers);
    }
    const result = await setStatus(env.ORDERS, key, status);
    if (!result.ok) return json({ error: result.error }, 409, headers);
    return json({ order: result.order }, 200, headers);
  }

  return json({ error: 'Not found.' }, 404, headers);
}

/* ------------------------------------------------------------------ */

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (pathname === '/health') {
      return json({
        ok: true,
        stripe: Boolean(env.STRIPE_SECRET_KEY),
        webhook: Boolean(env.STRIPE_WEBHOOK_SECRET),
        orders: Boolean(env.ORDERS),
        admin: Boolean(env.ADMIN_TOKEN),
        tax: env.ENABLE_STRIPE_TAX === 'true',
        min_pints: MIN_PINTS
      }, 200);
    }

    if (pathname.startsWith('/admin/')) {
      return handleAdmin(request, env, pathname);
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed.', { status: 405 });
    }

    if (pathname === '/checkout') return handleCheckout(request, env);
    if (pathname === '/webhook')  return handleWebhook(request, env);

    return new Response('Not found.', { status: 404 });
  }
};
