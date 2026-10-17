// Background event page: periodic checks of tracked product URLs.
// Storage schema is documented in src/lib/types.ts and CLAUDE.md.
//
// This page is the only writer of `tracked`. Popup, details page and content
// script send messages instead of writing storage themselves, and every
// read-modify-write goes through withTracked(), so a long background check
// can no longer overwrite an item added or removed while it was running.
import { formatPct, formatPrice, cleanTitle } from './lib/format.js';
import { dmTarget, fetchDmPrice } from './lib/dmstore.js';
import { fetchKwPrice, kwTarget } from './lib/kwstore.js';
import {
  currencyCodeOf,
  findPriceInHtml,
  hasCurrencyMarker,
  normalizeRaw
} from './lib/price.js';
import {
  CONFIRM_MIN_AGE_MS,
  HISTORY_LIMIT,
  applyHit,
  commitPrice,
  sanitizeImported
} from './lib/tracking.js';
import { cleanUrl, isWebUrl, productKey, siteName } from './lib/url.js';
import type {
  FetchJson,
  ImportResponse,
  Message,
  NotifyOn,
  PickedItem,
  PriceHit,
  RunCheckMessage,
  RunCheckResponse,
  TrackedItem,
  VisitUpdateMessage
} from './lib/types.js';

const ALARM_NAME = 'checkPrices';
const CONFIRM_ALARM = 'confirmPrices';
const DEFAULT_INTERVAL_MINUTES = 60;
const MIGRATION_FLAG = 'normalizedV2';
const MIGRATION_V3_FLAG = 'normalizedV3';
// Notification ids embed the product url after this prefix so onClicked can
// reopen the page without holding state across event-page suspensions.
const NOTIFY_PREFIX = 'price-change:';
const FETCH_TIMEOUT_MS = 20_000;
const CHECK_CONCURRENCY = 3;
// Pending prices are re-checked after this delay (past CONFIRM_MIN_AGE_MS).
const CONFIRM_DELAY_MINUTES = 5;

const action = browser.action ?? browser.browserAction;

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

let trackedQueue: Promise<unknown> = Promise.resolve();

// Serialized read-modify-write of the tracked list.
function withTracked<T>(fn: (list: TrackedItem[]) => T | Promise<T>): Promise<T> {
  const run = trackedQueue.then(async () => {
    const { tracked } = await browser.storage.local.get('tracked');
    const list: TrackedItem[] = Array.isArray(tracked) ? tracked : [];
    const result = await fn(list);
    await browser.storage.local.set({ tracked: list });
    return result;
  });
  trackedQueue = run.catch(() => { /* keep the queue alive; caller sees the error */ });
  return run;
}

async function readTracked(): Promise<TrackedItem[]> {
  await trackedQueue;
  const { tracked } = await browser.storage.local.get('tracked');
  return Array.isArray(tracked) ? tracked : [];
}

interface Settings {
  intervalMinutes: number;
  notifyOn: NotifyOn;
}

async function getSettings(): Promise<Settings> {
  const { checkIntervalMinutes, notifyOn } = await browser.storage.local.get(['checkIntervalMinutes', 'notifyOn']);
  const interval = Number(checkIntervalMinutes);
  return {
    intervalMinutes: Number.isFinite(interval) && interval >= 1 ? interval : DEFAULT_INTERVAL_MINUTES,
    notifyOn: notifyOn === 'drop' ? 'drop' : 'any'
  };
}

function findByUrl(list: TrackedItem[], url: string): TrackedItem | undefined {
  const key = productKey(url);
  return list.find(i => productKey(i.url) === key);
}

// ---------------------------------------------------------------------------
// Badge + notifications
// ---------------------------------------------------------------------------

async function setBadge(count: number): Promise<void> {
  if (!action) return;
  await action.setBadgeText({ text: count > 0 ? String(count) : '' });
  if (action.setBadgeBackgroundColor) {
    await action.setBadgeBackgroundColor({ color: '#dc2626' });
  }
}

async function incrementBadge(): Promise<void> {
  const { badgeCount } = await browser.storage.local.get('badgeCount');
  const next = (Number(badgeCount) || 0) + 1;
  await browser.storage.local.set({ badgeCount: next });
  await setBadge(next);
}

async function clearBadge(): Promise<void> {
  await browser.storage.local.set({ badgeCount: 0 });
  await setBadge(0);
}

function notifyPriceChange(item: TrackedItem, prev: number, prevRaw: string): void {
  const next = item.lastPrice as number;
  const title = cleanTitle(item.title, siteName(item.url)) || item.url;
  const from = formatPrice(prev, item.currency, prevRaw);
  const to = formatPrice(next, item.currency, item.lastRaw);
  const arrow = next < prev ? '▼' : '▲';
  const pct = prev > 0 ? ` (${formatPct(((next - prev) / prev) * 100)})` : '';
  browser.notifications.create(`${NOTIFY_PREFIX}${item.url}`, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('icons/icon-128.png'),
    title: `${arrow} ${to}${pct}`,
    message: `${title}\nwas ${from}`
  });
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

type Observation =
  | { ok: true; hit: PriceHit }
  | { ok: false; error: string };

const BLOCK_MARKERS = /<title>\s*(?:Robot or human|Access Denied|Just a moment|Attention Required|Are you a robot|Verify Your Identity|Access to this page has been denied|Pardon Our Interruption)|px-captcha|cf-chl-|captcha-delivery\.com|splashui\/challenge|Bitte entschuldigen Sie die Störung/i;

function hostnameOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

// Shop cookies go along so region/currency match the user's own visits.
function shopFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, credentials: 'include', cache: 'no-cache', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

function fetchError(err: unknown): string {
  return err instanceof DOMException && err.name === 'TimeoutError' ? 'Timed out' : 'Network error';
}

class HttpStatusError extends Error {}

type ApiReader = (fetchJson: FetchJson) => Promise<PriceHit | null>;

// Shops whose pages never carry the price in their HTML: ask the JSON
// endpoints their pages use instead (src/lib/kwstore.ts, src/lib/dmstore.ts).
function apiReader(item: TrackedItem): ApiReader | null {
  const kw = kwTarget(item.url);
  if (kw) return fetchJson => fetchKwPrice(kw, fetchJson, item.currency ?? null);
  const dm = dmTarget(item.url);
  if (dm) return fetchJson => fetchDmPrice(dm, fetchJson);
  return null;
}

async function observeApi(read: ApiReader): Promise<Observation> {
  const fetchJson = async (url: string, init?: RequestInit): Promise<unknown> => {
    const resp = await shopFetch(url, init);
    if (!resp.ok) throw new HttpStatusError(`HTTP ${resp.status}`);
    return resp.json();
  };
  try {
    const hit = await read(fetchJson);
    return hit ? { ok: true, hit } : { ok: false, error: 'No price in page' };
  } catch (err) {
    if (err instanceof HttpStatusError) return { ok: false, error: err.message };
    // Not JSON: the endpoint answered with a page, i.e. the API changed.
    if (err instanceof SyntaxError) return { ok: false, error: 'No price in page' };
    return { ok: false, error: fetchError(err) };
  }
}

async function observe(item: TrackedItem): Promise<Observation> {
  const api = apiReader(item);
  if (api) return observeApi(api);
  let resp: Response;
  try {
    resp = await shopFetch(item.url, { method: 'GET' });
  } catch (err) {
    return { ok: false, error: fetchError(err) };
  }
  const html = await resp.text();
  if (!resp.ok) {
    return { ok: false, error: BLOCK_MARKERS.test(html.slice(0, 50_000)) ? 'Blocked by the site' : `HTTP ${resp.status}` };
  }
  const hit = findPriceInHtml(html, {
    hostname: hostnameOf(resp.url || item.url),
    preferredSelector: item.selector,
    pageUrl: item.url
  });
  if (hit) return { ok: true, hit };
  if (BLOCK_MARKERS.test(html.slice(0, 50_000))) return { ok: false, error: 'Blocked by the site' };
  return { ok: false, error: 'No price in page' };
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

async function scheduleConfirm(): Promise<void> {
  await browser.alarms.create(CONFIRM_ALARM, { delayInMinutes: CONFIRM_DELAY_MINUTES });
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await fn(next);
  });
  await Promise.all(workers);
}

interface CheckOptions {
  force?: boolean;
  url?: string;
  onlyPending?: boolean;
}

let running: Promise<RunCheckResponse> | null = null;

function checkAll(options: CheckOptions = {}): Promise<RunCheckResponse> {
  // Coalesce overlapping runs (alarm + popup refresh) into one.
  if (running && !options.url) return running;
  const run = doCheck(options).finally(() => { if (running === run) running = null; });
  if (!options.url) running = run;
  return run;
}

async function doCheck(options: CheckOptions): Promise<RunCheckResponse> {
  await ensureMigrated();
  const start = Date.now();
  const { intervalMinutes, notifyOn } = await getSettings();
  const list = await readTracked();
  const dueBefore = start - intervalMinutes * 60_000 + 30_000;
  const targetKey = options.url ? productKey(options.url) : null;
  const due = list.filter(item => {
    if (!isWebUrl(item.url)) return false;
    if (targetKey) return productKey(item.url) === targetKey;
    const pendingReady = !!item.pending && start - item.pending.firstSeen >= CONFIRM_MIN_AGE_MS;
    if (options.onlyPending) return pendingReady;
    return options.force || pendingReady || (item.lastChecked || item.updatedAt || 0) <= dueBefore;
  });

  const observations = new Map<string, Observation>();
  await pool(due, CHECK_CONCURRENCY, async item => {
    observations.set(item.url, await observe(item));
  });

  let changed = 0;
  let failed = 0;
  let needsConfirm = false;
  const notifications: Array<{ item: TrackedItem; prev: number; prevRaw: string }> = [];
  await withTracked(fresh => {
    const now = Date.now();
    for (const item of fresh) {
      const obs = observations.get(item.url);
      if (!obs) continue;
      item.lastChecked = now;
      if (!obs.ok) {
        item.failedChecks = (item.failedChecks ?? 0) + 1;
        item.lastError = obs.error;
        failed++;
        if (item.pending) needsConfirm = true;
        continue;
      }
      item.failedChecks = 0;
      item.lastError = null;
      const result = applyHit(item, obs.hit, 'check', now);
      if (result.pending) needsConfirm = true;
      if (result.changed) changed++;
      if (result.notify) {
        const dropped = (item.lastPrice as number) < result.notify.prev;
        if (notifyOn === 'any' || dropped) notifications.push({ item, ...result.notify });
      }
    }
  });

  for (const n of notifications) {
    notifyPriceChange(n.item, n.prev, n.prevRaw);
    await incrementBadge();
  }
  if (needsConfirm) await scheduleConfirm();
  await browser.storage.local.set({ lastRunAt: Date.now() });
  return { checked: due.length, skipped: list.length - due.length, changed, failed, durationMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Mutations requested by the UI and content script
// ---------------------------------------------------------------------------

function newItem(pick: PickedItem, price: number | null, raw: string, now: number): TrackedItem {
  return {
    url: cleanUrl(pick.url),
    title: pick.title || pick.url,
    lastPrice: price,
    lastRaw: raw,
    selector: pick.selector ?? null,
    image: pick.image ?? null,
    currency: pick.currency ?? currencyCodeOf(raw),
    updatedAt: now,
    lastChecked: now,
    addedAt: now,
    failedChecks: 0,
    history: [{ ts: now, price, raw }]
  };
}

// Track (or re-track) a product from the popup or the manual picker. The
// user is looking at this price right now, so it is committed directly.
async function upsertItem(pick: PickedItem): Promise<void> {
  if (!isWebUrl(pick.url)) return;
  const norm = normalizeRaw(pick.raw ?? '');
  const price = typeof pick.price === 'number' && Number.isFinite(pick.price) ? pick.price : norm.price;
  const raw = norm.raw || String(pick.raw ?? '');
  const now = Date.now();
  await withTracked(list => {
    const existing = findByUrl(list, pick.url);
    if (!existing) {
      list.push(newItem(pick, price, raw, now));
      return;
    }
    if (pick.selector !== undefined && pick.selector !== null) existing.selector = pick.selector;
    if (pick.image && !existing.image) existing.image = pick.image;
    if (pick.title && (!existing.title || existing.title === existing.url)) existing.title = pick.title;
    existing.failedChecks = 0;
    existing.lastError = null;
    existing.lastChecked = now;
    if (price != null) commitPrice(existing, { price, raw, currency: pick.currency ?? currencyCodeOf(raw) }, now);
  });
}

async function removeItem(url: string): Promise<void> {
  const key = productKey(url);
  await withTracked(list => {
    const idx = list.findIndex(i => productKey(i.url) === key);
    if (idx >= 0) list.splice(idx, 1);
  });
}

async function visitUpdate(msg: VisitUpdateMessage): Promise<void> {
  if (!isWebUrl(msg.url) || !Number.isFinite(msg.price)) return;
  let needsConfirm = false;
  await withTracked(list => {
    const item = findByUrl(list, msg.url);
    if (!item) return;
    const now = Date.now();
    if (msg.image && !item.image) item.image = msg.image;
    const result = applyHit(item, { price: msg.price, raw: msg.raw, currency: msg.currency ?? null }, 'visit', now);
    if (!result.pending) {
      item.lastChecked = now;
      item.failedChecks = 0;
      item.lastError = null;
    }
    needsConfirm = result.pending;
  });
  if (needsConfirm) await scheduleConfirm();
}

async function importItems(items: unknown[]): Promise<ImportResponse> {
  const result: ImportResponse = { added: 0, updated: 0, skipped: 0 };
  await withTracked(list => {
    for (const raw of items) {
      const item = sanitizeImported(raw);
      if (!item) { result.skipped++; continue; }
      const existing = findByUrl(list, item.url);
      if (!existing) { list.push(item); result.added++; continue; }
      // Merge history so a backup restores older data without losing newer.
      const seen = new Set((existing.history ?? []).map(h => h.ts));
      const extra = item.history.filter(h => !seen.has(h.ts));
      if (!extra.length) { result.skipped++; continue; }
      existing.history = [...(existing.history ?? []), ...extra].sort((a, b) => a.ts - b.ts).slice(-HISTORY_LIMIT);
      existing.addedAt = Math.min(existing.addedAt ?? Infinity, item.addedAt ?? Infinity, existing.history[0]?.ts ?? Infinity);
      result.updated++;
    }
  });
  return result;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

async function migrateStoredTracked(): Promise<void> {
  const flag = await browser.storage.local.get(MIGRATION_FLAG);
  if ((flag as Record<string, unknown>)[MIGRATION_FLAG]) return;
  await withTracked(list => {
    for (const item of list) {
      const source = item.lastRaw || (item.lastPrice != null ? String(item.lastPrice) : '');
      const norm = normalizeRaw(source);
      if (norm.raw && (item.lastRaw !== norm.raw || item.lastPrice !== norm.price)) {
        item.lastRaw = norm.raw;
        item.lastPrice = norm.price;
      }
      if (Array.isArray(item.history)) {
        for (const h of item.history) {
          const hn = normalizeRaw(h.raw || (h.price != null ? String(h.price) : ''));
          if (hn.raw && (h.raw !== hn.raw || h.price !== hn.price)) {
            h.raw = hn.raw;
            h.price = hn.price;
          }
        }
      }
    }
  });
  await browser.storage.local.set({ [MIGRATION_FLAG]: true });
}

// v0.4 parser fixes: "$1,299" used to parse as 1.299 and "1.299 €" as 1.299.
// Re-derive numbers from raw text that carries a currency marker (structured
// data raws were bare machine numbers and are left alone), and backfill the
// currency code from unambiguous symbols. Every existing item also gets
// quietNextChange: the new detector may read a different (correct) price
// than 0.3.x did, and that must not look like a price change to the user.
async function migrateV3(): Promise<void> {
  const flag = await browser.storage.local.get(MIGRATION_V3_FLAG);
  if ((flag as Record<string, unknown>)[MIGRATION_V3_FLAG]) return;
  const reparse = (raw: string, price: number | null): number | null => {
    if (!hasCurrencyMarker(raw)) return price;
    const v = normalizeRaw(raw).price;
    return v != null ? v : price;
  };
  await withTracked(list => {
    for (const item of list) {
      item.lastPrice = reparse(item.lastRaw ?? '', item.lastPrice);
      if (!item.currency) item.currency = currencyCodeOf(item.lastRaw);
      if (Array.isArray(item.history)) {
        for (const h of item.history) h.price = reparse(h.raw ?? '', h.price);
      }
      item.addedAt ??= item.history?.[0]?.ts ?? item.updatedAt;
      item.quietNextChange = true;
    }
  });
  await browser.storage.local.set({ [MIGRATION_V3_FLAG]: true });
}

let migrations: Promise<void> | null = null;

// Idempotent (flag-guarded); every wake-up and every check waits on it so a
// check can never run against un-migrated data.
function ensureMigrated(): Promise<void> {
  migrations ??= (async () => {
    await migrateStoredTracked();
    await migrateV3();
  })().catch(err => {
    migrations = null;
    console.warn('PriceTracker: migration failed', err);
  });
  return migrations;
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

// Alarms are not guaranteed to survive a browser restart, and the period has
// to follow the user's interval (items are still skipped until due), so make
// sure the alarm exists and matches on every wake-up.
async function ensureAlarm(): Promise<void> {
  const { intervalMinutes } = await getSettings();
  const period = Math.min(intervalMinutes, DEFAULT_INTERVAL_MINUTES);
  const existing = await browser.alarms.get(ALARM_NAME);
  if (!existing || existing.periodInMinutes !== period) {
    browser.alarms.create(ALARM_NAME, { periodInMinutes: period });
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

browser.runtime.onInstalled.addListener(() => {
  ensureMigrated();
});

if (browser.runtime.onStartup) {
  browser.runtime.onStartup.addListener(() => {
    checkAll().catch(err => console.warn('PriceTracker: startup check failed', err));
  });
}

browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) {
    checkAll().catch(err => console.warn('PriceTracker: alarm check failed', err));
  } else if (alarm.name === CONFIRM_ALARM) {
    checkAll({ onlyPending: true }).catch(err => console.warn('PriceTracker: confirm check failed', err));
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.checkIntervalMinutes) {
    ensureAlarm().catch(err => console.warn('PriceTracker: alarm update failed', err));
  }
});

// Clicking a price-change notification opens the tracked product page. The url
// is decoded from the notification id (see notifyPriceChange), so this works on
// desktop and Android and survives event-page suspend/respawn.
browser.notifications.onClicked.addListener(id => {
  if (typeof id !== 'string' || !id.startsWith(NOTIFY_PREFIX)) return;
  const url = id.slice(NOTIFY_PREFIX.length);
  if (url) {
    browser.tabs.create({ url, active: true }).catch(err =>
      console.warn('PriceTracker: failed to open notification target', err));
  }
  browser.notifications.clear(id).catch(() => { /* already dismissed */ });
});

browser.runtime.onMessage.addListener(async (msg: Message) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.action) {
    case 'runCheck': {
      const m = msg as RunCheckMessage;
      return checkAll({ force: Boolean(m.force), url: m.url });
    }
    case 'clearBadge':
      await clearBadge();
      return { cleared: true };
    case 'manualSelectResult':
    case 'trackItem':
      await upsertItem(msg.item);
      return { saved: true };
    case 'removeItem':
      await removeItem(msg.url);
      return { removed: true };
    case 'visitUpdate':
      await visitUpdate(msg);
      return { ok: true };
    case 'importItems':
      return importItems(Array.isArray(msg.items) ? msg.items : []);
    default:
      return;
  }
});

ensureMigrated();
ensureAlarm().catch(err => console.warn('PriceTracker: alarm setup failed', err));
