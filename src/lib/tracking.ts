// Pure tracked-item bookkeeping: history, price-change confirmation and
// import validation. Kept free of browser APIs so it can be unit-tested.
import { hasCurrencyMarker, normalizeCurrencyCode } from './price.js';
import { isWebUrl } from './url.js';
import type { AlertSide, HistoryEntry, NotifyOn, PriceAlert, TrackedItem } from './types.js';

export const HISTORY_LIMIT = 200;
// Prices are compared at display precision; HSN-style "19.701001" vs
// "19.70" is the same price.
export const PRICE_EPSILON = 0.005;
// A changed price must be seen again at least this much later before it is
// recorded and notified. Filters out prices a site serves briefly: flash-sale
// boundaries, CDN caches serving stale copies for a few minutes (HSN's are
// up to ~6 min old), A/B tests.
export const CONFIRM_MIN_AGE_MS = 4 * 60_000;
// Items the background can't read (JS-rendered, bot-protected) are only ever
// updated by page visits, so those updates are accepted directly.
export const FAIL_WARN_THRESHOLD = 2;

export function appendHistory(item: TrackedItem, entry: HistoryEntry): void {
  item.history = Array.isArray(item.history) ? item.history : [];
  const last = item.history[item.history.length - 1];
  if (last && last.raw === entry.raw && last.price === entry.price) return;
  item.history.push(entry);
  if (item.history.length > HISTORY_LIMIT) {
    item.history = item.history.slice(-HISTORY_LIMIT);
  }
}

export function pricesEqual(a: number | null | undefined, b: number | null | undefined): boolean {
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return Math.abs(a - b) < PRICE_EPSILON;
}

export interface ApplyResult {
  changed: boolean;
  notify: { prev: number; prevRaw: string } | null;
  pending: boolean;
}

export function commitPrice(item: TrackedItem, hit: { price: number; raw: string; currency?: string | null }, now: number): void {
  item.lastPrice = hit.price;
  item.lastRaw = hit.raw;
  if (hit.currency) item.currency = hit.currency;
  item.updatedAt = now;
  item.pending = null;
  appendHistory(item, { ts: now, price: hit.price, raw: hit.raw });
}

// source 'check': a background fetch; 'visit': the content script saw the
// price on the user's own page view (never notifies; the user saw it).
export function applyHit(
  item: TrackedItem,
  hit: { price: number; raw: string; currency?: string | null },
  source: 'check' | 'visit',
  now: number
): ApplyResult {
  const none: ApplyResult = { changed: false, notify: null, pending: false };
  if (!item.currency && hit.currency) item.currency = hit.currency;

  if (item.lastPrice == null || !Number.isFinite(item.lastPrice)) {
    commitPrice(item, hit, now);
    delete item.quietNextChange;
    return { ...none, changed: true };
  }
  if (pricesEqual(item.lastPrice, hit.price)) {
    // Same price; a blip we were waiting to confirm has reverted.
    item.pending = null;
    delete item.quietNextChange;
    if (hit.raw && hasCurrencyMarker(hit.raw) && !hasCurrencyMarker(item.lastRaw)) item.lastRaw = hit.raw;
    return none;
  }

  const pending = item.pending;
  const confirms = pending && pricesEqual(pending.price, hit.price) && now - pending.firstSeen >= CONFIRM_MIN_AGE_MS;
  if (confirms || (source === 'visit' && (item.failedChecks ?? 0) >= FAIL_WARN_THRESHOLD)) {
    const prev = item.lastPrice;
    const prevRaw = item.lastRaw;
    const quiet = source === 'visit' || pending?.source === 'visit' || !!item.quietNextChange;
    commitPrice(item, hit, now);
    delete item.quietNextChange;
    return { changed: true, notify: quiet ? null : { prev, prevRaw }, pending: false };
  }
  if (!pending || !pricesEqual(pending.price, hit.price)) {
    item.pending = { price: hit.price, raw: hit.raw, currency: hit.currency ?? null, firstSeen: now, source };
  }
  return { ...none, pending: true };
}

// Bounds must be positive prices, and with both set below must be under
// above (otherwise every price would match one side). Returns null when
// nothing valid is left.
export function sanitizeAlert(raw: unknown): PriceAlert | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const bound = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const below = bound(o.below);
  const above = bound(o.above);
  if (below == null && above == null) return null;
  if (below != null && above != null && above - below < PRICE_EPSILON) return null;
  return { below, above };
}

// Which side of the alert `price` is on, at cent precision ("at or below",
// "at or above"), or null when it is between the bounds / there is no alert.
export function alertMatch(alert: unknown, price: number | null | undefined): AlertSide | null {
  const a = sanitizeAlert(alert);
  if (!a || typeof price !== 'number' || !Number.isFinite(price)) return null;
  if (a.below != null && price < a.below + PRICE_EPSILON) return 'below';
  if (a.above != null && price > a.above - PRICE_EPSILON) return 'above';
  return null;
}

export type NotifyReason = 'change' | AlertSide;

// Whether a confirmed change from `prev` to `next` notifies, and why.
// Without an alert the global setting decides. An alert replaces it: it
// fires when the price reaches the target, and again on every further move
// past it (cheaper still, or pricier still), but not when the price moves
// back toward or out of the range.
export function notifyReason(item: Pick<TrackedItem, 'alert'>, prev: number, next: number, notifyOn: NotifyOn): NotifyReason | null {
  const alert = sanitizeAlert(item.alert);
  if (!alert) return notifyOn === 'any' || next < prev ? 'change' : null;
  const side = alertMatch(alert, next);
  if (side === 'below') return alertMatch(alert, prev) !== 'below' || next < prev ? 'below' : null;
  if (side === 'above') return alertMatch(alert, prev) !== 'above' || next > prev ? 'above' : null;
  return null;
}

export function sanitizeImported(raw: unknown): TrackedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.url !== 'string' || !isWebUrl(o.url)) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const history: HistoryEntry[] = Array.isArray(o.history)
    ? o.history
      .filter((h): h is Record<string, unknown> => !!h && typeof h === 'object' && typeof (h as Record<string, unknown>).ts === 'number')
      .map(h => ({ ts: h.ts as number, price: num(h.price), raw: str(h.raw) }))
      .slice(-HISTORY_LIMIT)
    : [];
  const now = Date.now();
  const image = typeof o.image === 'string' && isWebUrl(o.image) ? o.image : null;
  const alert = sanitizeAlert(o.alert);
  return {
    ...(alert ? { alert } : {}),
    url: o.url,
    title: str(o.title) || o.url,
    lastPrice: num(o.lastPrice),
    lastRaw: str(o.lastRaw),
    selector: typeof o.selector === 'string' && o.selector ? o.selector : null,
    image,
    currency: normalizeCurrencyCode(o.currency),
    updatedAt: num(o.updatedAt) ?? now,
    lastChecked: num(o.lastChecked) ?? 0,
    addedAt: num(o.addedAt) ?? history[0]?.ts ?? now,
    failedChecks: 0,
    history
  };
}
