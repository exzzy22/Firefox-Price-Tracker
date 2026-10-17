// KW automotive store (store.kwautomotive.de, all brand/country store views).
// Its product configurator renders prices client-side from JSON endpoints, so
// the HTML a background check fetches never contains a price. For
// configurator URLs the background asks the same endpoints the page does:
//
//   1. couch_adapter getProducts?car_id=<c_car>&group_id=<g> for each g in
//      `pgs`, until one returns the product group named by `ag`;
//   2. productfinder/ajax/GetProductsPriceAndAvailability for that group's
//      product id.
//
// Free of browser APIs (fetching is injected) so it can be unit-tested.
import { parseMachineNumber, structuredRaw } from './price.js';
import type { FetchJson, PriceHit } from './types.js';

const HOST = /^store\.kwautomotive\.de$/i;

export interface KwTarget {
  // Store-view root the page and its endpoints live under,
  // e.g. "https://store.kwautomotive.de/de/st/".
  base: string;
  carId: string;
  groupKey: string;
  groupIds: string[];
}

export function kwTarget(url: string): KwTarget | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || !HOST.test(u.hostname)) return null;
  const root = u.pathname.match(/^((?:\/[^/]+)*\/)shop\/?$/)?.[1];
  if (!root) return null;
  const carId = u.searchParams.get('c_car') ?? '';
  const groupKey = u.searchParams.get('ag') ?? '';
  const groupIds = (u.searchParams.get('pgs') ?? '').split(',').filter(g => /^\d+$/.test(g));
  if (!/^\d+$/.test(carId) || !/^[\w-]+$/.test(groupKey) || !groupIds.length) return null;
  return { base: u.origin + root, carId, groupKey, groupIds };
}

function groupIn(groups: unknown, groupKey: string): Record<string, unknown> | null {
  if (!Array.isArray(groups)) return null;
  for (const g of groups) {
    if (g && typeof g === 'object' && (g as Record<string, unknown>).group_key === groupKey) {
      return g as Record<string, unknown>;
    }
  }
  return null;
}

// A group with several products for the car needs a choice on the page that
// the URL doesn't record, so there's no telling which one was tracked.
function singleProductId(group: Record<string, unknown>): number | null {
  const products = group.products;
  if (!Array.isArray(products) || products.length !== 1) return null;
  const id = Number((products[0] as Record<string, unknown> | null)?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Response shape: [{"155140": {"price": 1349, "strike_price": 1349, ...}}].
// Unknown ids come back as {"<id>": ["<id> not found."]}.
function priceIn(json: unknown, id: number): number | null {
  for (const entry of Array.isArray(json) ? json : [json]) {
    if (!entry || typeof entry !== 'object') continue;
    const info = (entry as Record<string, unknown>)[String(id)];
    if (!info || typeof info !== 'object' || Array.isArray(info)) continue;
    const v = parseMachineNumber((info as Record<string, unknown>).price);
    if (v != null && v > 0) return v;
  }
  return null;
}

// The endpoints return bare numbers; the currency is the store view's, which
// the caller knows from the price it saw on the page.
export async function fetchKwPrice(
  target: KwTarget,
  fetchJson: FetchJson,
  currency: string | null
): Promise<PriceHit | null> {
  for (const groupId of target.groupIds) {
    const groups = await fetchJson(
      `${target.base}fwd_php/couch_adapter/get.php/getProducts?car_id=${target.carId}&group_id=${groupId}&brand_filter=`);
    const group = groupIn(groups, target.groupKey);
    if (!group) continue;
    const id = singleProductId(group);
    if (id == null) return null;
    const prices = await fetchJson(`${target.base}productfinder/ajax/GetProductsPriceAndAvailability`, {
      method: 'POST',
      // Without X-Requested-With the endpoint redirects to the home page.
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: `idarr%5B%5D=${id}`
    });
    const price = priceIn(prices, id);
    return price == null ? null : { price, raw: structuredRaw(price, currency), currency, source: 'api:kwautomotive' };
  }
  return null;
}
