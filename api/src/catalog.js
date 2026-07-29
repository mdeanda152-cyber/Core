/**
 * Server-side source of truth for pricing.
 *
 * The browser sends only product IDs and quantities. Every price, discount and
 * shipping figure is recomputed here from this file. Nothing the client sends
 * about money is ever trusted — a cart POST is a request, not a quote.
 *
 * Keep these values in sync with UNIT / TIERS / SHIP / FREE_AT / MIN_PINTS in
 * ../../assets/js/site.js. The frontend copy exists only so the shopper sees
 * live totals; this copy is the one that charges the card.
 */

/** All amounts in cents, to avoid floating-point money. */
export const CATALOG = {
  vanilla:    { name: 'Toasted Milk & Vanilla Bean',     cents: 950 },
  chocolate:  { name: 'Dark Chocolate Truffle',          cents: 950 },
  caramel:    { name: 'Salted Butter Caramel',           cents: 950 },
  coffee:     { name: 'Coffee & Cream',                  cents: 950 },
  strawberry: { name: 'Strawberries & Cultured Cream',   cents: 950 },
  peanut:     { name: 'Peanut Butter Fudge Ripple',      cents: 950 },
  cookies:    { name: 'Cookies & Cultured Cream',        cents: 950 },
  pistachio:  { name: 'Pistachio & Olive Oil',           cents: 950 }
};

/** Volume discount applied on total pint count, highest matching tier wins. */
export const TIERS = [
  { min: 12, rate: 0.20 },
  { min: 8,  rate: 0.14 },
  { min: 4,  rate: 0.08 },
  { min: 0,  rate: 0    }
];

export const MIN_PINTS      = 4;      // dry-ice boxes need the thermal mass
export const SHIP_CENTS     = 1299;
export const FREE_SHIP_AT   = 7500;   // on the discounted merchandise subtotal
export const MAX_PINTS      = 48;     // sanity bound on a single order
export const CURRENCY       = 'usd';

export function tierFor(qty) {
  return TIERS.find(t => qty >= t.min) || TIERS[TIERS.length - 1];
}

/**
 * Validate a client cart and price it.
 * @param {Array<{id:string, qty:number}>} rawItems
 * @returns {{ok:true, lines:Array, qty:number, subtotal:number, shipping:number, rate:number}
 *          |{ok:false, error:string}}
 */
export function priceCart(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: false, error: 'Cart is empty.' };
  }

  // Collapse duplicates and coerce quantities to safe integers.
  const merged = new Map();
  for (const item of rawItems) {
    const id = typeof item?.id === 'string' ? item.id : null;
    if (!id || !Object.prototype.hasOwnProperty.call(CATALOG, id)) {
      return { ok: false, error: `Unknown product: ${String(item?.id).slice(0, 40)}` };
    }
    // Accept a number or a plain digit string only. Bare Number() coercion
    // would quietly turn `true` into 1 and `['5']` into 5.
    const rawQty = item.qty;
    const isNumber = typeof rawQty === 'number';
    const isDigits = typeof rawQty === 'string' && /^\d+$/.test(rawQty);
    if (!isNumber && !isDigits) {
      return { ok: false, error: `Invalid quantity for ${id}.` };
    }
    const qty = Number(rawQty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_PINTS) {
      return { ok: false, error: `Invalid quantity for ${id}.` };
    }
    merged.set(id, (merged.get(id) || 0) + qty);
  }

  const totalQty = [...merged.values()].reduce((n, q) => n + q, 0);
  if (totalQty < MIN_PINTS) {
    return { ok: false, error: `Minimum order is ${MIN_PINTS} pints.` };
  }
  if (totalQty > MAX_PINTS) {
    return { ok: false, error: `Maximum order is ${MAX_PINTS} pints.` };
  }

  const { rate } = tierFor(totalQty);

  const lines = [];
  let subtotal = 0;
  for (const [id, qty] of merged) {
    const product = CATALOG[id];
    const unit = Math.round(product.cents * (1 - rate));
    subtotal += unit * qty;
    lines.push({ id, name: product.name, qty, unit });
  }

  const shipping = subtotal >= FREE_SHIP_AT ? 0 : SHIP_CENTS;

  return { ok: true, lines, qty: totalQty, subtotal, shipping, rate };
}
