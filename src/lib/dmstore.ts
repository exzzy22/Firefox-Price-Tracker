// dm-drogerie markt (dm.de, dm.hr, dm.si, ...). Product pages are a shell
// that fetches everything client-side, so the HTML a background check gets
// never contains a price. The page's own source is dm's product API, keyed by
// the country (the site's TLD) and the dm article number in the URL:
// https://www.dm.hr/p/d/<dan>/<slug>.
//
// Free of browser APIs (fetching is injected) so it can be unit-tested.
import { cleanNumber, normalizeCurrencyCode, parseMachineNumber, structuredRaw } from './price.js';
import type { FetchJson, PriceHit } from './types.js';

const HOST = /^(?:www\.)?dm\.([a-z]{2})$/i;

export interface DmTarget {
  country: string;
  dan: string;
}

export function dmTarget(url: string): DmTarget | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const country = u.protocol === 'https:' ? u.hostname.match(HOST)?.[1] : undefined;
  const dan = u.pathname.match(/^\/p\/d\/(\d+)(?:\/|$)/)?.[1];
  return country && dan ? { country: country.toUpperCase(), dan } : null;
}

// obj.a.b.c, without trusting the response's shape.
function at(obj: unknown, ...path: string[]): unknown {
  let v = obj;
  for (const key of path) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
  return v;
}

// Response: { metadata: { price: 0.95, currency: "EUR" },
//             price: { price: { current: { value: "0,95 €" } } }, ... }
export async function fetchDmPrice(target: DmTarget, fetchJson: FetchJson): Promise<PriceHit | null> {
  const product = await fetchJson(
    `https://products.dm.de/product/products/detail/${target.country}/dan/${target.dan}`);
  const value = parseMachineNumber(at(product, 'metadata', 'price'));
  if (value == null || value <= 0) return null;
  const currency = normalizeCurrencyCode(at(product, 'metadata', 'currency'));
  const shown = at(product, 'price', 'price', 'current', 'value');
  const raw = typeof shown === 'string' && cleanNumber(shown) === value ? shown.trim() : structuredRaw(value, currency);
  return { price: value, raw, currency, source: 'api:dm' };
}
