import type { NormalizedPrice, RunCheckResponse, TrackedItem } from './lib/types.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

interface Current {
  price: number | null;
  raw: string;
  title: string | null;
  image?: string | null;
}

let activeTab: browser.tabs.Tab | null = null;
let activeSelector: string | null = null;
let currentDetected: Current | null = null;
let statusTimer: ReturnType<typeof setTimeout> | null = null;

function extractCurrencySnippet(raw: unknown): string {
  if (!raw) return '';
  const s = String(raw);
  const m = s.match(/[$£€¥]\s?\d[\d,.\s]*/);
  return (m ? m[0] : s).replace(/\s+/g, ' ').trim();
}

function compactTitle(full: string | null | undefined): string {
  if (!full) return '';
  const parts = String(full).split(/[-–—|:\u00B7]/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) return String(full);
  return parts.reduce((a, b) => (b.length > a.length ? b : a), parts[0]!);
}

function sameUrl(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.split('#')[0] === b.split('#')[0];
}

function setStatus(text: string, timeoutMs?: number): void {
  $('refreshStatus').textContent = text;
  if (timeoutMs) {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { $('refreshStatus').textContent = ''; }, timeoutMs);
  }
}

function setSelectorNote(): void {
  $('selectorNote').textContent = activeSelector ? `Using selector: ${activeSelector}` : '';
}

async function getActiveTab(): Promise<browser.tabs.Tab | null> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

async function openTab(url: string): Promise<void> {
  // On Firefox Android the popup sheet keeps focus even after tabs.create,
  // so the new tab lands in the background. Closing the popup first lets
  // the fresh tab become active.
  browser.tabs.create({ url, active: true }).catch(() => { /* ignore */ });
  window.close();
}

async function fetchCurrent(): Promise<Current | null> {
  activeTab = await getActiveTab();
  if (!activeTab?.id) return null;

  const { tracked } = await browser.storage.local.get('tracked');
  const list: TrackedItem[] = tracked ?? [];
  const existing = list.find(i => sameUrl(i.url, activeTab?.url));
  if (existing?.selector) activeSelector = existing.selector;

  try {
    const resp = await Promise.race([
      browser.tabs.sendMessage(activeTab.id, { action: 'getPrice' }),
      new Promise<undefined>(r => setTimeout(() => r(undefined), 2000))
    ]);
    if (resp && resp.price != null) {
      return { price: resp.price, raw: resp.raw, title: resp.title ?? activeTab.title ?? null, image: resp.image };
    }
  } catch {
    // content script may not be injected (e.g. extension pages)
  }

  const { lastDetected } = await browser.storage.local.get('lastDetected');
  if (lastDetected && sameUrl(lastDetected.url, activeTab.url)) {
    return {
      price: lastDetected.price,
      raw: lastDetected.raw,
      title: lastDetected.title ?? activeTab.title ?? null,
      image: lastDetected.image
    };
  }
  return null;
}

function renderCurrent(current: Current | null): void {
  const titleEl = $('currentTitle');
  const priceEl = $('currentPrice');
  const trackBtn = $<HTMLButtonElement>('trackBtn');
  currentDetected = current;
  if (!current) {
    titleEl.textContent = 'No product price detected on this page';
    priceEl.textContent = '';
    trackBtn.disabled = true;
    return;
  }
  titleEl.textContent = compactTitle(current.title ?? activeTab?.title ?? '');
  priceEl.textContent = extractCurrencySnippet(current.raw)
    || (current.price != null ? String(current.price) : '');
  trackBtn.disabled = false;
}

async function loadTracked(): Promise<void> {
  const { tracked } = await browser.storage.local.get('tracked');
  const list: TrackedItem[] = tracked ?? [];
  const container = $('list');
  container.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '(none)';
    container.appendChild(empty);
    return;
  }
  for (const item of list) {
    container.appendChild(renderItem(item));
  }
}

function renderItem(item: TrackedItem): HTMLElement {
  const row = document.createElement('div');
  row.className = 'list-item';

  const meta = document.createElement('div');
  meta.className = 'list-item-meta';
  const title = document.createElement('div');
  title.className = 'list-item-title';
  if ((item.failedChecks ?? 0) >= 2) title.classList.add('stale');
  title.textContent = compactTitle(item.title || item.url);
  meta.appendChild(title);

  const price = document.createElement('div');
  price.className = 'list-item-price';
  price.textContent = extractCurrencySnippet(item.lastRaw)
    || (item.lastPrice != null ? String(item.lastPrice) : '');

  const actions = document.createElement('div');
  actions.className = 'list-item-actions';
  const openBtn = document.createElement('button');
  openBtn.className = 'btn btn-ghost';
  openBtn.textContent = 'Open';
  openBtn.addEventListener('click', () => openTab(item.url));
  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn btn-ghost btn-danger';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', () => removeItem(item.url));
  actions.appendChild(openBtn);
  actions.appendChild(removeBtn);

  row.appendChild(meta);
  row.appendChild(price);
  row.appendChild(actions);
  return row;
}

async function removeItem(url: string): Promise<void> {
  const { tracked } = await browser.storage.local.get('tracked');
  const next = (tracked ?? []).filter((i: TrackedItem) => i.url !== url);
  await browser.storage.local.set({ tracked: next });
  await loadTracked();
}

async function trackCurrent(): Promise<void> {
  if (!currentDetected || !activeTab?.url) return;
  const norm = await browser.runtime.sendMessage({
    action: 'normalizePrice',
    raw: currentDetected.raw
  }) as NormalizedPrice | undefined;
  const finalRaw = norm?.raw || currentDetected.raw;
  const finalPrice = norm?.price ?? currentDetected.price;

  const { tracked } = await browser.storage.local.get('tracked');
  const list: TrackedItem[] = tracked ?? [];
  const existing = list.find(i => i.url === activeTab!.url);
  const ts = Date.now();
  const newItem: TrackedItem = {
    url: activeTab.url,
    title: currentDetected.title || activeTab.title || '',
    lastPrice: finalPrice,
    lastRaw: finalRaw,
    selector: activeSelector ?? null,
    image: currentDetected.image ?? null,
    updatedAt: ts,
    lastChecked: ts,
    history: [{ ts, price: finalPrice, raw: finalRaw }]
  };
  if (existing) {
    existing.lastPrice = newItem.lastPrice;
    existing.lastRaw = newItem.lastRaw;
    existing.updatedAt = ts;
    existing.failedChecks = 0;
    existing.history = existing.history ?? [];
    existing.history.push({ ts, price: newItem.lastPrice, raw: newItem.lastRaw });
    if (activeSelector) existing.selector = activeSelector;
  } else {
    list.push(newItem);
  }
  await browser.storage.local.set({ tracked: list });
  setStatus(`Tracking: ${compactTitle(newItem.title)}`, 3000);
  await loadTracked();
}

async function pickElement(): Promise<void> {
  if (!activeTab?.id) return;
  browser.tabs.sendMessage(activeTab.id, { action: 'startSelect' }).catch(() => { /* ignored */ });
  window.close();
}

async function refresh(): Promise<void> {
  const btn = $<HTMLButtonElement>('refreshBtn');
  const spinner = $('refreshSpinner');
  const label = $('refreshLabel');
  btn.disabled = true;
  spinner.hidden = false;
  label.textContent = 'Checking…';
  try {
    const result = await browser.runtime.sendMessage({
      action: 'runCheck',
      force: true
    }) as RunCheckResponse | undefined;
    const current = await fetchCurrent();
    renderCurrent(current);
    await loadTracked();
    if (result) {
      const secs = ((result.durationMs || 0) / 1000).toFixed(1);
      setStatus(`Checked ${result.checked}, skipped ${result.skipped} in ${secs}s`, 4000);
    }
  } catch (err) {
    console.warn('refresh failed', err);
    setStatus('Check failed', 3000);
  } finally {
    spinner.hidden = true;
    label.textContent = 'Refresh';
    btn.disabled = false;
  }
}

async function init(): Promise<void> {
  $('trackBtn').addEventListener('click', trackCurrent);
  $('pickBtn').addEventListener('click', pickElement);
  $('refreshBtn').addEventListener('click', refresh);
  $('openDetailsBtn').addEventListener('click', () => {
    openTab(browser.runtime.getURL('details.html'));
  });

  browser.runtime.sendMessage({ action: 'clearBadge' }).catch(() => { /* ignored */ });

  await loadTracked();
  const current = await fetchCurrent();
  renderCurrent(current);
  setSelectorNote();

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.tracked) {
      loadTracked().catch(() => { /* ignore */ });
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
