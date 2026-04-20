import type { HistoryEntry, RunCheckResponse, TrackedItem } from './lib/types.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

let statusTimer: ReturnType<typeof setTimeout> | null = null;

function extractCurrencySnippet(raw: unknown): string {
  if (!raw) return '';
  const s = String(raw);
  const m = s.match(/[$£€¥]\s?\d[\d,.\s]*/);
  return (m ? m[0] : s).replace(/\s+/g, ' ').trim();
}

function formatTimestamp(ts: number | null | undefined): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}

function setStatus(text: string, timeoutMs?: number): void {
  const el = $('detailsStatus');
  el.textContent = text;
  if (timeoutMs) {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { el.textContent = ''; }, timeoutMs);
  }
}

async function loadInterval(): Promise<void> {
  const { checkIntervalMinutes } = await browser.storage.local.get('checkIntervalMinutes');
  if (checkIntervalMinutes) {
    $<HTMLInputElement>('intervalInput').value = String(checkIntervalMinutes);
  }
}

async function saveInterval(): Promise<void> {
  const btn = $('saveIntervalBtn');
  const raw = Number($<HTMLInputElement>('intervalInput').value);
  const value = Math.max(1, Number.isFinite(raw) ? raw : 60);
  await browser.storage.local.set({ checkIntervalMinutes: value });
  btn.textContent = 'Saved';
  setTimeout(() => { btn.textContent = 'Save'; }, 1200);
}

async function loadList(): Promise<void> {
  const { tracked } = await browser.storage.local.get('tracked');
  const list: TrackedItem[] = tracked ?? [];
  const container = $('list');
  container.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No tracked items yet. Open the popup on a product page and click "Track price".';
    container.appendChild(empty);
    return;
  }
  for (const item of list) {
    container.appendChild(renderCard(item));
  }
}

function span(text: string): HTMLElement {
  const el = document.createElement('span');
  el.textContent = text;
  return el;
}

function button(text: string, className: string, handler?: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = text;
  if (handler) b.addEventListener('click', handler);
  return b;
}

function renderCard(item: TrackedItem): HTMLElement {
  const card = document.createElement('div');
  card.className = 'details-card';

  const row = document.createElement('div');
  row.className = 'details-card-row';

  const meta = document.createElement('div');
  const title = document.createElement('a');
  title.className = 'product-title';
  title.href = '#';
  title.textContent = item.title || item.url;
  title.addEventListener('click', e => {
    e.preventDefault();
    browser.tabs.create({ url: item.url });
  });
  const url = document.createElement('div');
  url.className = 'product-url';
  url.textContent = item.url;
  const metaRow = document.createElement('div');
  metaRow.className = 'meta-row';
  if (item.updatedAt) metaRow.appendChild(span(`Updated: ${formatTimestamp(item.updatedAt)}`));
  if (item.lastChecked) metaRow.appendChild(span(`Last checked: ${formatTimestamp(item.lastChecked)}`));
  if (item.selector) metaRow.appendChild(span(`Selector: ${item.selector}`));
  meta.appendChild(title);
  meta.appendChild(url);
  meta.appendChild(metaRow);

  const price = document.createElement('div');
  price.className = 'price-block';
  price.textContent = extractCurrencySnippet(item.lastRaw)
    || (item.lastPrice != null ? String(item.lastPrice) : '—');

  const btns = document.createElement('div');
  btns.className = 'card-btns';
  const openBtn = button('Open', 'btn btn-secondary', () => browser.tabs.create({ url: item.url }));
  const histBtn = button('Show history', 'btn btn-secondary');
  const removeBtn = button('Remove', 'btn btn-secondary btn-danger', () => removeItem(item.url));
  btns.appendChild(openBtn);
  btns.appendChild(histBtn);
  btns.appendChild(removeBtn);

  row.appendChild(meta);
  row.appendChild(price);
  row.appendChild(btns);
  card.appendChild(row);

  const history = document.createElement('div');
  history.className = 'history';
  card.appendChild(history);

  histBtn.addEventListener('click', () => {
    const shown = history.classList.toggle('open');
    histBtn.textContent = shown ? 'Hide history' : 'Show history';
    if (shown) renderHistory(history, item.history ?? []);
  });

  return card;
}

function renderHistory(container: HTMLElement, entries: HistoryEntry[]): void {
  container.innerHTML = '';
  if (!entries.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = '(no history)';
    container.appendChild(e);
    return;
  }
  for (const entry of entries.slice().reverse()) {
    const row = document.createElement('div');
    row.className = 'history-row';
    const p = document.createElement('div');
    p.className = 'history-row-price';
    p.textContent = extractCurrencySnippet(entry.raw)
      || (entry.price != null ? String(entry.price) : '');
    const t = document.createElement('div');
    t.className = 'history-row-time';
    t.textContent = formatTimestamp(entry.ts);
    row.appendChild(p);
    row.appendChild(t);
    container.appendChild(row);
  }
}

async function removeItem(url: string): Promise<void> {
  const { tracked } = await browser.storage.local.get('tracked');
  const next = (tracked ?? []).filter((i: TrackedItem) => i.url !== url);
  await browser.storage.local.set({ tracked: next });
  await loadList();
}

async function runForceCheck(): Promise<void> {
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
    await loadList();
    if (result) {
      const secs = ((result.durationMs || 0) / 1000).toFixed(1);
      setStatus(`Checked ${result.checked}, skipped ${result.skipped} in ${secs}s`, 4000);
    }
  } catch (err) {
    console.warn('runCheck failed', err);
    setStatus('Check failed', 3000);
  } finally {
    spinner.hidden = true;
    label.textContent = 'Force Check';
    btn.disabled = false;
  }
}

function init(): void {
  $('refreshBtn').addEventListener('click', runForceCheck);
  $('saveIntervalBtn').addEventListener('click', saveInterval);
  loadInterval();
  loadList();
}

document.addEventListener('DOMContentLoaded', init);
