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
| `docs/formulation-spec.md` | Internal master formula (% w/w), mass balance, QC gates, change log |
| `assets/css/site.css` | Design system — tokens, light/dark, components |
| `assets/js/site.js` | Theme, nav, reveal, freezing-point model, waitlist |
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

### Wiring checkout

The store deliberately **does not collect card details**. That belongs to a PCI-compliant
processor, never to hand-rolled HTML. Checkout POSTs the cart as JSON and expects
`{ url }` back, then redirects:

```html
<aside class="cart" data-cart-drawer data-checkout-endpoint="https://your-api/checkout">
```

Your endpoint creates a Stripe Checkout session from the posted items and returns its URL.
Until one is configured, the Checkout button says plainly that checkout is not connected —
it does not pretend to take an order.

### Still needed before you can actually sell

- A payment processor and the endpoint above
- Real product photography (the product tiles are CSS gradients as placeholders)
- Terms, refund/replacement policy, and privacy policy pages
- Sales-tax handling — Stripe Tax or equivalent
- Verified nutrition panels (see below) before any macro claim is printed on packaging

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
