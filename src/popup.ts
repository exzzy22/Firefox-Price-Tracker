import { cleanTitle, formatItemPrice, formatPct, formatPrice, lastChange, relativeTime } from './lib/format.js';
import { h, icon } from './lib/dom.js';
import { isWebUrl, productKey, siteName } from './lib/url.js';
import type { GetPriceResponse, LastDetected, RunCheckResponse, TrackedItem } from './lib/types.js';

import { FAIL_WARN_THRESHOLD } from './lib/tracking.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

interface Current {
  price: number;
  raw: string;
  currency: string | null;
  title: string | null;
  image: string | null;
}

let activeTab: browser.tabs.Tab | null = null;
let current: Current | null = null;
let tracked: TrackedItem[] = [];
let lastRunAt: number | null = null;
let statusTimer: ReturnType<typeof setTimeout> | null = null;

function setStatus(text: string, timeoutMs?: number): void {
  $('status').textContent = text;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = timeoutMs ? setTimeout(renderStatus, timeoutMs) : null;
}

function renderStatus(): void {
  $('status').textContent = lastRunAt && tracked.length ? `Checked ${relativeTime(lastRunAt, Date.now(), 'short')}` : '';
}

async function getActiveTab(): Promise<browser.tabs.Tab | null> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

function openTab(url: string): void {
  // On Firefox Android the popup sheet keeps focus even after tabs.create,
  // so the new tab lands in the background. Closing the popup first lets
  // the fresh tab become active.
  browser.tabs.create({ url, active: true }).catch(() => { /* ignore */ });
  window.close();
}

function trackedForTab(): TrackedItem | undefined {
  if (!activeTab?.url) return undefined;
  const key = productKey(activeTab.url);
  return tracked.find(i => productKey(i.url) === key);
}

async function fetchCurrent(): Promise<Current | null> {
  if (!activeTab?.id || !isWebUrl(activeTab.url)) return null;
  try {
    const resp = await Promise.race([
      browser.tabs.sendMessage(activeTab.id, { action: 'getPrice' }) as Promise<GetPriceResponse>,
      new Promise<undefined>(r => setTimeout(() => r(undefined), 2500))
    ]);
    if (resp && typeof resp.price === 'number') {
      return {
        price: resp.price,
        raw: resp.raw ?? '',
        currency: resp.currency ?? null,
        title: resp.title ?? activeTab.title ?? null,
        image: resp.image ?? null
      };
    }
  } catch {
    // content script not injected (tab predates install, or a restricted page)
  }
  const { lastDetected } = await browser.storage.local.get('lastDetected') as { lastDetected?: LastDetected };
  if (lastDetected && activeTab.url && productKey(lastDetected.url) === productKey(activeTab.url)) {
    return {
      price: lastDetected.price,
      raw: lastDetected.raw,
      currency: lastDetected.currency ?? null,
      title: lastDetected.title ?? activeTab.title ?? null,
      image: lastDetected.image ?? null
    };
  }
  return null;
}

function thumb(image: string | null | undefined, label: string, className: string): HTMLElement {
  const box = h('div', { className });
  const fallback = () => {
    box.replaceChildren(h('span', { className: 'thumb-letter' }, (label.trim()[0] ?? '?').toUpperCase()));
  };
  if (image) {
    const img = h('img', { src: image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', fallback, { once: true });
    box.append(img);
  } else {
    fallback();
  }
  return box;
}

function changeBadge(item: TrackedItem): HTMLElement | null {
  const ch = lastChange(item);
  if (!ch) return null;
  const down = ch.delta < 0;
  return h('span', {
    className: `badge ${down ? 'badge-down' : 'badge-up'}`,
    title: `Was ${formatPrice(ch.from, item.currency)}`
  }, `${down ? '▼' : '▲'} ${formatPct(ch.pct).replace(/^[−+]/, '')}`);
}

function renderCurrent(): void {
  const card = $('currentCard');
  const titleEl = $('currentTitle');
  const priceEl = $('currentPrice');
  const noteEl = $('currentNote');
  const badge = $('currentBadge');
  const trackBtn = $<HTMLButtonElement>('trackBtn');
  const pickBtn = $<HTMLButtonElement>('pickBtn');
  const url = activeTab?.url ?? '';
  const item = trackedForTab();
  const site = siteName(url);

  card.classList.remove('is-loading', 'is-empty');
  $('currentSite').textContent = site;
  badge.hidden = true;
  trackBtn.className = 'btn btn-primary';
  pickBtn.className = 'btn btn-secondary';
  trackBtn.textContent = 'Track price';
  trackBtn.disabled = false;
  trackBtn.hidden = false;
  pickBtn.disabled = false;

  const image = current?.image ?? item?.image ?? null;
  const thumbEl = thumb(image, site || '?', 'thumb thumb-lg');
  thumbEl.id = 'currentThumb';
  $('currentThumb').replaceWith(thumbEl);

  if (!isWebUrl(url)) {
    card.classList.add('is-empty');
    titleEl.textContent = 'Open a product page to track its price';
    priceEl.textContent = '';
    noteEl.textContent = 'Price Tracker only works on regular web pages.';
    trackBtn.hidden = true;
    pickBtn.disabled = true;
    return;
  }

  if (!current) {
    titleEl.textContent = cleanTitle(item?.title ?? activeTab?.title, site) || 'No price found on this page';
    if (item) {
      priceEl.textContent = formatItemPrice(item);
      noteEl.textContent = 'Not visible on the page right now — showing the last tracked price.';
      badge.hidden = false;
      badge.className = 'badge badge-neutral';
      badge.textContent = 'Tracked';
      trackBtn.hidden = true;
    } else {
      card.classList.add('is-empty');
      priceEl.textContent = '';
      noteEl.textContent = 'No product price detected. Use Pick price and click the price on the page.';
      trackBtn.hidden = true;
      pickBtn.className = 'btn btn-primary';
    }
    return;
  }

  titleEl.textContent = cleanTitle(current.title ?? activeTab?.title, site);
  priceEl.textContent = formatPrice(current.price, current.currency, current.raw);
  if (item) {
    badge.hidden = false;
    badge.className = 'badge badge-neutral';
    badge.textContent = 'Tracked';
    const same = typeof item.lastPrice === 'number' && Math.abs(item.lastPrice - current.price) < 0.005;
    if (same) {
      trackBtn.disabled = true;
      trackBtn.textContent = 'Tracking';
      trackBtn.prepend(icon('check', 16));
      const since = item.addedAt ?? item.history?.[0]?.ts;
      noteEl.textContent = since ? `Tracking since ${new Date(since).toLocaleDateString()}` : '';
    } else {
      trackBtn.textContent = 'Update price';
      noteEl.textContent = `Last tracked price ${formatItemPrice(item)}`;
    }
  } else {
    noteEl.textContent = 'Wrong price? Use Pick price to choose it on the page.';
  }
}

function itemMeta(item: TrackedItem): HTMLElement {
  if ((item.failedChecks ?? 0) >= FAIL_WARN_THRESHOLD) {
    return h('div', { className: 'item-meta is-warning', title: 'Background checks keep failing. Opening the page updates the price.' },
      icon('alert', 13), `${item.lastError || 'Can’t check'} · open to refresh`);
  }
  if (item.pending) {
    return h('div', { className: 'item-meta is-pending' }, icon('clock', 13),
      `Confirming ${formatPrice(item.pending.price, item.pending.currency ?? item.currency, item.pending.raw)}…`);
  }
  return h('div', { className: 'item-meta' }, `${siteName(item.url)} · ${relativeTime(item.lastChecked || item.updatedAt, Date.now(), 'short')}`);
}

// Two-step remove; kept outside the DOM so list re-renders don't reset it.
let confirmRemoveUrl: string | null = null;
let confirmRemoveTimer: ReturnType<typeof setTimeout> | null = null;

function renderItem(item: TrackedItem): HTMLElement {
  const site = siteName(item.url);
  const title = cleanTitle(item.title, site) || item.url;
  const confirming = confirmRemoveUrl === item.url;
  const remove = h('button', {
    className: `icon-btn remove-btn${confirming ? ' is-confirming' : ''}`,
    title: 'Stop tracking',
    'aria-label': `Stop tracking ${title}`
  }, confirming ? 'Remove?' : icon('trash', 16));
  remove.addEventListener('click', e => {
    e.stopPropagation();
    if (confirmRemoveUrl !== item.url) {
      confirmRemoveUrl = item.url;
      if (confirmRemoveTimer) clearTimeout(confirmRemoveTimer);
      confirmRemoveTimer = setTimeout(() => { confirmRemoveUrl = null; renderList(); }, 4000);
      renderList();
      return;
    }
    confirmRemoveUrl = null;
    if (confirmRemoveTimer) clearTimeout(confirmRemoveTimer);
    browser.runtime.sendMessage({ action: 'removeItem', url: item.url }).catch(() => { /* ignore */ });
  });

  const main = h('button', { className: 'item-main', title: `Open ${site}` },
    thumb(item.image, site, 'thumb'),
    h('div', { className: 'item-text' },
      h('div', { className: 'item-title' }, title),
      itemMeta(item)),
    h('div', { className: 'item-price-col' },
      h('div', { className: 'item-price' }, formatItemPrice(item)),
      changeBadge(item)));
  main.addEventListener('click', () => openTab(item.url));

  return h('li', { className: 'item' }, main, remove);
}

function renderList(): void {
  const list = $('list');
  $('count').textContent = tracked.length ? String(tracked.length) : '';
  if (!tracked.length) {
    list.replaceChildren(h('li', { className: 'empty' },
      icon('tag', 22),
      h('strong', {}, 'Nothing tracked yet'),
      h('span', {}, 'Open a product page and press Track price. You’ll get a notification when the price changes.')));
    return;
  }
  list.replaceChildren(...tracked.slice().reverse().map(renderItem));
}

async function loadTracked(): Promise<void> {
  const data = await browser.storage.local.get(['tracked', 'lastRunAt']);
  tracked = Array.isArray(data.tracked) ? data.tracked : [];
  lastRunAt = typeof data.lastRunAt === 'number' ? data.lastRunAt : null;
}

async function trackCurrent(): Promise<void> {
  if (!current || !activeTab?.url) return;
  const btn = $<HTMLButtonElement>('trackBtn');
  btn.disabled = true;
  await browser.runtime.sendMessage({
    action: 'trackItem',
    item: {
      url: activeTab.url,
      selector: null,
      raw: current.raw,
      price: current.price,
      currency: current.currency,
      title: current.title || activeTab.title || '',
      image: current.image
    }
  });
  setStatus('Saved', 2500);
}

async function pickElement(): Promise<void> {
  if (!activeTab?.id) return;
  try {
    // Make sure the content script is there before closing the popup.
    await browser.tabs.sendMessage(activeTab.id, { action: 'isProductPage' });
  } catch {
    $('currentNote').textContent = 'Reload the page, then try Pick price again.';
    return;
  }
  browser.tabs.sendMessage(activeTab.id, { action: 'startSelect' }).catch(() => { /* picker closed */ });
  window.close();
}

async function refresh(): Promise<void> {
  const btn = $<HTMLButtonElement>('refreshBtn');
  btn.disabled = true;
  btn.classList.add('is-spinning');
  setStatus('Checking…');
  try {
    const result = await browser.runtime.sendMessage({ action: 'runCheck', force: true }) as RunCheckResponse | undefined;
    if (result) {
      const parts = [`Checked ${result.checked}`];
      if (result.changed) parts.push(`${result.changed} changed`);
      if (result.failed) parts.push(`${result.failed} failed`);
      setStatus(parts.join(' · '), 5000);
    }
    current = await fetchCurrent();
    renderCurrent();
  } catch (err) {
    console.warn('refresh failed', err);
    setStatus('Check failed', 3000);
  } finally {
    btn.classList.remove('is-spinning');
    btn.disabled = false;
  }
}

async function init(): Promise<void> {
  $('refreshBtn').append(icon('refresh'));
  $('openDetailsBtn').append(icon('expand'));
  $('trackBtn').addEventListener('click', () => { trackCurrent().catch(err => console.warn('track failed', err)); });
  $('pickBtn').addEventListener('click', () => { pickElement().catch(() => { /* ignore */ }); });
  $('refreshBtn').addEventListener('click', () => { refresh().catch(() => { /* ignore */ }); });
  $('openDetailsBtn').addEventListener('click', () => openTab(browser.runtime.getURL('details.html')));

  browser.runtime.sendMessage({ action: 'clearBadge' }).catch(() => { /* ignored */ });

  activeTab = await getActiveTab();
  await loadTracked();
  renderList();
  renderStatus();
  current = await fetchCurrent();
  renderCurrent();

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(changes.tracked || changes.lastRunAt)) return;
    loadTracked().then(() => {
      renderList();
      if (!statusTimer) renderStatus();
      if (changes.tracked) renderCurrent();
    }).catch(() => { /* ignore */ });
  });
}

document.addEventListener('DOMContentLoaded', () => { init().catch(err => console.warn('popup init failed', err)); });
