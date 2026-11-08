import {
  changeSinceAdded,
  cleanTitle,
  currencySymbol,
  formatAlert,
  formatItemPrice,
  formatPct,
  formatPrice,
  formatTimestamp,
  lastChange,
  parsePriceInput,
  priceInputValue,
  priceRange,
  relativeTime
} from './lib/format.js';
import { h, historyChart, icon, sparkline } from './lib/dom.js';
import { siteName } from './lib/url.js';
import type { AlertSide, ImportResponse, NotifyOn, PriceAlert, RunCheckResponse, TrackedItem } from './lib/types.js';

import { FAIL_WARN_THRESHOLD, alertMatch, sanitizeAlert } from './lib/tracking.js';
const DEFAULT_INTERVAL_MINUTES = 60;
const INTERVAL_PRESETS = [15, 30, 60, 120, 240, 360, 720, 1440];

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

type SortKey = 'added' | 'drop' | 'changed' | 'price-asc' | 'price-desc' | 'name';

let tracked: TrackedItem[] = [];
let lastRunAt: number | null = null;
let query = '';
let sortKey: SortKey = 'added';
const openHistory = new Set<string>();
const openAlerts = new Set<string>();
// What the user has typed into an open alert form. Kept outside the DOM so
// a re-render (storage changes arrive at any time) doesn't wipe it.
const alertDrafts = new Map<string, Record<AlertSide, string>>();
let statusTimer: ReturnType<typeof setTimeout> | null = null;

function setStatus(text: string, timeoutMs = 5000): void {
  const el = $('status');
  el.textContent = text;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ''; }, timeoutMs);
}

async function openTab(url: string): Promise<void> {
  await browser.tabs.create({ url, active: true });
}

function intervalLabel(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? '24 hours' : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

async function loadSettings(): Promise<void> {
  const { checkIntervalMinutes, notifyOn } = await browser.storage.local.get(['checkIntervalMinutes', 'notifyOn']);
  const interval = Number(checkIntervalMinutes) >= 1 ? Number(checkIntervalMinutes) : DEFAULT_INTERVAL_MINUTES;
  const values = INTERVAL_PRESETS.includes(interval) ? INTERVAL_PRESETS : [...INTERVAL_PRESETS, interval].sort((a, b) => a - b);
  $('intervalSelect').replaceChildren(...values.map(v =>
    h('option', { value: String(v), selected: v === interval }, intervalLabel(v))));
  $<HTMLSelectElement>('notifySelect').value = notifyOn === 'drop' ? 'drop' : 'any';
}

function displayTitle(item: TrackedItem): string {
  return cleanTitle(item.title, siteName(item.url)) || item.url;
}

function sorted(list: TrackedItem[]): TrackedItem[] {
  const indexed = list.map((item, i) => ({ item, i }));
  const price = (x: TrackedItem) => (typeof x.lastPrice === 'number' ? x.lastPrice : Infinity);
  const drop = (x: TrackedItem) => changeSinceAdded(x)?.pct ?? 0;
  const cmp: Record<SortKey, (a: { item: TrackedItem; i: number }, b: { item: TrackedItem; i: number }) => number> = {
    added: (a, b) => (b.item.addedAt ?? b.i) - (a.item.addedAt ?? a.i) || b.i - a.i,
    drop: (a, b) => drop(a.item) - drop(b.item),
    changed: (a, b) => (b.item.updatedAt ?? 0) - (a.item.updatedAt ?? 0),
    'price-asc': (a, b) => price(a.item) - price(b.item),
    'price-desc': (a, b) => price(b.item) - price(a.item),
    name: (a, b) => displayTitle(a.item).localeCompare(displayTitle(b.item))
  };
  return indexed.sort(cmp[sortKey]).map(x => x.item);
}

function filtered(list: TrackedItem[]): TrackedItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(i => `${i.title} ${siteName(i.url)}`.toLowerCase().includes(q));
}

function thumb(item: TrackedItem): HTMLElement {
  const site = siteName(item.url);
  const box = h('div', { className: 'thumb thumb-xl' });
  const fallback = () => box.replaceChildren(h('span', { className: 'thumb-letter' }, (site[0] ?? '?').toUpperCase()));
  if (item.image) {
    const img = h('img', { src: item.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', fallback, { once: true });
    box.append(img);
  } else {
    fallback();
  }
  return box;
}

function badge(pct: number, prefix = ''): HTMLElement {
  const down = pct < 0;
  return h('span', { className: `badge ${down ? 'badge-down' : 'badge-up'}` },
    `${prefix}${down ? '▼' : '▲'} ${formatPct(pct).replace(/^[−+]/, '')}`);
}

// Two-step remove. The pending confirmation lives outside the DOM so a
// re-render (storage changes arrive at any time) doesn't reset it.
let confirmRemoveUrl: string | null = null;
let confirmRemoveTimer: ReturnType<typeof setTimeout> | null = null;
const CONFIRM_REMOVE_MS = 4000;

function removeButton(item: TrackedItem): HTMLButtonElement {
  const confirming = confirmRemoveUrl === item.url;
  const btn = h('button', { className: `btn btn-ghost btn-danger${confirming ? ' is-confirming' : ''}` },
    icon('trash', 15), confirming ? 'Confirm' : 'Remove');
  btn.addEventListener('click', () => {
    if (confirmRemoveUrl !== item.url) {
      confirmRemoveUrl = item.url;
      btn.classList.add('is-confirming');
      btn.replaceChildren(icon('trash', 15), 'Confirm');
      if (confirmRemoveTimer) clearTimeout(confirmRemoveTimer);
      confirmRemoveTimer = setTimeout(() => { confirmRemoveUrl = null; renderList(); }, CONFIRM_REMOVE_MS);
      return;
    }
    confirmRemoveUrl = null;
    if (confirmRemoveTimer) clearTimeout(confirmRemoveTimer);
    browser.runtime.sendMessage({ action: 'removeItem', url: item.url })
      .then(() => setStatus(`Removed ${displayTitle(item)}`))
      .catch(() => setStatus('Could not remove the item'));
  });
  return btn;
}

async function checkOne(item: TrackedItem, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.classList.add('is-spinning');
  try {
    const result = await browser.runtime.sendMessage({ action: 'runCheck', force: true, url: item.url }) as RunCheckResponse | undefined;
    const fresh = (await browser.storage.local.get('tracked')).tracked as TrackedItem[] | undefined;
    const now = fresh?.find(i => i.url === item.url);
    if (result?.failed) setStatus(`Couldn’t check: ${now?.lastError ?? 'unknown error'}`);
    else if (now?.pending) setStatus('New price seen — confirming it in a few minutes before notifying');
    else if (result?.changed) setStatus('Price updated');
    else setStatus('No change');
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-spinning');
  }
}

function renderHistory(item: TrackedItem, panel: HTMLElement): void {
  const fmt = (n: number) => formatPrice(n, item.currency);
  const chart = historyChart(item.history ?? [], fmt, ts => new Date(ts).toLocaleDateString(), panel.clientWidth || 640);
  const entries = (item.history ?? []).slice().reverse();
  const rows = entries.map((e, idx) => {
    const older = entries[idx + 1];
    const pct = older && typeof older.price === 'number' && older.price > 0 && typeof e.price === 'number'
      ? ((e.price - older.price) / older.price) * 100 : null;
    return h('li', { className: 'history-row' },
      h('span', { className: 'history-price' }, formatPrice(e.price, item.currency, e.raw)),
      pct != null && Math.abs(pct) >= 0.05 ? badge(pct) : h('span', { className: 'badge badge-neutral' }, idx === entries.length - 1 ? 'Added' : '—'),
      h('span', { className: 'history-time' }, formatTimestamp(e.ts)));
  });
  panel.replaceChildren(
    chart ? h('div', { className: 'chart-wrap' }, chart) : h('p', { className: 'hint' }, 'The chart appears once the price has changed.'),
    h('ol', { className: 'history-list' }, ...rows));
}

function toggleAlert(item: TrackedItem): void {
  if (openAlerts.has(item.url)) {
    openAlerts.delete(item.url);
    alertDrafts.delete(item.url);
    renderList();
    return;
  }
  openAlerts.add(item.url);
  renderList();
  focusInput(`${item.url}|below`);
}

function alertSavedMessage(item: TrackedItem, alert: PriceAlert): string {
  const fmt = (n: number | null) => formatPrice(n, item.currency);
  const side = alertMatch(alert, item.lastPrice);
  if (side === 'below') return `Alert saved. It’s already at or below ${fmt(alert.below)}, so you’ll be notified when it drops further.`;
  if (side === 'above') return `Alert saved. It’s already at or above ${fmt(alert.above)}, so you’ll be notified when it rises further.`;
  return `Alert saved. You’ll be notified when the price goes ${formatAlert({ alert, currency: item.currency })}.`;
}

async function saveAlert(item: TrackedItem, alert: PriceAlert | null): Promise<void> {
  const res = await browser.runtime.sendMessage({ action: 'setAlert', url: item.url, alert }) as { saved?: boolean } | undefined;
  if (!res?.saved) {
    setStatus('Could not save the alert');
    return;
  }
  openAlerts.delete(item.url);
  alertDrafts.delete(item.url);
  renderList();
  setStatus(alert ? alertSavedMessage(item, alert) : 'Alert removed', 8000);
}

function renderAlertPanel(item: TrackedItem): HTMLFormElement {
  let draft = alertDrafts.get(item.url);
  if (!draft) {
    draft = { below: priceInputValue(item.alert?.below), above: priceInputValue(item.alert?.above) };
    alertDrafts.set(item.url, draft);
  }
  const values = draft;
  const symbol = currencySymbol(item.currency);
  const error = h('p', { className: 'field-error', role: 'alert', hidden: true });
  const fail = (text: string) => { error.textContent = text; error.hidden = false; };

  const field = (side: AlertSide, label: string) => {
    const input = h('input', {
      className: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off',
      placeholder: 'Not set', value: values[side], 'data-focus-key': `${item.url}|${side}`
    });
    input.addEventListener('input', () => { values[side] = input.value; error.hidden = true; });
    return h('label', { className: 'field' },
      h('span', { className: 'field-label' }, label),
      h('span', { className: 'price-input' }, input,
        symbol ? h('span', { className: 'price-input-symbol', 'aria-hidden': 'true' }, symbol) : null));
  };

  const removeBtn = item.alert
    ? h('button', { type: 'button', className: 'btn btn-secondary' }, 'Remove alert')
    : null;
  removeBtn?.addEventListener('click', () => { saveAlert(item, null).catch(() => setStatus('Could not remove the alert')); });

  const form = h('form', { className: 'alert-panel', novalidate: true },
    h('div', { className: 'alert-title' }, icon('bell', 14), 'Notify me when the price'),
    h('div', { className: 'alert-fields' }, field('below', 'drops to or below'), field('above', 'rises to or above')),
    error,
    h('div', { className: 'alert-foot' },
      h('p', { className: 'hint' }, 'Leave either one empty. While an alert is set, other price changes don’t notify.'),
      h('div', { className: 'alert-buttons' }, removeBtn, h('button', { type: 'submit', className: 'btn btn-primary' }, 'Save alert'))));

  form.addEventListener('submit', e => {
    e.preventDefault();
    const below = parsePriceInput(values.below);
    const above = parsePriceInput(values.above);
    if (below === 'invalid' || above === 'invalid') return fail('Enter a price such as 89.99.');
    if (below == null && above == null) {
      if (item.alert) saveAlert(item, null).catch(() => setStatus('Could not remove the alert'));
      else fail('Enter a price in at least one field.');
      return;
    }
    const alert = sanitizeAlert({ below, above });
    if (!alert) return fail('The “drops to” price has to be lower than the “rises to” price.');
    saveAlert(item, alert).catch(() => setStatus('Could not save the alert'));
  });
  return form;
}

function renderCard(item: TrackedItem): HTMLElement {
  const site = siteName(item.url);
  const title = displayTitle(item);
  const failing = (item.failedChecks ?? 0) >= FAIL_WARN_THRESHOLD;
  const ch = lastChange(item);
  const since = changeSinceAdded(item);
  const range = priceRange(item.history ?? []);
  const trend = since ? (since.delta < 0 ? 'down' : 'up') : 'flat';

  const titleLink = h('a', { className: 'card-title', href: item.url, title: item.title || item.url }, title);
  titleLink.addEventListener('click', e => { e.preventDefault(); openTab(item.url).catch(() => { /* ignore */ }); });

  const meta: (HTMLElement | string)[] = [h('span', { className: 'chip' }, site)];
  meta.push(h('span', {}, `Checked ${relativeTime(item.lastChecked || item.updatedAt)}`));
  if (range && range.max - range.min >= 0.005) {
    meta.push(h('span', {}, `Low ${formatPrice(range.min, item.currency)} · High ${formatPrice(range.max, item.currency)}`));
  }
  if (since) meta.push(h('span', {}, 'Since added ', badge(since.pct)));
  const alertText = formatAlert(item);
  if (alertText) {
    const reached = alertMatch(item.alert, item.lastPrice);
    meta.push(h('span', {
      className: `chip chip-alert${reached ? ` is-${reached}` : ''}`,
      title: reached ? 'The price has reached your alert' : 'Price alert'
    }, icon('bell', 12), `Alert ${alertText}`));
  }

  const notices: HTMLElement[] = [];
  if (failing) {
    notices.push(h('div', { className: 'notice notice-warn' }, icon('alert', 15),
      h('span', {}, `Can’t check automatically (${item.lastError || 'no price found'}). Opening the page refreshes the price.`)));
  }
  if (item.pending) {
    notices.push(h('div', { className: 'notice notice-info' }, icon('clock', 15),
      h('span', {}, `New price ${formatPrice(item.pending.price, item.pending.currency ?? item.currency, item.pending.raw)} seen ${relativeTime(item.pending.firstSeen)} — confirming before it’s recorded.`)));
  }

  const historyPanel = h('div', { className: 'history-panel', hidden: !openHistory.has(item.url) });
  const histBtn = h('button', { className: 'btn btn-ghost', 'aria-expanded': String(openHistory.has(item.url)) }, icon('chart', 15), 'History');
  histBtn.addEventListener('click', () => {
    const show = historyPanel.hidden;
    historyPanel.hidden = !show;
    histBtn.setAttribute('aria-expanded', String(show));
    if (show) { openHistory.add(item.url); renderHistory(item, historyPanel); } else { openHistory.delete(item.url); }
  });
  // Rendered after insertion so the chart can size itself to the panel.
  if (!historyPanel.hidden) requestAnimationFrame(() => renderHistory(item, historyPanel));

  const openBtn = h('button', { className: 'btn btn-ghost' }, icon('external', 15), 'Open');
  openBtn.addEventListener('click', () => { openTab(item.url).catch(() => { /* ignore */ }); });
  const checkBtn = h('button', { className: 'btn btn-ghost' }, icon('refresh', 15), 'Check');
  checkBtn.addEventListener('click', () => { checkOne(item, checkBtn).catch(() => setStatus('Check failed')); });
  const alertOpen = openAlerts.has(item.url);
  const alertBtn = h('button', {
    className: `btn btn-ghost${alertText ? ' is-active' : ''}`,
    'aria-expanded': String(alertOpen),
    title: alertText ? `Alert ${alertText}` : 'Get notified at a target price'
  }, icon('bell', 15), 'Alert');
  alertBtn.addEventListener('click', () => toggleAlert(item));

  const spark = sparkline(item.history ?? [], trend);

  return h('article', { className: `card item-card${failing ? ' is-warning' : ''}` },
    thumb(item),
    h('div', { className: 'card-content' },
      h('div', { className: 'card-top' },
        titleLink,
        h('div', { className: 'card-price-block' },
          h('div', { className: 'card-price' }, formatItemPrice(item)),
          ch ? badge(ch.pct) : null)),
      h('div', { className: 'card-meta' }, ...meta),
      ...notices,
      h('div', { className: 'card-foot' },
        h('div', { className: 'item-actions' }, openBtn, histBtn, alertBtn, checkBtn, removeButton(item)),
        spark ? h('div', { className: 'card-spark' }, spark) : null),
      alertOpen ? renderAlertPanel(item) : null,
      historyPanel));
}

function renderStats(): void {
  const drops = tracked.filter(i => (changeSinceAdded(i)?.delta ?? 0) < 0).length;
  const failing = tracked.filter(i => (i.failedChecks ?? 0) >= FAIL_WARN_THRESHOLD).length;
  const stat = (value: string, label: string, cls = '') =>
    h('div', { className: `stat ${cls}` }, h('div', { className: 'stat-value' }, value), h('div', { className: 'stat-label' }, label));
  $('stats').replaceChildren(
    stat(String(tracked.length), 'Tracked'),
    stat(String(drops), 'Cheaper than when added', drops ? 'is-good' : ''),
    stat(String(failing), 'Need attention', failing ? 'is-warn' : ''),
    stat(lastRunAt ? relativeTime(lastRunAt, Date.now(), 'short') : 'never', 'Last check', 'is-small'));
  $('summary').textContent = tracked.length
    ? `${tracked.length} product${tracked.length === 1 ? '' : 's'} · checked ${relativeTime(lastRunAt, Date.now(), 'short')}`
    : 'Nothing tracked yet';
}

function focusInput(key: string, caret?: { start: number | null; end: number | null }): void {
  const input = Array.from(document.querySelectorAll<HTMLInputElement>('input[data-focus-key]'))
    .find(el => el.dataset.focusKey === key);
  if (!input) return;
  input.focus();
  if (caret) input.setSelectionRange(caret.start, caret.end);
}

// Re-rendering replaces the alert inputs; keep focus and caret where the
// user left them.
function renderList(): void {
  const active = document.activeElement;
  const key = active instanceof HTMLInputElement ? active.dataset.focusKey : undefined;
  const caret = key ? { start: (active as HTMLInputElement).selectionStart, end: (active as HTMLInputElement).selectionEnd } : undefined;
  renderListContent();
  if (key) focusInput(key, caret);
}

function renderListContent(): void {
  renderStats();
  const container = $('list');
  if (!tracked.length) {
    container.replaceChildren(h('div', { className: 'empty empty-lg' },
      icon('tag', 28),
      h('strong', {}, 'No tracked products yet'),
      h('span', {}, 'Open a product page, click the Price Tracker icon and press Track price. You’ll get a notification when the price changes.')));
    return;
  }
  const items = filtered(sorted(tracked));
  if (!items.length) {
    container.replaceChildren(h('div', { className: 'empty' }, `Nothing matches “${query}”.`));
    return;
  }
  container.replaceChildren(...items.map(renderCard));
}

async function load(): Promise<void> {
  const data = await browser.storage.local.get(['tracked', 'lastRunAt']);
  tracked = Array.isArray(data.tracked) ? data.tracked : [];
  lastRunAt = typeof data.lastRunAt === 'number' ? data.lastRunAt : null;
  renderList();
}

async function runForceCheck(): Promise<void> {
  const btn = $<HTMLButtonElement>('refreshBtn');
  const spinner = $('refreshSpinner');
  const label = $('refreshLabel');
  btn.disabled = true;
  spinner.hidden = false;
  label.textContent = 'Checking…';
  try {
    const result = await browser.runtime.sendMessage({ action: 'runCheck', force: true }) as RunCheckResponse | undefined;
    if (result) {
      const secs = ((result.durationMs || 0) / 1000).toFixed(1);
      const parts = [`Checked ${result.checked} in ${secs}s`];
      if (result.changed) parts.push(`${result.changed} updated`);
      if (result.failed) parts.push(`${result.failed} couldn’t be checked`);
      setStatus(parts.join(' · '));
    }
  } catch (err) {
    console.warn('runCheck failed', err);
    setStatus('Check failed');
  } finally {
    spinner.hidden = true;
    label.textContent = 'Check now';
    btn.disabled = false;
  }
}

async function exportBackup(): Promise<void> {
  const data = await browser.storage.local.get(['tracked', 'checkIntervalMinutes', 'notifyOn']);
  const backup = {
    format: 'price-tracker-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: { checkIntervalMinutes: data.checkIntervalMinutes ?? DEFAULT_INTERVAL_MINUTES, notifyOn: data.notifyOn ?? 'any' },
    tracked: Array.isArray(data.tracked) ? data.tracked : []
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const a = h('a', { href: url, download: `price-tracker-backup-${stamp}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  setStatus(`Exported ${backup.tracked.length} item${backup.tracked.length === 1 ? '' : 's'}`);
}

async function importBackup(file: File): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    setStatus('That file isn’t a Price Tracker backup (invalid JSON)');
    return;
  }
  const items = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { tracked?: unknown }).tracked))
      ? (parsed as { tracked: unknown[] }).tracked
      : null;
  if (!items) {
    setStatus('That file isn’t a Price Tracker backup');
    return;
  }
  const res = await browser.runtime.sendMessage({ action: 'importItems', items }) as ImportResponse;
  setStatus(`Imported: ${res.added} added, ${res.updated} merged, ${res.skipped} skipped`, 8000);
}

function init(): void {
  $('searchIcon').append(icon('search', 16));
  $('refreshBtn').addEventListener('click', () => { runForceCheck().catch(() => { /* reported */ }); });
  $<HTMLInputElement>('search').addEventListener('input', e => {
    query = (e.target as HTMLInputElement).value;
    renderList();
  });
  $<HTMLSelectElement>('sort').addEventListener('change', e => {
    sortKey = (e.target as HTMLSelectElement).value as SortKey;
    renderList();
  });
  $<HTMLSelectElement>('intervalSelect').addEventListener('change', e => {
    const value = Number((e.target as HTMLSelectElement).value);
    browser.storage.local.set({ checkIntervalMinutes: value })
      .then(() => setStatus(`Prices will be checked every ${intervalLabel(value)}`))
      .catch(() => setStatus('Could not save the interval'));
  });
  $<HTMLSelectElement>('notifySelect').addEventListener('change', e => {
    const value = (e.target as HTMLSelectElement).value as NotifyOn;
    browser.storage.local.set({ notifyOn: value })
      .then(() => setStatus(value === 'drop' ? 'You’ll only be notified about price drops' : 'You’ll be notified about every price change'))
      .catch(() => setStatus('Could not save the setting'));
  });
  $('exportBtn').addEventListener('click', () => { exportBackup().catch(() => setStatus('Export failed')); });
  $<HTMLInputElement>('importFile').addEventListener('change', e => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) importBackup(file).catch(() => setStatus('Import failed'));
  });

  loadSettings().catch(() => { /* defaults stay */ });
  load().catch(err => console.warn('load failed', err));

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.tracked || changes.lastRunAt) load().catch(() => { /* ignore */ });
    if (changes.checkIntervalMinutes || changes.notifyOn) loadSettings().catch(() => { /* ignore */ });
  });
  // Keep "checked 3 minutes ago" honest while the page stays open.
  setInterval(() => { renderStats(); }, 60_000);
}

document.addEventListener('DOMContentLoaded', init);
