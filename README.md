# Guiltless

Marketing site and formulation documentation for **Guiltless** — a high-protein ice cream
built taste-first.

**Targets:** 335 kcal · 42 g protein · 10 g fat per 473 mL pint, at 45% overrun.

## What's here

| Path | Purpose |
|---|---|
| `index.html` | Landing page — the problem, the competitive comparison, the four levers |
| `science.html` | Full formulation: freezing-point maths, 24-ingredient deck with mechanisms, process spec, open problems |
| `flavors.html` | Launch eight, with per-flavour macros and the formulation problem each solves |
| `franchise.html` | Growth sequencing, model economics, roadmap, franchise legal notice |
| `docs/formulation-spec.md` | Internal master formula (% w/w), mass balance, QC gates, change log |
| `assets/css/site.css` | Design system — tokens, light/dark, components |
| `assets/js/site.js` | Theme toggle, mobile nav, scroll reveal, waitlist handling |

## Running it

Static HTML with no build step, no dependencies, and no external network requests —
fonts are system stacks, the logo and favicon are inline SVG, textures are CSS.

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Deploys as-is to GitHub Pages, Netlify, Cloudflare Pages or any static host. No
configuration required.

## Before this goes live

These are deliberate gaps, not oversights:

1. **The waitlist form has no backend.** It currently opens the visitor's mail client via
   `mailto:` and tells them so. Wire it to a real list provider before launch — the handler
   is `data-waitlist` in `assets/js/site.js`.
2. **Replace the placeholder address.** `hello@guiltless.example` appears in the
   `data-waitlist` attribute on all four pages.
3. **Nutrition figures are calculated, not assayed.** Every number is derived from ingredient
   specifications using Atwater factors plus the FDA's 0.4 kcal/g for allulose. A printed
   Nutrition Facts panel requires third-party analytical testing. The site says this in four
   places; keep it saying so until testing is done.
4. **Competitor figures are sourced and dated.** Frozen One and Halo Top numbers on
   `index.html` carry footnotes with links. Re-verify before launch — competitors reformulate,
   and a stale comparison claim is a legal exposure.
5. **The franchise page is not an offer.** It carries the required notice. In the US a
   franchise may only be offered through a prepared and (in registration states) registered
   FDD. Do not add pricing, territory availability, or an "apply now" flow to that page until
   counsel has cleared an FDD.

## Formulation summary

The short version of `docs/formulation-spec.md`:

- **Allulose replaces sugar's physics, not its sweetness.** MW 180 vs sucrose's 342 gives
  ~1.9× the freezing-point depression per gram at 0.4 kcal/g. This is what makes the pint
  scoopable straight from a freezer.
- **10 g of real butterfat, deliberately not zero.** Fat builds the partial-coalescence
  network that gives stand-up and slow melt, and carries the aroma compounds that low-fat
  products lose. Polysorbate 80 at 0.03% ensures none of it sits inert.
- **85:15 casein-to-whey.** Casein micelles bind ~3.7 g water per gram (less freezable water,
  smaller crystals) and scatter light into real opacity. Whey is capped because it aggregates
  above ~75 °C into chalk.
- **45% overrun, not 82%.** Air is the cheap way to cut calories per pint. We left it on the
  table; the pint weighs ~359 g as a result.
- **No erythritol.** Cooling burn, recrystallisation grit, and contested cardiovascular
  literature — when allulose beats it on all three, the choice makes itself.

Priority order for every formulation decision: **taste → texture → macros → cost.**
