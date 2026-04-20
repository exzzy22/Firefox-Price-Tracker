// Background event page: periodic checks of tracked product URLs.
// Storage schema is documented in src/lib/types.ts and CLAUDE.md.
import {
  canonicalForCompare,
  findPriceInHtml,
  normalizeRaw
} from './lib/price.js';
import type {
  HistoryEntry,
  Message,
  NormalizePriceMessage,
  RunCheckMessage,
  RunCheckResponse,
  TrackedItem
} from './lib/types.js';

const ALARM_NAME = 'checkPrices';
const DEFAULT_INTERVAL_MINUTES = 60;
const HISTORY_LIMIT = 200;
const PRICE_EPSILON = 0.0001;
const MIGRATION_FLAG = 'normalizedV2';

const action = browser.action ?? browser.browserAction;

async function setBadge(count: number): Promise<void> {
  if (!action) return;
  const text = count > 0 ? String(count) : '';
  await action.setBadgeText({ text });
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

function hostnameOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

async function fetchPrice(item: TrackedItem) {
  const resp = await fetch(item.url, { method: 'GET', mode: 'cors' });
  const html = await resp.text();
  return findPriceInHtml(html, {
    hostname: hostnameOf(item.url),
    preferredSelector: item.selector
  });
}

function appendHistory(item: TrackedItem, entry: HistoryEntry): void {
  item.history = item.history ?? [];
  const last = item.history[item.history.length - 1];
  if (last && last.raw === entry.raw && last.price === entry.price) return;
  item.history.push(entry);
  if (item.history.length > HISTORY_LIMIT) {
    item.history = item.history.slice(-HISTORY_LIMIT);
  }
}

function pricesEqual(a: number | null, b: number | null): boolean {
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return Math.abs(a - b) <= PRICE_EPSILON;
}

function notifyPriceChange(item: TrackedItem, prevRaw: string, nextRaw: string, idx: number): void {
  const title = item.title || item.url;
  const body = prevRaw
    ? `Price changed from ${prevRaw} → ${nextRaw}`
    : `Now ${nextRaw}`;
  browser.notifications.create(`price-change-${idx}-${Date.now()}`, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('icons/icon-128.png'),
    title: `Price update: ${title}`,
    message: body
  });
}

interface CheckOneResult {
  checked: boolean;
  error?: boolean;
  changed?: boolean;
}

async function checkOne(item: TrackedItem, idx: number, force: boolean): Promise<CheckOneResult> {
  if (!force) {
    const { checkIntervalMinutes } = await browser.storage.local.get('checkIntervalMinutes');
    const interval = Number(checkIntervalMinutes) || DEFAULT_INTERVAL_MINUTES;
    const last = item.lastChecked || item.updatedAt || 0;
    if (Date.now() - last < interval * 60 * 1000) return { checked: false };
  }

  let found;
  try {
    found = await fetchPrice(item);
  } catch (err) {
    console.warn('PriceTracker: fetch failed for', item.url, err);
    return { checked: true, error: true };
  }

  item.lastChecked = Date.now();
  if (!found) return { checked: true };

  const prevRaw = String(item.lastRaw ?? '').trim();
  const nextRaw = String(found.raw ?? '').trim();
  if (canonicalForCompare(prevRaw) === canonicalForCompare(nextRaw)) {
    return { checked: true };
  }

  const prevNorm = normalizeRaw(prevRaw);
  const nextNorm = normalizeRaw(nextRaw);
  if (pricesEqual(prevNorm.price, nextNorm.price)) {
    item.lastRaw = nextNorm.raw || item.lastRaw;
    if (nextNorm.price != null) item.lastPrice = nextNorm.price;
    item.updatedAt = Date.now();
    appendHistory(item, { ts: Date.now(), price: nextNorm.price, raw: nextNorm.raw });
    return { checked: true };
  }

  appendHistory(item, { ts: Date.now(), price: nextNorm.price, raw: nextRaw });
  item.lastRaw = nextRaw;
  if (nextNorm.price != null) item.lastPrice = nextNorm.price;
  item.updatedAt = Date.now();
  notifyPriceChange(item, prevRaw, nextRaw, idx);
  await incrementBadge();
  return { checked: true, changed: true };
}

async function checkAll(force = false): Promise<RunCheckResponse> {
  const { tracked } = await browser.storage.local.get('tracked');
  const list: TrackedItem[] = tracked ?? [];
  if (!list.length) return { checked: 0, skipped: 0, durationMs: 0 };

  const start = Date.now();
  let checked = 0;
  let skipped = 0;
  for (let i = 0; i < list.length; i++) {
    const result = await checkOne(list[i]!, i, force);
    if (result.checked) checked++; else skipped++;
  }
  await browser.storage.local.set({ tracked: list });
  return { checked, skipped, durationMs: Date.now() - start };
}

async function saveManualPick(pick: {
  url: string;
  title: string | null;
  raw: string;
  price: number | null;
  selector: string | null;
  image?: string | null;
}): Promise<void> {
  const { tracked } = await browser.storage.local.get('tracked');
  const list: TrackedItem[] = tracked ?? [];
  const norm = normalizeRaw(pick.raw ?? '');
  const now = Date.now();
  const item: TrackedItem = {
    url: pick.url ?? '',
    title: pick.title || pick.url || '',
    lastPrice: norm.price ?? pick.price ?? null,
    lastRaw: norm.raw || String(pick.raw ?? ''),
    selector: pick.selector ?? null,
    image: pick.image ?? null,
    updatedAt: now,
    lastChecked: now,
    history: []
  };
  appendHistory(item, { ts: now, price: item.lastPrice, raw: item.lastRaw });

  const existing = list.find(i => i.url === item.url);
  if (existing) {
    existing.lastPrice = item.lastPrice;
    existing.lastRaw = item.lastRaw;
    existing.selector = item.selector;
    if (item.image) existing.image = item.image;
    existing.updatedAt = item.updatedAt;
    existing.lastChecked = item.lastChecked;
    appendHistory(existing, { ts: now, price: item.lastPrice, raw: item.lastRaw });
  } else {
    list.push(item);
  }
  await browser.storage.local.set({ tracked: list });
}

async function migrateStoredTracked(): Promise<void> {
  const flag = await browser.storage.local.get(MIGRATION_FLAG);
  if ((flag as Record<string, unknown>)[MIGRATION_FLAG]) return;
  const { tracked } = await browser.storage.local.get('tracked');
  const list: TrackedItem[] = tracked ?? [];
  let changed = false;
  for (const item of list) {
    const source = item.lastRaw || (item.lastPrice != null ? String(item.lastPrice) : '');
    const norm = normalizeRaw(source);
    if (norm.raw && (item.lastRaw !== norm.raw || item.lastPrice !== norm.price)) {
      item.lastRaw = norm.raw;
      item.lastPrice = norm.price;
      changed = true;
    }
    if (Array.isArray(item.history)) {
      for (const h of item.history) {
        const hn = normalizeRaw(h.raw || (h.price != null ? String(h.price) : ''));
        if (hn.raw && (h.raw !== hn.raw || h.price !== hn.price)) {
          h.raw = hn.raw;
          h.price = hn.price;
          changed = true;
        }
      }
    }
  }
  if (changed) await browser.storage.local.set({ tracked: list });
  await browser.storage.local.set({ [MIGRATION_FLAG]: true });
}

browser.runtime.onInstalled.addListener(() => {
  browser.alarms.create(ALARM_NAME, { periodInMinutes: DEFAULT_INTERVAL_MINUTES });
  migrateStoredTracked().catch(err => console.warn('PriceTracker: migration failed', err));
});

if (browser.runtime.onStartup) {
  browser.runtime.onStartup.addListener(() => {
    checkAll().catch(err => console.warn('PriceTracker: startup check failed', err));
    migrateStoredTracked().catch(() => { /* swallowed: migration retries next install */ });
  });
}

browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) {
    checkAll().catch(err => console.warn('PriceTracker: alarm check failed', err));
  }
});

browser.runtime.onMessage.addListener(async (msg: Message) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.action) {
    case 'runCheck':
      return checkAll(Boolean((msg as RunCheckMessage).force));
    case 'normalizePrice':
      return normalizeRaw((msg as NormalizePriceMessage).raw);
    case 'clearBadge':
      await clearBadge();
      return { cleared: true };
    case 'manualSelectResult':
      await saveManualPick(msg.item);
      return { saved: true };
    default:
      return;
  }
});
