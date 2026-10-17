// Shared price parsing utilities. DOM-touching helpers accept any Document
// so they can be exercised under happy-dom in tests.
import type { FindPriceOptions, NormalizedPrice, PriceHit } from './types.js';

// ---------------------------------------------------------------------------
// Currency markers
// ---------------------------------------------------------------------------

// Symbol/word -> ISO 4217 code, or null when the marker is ambiguous
// (`$` could be USD/CAD/AUD/..., `¥` JPY/CNY, `kr` SEK/NOK/DKK).
const SYMBOL_CURRENCY: Readonly<Record<string, string | null>> = {
  'US$': 'USD', 'CA$': 'CAD', 'C$': 'CAD', 'AU$': 'AUD', 'A$': 'AUD',
  'NZ$': 'NZD', 'HK$': 'HKD', 'S$': 'SGD', 'MX$': 'MXN', 'R$': 'BRL', 'NT$': 'TWD',
  '$': null, '£': 'GBP', '€': 'EUR', '¥': null, '￥': null, '₹': 'INR', '₩': 'KRW',
  '₽': 'RUB', '₺': 'TRY', '₪': 'ILS', '₫': 'VND', '฿': 'THB', '₱': 'PHP', '₴': 'UAH',
  '₦': 'NGN', '₸': 'KZT', '₾': 'GEL', '₼': 'AZN', '₡': 'CRC', '₵': 'GHS', '₨': null,
  'zł': 'PLN', 'Kč': 'CZK', 'Ft': 'HUF', 'lei': 'RON', 'лв': 'BGN', 'kn': 'HRK',
  'din': 'RSD', 'руб': 'RUB', 'грн': 'UAH', 'Fr.': 'CHF', 'RM': 'MYR', 'Rp': 'IDR',
  'Rs.': null, 'Rs': null, 'kr.': null, 'kr': null, 'Kr.': null, 'Kr': null
};

const ISO_CODES: readonly string[] = [
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'RMB', 'INR', 'KRW', 'RUB', 'TRY', 'ILS', 'PLN',
  'CZK', 'HUF', 'RON', 'BGN', 'HRK', 'RSD', 'BAM', 'MKD', 'SEK', 'NOK', 'DKK', 'ISK',
  'CHF', 'CAD', 'AUD', 'NZD', 'HKD', 'SGD', 'TWD', 'MXN', 'BRL', 'ARS', 'CLP', 'COP',
  'PEN', 'UYU', 'ZAR', 'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'EGP', 'MAD', 'NGN',
  'KES', 'THB', 'VND', 'PHP', 'IDR', 'MYR', 'UAH', 'GEL', 'KZT', 'PKR', 'BDT', 'LKR'
];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Word-like markers ("kr", "EUR") must not be glued to other letters, so
// "USDC" or "Kraft" never count as currency.
function markerSource(marker: string): string {
  const pre = /^\p{L}/u.test(marker) ? '(?<!\\p{L})' : '';
  const post = /\p{L}$/u.test(marker) ? '(?!\\p{L})' : '';
  return pre + escapeRe(marker) + post;
}

const MARKERS = [...Object.keys(SYMBOL_CURRENCY), ...ISO_CODES]
  .sort((a, b) => b.length - a.length);
const MARKER_SRC = `(?:${MARKERS.map(markerSource).join('|')})`;

// A number as humans write prices: grouped thousands ("1,299.99", "1.299,99",
// "1 299,99", "1'299.99") or a plain run of digits with an optional decimal part.
const NUM_SRC = String.raw`\d{1,3}(?:[.,\s  '’]\d{3})+(?:[.,]\d{1,2})?(?!\d)|\d+(?:[.,]\d+)?`;
const GAP_SRC = String.raw`[\s  ]?`;
const PRICE_SRC = `${MARKER_SRC}${GAP_SRC}(?:${NUM_SRC})|(?:${NUM_SRC})${GAP_SRC}${MARKER_SRC}`;

// A currency marker adjacent to a number, prefix ("€12") or suffix ("12 zł").
export const CURRENCY_RE = new RegExp(PRICE_SRC, 'u');
export const CURRENCY_RE_G = new RegExp(PRICE_SRC, 'gu');
const MARKER_RE = new RegExp(MARKER_SRC, 'u');
const NUM_RE = new RegExp(NUM_SRC, 'u');

export function hasCurrencyMarker(input: unknown): boolean {
  return input != null && MARKER_RE.test(String(input));
}

// ISO code for the first currency marker in the text, or null when there is
// none or it is ambiguous.
export function currencyCodeOf(input: unknown): string | null {
  if (input == null) return null;
  const m = String(input).match(MARKER_RE);
  if (!m) return null;
  const marker = m[0];
  if (marker in SYMBOL_CURRENCY) return SYMBOL_CURRENCY[marker] ?? null;
  return marker === 'RMB' ? 'CNY' : marker;
}

// Accepts an ISO code as found in structured data; rejects anything else.
export function normalizeCurrencyCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.trim().toUpperCase();
  if (code === 'RMB') return 'CNY';
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

// ---------------------------------------------------------------------------
// Number parsing
// ---------------------------------------------------------------------------

// Turns one number token into a value, deciding which separator (if any) is
// the decimal point. A lone separator followed by exactly three digits is a
// thousands separator ("1,299" -> 1299, "1.299" -> 1299) unless the integer
// part is zero ("0,999").
function tokenToNumber(token: string): number | null {
  const seps = [...token.matchAll(/[.,\s  '’]/g)];
  let decimalAt = -1;
  const last = seps[seps.length - 1];
  if (last && (last[0] === '.' || last[0] === ',')) {
    const idx = last.index ?? 0;
    const digitsAfter = token.length - idx - 1;
    const sameKind = seps.filter(s => s[0] === last[0]).length;
    if (digitsAfter !== 3) decimalAt = idx;
    else if (sameKind > 1) decimalAt = -1;
    else if (seps.length > 1) decimalAt = idx;
    else if (/^0+$/.test(token.slice(0, idx))) decimalAt = idx;
  }
  const intDigits = (decimalAt >= 0 ? token.slice(0, decimalAt) : token).replace(/\D/g, '');
  const decDigits = decimalAt >= 0 ? token.slice(decimalAt + 1).replace(/\D/g, '') : '';
  if (!intDigits && !decDigits) return null;
  const v = parseFloat(`${intDigits || '0'}${decDigits ? '.' + decDigits : ''}`);
  return Number.isFinite(v) ? v : null;
}

// Parses the first number in human-written text ("$1,299.99", "1.299,99 €").
export function cleanNumber(input: unknown): number | null {
  if (input == null) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const m = String(input).match(NUM_RE);
  return m ? tokenToNumber(m[0]) : null;
}

// Parses machine-formatted values from structured data ("1299.00", 1299).
// Falls back to the human parser for sites that put "1.299,00 €" there.
export function parseMachineNumber(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return parseFloat(s);
  return cleanNumber(s);
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
  const sym = String(raw ?? '').match(MARKER_RE);
  return { raw: snippet, price, currencySymbol: sym ? sym[0] : null };
}

export function canonicalForCompare(raw: unknown): string {
  const n = normalizeRaw(raw);
  if (Number.isFinite(n.price)) return String(n.price);
  return String(raw ?? '').replace(MARKER_RE, '').replace(/\s+/g, ' ').trim();
}

// Raw string for a price that came from structured data. Kept parseable by
// normalizeRaw, e.g. "EUR 19.70".
export function structuredRaw(value: number, currency: string | null): string {
  const num = Number.isInteger(value * 100) ? value.toFixed(2) : String(value);
  return currency ? `${currency} ${num}` : num;
}

function isPositive(v: number | null): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

// ---------------------------------------------------------------------------
// Reading prices from elements
// ---------------------------------------------------------------------------

interface ReadOptions {
  // Descendants to ignore, e.g. struck-through list prices.
  exclude?: readonly string[];
  // Only accept text that carries a currency marker (used by heuristics).
  requireMarker?: boolean;
}

function visibleText(el: Element, exclude?: readonly string[]): string {
  if (!exclude?.length) return el.textContent ?? '';
  const clone = el.cloneNode(true) as Element;
  for (const sel of exclude) {
    for (const n of clone.querySelectorAll(sel)) n.remove();
  }
  return clone.textContent ?? '';
}

export function readPriceFromElement(
  el: Element | null | undefined,
  options: ReadOptions = {}
): PriceHit | null {
  if (!el) return null;
  const text = visibleText(el, options.exclude).replace(/\s+/g, ' ').trim();
  const machine = el.getAttribute('content') ?? el.getAttribute('data-price-amount');
  if (machine != null && machine.trim() !== '') {
    const v = parseMachineNumber(machine);
    if (v == null) return null;
    const snippet = extractCurrencySnippet(text);
    const raw = hasCurrencyMarker(snippet) && cleanNumber(snippet) === v ? snippet : machine.trim();
    return { price: v, raw, currency: currencyCodeOf(raw) };
  }
  const snippet = extractCurrencySnippet(text);
  if (options.requireMarker && !hasCurrencyMarker(snippet)) return null;
  const v = cleanNumber(snippet);
  if (v == null) return null;
  return { price: v, raw: snippet, currency: currencyCodeOf(snippet) };
}

// First element across `selectors` (in order, then document order) that
// yields a positive price.
function firstPrice(
  root: ParentNode,
  selectors: readonly string[],
  read: (el: Element) => PriceHit | null
): PriceHit | null {
  for (const sel of selectors) {
    let els: NodeListOf<Element>;
    try { els = root.querySelectorAll(sel); } catch { continue; }
    for (const el of els) {
      const hit = read(el);
      if (hit && isPositive(hit.price)) return hit;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

// Parsed JSON-LD per <script>, re-parsed only when its text changes (the
// content script re-runs detection while JS-rendered pages mutate).
const ldCache = new WeakMap<Element, { text: string; value: unknown }>();

function parseLenientJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Common breakage: HTML comment/CDATA wrappers, raw newlines inside
    // strings, trailing commas.
    const cleaned = text
      .replace(/^\s*(?:<!--|\/\/\s*<!\[CDATA\[)/, '')
      .replace(/(?:-->|\/\/\s*\]\]>)\s*$/, '')
      .replace(/[\u0000-\u001f]+/g, ' ')
      .replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(cleaned); } catch { return undefined; }
  }
}

function jsonLdRoots(doc: Document): unknown[] {
  const out: unknown[] = [];
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    const text = s.textContent ?? '';
    let entry = ldCache.get(s);
    if (!entry || entry.text !== text) {
      entry = { text, value: parseLenientJson(text) };
      ldCache.set(s, entry);
    }
    if (entry.value !== undefined) out.push(entry.value);
  }
  return out;
}

type LdNode = Record<string, unknown>;

const PRODUCT_TYPES = new Set([
  'product', 'productgroup', 'individualproduct', 'productmodel', 'someproducts',
  'vehicle', 'car', 'motorcycle', 'dietarysupplement', 'drug'
]);

function ldTypes(node: LdNode): string[] {
  const t = node['@type'];
  const list = Array.isArray(t) ? t : [t];
  return list
    .filter((x): x is string => typeof x === 'string')
    .map(x => x.replace(/^.*[/:#]/, '').toLowerCase());
}

function isProductNode(node: LdNode): boolean {
  return ldTypes(node).some(t => PRODUCT_TYPES.has(t));
}

// Product-like nodes in document order. Follows @graph, mainEntity and
// BuyAction.object, but never ItemList members (category pages list many
// products and none of them is "the" product).
export function jsonLdProducts(doc: Document): LdNode[] {
  const out: LdNode[] = [];
  const visit = (v: unknown, depth: number): void => {
    if (depth > 6 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    const node = v as LdNode;
    if (isProductNode(node) || (node.offers && !ldTypes(node).includes('itemlist'))) out.push(node);
    for (const key of ['@graph', 'mainEntity', 'object', 'itemReviewed']) {
      if (node[key]) visit(node[key], depth + 1);
    }
  };
  for (const root of jsonLdRoots(doc)) visit(root, 0);
  return out;
}

interface LdOffer {
  value: number;
  currency: string | null;
  // AggregateOffer ranges ("from X") are a weak signal: the page may show a
  // different variant. HSN, for one, publishes the cheapest of 100+ variants.
  weak: boolean;
}

const LIST_PRICE_TYPES = /strikethrough|listprice|msrp|srp|invoice/i;

function priceFromSpec(spec: unknown, fallbackCurrency: string | null): LdOffer | null {
  const specs = Array.isArray(spec) ? spec : [spec];
  for (const s of specs) {
    if (!s || typeof s !== 'object') continue;
    const o = s as LdNode;
    if (typeof o.priceType === 'string' && LIST_PRICE_TYPES.test(o.priceType)) continue;
    const v = parseMachineNumber(o.price);
    if (isPositive(v)) {
      return { value: v, currency: normalizeCurrencyCode(o.priceCurrency) ?? fallbackCurrency, weak: false };
    }
  }
  return null;
}

function offerPrice(offer: unknown, depth = 0): LdOffer | null {
  if (!offer || typeof offer !== 'object' || depth > 3) return null;
  if (Array.isArray(offer)) {
    for (const o of offer) {
      const hit = offerPrice(o, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const o = offer as LdNode;
  const currency = normalizeCurrencyCode(o.priceCurrency);
  const direct = parseMachineNumber(o.price);
  if (isPositive(direct)) return { value: direct, currency, weak: false };
  const spec = priceFromSpec(o.priceSpecification, currency);
  if (spec) return spec;
  // AggregateOffer: nested offers first, then the range.
  if (o.offers) {
    const nested = offerPrice(o.offers, depth + 1);
    if (nested) return nested;
  }
  const low = parseMachineNumber(o.lowPrice);
  if (isPositive(low)) {
    const high = parseMachineNumber(o.highPrice);
    const count = Number(o.offerCount);
    const isRange = (isPositive(high) && Math.abs(high - low) > 0.0001) || count > 1;
    return { value: low, currency, weak: isRange };
  }
  return null;
}

function nodeUrls(node: LdNode): string[] {
  const urls: string[] = [];
  const add = (u: unknown) => { if (typeof u === 'string') urls.push(u); };
  add(node.url); add(node['@id']);
  const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
  for (const o of offers) if (o && typeof o === 'object') add((o as LdNode).url);
  return urls;
}

// For a ProductGroup, prefer the variant the URL points at (?variant=,
// ?skuId=, or the variant's own url), else the first priced variant.
function variantPrice(group: LdNode, pageUrl: string | undefined): LdOffer | null {
  const variants = (Array.isArray(group.hasVariant) ? group.hasVariant : [group.hasVariant])
    .filter((v): v is LdNode => !!v && typeof v === 'object');
  if (!variants.length) return null;
  if (pageUrl) {
    let page: URL | null = null;
    try { page = new URL(pageUrl); } catch { /* ignore */ }
    if (page) {
      const pagePath = page.origin + page.pathname;
      // Not searchParams.values(): not iterable through content-script Xrays.
      const params = page.search.replace(/^\?/, '').split('&').map(part => {
        const v = part.slice(part.indexOf('=') + 1);
        try { return decodeURIComponent(v); } catch { return v; }
      });
      for (const v of variants) {
        const sku = typeof v.sku === 'string' ? v.sku : null;
        const urlMatch = nodeUrls(v).some(u => {
          try {
            const vu = new URL(u, page!.href);
            if (vu.search) return vu.origin + vu.pathname + vu.search === page!.origin + page!.pathname + page!.search;
            return vu.origin + vu.pathname === pagePath && !page!.search;
          } catch { return false; }
        });
        if (urlMatch || (sku && params.includes(sku))) {
          const hit = offerPrice(v.offers);
          if (hit) return hit;
        }
      }
    }
  }
  for (const v of variants) {
    const hit = offerPrice(v.offers);
    if (hit) return hit;
  }
  return null;
}

function productNodePrice(node: LdNode, pageUrl?: string): LdOffer | null {
  return offerPrice(node.offers) ?? variantPrice(node, pageUrl);
}

// Back-compat helper (and handy in tests): the raw price value of a JSON-LD
// object, walking offers/@graph.
export function pickLdPrice(obj: unknown): string | number | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as LdNode;
  if (o.offers) {
    const offer = Array.isArray(o.offers) ? o.offers[0] : o.offers;
    if (offer && typeof offer === 'object') {
      const f = offer as LdNode;
      if (f.price != null) return f.price as string | number;
      const spec = f.priceSpecification as LdNode | undefined;
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

function jsonLdOffer(doc: Document, pageUrl?: string): LdOffer | null {
  let weak: LdOffer | null = null;
  for (const node of jsonLdProducts(doc)) {
    const hit = productNodePrice(node, pageUrl);
    if (!hit) continue;
    if (!hit.weak) return hit;
    weak ??= hit;
  }
  return weak;
}

function toHit(offer: LdOffer, source: string): PriceHit {
  return { price: offer.value, raw: structuredRaw(offer.value, offer.currency), currency: offer.currency, source };
}

export function findPriceInJsonLd(doc: Document, pageUrl?: string): PriceHit | null {
  const offer = jsonLdOffer(doc, pageUrl);
  return offer ? toHit(offer, offer.weak ? 'json-ld-range' : 'json-ld') : null;
}

// ---------------------------------------------------------------------------
// Microdata and meta tags
// ---------------------------------------------------------------------------

export function findPriceInMicrodata(doc: Document): PriceHit | null {
  const scopes = doc.querySelectorAll('[itemscope][itemtype*="Product"], [itemscope][itemtype*="product"]');
  for (const scope of scopes) {
    const el = scope.querySelector('[itemprop~=price], [itemprop~=lowPrice]');
    const hit = readPriceFromElement(el);
    if (!hit || !isPositive(hit.price)) continue;
    const curEl = scope.querySelector('[itemprop~=priceCurrency]');
    const code = normalizeCurrencyCode(curEl?.getAttribute('content') ?? curEl?.textContent);
    return { ...hit, currency: code ?? hit.currency ?? null, source: 'microdata' };
  }
  return null;
}

function metaContent(doc: Document, names: readonly string[]): string | null {
  for (const n of names) {
    const v = doc.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.getAttribute('content');
    if (v != null && v.trim() !== '') return v;
  }
  return null;
}

function saleIsCurrent(doc: Document, now: number): boolean {
  const parse = (v: string | null) => {
    if (!v) return null;
    const t = Date.parse(v.replace(' ', 'T'));
    return Number.isFinite(t) ? t : null;
  };
  const start = parse(metaContent(doc, ['product:sale_price_dates:start']));
  const end = parse(metaContent(doc, ['product:sale_price_dates:end']));
  if (start != null && now < start) return false;
  if (end != null && now > end) return false;
  return true;
}

export function findPriceInMeta(doc: Document, now: number = Date.now()): PriceHit | null {
  const currency = normalizeCurrencyCode(metaContent(doc, [
    'product:sale_price:currency', 'product:price:currency', 'og:price:currency'
  ])) ?? normalizeCurrencyCode(doc.querySelector('meta[itemprop="priceCurrency"]')?.getAttribute('content'));
  const candidates: string[] = [];
  if (saleIsCurrent(doc, now)) {
    const sale = metaContent(doc, ['product:sale_price:amount']);
    if (sale) candidates.push(sale);
  }
  const amount = metaContent(doc, ['product:price:amount', 'og:price:amount']);
  if (amount) candidates.push(amount);
  const itemprop = doc.querySelector('meta[itemprop="price"]')?.getAttribute('content');
  if (itemprop) candidates.push(itemprop);
  for (const c of candidates) {
    const v = parseMachineNumber(c);
    if (!isPositive(v)) continue;
    const code = currency ?? currencyCodeOf(c);
    return { price: v, raw: structuredRaw(v, code), currency: code, source: 'meta' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Site rules
// ---------------------------------------------------------------------------

interface SiteRule {
  name: string;
  host: RegExp;
  // Any of these present => this is a product page on this site.
  signals: readonly string[];
  // Tried in order; the first element yielding a price wins.
  prices: readonly string[];
  exclude?: readonly string[];
  read?: (el: Element) => PriceHit | null;
  // For shops that put the price in inline script data instead of markup.
  // Replaces `prices` when given.
  extract?: (doc: Document, pageUrl?: string) => PriceHit | null;
}

// Amazon product-page signals. #productTitle is desktop-only; mobile
// uses the core price display feature divs instead, so we accept any.
export const AMAZON_PRODUCT_PAGE_SIGNALS: readonly string[] = [
  '#productTitle',
  '#corePriceDisplay_desktop_feature_div',
  '#corePriceDisplay_mobile_feature_div',
  '#corePrice_feature_div',
  '#corePrice_desktop',
  '#apex_desktop'
];

// Buy-box price only. Never a bare `.a-price`: product pages carry dozens
// of them in recommendation carousels, and when the item can't be bought
// (e.g. doesn't ship to the user) the first one belongs to another product.
// `.a-text-price` is the struck-through list price or the unit price.
export const AMAZON_SELECTORS: readonly string[] = [
  '#corePriceDisplay_desktop_feature_div .priceToPay',
  '#corePriceDisplay_mobile_feature_div .priceToPay',
  '#corePrice_feature_div .priceToPay',
  '#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price)',
  '#corePriceDisplay_mobile_feature_div .a-price:not(.a-text-price)',
  '#corePrice_feature_div .a-price:not(.a-text-price)',
  '#corePrice_desktop .a-price:not(.a-text-price)',
  '#corePrice_mobile_feature_div .a-price:not(.a-text-price)',
  '#apex_desktop .a-price:not(.a-text-price)',
  '#priceblock_dealprice',
  '#priceblock_ourprice',
  '#priceblock_saleprice',
  '#price_inside_buybox',
  '#newBuyBoxPrice',
  '#tp_price_block_total_price_ww .a-offscreen',
  '#kindle-price',
  '#buyNewSection .offer-price'
];

// Amazon's hidden `.a-offscreen` text is sometimes missing the decimal point
// ("EUR1842" for €18.42), so build the price from the visible parts.
function readAmazonPrice(el: Element): PriceHit | null {
  const whole = el.querySelector('.a-price-whole');
  if (whole) {
    const wholeDigits = (whole.textContent ?? '').replace(/\D/g, '');
    const frac = (el.querySelector('.a-price-fraction')?.textContent ?? '').replace(/\D/g, '');
    const symbol = (el.querySelector('.a-price-symbol')?.textContent ?? '').trim();
    if (wholeDigits) {
      const price = parseFloat(frac ? `${wholeDigits}.${frac}` : wholeDigits);
      const offscreen = el.querySelector('.a-offscreen')?.textContent?.trim() ?? '';
      const raw = offscreen && cleanNumber(offscreen) === price
        ? offscreen
        : `${symbol}${wholeDigits}${frac ? '.' + frac : ''}`;
      return { price, raw, currency: currencyCodeOf(symbol || offscreen) };
    }
  }
  const off = el.querySelector('.a-offscreen');
  return readPriceFromElement(off && off.textContent?.trim() ? off : el);
}

const AMAZON_HOST = /(^|\.)amazon\.[a-z.]+$/;

// ASOS ships JSON-LD without offers. The price API's response is inlined in
// a script instead: window.asos.pdp.config.stockPriceResponse = '[...]',
// one entry per product id (the number after /prd/ in the URL).
function readAsosStockPrice(doc: Document, pageUrl?: string): PriceHit | null {
  const marker = "stockPriceResponse = '";
  for (const script of doc.querySelectorAll('script:not([src])')) {
    const text = script.textContent ?? '';
    const start = text.indexOf(marker);
    if (start < 0) continue;
    const end = text.indexOf("';", start + marker.length);
    if (end < 0) return null;
    let products: unknown;
    // A JS single-quoted literal: JSON with any apostrophes escaped.
    try { products = JSON.parse(text.slice(start + marker.length, end).replace(/\\'/g, "'")); } catch { return null; }
    if (!Array.isArray(products)) return null;
    const id = pageUrl?.match(/\/prd\/(\d+)/)?.[1];
    const product = (id && products.find(p => String((p as LdNode | null)?.productId) === id))
      ?? (products.length === 1 ? products[0] : null);
    const price = (product as LdNode | null)?.productPrice as LdNode | undefined;
    const current = price?.current as LdNode | undefined;
    const value = parseMachineNumber(current?.value);
    if (!isPositive(value)) return null;
    const currency = normalizeCurrencyCode(price?.currency);
    const shown = typeof current?.text === 'string' ? current.text.trim() : '';
    return { price: value, raw: cleanNumber(shown) === value ? shown : structuredRaw(value, currency), currency };
  }
  return null;
}

// Reads the element a user picked by hand (or its saved selector).
export function readPickedElement(el: Element | null | undefined, hostname = ''): PriceHit | null {
  if (!el) return null;
  const amazonPrice = AMAZON_HOST.test(hostname.toLowerCase()) ? el.closest('.a-price') : null;
  const hit = amazonPrice ? readAmazonPrice(amazonPrice) : readPriceFromElement(el);
  return hit ? { ...hit, source: 'selector' } : null;
}

export const SITE_RULES: readonly SiteRule[] = [
  {
    name: 'amazon',
    host: AMAZON_HOST,
    signals: AMAZON_PRODUCT_PAGE_SIGNALS,
    prices: AMAZON_SELECTORS,
    read: readAmazonPrice
  },
  {
    name: 'target',
    host: /(^|\.)target\.com$/,
    signals: ['[data-test="product-price"]'],
    prices: ['[data-test="product-price"]']
  },
  {
    name: 'newegg',
    host: /(^|\.)newegg\.(com|ca)$/,
    signals: ['.product-buy-box', '.product-pane .product-price'],
    // After load a collapsed "Buy Used" pane is inserted above "Buy New";
    // the raw HTML only has "Buy New".
    prices: [
      '.product-pane:not(.is-collapsed) .product-price [class*="price-current"]',
      '.product-pane .product-price [class*="price-current"]',
      '.product-buy-box [class*="price-current"]'
    ]
  },
  {
    name: 'mediamarkt',
    host: /(^|\.)(mediamarkt|saturn)\.[a-z.]+$/,
    signals: ['[data-test="mms-product-price"]'],
    prices: ['[data-test="mms-product-price"]', '[data-test~="mms-branded-price"]'],
    exclude: ['[data-test^="mms-strike-price"]']
  },
  {
    // The JSON-LD is only added after load; the markup is server-rendered.
    name: 'ekupi',
    host: /(^|\.)ekupi\.hr$/,
    signals: ['.main-price-block .final-price'],
    prices: ['.main-price-block .final-price'],
    exclude: ['.altPrice']
  },
  {
    name: 'svijet-medija',
    host: /(^|\.)svijet-medija\.hr$/,
    signals: ['.product__pricing .product__pricing-main'],
    prices: ['.product__pricing .product__pricing-main']
  },
  {
    // Public discounts (the shop's own list: clearance/promo) beat the regular
    // price. The "Klub" price (simple_loyalty) needs a login, and it is what
    // the JSON-LD added after load reports, so it must never win.
    name: 'emmezeta',
    host: /(^|\.)emmezeta\.hr$/,
    signals: ['.sidebar-price .product-item__price-box'],
    prices: [
      '.sidebar-price .simple_clearance .base-currency-price',
      '.sidebar-price .simple_promo .base-currency-price',
      '.sidebar-price .promo_price .base-currency-price',
      '.sidebar-price .simple_regular .base-currency-price'
    ]
  },
  {
    name: 'asos',
    host: /(^|\.)asos\.com$/,
    signals: ['#pdp-react-critical-app', '#pdp-react-app'],
    prices: [],
    extract: readAsosStockPrice
  }
];

function siteRuleFor(doc: Document, hostname: string): SiteRule | null {
  if (!hostname) return null;
  for (const rule of SITE_RULES) {
    if (rule.host.test(hostname) && rule.signals.some(sel => doc.querySelector(sel))) return rule;
  }
  return null;
}

function findPriceBySiteRule(doc: Document, rule: SiteRule, pageUrl?: string): PriceHit | null {
  const read = rule.read ?? ((el: Element) => readPriceFromElement(el, { exclude: rule.exclude }));
  const hit = rule.extract ? rule.extract(doc, pageUrl) : firstPrice(doc, rule.prices, read);
  return hit ? { ...hit, source: `site:${rule.name}` } : null;
}

// ---------------------------------------------------------------------------
// Platform markup and product-page heuristics
// ---------------------------------------------------------------------------

export const WOOCOMMERCE_SELECTORS: readonly string[] = [
  'p.price ins .woocommerce-Price-amount',
  'p.price .woocommerce-Price-amount:not(del .woocommerce-Price-amount)',
  '.summary .price ins .woocommerce-Price-amount',
  '.summary .price .woocommerce-Price-amount:not(del .woocommerce-Price-amount)',
];

// Last-resort selectors, only tried on pages that already carry a product
// signal, and only accepted when the text shows a currency (or the element
// has a machine-readable amount). Ordered from most to least specific.
export const GENERIC_PRICE_SELECTORS: readonly string[] = [
  '[itemprop~=price]',
  '.product-info-main [data-price-type="finalPrice"][data-price-amount]',
  '.product-info-price [data-price-type="finalPrice"][data-price-amount]',
  '.product-prices .current-price [content]',
  '.current-price-value',
  '.product__info-container .price__sale .price-item--sale',
  '.product__info-container .price-item--regular',
  '[data-testid="product-price"]',
  '[data-test="product-price"]',
  '[data-qa="product-price"]',
  '#product-price',
  '.product-price-value',
  '.product__price',
  '.product-price',
  '.pdp-price'
];

const STRIKE_EXCLUDE: readonly string[] = [
  'del', 's', 'strike', '.old-price', '.price--compare', '.price-was', '.was-price',
  '[class*="strike"]', '[class*="Strike"]', '[class*="compare-at"]', '[data-test*="strike"]'
];

function findPriceByGenericSelectors(doc: Document): PriceHit | null {
  const hit = firstPrice(doc, GENERIC_PRICE_SELECTORS, el =>
    readPriceFromElement(el, { exclude: STRIKE_EXCLUDE, requireMarker: !el.hasAttribute('content') && !el.hasAttribute('data-price-amount') }));
  return hit ? { ...hit, source: 'dom' } : null;
}

function hasWooCommerceProduct(doc: Document): boolean {
  return !!(doc.querySelector('form.cart') && doc.querySelector('.woocommerce-Price-amount'));
}

export function isProductPage(doc: Document, hostname?: string): boolean {
  if (jsonLdProducts(doc).some(n => isProductNode(n) || n.offers)) return true;
  if (doc.querySelector('[itemscope][itemtype*="Product"], [itemscope][itemtype*="product"]')) return true;
  const ogType = doc.querySelector('meta[property="og:type"]');
  if (ogType && /product/i.test(ogType.getAttribute('content') ?? '')) return true;
  if (doc.querySelector('meta[property="product:price:amount"]')) return true;
  if (hasWooCommerceProduct(doc)) return true;
  if (doc.querySelector('body.catalog-product-view, body#product')) return true; // Magento, PrestaShop
  if (hostname && siteRuleFor(doc, hostname.toLowerCase())) return true;
  return false;
}

// Structured-data-first price finder. No body-text scanning — that was the
// source of false positives on non-product pages. See CLAUDE.md.
export function findPriceOnPage(doc: Document, options: FindPriceOptions = {}): PriceHit | null {
  const hostname = (options.hostname ?? '').toLowerCase();
  const preferredSelector = options.preferredSelector ?? null;

  if (preferredSelector) {
    try {
      const hit = readPickedElement(doc.querySelector(preferredSelector), hostname);
      if (hit) return hit;
    } catch {
      // selector might be invalid after site rewrites; fall through
    }
  }

  const rule = siteRuleFor(doc, hostname);
  if (rule) {
    const hit = findPriceBySiteRule(doc, rule, options.pageUrl);
    if (hit) return hit;
  }

  const ld = jsonLdOffer(doc, options.pageUrl);
  if (ld && !ld.weak) return toHit(ld, 'json-ld');

  const structured = findPriceInMicrodata(doc) ?? findPriceInMeta(doc, options.now);
  if (structured) return structured;

  if (hasWooCommerceProduct(doc)) {
    const hit = firstPrice(doc, WOOCOMMERCE_SELECTORS, el => readPriceFromElement(el));
    if (hit) return { ...hit, source: 'woocommerce' };
  }

  // A known site whose own markup came up empty: don't guess from generic
  // class names (that's how Amazon carousels leak in).
  if (!rule && isProductPage(doc, hostname)) {
    const hit = findPriceByGenericSelectors(doc);
    if (hit) return hit;
  }

  return ld ? toHit(ld, 'json-ld-range') : null;
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

// ---------------------------------------------------------------------------
// Product title and image
// ---------------------------------------------------------------------------

function absoluteHttpUrl(u: unknown, base: string | undefined): string | null {
  if (typeof u !== 'string' || !u.trim()) return null;
  try {
    const url = new URL(u.trim(), base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function ldImage(img: unknown): unknown {
  const first = Array.isArray(img) ? img[0] : img;
  if (first && typeof first === 'object') {
    const o = first as LdNode;
    return o.url ?? o.contentUrl ?? null;
  }
  return first;
}

export function findProductImage(doc: Document, baseUrl?: string): string | null {
  const og = absoluteHttpUrl(doc.querySelector('meta[property="og:image"]')?.getAttribute('content'), baseUrl);
  if (og) return og;
  for (const node of jsonLdProducts(doc)) {
    const img = absoluteHttpUrl(ldImage(node.image), baseUrl);
    if (img) return img;
  }
  const tw = absoluteHttpUrl(doc.querySelector('meta[name="twitter:image"]')?.getAttribute('content'), baseUrl);
  if (tw) return tw;
  // Amazon: main product image lives in #landingImage; og/twitter tags are absent
  const amz = doc.querySelector('#landingImage, #imgTagWrappingDiv img, #main-image-container img');
  return absoluteHttpUrl(amz?.getAttribute('data-old-hires') || amz?.getAttribute('src'), baseUrl);
}

export function findTitle(doc: Document): string | null {
  const clean = (s: unknown) => typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  const amazon = clean(doc.querySelector('#productTitle')?.textContent);
  if (amazon) return amazon;
  for (const node of jsonLdProducts(doc)) {
    const name = clean(node.name);
    if (name) return name;
  }
  const og = clean(doc.querySelector('meta[property="og:title"]')?.getAttribute('content'));
  if (og) return og;
  const tw = clean(doc.querySelector('meta[name="twitter:title"]')?.getAttribute('content'));
  if (tw) return tw;
  return clean(doc.title) || null;
}
