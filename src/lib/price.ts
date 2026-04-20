// Shared price parsing utilities. DOM-touching helpers accept any Document
// so they can be exercised under happy-dom in tests.
import type { FindPriceOptions, NormalizedPrice, PriceHit } from './types.js';

export const CURRENCY_RE = /[$£€¥]\s?\d[\d,.\s]*/;
export const CURRENCY_RE_G = /[$£€¥]\s?\d[\d,.\s]*/g;

export const WOOCOMMERCE_SELECTORS: readonly string[] = [
  'ins .woocommerce-Price-amount',
  '.woocommerce-Price-amount',
];

export const AMAZON_SELECTORS: readonly string[] = [
  '#priceblock_ourprice',
  '#priceblock_dealprice',
  '#priceblock_saleprice',
  '#price_inside_buybox',
  '#tp_price_block_total_price_ww .a-offscreen',
  '.a-price .a-offscreen',
  '.priceToPay .a-offscreen',
  '#corePrice_feature_div .a-offscreen',
  '#corePriceDisplay_desktop_feature_div .a-offscreen'
];

export function cleanNumber(input: unknown): number | null {
  if (input == null) return null;
  const norm = String(input).replace(/[^0-9.,\-]/g, '').trim();
  if (!norm) return null;
  const commaCount = (norm.match(/,/g) ?? []).length;
  const dotCount = (norm.match(/\./g) ?? []).length;
  let cleaned: string;
  if (commaCount && !dotCount) {
    cleaned = norm.replace(/,/g, '.');
  } else if (commaCount && dotCount && norm.lastIndexOf(',') > norm.lastIndexOf('.')) {
    cleaned = norm.replace(/\./g, '').replace(/,/g, '.');
  } else {
    cleaned = norm.replace(/,/g, '');
  }
  const v = parseFloat(cleaned);
  return Number.isFinite(v) ? v : null;
}

export function extractCurrencySnippet(input: unknown): string {
  if (input == null) return '';
  const s = String(input);
  const m = s.match(CURRENCY_RE);
  if (m) return m[0].replace(/\s+/g, ' ').trim();
  return s.replace(/\s+/g, ' ').trim();
}

export function normalizeRaw(raw: unknown): NormalizedPrice {
  const snippet = extractCurrencySnippet(raw);
  const price = cleanNumber(snippet);
  const sym = (String(raw ?? '').match(/[$£€¥]/) ?? [null])[0];
  return { raw: snippet, price, currencySymbol: sym };
}

export function canonicalForCompare(raw: unknown): string {
  const n = normalizeRaw(raw);
  if (Number.isFinite(n.price)) return String(n.price);
  return String(raw ?? '').replace(/[$£€¥]/g, '').replace(/\s+/g, ' ').trim();
}

export function readPriceFromElement(el: Element | null | undefined): PriceHit | null {
  if (!el) return null;
  const content = el.getAttribute('content');
  const rawVal = (content != null && content !== '')
    ? content
    : (el.textContent ?? (el as HTMLInputElement).value ?? '');
  const snippet = extractCurrencySnippet(rawVal);
  const v = cleanNumber(snippet);
  if (v == null) return null;
  return { price: v, raw: snippet };
}

export function pickLdPrice(obj: unknown): string | number | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (o.offers) {
    const offer = Array.isArray(o.offers) ? o.offers[0] : o.offers;
    if (offer && typeof offer === 'object') {
      const f = offer as Record<string, unknown>;
      if (f.price != null) return f.price as string | number;
      const spec = f.priceSpecification as Record<string, unknown> | undefined;
      if (spec && spec.price != null) return spec.price as string | number;
      if (f.lowPrice != null) return f.lowPrice as string | number;
    }
  }
  if (o.price != null) return o.price as string | number;
  if (Array.isArray(o['@graph'])) {
    for (const g of o['@graph']) {
      const p = pickLdPrice(g);
      if (p != null) return p;
    }
  }
  return null;
}

export function findPriceInJsonLd(doc: Document): PriceHit | null {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const s of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(s.textContent ?? '');
    } catch {
      continue;
    }
    const objs = Array.isArray(parsed) ? parsed : [parsed];
    for (const obj of objs) {
      const price = pickLdPrice(obj);
      if (price == null) continue;
      const snippet = extractCurrencySnippet(String(price)) || String(price);
      const v = cleanNumber(String(price));
      if (v != null) return { price: v, raw: snippet };
    }
  }
  return null;
}

export function findPriceInMicrodata(doc: Document): PriceHit | null {
  const scopes = doc.querySelectorAll('[itemscope][itemtype*="Product"]');
  for (const scope of scopes) {
    const el = scope.querySelector('[itemprop~=price], [itemprop=price]');
    const hit = readPriceFromElement(el);
    if (hit) return hit;
  }
  return null;
}

export function findPriceInMeta(doc: Document): PriceHit | null {
  const selectors = [
    'meta[property="product:price:amount"]',
    'meta[property="og:price:amount"]',
    'meta[itemprop="price"]'
  ];
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (!el) continue;
    const content = el.getAttribute('content');
    if (!content) continue;
    const v = cleanNumber(content);
    if (v != null) {
      return { price: v, raw: extractCurrencySnippet(content) || content };
    }
  }
  return null;
}

export function isProductPage(doc: Document): boolean {
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(s.textContent ?? '') as unknown;
      const objs = Array.isArray(parsed) ? parsed : [parsed];
      for (const obj of objs) {
        if (!obj || typeof obj !== 'object') continue;
        const o = obj as Record<string, unknown>;
        const t = o['@type'];
        if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) return true;
        if (o.offers) return true;
        if (Array.isArray(o['@graph'])) {
          for (const g of o['@graph']) {
            if (!g || typeof g !== 'object') continue;
            const gt = (g as Record<string, unknown>)['@type'];
            if (gt === 'Product' || (Array.isArray(gt) && gt.includes('Product'))) return true;
            if ((g as Record<string, unknown>).offers) return true;
          }
        }
      }
    } catch {
      // ignore malformed JSON-LD
    }
  }
  if (doc.querySelector('[itemscope][itemtype*="Product"]')) return true;
  const ogType = doc.querySelector('meta[property="og:type"]');
  if (ogType && /product/i.test(ogType.getAttribute('content') ?? '')) return true;
  if (doc.querySelector('meta[property="product:price:amount"]')) return true;
  if (doc.querySelector('form.cart') && doc.querySelector('.woocommerce-Price-amount')) return true;
  return false;
}

// Structured-data-only price finder. No body-text scanning — that was the
// source of false positives on non-product pages. See CLAUDE.md.
export function findPriceOnPage(doc: Document, options: FindPriceOptions = {}): PriceHit | null {
  const hostname = (options.hostname ?? '').toLowerCase();
  const preferredSelector = options.preferredSelector ?? null;

  if (preferredSelector) {
    try {
      const el = doc.querySelector(preferredSelector);
      const hit = readPriceFromElement(el);
      if (hit) return hit;
    } catch {
      // selector might be invalid after site rewrites; fall through
    }
  }

  if (hostname.includes('amazon.') && doc.querySelector('#productTitle')) {
    for (const sel of AMAZON_SELECTORS) {
      const el = doc.querySelector(sel);
      const hit = readPriceFromElement(el);
      if (hit) return hit;
    }
  }

  const structured = findPriceInJsonLd(doc)
    ?? findPriceInMicrodata(doc)
    ?? findPriceInMeta(doc);
  if (structured) return structured;

  if (doc.querySelector('form.cart') && doc.querySelector('.woocommerce-Price-amount')) {
    for (const sel of WOOCOMMERCE_SELECTORS) {
      const hit = readPriceFromElement(doc.querySelector(sel));
      if (hit) return hit;
    }
  }

  return isProductPage(doc)
    ? readPriceFromElement(doc.querySelector('[itemprop~=price], [itemprop=price]'))
    : null;
}

export function findPriceInHtml(html: string, options: FindPriceOptions = {}): PriceHit | null {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    return findPriceOnPage(doc, options);
  } catch {
    return null;
  }
}
