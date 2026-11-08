// Display helpers shared by the popup, details page and notifications.
import { cleanNumber, extractCurrencySnippet, hasCurrencyMarker } from './price.js';
import { sanitizeAlert } from './tracking.js';
import type { HistoryEntry, TrackedItem } from './types.js';

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(currency: string | null, fractionDigits: number | null): Intl.NumberFormat | null {
  const key = `${currency ?? ''}|${fractionDigits ?? ''}`;
  let fmt = numberFormats.get(key);
  if (!fmt) {
    try {
      fmt = currency
        ? new Intl.NumberFormat(undefined, { style: 'currency', currency })
        : new Intl.NumberFormat(undefined, { minimumFractionDigits: fractionDigits ?? 0, maximumFractionDigits: 2 });
    } catch {
      return null; // unknown currency code
    }
    numberFormats.set(key, fmt);
  }
  return fmt;
}

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

// Best human rendering of a price: locale-formatted when the currency is
// known, the site's own text when it carries a symbol, else a bare number.
export function formatPrice(
  price: number | null | undefined,
  currency?: string | null,
  raw?: string | null
): string {
  if (finite(price) && currency) {
    const fmt = numberFormat(currency, null);
    if (fmt) return fmt.format(price);
  }
  const snippet = raw ? extractCurrencySnippet(raw) : '';
  if (snippet && hasCurrencyMarker(snippet)) return snippet;
  if (finite(price)) {
    return numberFormat(null, Number.isInteger(price) ? 0 : 2)!.format(price);
  }
  return snippet || '—';
}

export function formatItemPrice(item: Pick<TrackedItem, 'lastPrice' | 'currency' | 'lastRaw'>): string {
  return formatPrice(item.lastPrice, item.currency, item.lastRaw);
}

// "below €99.00", "above €150.00", "below €80.00 or above €120.00"; null
// without an alert.
export function formatAlert(item: Pick<TrackedItem, 'alert' | 'currency'>): string | null {
  const alert = sanitizeAlert(item.alert);
  if (!alert) return null;
  const parts: string[] = [];
  if (alert.below != null) parts.push(`below ${formatPrice(alert.below, item.currency)}`);
  if (alert.above != null) parts.push(`above ${formatPrice(alert.above, item.currency)}`);
  return parts.join(' or ');
}

// The symbol shown next to a price input ("€", "CHF"), or '' when unknown.
export function currencySymbol(currency: string | null | undefined): string {
  if (!currency) return '';
  const fmt = numberFormat(currency, null);
  return fmt?.formatToParts(0).find(p => p.type === 'currency')?.value ?? '';
}

// A price as the user typed it: "89.99", "89,99", "1 299", "€89". null for
// an empty field, 'invalid' for anything that isn't a positive price.
export function parsePriceInput(text: string): number | null | 'invalid' {
  const s = text.trim();
  if (!s) return null;
  // Digits and separators, with at most a short currency marker either side.
  // No minus signs: "-5" is not a price.
  if (!/^[^\d\-−]{0,4}\d[\d\s.,'’]*[^\d\-−]{0,4}$/u.test(s)) return 'invalid';
  const value = cleanNumber(s);
  return value != null && value > 0 ? value : 'invalid';
}

// Pre-fills a price input. Plain digits with a dot read back unchanged
// through parsePriceInput in every locale.
export function priceInputValue(value: number | null | undefined): string {
  return finite(value) ? String(Math.round(value * 100) / 100) : '';
}

export interface PriceChange {
  from: number;
  to: number;
  delta: number;
  pct: number;
}

function change(from: number, to: number): PriceChange | null {
  if (!(from > 0) || Math.abs(to - from) < 0.005) return null;
  return { from, to, delta: to - from, pct: ((to - from) / from) * 100 };
}

// Change from the previous distinct price to the current one.
export function lastChange(item: Pick<TrackedItem, 'history' | 'lastPrice'>): PriceChange | null {
  const current = item.lastPrice;
  if (!finite(current)) return null;
  const hist = item.history ?? [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const p = hist[i]!.price;
    if (finite(p) && Math.abs(p - current) >= 0.005) return change(p, current);
  }
  return null;
}

// Change since the item was first tracked.
export function changeSinceAdded(item: Pick<TrackedItem, 'history' | 'lastPrice'>): PriceChange | null {
  const first = (item.history ?? []).find(h => finite(h.price));
  if (!first || !finite(item.lastPrice)) return null;
  return change(first.price as number, item.lastPrice);
}

export function priceRange(history: HistoryEntry[]): { min: number; max: number } | null {
  const prices = history.map(h => h.price).filter(finite);
  if (!prices.length) return null;
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

export function formatPct(pct: number): string {
  const abs = Math.abs(pct);
  const digits = abs < 10 ? 1 : 0;
  return `${pct < 0 ? '−' : '+'}${abs.toFixed(digits)}%`;
}

const relFormats = new Map<string, Intl.RelativeTimeFormat>();

function relFormat(style: Intl.RelativeTimeFormatStyle): Intl.RelativeTimeFormat | null {
  if (typeof Intl.RelativeTimeFormat !== 'function') return null;
  let fmt = relFormats.get(style);
  if (!fmt) {
    fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style });
    relFormats.set(style, fmt);
  }
  return fmt;
}

export function relativeTime(
  ts: number | null | undefined,
  now: number = Date.now(),
  style: Intl.RelativeTimeFormatStyle = 'long'
): string {
  const relFmt = relFormat(style);
  if (!ts) return 'never';
  const diff = ts - now;
  const abs = Math.abs(diff);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 365 * 864e5], ['month', 30 * 864e5], ['week', 7 * 864e5],
    ['day', 864e5], ['hour', 36e5], ['minute', 6e4]
  ];
  if (abs < 45e3) return 'just now';
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'minute') {
      const value = Math.round(diff / ms);
      return relFmt ? relFmt.format(value, unit) : `${Math.abs(value)} ${unit}${Math.abs(value) === 1 ? '' : 's'} ago`;
    }
  }
  return '';
}

export function formatTimestamp(ts: number | null | undefined): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// Drops a trailing (or leading, "Amazon.de: ...") site-name segment from a
// page title: "Widget Pro | Example Shop" -> "Widget Pro". Only separators
// with spaces around them count, so "Spider-Man" and "Wi-Fi" stay intact.
export function cleanTitle(title: string | null | undefined, hostname = ''): string {
  let t = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const site = norm(hostname.toLowerCase().replace(/^www\d*\./, '').split('.')[0] ?? '');
  const looksLikeSite = (seg: string) =>
    (!!site && norm(seg).includes(site)) || /^[\w-]+(?:\.[\w-]+)+$/.test(seg.trim());
  // Prefix only when it is a bare domain ("Amazon.de: ..."), so product
  // names like "Nike Air Max: ..." survive.
  const prefix = t.match(/^([\w-]+(?:\.[\w-]+)+)\s?:\s+(.+)$/);
  if (prefix) t = prefix[2]!;
  const suffix = t.match(/^(.+?)\s+[|–—·-]\s+([^|–—·]+)$/);
  if (suffix && suffix[1]!.length >= 8 && looksLikeSite(suffix[2]!)) t = suffix[1]!;
  return t;
}
