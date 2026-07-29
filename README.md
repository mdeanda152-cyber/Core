# Guiltless

Website and formulation documentation for **Guiltless** — high-protein ice cream built taste-first.

**Targets:** 335 kcal · 42 g protein · 10 g fat per 473 mL pint, at 45% overrun (~359 g net).

## What's here

| Path | Purpose |
|---|---|
| `index.html` | Landing page + the interactive freezing-point model |
| `shop.html` | Storefront — product grid, volume pricing, working cart, checkout handoff |
| `science.html` | Full formulation: FPD maths, all 24 ingredients with mechanisms, 7-step process spec, open problems |
| `flavors.html` | Launch eight, per-flavour macros and the problem each solves |
| `franchise.html` | Growth sequencing, model economics, roadmap gates, franchise legal notice |
| `404.html` | Not-found page |
| `success.html` | Post-payment order confirmation |
| `shipping.html` | Shipping, returns and refunds policy |
| `allergens.html` | Allergen table per flavour, fibre/allulose tolerance, nutrition basis |
| `terms.html` | Terms of sale |
| `privacy.html` | Privacy policy |
| `admin.html` | Order desk — token-gated, lists and advances orders |
| `api/` | Stripe Checkout backend (Cloudflare Worker), order storage, tests |
| `docs/payments.md` | Payment setup, testing, tax and food-licensing notes |
| `docs/formulation-spec.md` | Internal master formula (% w/w), mass balance, QC gates, change log |
| `assets/css/site.css` | Design system — tokens, light/dark, components |
| `assets/js/site.js` | Theme, nav, reveal, freezing-point model, waitlist, cart |
| `assets/js/admin.js` | Order desk client |
| `.github/workflows/deploy-site.yml` | Builds, link-checks and deploys to GitHub Pages |

## Running it locally

Static HTML. No build step, no dependencies, no external network requests — system font
stacks, inline SVG, CSS gradients.

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Privacy

**The site is not published.** GitHub Pages is not enabled, and the deploy workflow is
`workflow_dispatch` only — it never fires on its own. Nothing is served publicly until you
run it deliberately from the Actions tab.

Note that **the repository itself is public**, so this source is readable on github.com.
To make it private: **Settings → General → Danger Zone → Change repository visibility**.

`shop.html` also carries `<meta name="robots" content="noindex, nofollow">` so it stays out
of search results if the site does go live before you are ready to sell.

## Deploying (when you want it live)

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**
2. **Actions → Deploy site to GitHub Pages → Run workflow**

The workflow stages the site, fails the build if any internal link is broken, then
publishes to `https://mdeanda152-cyber.github.io/Core/`. To deploy automatically on every
push to `main`, uncomment the `push:` block in `.github/workflows/deploy-site.yml`.

If you point a custom domain at it, update the host in `sitemap.xml` and `robots.txt`.

## The store

`shop.html` is a working storefront: add to cart, quantity controls, cart persisted to
`localStorage`, and **volume pricing computed at cart level** rather than as separate bundle
SKUs — the per-pint price drops as the pack grows and product cards update live.

| Setting | Value | Where |
|---|---|---|
| Base price per pint | `$9.50` | `UNIT` in `site.js` |
| Volume tiers | 4+ → 8%, 8+ → 14%, 12+ → 20% | `TIERS` |
| Shipping | `$12.99`, free at `$75` | `SHIP`, `FREE_AT` |
| Pack minimum | 4 pints | `MIN_PINTS` |

**These prices are placeholders — set your own before selling anything.**

### Payments

Built and tested — it needs your Stripe keys and one deploy. **Full instructions:
[`docs/payments.md`](docs/payments.md).**

```bash
cd api && npm install
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler deploy
```

Then paste the Worker URL into `data-checkout-endpoint` on the cart in `shop.html`.

**Card details never touch this codebase** — the shopper goes to Stripe's hosted
Checkout page, which keeps you out of PCI scope. Don't add card fields to the site.

The security-critical property: **the browser never sends a price.** It sends product
IDs and quantities; `api/src/catalog.js` looks up real prices server-side, recomputes
the volume tier and shipping, and charges that. A tampered cart claiming a one-cent
pint is still charged full price — there's a test for it:

```bash
cd api && node --test test/catalog.test.js test/orders.test.js   # 28 tests
```

### Order desk

Paid orders land in Cloudflare KV and are managed from `admin.html` — no third-party
tool needed. Newest first, filterable by status, shipping address loaded on demand,
and buttons to move an order `new → packed → shipped`.

Setup is in [`docs/payments.md`](docs/payments.md): create a KV namespace, set an
`ADMIN_TOKEN` secret, and point `data-api` at your Worker.

The token lives in `sessionStorage`, so it dies with the tab and never touches disk.
**Anyone holding it can read customer names, addresses and phone numbers** — treat it
like a password. `admin.html` is `noindex`, but that is a request to crawlers, not
access control; the token is the actual control. Put Cloudflare Access in front of
`/admin/*` if you want a second factor.

Stripe retries webhooks, so orders are keyed by session id plus creation time: a retry
overwrites the same record rather than creating a duplicate, and will not reset an
order you have already marked packed.

Until an endpoint is configured the Checkout button says plainly that payments aren't
connected, rather than pretending to take an order.

### Policy pages

Stripe's account activation review expects a published refund policy, terms, privacy
policy and contact details, so these are a hard prerequisite for taking live payments —
not paperwork to do later. Four pages exist and are linked from every footer.

They are drafted for a frozen-dairy DTC business, but **they are a starting point written
by an engineer, not legal advice.** Have a lawyer review them before you go live,
particularly the liability and governing-law clauses.

Every value that must be filled in is marked `[LIKE THIS]` and rendered as a highlighted
chip, so nothing ships as a plausible-looking blank:

| Placeholder | Page |
|---|---|
| `[LEGAL ENTITY NAME]`, `[BUSINESS ADDRESS]` | `terms.html` |
| `[STATE]`, `[STATE/COUNTY]` | `terms.html` |
| `[CO-PACKER CROSS-CONTACT STATEMENT]` | `allergens.html` |
| `[EMAIL PROVIDER]`, `[N]` (retention years) | `privacy.html` |
| `[DATE]` (last updated) | all four |

The cross-contact statement is the one that matters most: it cannot honestly be written
until a manufacturing facility is contracted, and someone with a severe allergy will read
it. The page currently says so outright.

The privacy policy claims no cookies, no analytics and no ad pixels. **That is currently
true** — the site loads zero third-party scripts. If you add analytics later, update that
page in the same commit.

### Still needed before you can actually sell

- **Food licensing** — FDA facility registration, a state dairy/frozen-dessert licence,
  verified nutrition panels and allergen declarations. Cottage-food exemptions generally
  do not cover dairy or interstate shipping. See the end of `docs/payments.md`.
- **Legal review** of the four policy pages, and the placeholders above filled in
- Real product photography (product tiles are CSS gradients as placeholders)
- Sales tax — `ENABLE_STRIPE_TAX` is off by default; food taxability varies by state

## Design

Cold-chain instrumentation: blast-freezer blue-black ground, frost-white type, monospace for
all data, and a single warm caramel accent used sparingly. The palette encodes the brand's
central tension — cold science, warm taste. Light and dark themes are both designed, with a
toggle that overrides the OS preference and persists.

The homepage centrepiece is a **live freezing-point model**. Two sliders (allulose, butterfat)
recompute sucrose-equivalent depression per 100 g water, calories, protein density and total
solids, and report a scoop-hardness verdict against the 26–30 premium window. It's the actual
physics the formula turns on, so a visitor can feel why 18 g is the answer rather than taking
our word for it.

## Before this goes live

Deliberate gaps, not oversights:

1. **Wire the waitlist.** Forms currently open the visitor's mail client and say so. To make
   them post for real, add `data-endpoint="https://…"` to each `<form data-waitlist>` — the
   handler POSTs `{email, source}` as JSON and handles success, failure and the busy state.
   Any provider that accepts JSON works (Formspree, Buttondown, a Cloudflare Worker).
2. **Replace the placeholder address.** `hello@guiltless.example` appears on four pages.
3. **Nutrition figures are calculated, not assayed.** Derived from ingredient specs using
   Atwater factors plus the FDA's 0.4 kcal/g for allulose. A printed Nutrition Facts panel
   requires third-party analytical testing. The site says so in several places — keep it
   saying so until testing is done.
4. **Re-verify competitor figures.** Frozen One and Halo Top numbers carry footnotes with
   dated source links. Competitors reformulate, and a stale comparison claim is legal exposure.
5. **The franchise page is not an offer.** It carries the required notice. In the US a
   franchise may only be offered through a prepared and (in registration states) registered
   FDD. Don't add pricing, territory availability or an "apply now" flow until counsel has
   cleared an FDD.

## Formulation summary

The short version of `docs/formulation-spec.md`:

- **Allulose replaces sugar's physics, not its sweetness.** MW 180 vs sucrose's 342 → ~1.9×
  the freezing-point depression per gram at 0.4 kcal/g. This is what makes the pint scoopable
  straight from a freezer.
- **10 g of real butterfat, deliberately not zero.** Fat builds the partial-coalescence
  network that gives stand-up and slow melt, and carries the aroma compounds low-fat products
  lose. Polysorbate 80 at 0.03% ensures none of it sits inert.
- **85:15 casein-to-whey.** Casein micelles bind ~3.7 g water per gram (less freezable water,
  smaller crystals) and scatter light into real opacity. Whey is capped because it aggregates
  above ~75 °C into chalk.
- **45% overrun, not 82%.** Air is the cheap way to cut calories per pint. We left it on the
  table; the pint weighs ~359 g as a result.
- **No erythritol.** Cooling burn, recrystallisation grit, and contested cardiovascular
  literature — when allulose beats it on all three, the choice makes itself.

Priority order for every formulation decision: **taste → texture → macros → cost.**
