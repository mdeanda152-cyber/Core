# Taking payments

Stripe Checkout, fronted by a Cloudflare Worker. About 30 minutes end to end.

**Card details never touch this codebase.** The shopper is redirected to Stripe's
hosted Checkout page, which is what keeps you out of PCI scope. Do not add card
fields to the site — if you ever feel tempted, that is the moment to stop.

---

## How it works

```
shop.html                    Worker /checkout              Stripe
  cart {id, qty}   ────────▶  reprice from catalog.js  ──▶  create session
                                                              │
  redirect to Stripe  ◀──────  { url }  ◀─────────────────────┘
                                   │
  success.html  ◀── shopper pays ──┘
                                   │
                Worker /webhook  ◀─┴── checkout.session.completed
                       │
                       ├──▶ KV  ──▶  admin.html (the order desk)
                       └──▶ FULFILMENT_WEBHOOK (optional 3PL / sheet)
```

**The browser never sends a price.** It sends product IDs and quantities;
`api/src/catalog.js` looks up the real prices, recomputes the volume discount and
shipping, and charges that. A tampered cart claiming a one-cent pint is still
charged $9.50 — there is a test for exactly that.

---

## Setup

### 1. Stripe account

1. Create one at [stripe.com](https://stripe.com) and complete business verification.
   Until it is verified you can only take **test** payments.
2. **Developers → API keys** → copy the **Secret key**. Start with the test key
   (`sk_test_…`); switch to live only once a test order has gone through end to end.

### 2. Deploy the Worker

```bash
cd api
npm install
npx wrangler login
```

Edit `wrangler.toml` and set `SITE_URL` and `ALLOWED_ORIGINS` to wherever the site
is actually served. `ALLOWED_ORIGINS` is the browser origin only — scheme and host,
no path, no trailing slash.

```bash
npx wrangler secret put STRIPE_SECRET_KEY      # paste sk_test_… when prompted
npx wrangler deploy
```

Wrangler prints a URL like `https://guiltless-payments.<you>.workers.dev`.
Check it: `curl https://…workers.dev/health` should report `"stripe": true`.

> Secrets go in with `wrangler secret put`, never in `wrangler.toml` — that file is
> committed to git.

### 3. Point the storefront at it

In `shop.html`:

```html
<aside class="cart" data-cart-drawer
       data-checkout-endpoint="https://guiltless-payments.<you>.workers.dev/checkout">
```

### 4. Webhook, so you find out about orders

Without this you have no reliable signal that a payment succeeded. A shopper
closing the tab on the success page does not mean the order did not happen.

1. Stripe **Developers → Webhooks → Add endpoint**
2. URL: `https://…workers.dev/webhook`
3. Event: `checkout.session.completed`
4. Copy the **Signing secret** (`whsec_…`), then:

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler deploy
```

Signatures are verified before anything is acted on, so a forged POST claiming a
paid order is rejected.

### 5. Order storage and the admin desk

Paid orders are stored in Cloudflare KV and managed from `admin.html`, so you do not
need a third-party tool to see what to pack.

```bash
npx wrangler kv namespace create ORDERS
```

Paste the printed `id` into the `[[kv_namespaces]]` block in `wrangler.toml`, then set
an admin token — any long random string:

```bash
openssl rand -base64 32                    # generate one
npx wrangler secret put ADMIN_TOKEN        # paste it
npx wrangler deploy
```

Finally, set `data-api` on the `<main data-admin>` element in `admin.html` to your
Worker's **base** URL (no path):

```html
<main id="main" data-admin data-api="https://guiltless-payments.you.workers.dev">
```

Open `admin.html`, paste the token, and you have the desk: orders newest-first,
filterable by status, with the shipping address loaded on demand and buttons to move
an order `new → packed → shipped`.

**About the token.** It is held in `sessionStorage`, so it dies with the browser tab and
is never written to disk. Anyone holding it can read customer names, addresses and phone
numbers — treat it like a password, and rotate it with `wrangler secret put ADMIN_TOKEN`
if it leaks. `admin.html` is `noindex, nofollow`, but that is a request to crawlers, not
access control; the token is the actual control.

For stronger protection, put Cloudflare Access in front of the `/admin/*` routes so the
token is a second factor rather than the only one.

**Duplicate protection.** Stripe retries webhooks. Orders are keyed by the Stripe session
plus its creation time, so a retry rewrites the same record instead of creating a second
one — and a retry arriving after you have marked an order packed will not reset it to new.

### 6. Optional: forward orders elsewhere

Set `FULFILMENT_WEBHOOK` in `wrangler.toml` to a Zapier/Make hook, a Google Sheet
endpoint, or your own API, and paid orders are POSTed there as JSON in addition to being
stored in KV. Only needed if a 3PL or spreadsheet has to be in the loop.

---

## Test before going live

With the test secret key, use Stripe's test cards — `4242 4242 4242 4242`, any
future expiry, any CVC.

Walk the whole path: add 4 pints → checkout → pay → land on `success.html` → confirm
the cart cleared → confirm the order shows in Stripe → confirm your fulfilment hook
fired.

Then also try the failure paths:

| Try this | Expected |
|---|---|
| 3 pints | Checkout disabled, minimum explained |
| Card `4000 0000 0000 0002` | Declined, cart intact, no order |
| Close the Stripe tab | Back to `shop.html`, cart still there |
| `curl -X POST …/checkout -d '{"items":[{"id":"vanilla","qty":4,"unit":1}]}'` | Charges $34.96, not 4 cents |
| `curl …/admin/orders` with no token | `401 Not authorised` |
| A completed test order | Appears in `admin.html` under **New** |

Only once all six behave should you swap in `sk_live_…` and redeploy.

---

## Changing prices

Two files, and they must agree:

| What | Frontend (`assets/js/site.js`) | Backend (`api/src/catalog.js`) |
|---|---|---|
| Unit price | `UNIT = 9.50` | `cents: 950` |
| Tiers | `TIERS` | `TIERS` |
| Shipping | `SHIP`, `FREE_AT` | `SHIP_CENTS`, `FREE_SHIP_AT` |
| Minimum | `MIN_PINTS` | `MIN_PINTS` |

The frontend copy only draws the totals the shopper sees. The backend copy is what
charges the card. If they drift, the shopper sees one number and pays another —
so change both, then run `cd api && node --test test/catalog.test.js`.

---

## Sales tax

`ENABLE_STRIPE_TAX` is `"false"` by default, and turning it on without setup will
error the checkout.

To enable: activate **Stripe Tax**, register your origin address and any states
where you have nexus, then set the flag to `"true"` and redeploy.

Worth knowing: **food taxability varies enormously by state.** Groceries are exempt
in many states, but "prepared food" or "candy" often is not, and ice cream lands on
different sides of that line depending on jurisdiction and packaging. Stripe Tax
handles the mechanics once products are categorised, but the categorisation is a
question for an accountant, not a default.

---

## Before you can legally ship food

The payment plumbing is the easy part. Selling frozen dairy interstate in the US
generally also needs:

- **FDA food facility registration** for the facility that manufactures it
- A **state dairy/frozen-dessert manufacturing licence** — dairy is regulated more
  tightly than shelf-stable food, and many states licence frozen desserts specifically
- **Nutrition Facts labelling** from verified analytical testing, not calculated
  values. Everything in this repo is calculated and marked as such.
- **Allergen declaration** — this formula contains milk, and the flagship and caramel
  bases contain egg. Peanut and pistachio variants add those.
- A **co-packer** already holding the above, which is the usual route and much faster
  than licensing your own facility

Cottage-food exemptions generally do **not** cover dairy, and typically do not cover
interstate shipping. Get this confirmed for your state before the first live order —
it is the part that carries real consequences, and it is cheaper to sort out now than
after you have taken money.
