// Content script: detects a product price on the current page and handles
// the user-driven manual-pick flow. Top frame only; runs on every page, so
// it does nothing beyond one storage read unless the page looks like a
// product page or has a tracked selector.
import {
  CURRENCY_RE,
  cleanNumber,
  currencyCodeOf,
  extractCurrencySnippet,
  findPriceOnPage,
  findProductImage,
  findTitle,
  isProductPage,
  readPickedElement
} from './lib/price.js';
import { productKey } from './lib/url.js';
import type {
  GetPriceResponse,
  Message,
  PriceHit,
  StartSelectResponse,
  TrackedItem
} from './lib/types.js';

// A detected price must hold this long before it is reported as a visit
// update; transient DOM states while a page renders are ignored.
const STABLE_MS = 1500;
const WATCH_MS = 8000;

let cachedTrackedSelector: string | null = null;
let isTracked = false;

async function loadTrackedState(): Promise<void> {
  try {
    const { tracked } = await browser.storage.local.get('tracked');
    const list = (Array.isArray(tracked) ? tracked : []) as TrackedItem[];
    const key = productKey(location.href);
    const match = list.find(i => productKey(i.url) === key);
    isTracked = !!match;
    cachedTrackedSelector = match?.selector ?? null;
  } catch (err) {
    console.warn('PriceTracker: could not read tracked items', err);
  }
}

function detect(): PriceHit | null {
  return findPriceOnPage(document, {
    hostname: location.hostname,
    preferredSelector: cachedTrackedSelector,
    pageUrl: location.href
  });
}

function productImage(): string | null {
  return findProductImage(document, location.href);
}

function report(hit: PriceHit): void {
  const image = productImage();
  browser.storage.local.set({
    lastDetected: {
      url: location.href,
      price: hit.price,
      raw: hit.raw,
      currency: hit.currency ?? null,
      title: findTitle(document),
      image,
      updatedAt: Date.now()
    }
  }).catch(() => { /* best-effort cache for the popup */ });
  if (!isTracked) return;
  browser.runtime.sendMessage({
    action: 'visitUpdate',
    url: location.href,
    price: hit.price,
    raw: hit.raw,
    currency: hit.currency ?? null,
    image
  }).catch(() => { /* background unavailable; next check covers it */ });
}

// Watches the page (it may still be rendering) until the same price has been
// detected for STABLE_MS, then reports it once.
function watchForStablePrice(): void {
  let candidate: { key: string; since: number; hit: PriceHit } | null = null;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const finish = () => {
    done = true;
    obs.disconnect();
    if (timer) clearTimeout(timer);
  };
  const evaluate = () => {
    timer = null;
    if (done) return;
    const hit = detect();
    const now = Date.now();
    if (!hit) { candidate = null; return; }
    const key = `${hit.price}|${hit.raw}`;
    if (!candidate || candidate.key !== key) {
      candidate = { key, since: now, hit };
      schedule(STABLE_MS);
      return;
    }
    if (now - candidate.since >= STABLE_MS) {
      finish();
      report(candidate.hit);
    } else {
      schedule(candidate.since + STABLE_MS - now);
    }
  };
  // Throttled: busy pages fire thousands of mutations.
  const schedule = (ms = 250) => {
    if (done) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(evaluate, ms);
  };
  const obs = new MutationObserver(() => { if (!timer) schedule(); });
  try {
    obs.observe(document, { childList: true, subtree: true, characterData: true });
  } catch { /* detached */ }
  setTimeout(() => {
    if (done) return;
    finish();
    // Settled on something that never changed again: still stable.
    if (candidate) report(candidate.hit);
  }, WATCH_MS);
  evaluate();
}

let started = false;

async function start(): Promise<void> {
  if (started || window.top !== window.self) return;
  await loadTrackedState();
  if (!cachedTrackedSelector && !isProductPage(document, location.hostname)) return;
  started = true;
  watchForStablePrice();
}

function waitForDynamicPrice(timeoutMs: number): Promise<GetPriceResponse> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: GetPriceResponse) => {
      if (settled) return;
      settled = true;
      obs.disconnect();
      resolve(result);
    };
    const tryOnce = (): boolean => {
      const p = detect();
      if (p) {
        finish(describe(p));
        return true;
      }
      return false;
    };
    const obs = new MutationObserver(() => { tryOnce(); });
    try {
      obs.observe(document, { childList: true, subtree: true, characterData: true });
    } catch {
      // detached document; fall back to timeout
    }
    setTimeout(() => { if (!tryOnce()) finish({}); }, timeoutMs);
  });
}

function describe(hit: PriceHit): GetPriceResponse {
  return {
    price: hit.price,
    raw: hit.raw,
    currency: hit.currency ?? null,
    title: findTitle(document),
    image: productImage()
  };
}

// ---------------------------------------------------------------------------
// Manual picker
// ---------------------------------------------------------------------------

function isTouchDevice(): boolean {
  try { return window.matchMedia('(pointer: coarse)').matches; }
  catch { return false; }
}

const PRICE_TEXT_MAX = 48;

function normText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function looksLikePrice(el: Element): boolean {
  const t = normText(el);
  return t.length > 0 && t.length <= PRICE_TEXT_MAX && CURRENCY_RE.test(t);
}

function isVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

// The element the user most likely meant: climbs out of split-price
// fragments ("99" in $19<sup>99</sup>) or dives into a container.
function bestElementForPrice(el: Element): Element {
  let cur: Element | null = el;
  for (let i = 0; i < 4 && cur && cur !== document.body; i++, cur = cur.parentElement) {
    if (looksLikePrice(cur)) return cur;
  }
  for (const d of toArray(el.querySelectorAll('*'))) {
    if (d.closest('del, s, strike')) continue;
    if (isVisible(d) && looksLikePrice(d)) return d;
  }
  return el;
}

function readRaw(el: Element): string {
  const aria = el.getAttribute('aria-label');
  const content = el.getAttribute('content');
  if (content) return extractCurrencySnippet(content);
  if (aria && CURRENCY_RE.test(aria)) return extractCurrencySnippet(aria);
  const text = (el as HTMLElement).innerText || el.textContent || '';
  return extractCurrencySnippet(text);
}

// Class names that look generated (hashes, CSS-module suffixes) change on
// every deploy and would break the saved selector.
function stableClass(c: string): boolean {
  if (!/^[a-zA-Z][\w-]*$/.test(c) || c.length > 40) return false;
  return !c.split(/[-_]+/).some(seg => /\d/.test(seg) || (seg.length <= 8 && (seg.match(/[A-Z]/g) ?? []).length >= 3));
}

function stableId(id: string): boolean {
  return !!id && !/^(?:[:_]r|radix-|headlessui-|mui-|ember\d|react-|uid-)|[0-9a-f]{8,}/i.test(id);
}

const STABLE_ATTRS = ['itemprop', 'data-testid', 'data-test', 'data-qa', 'data-price-type', 'data-automation-id', 'data-cy'];

function isUnique(sel: string, el: Element): boolean {
  try {
    const found = document.querySelectorAll(sel);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

// Page collections are Xray-wrapped in content scripts; index-based copying
// avoids relying on their iterators.
function toArray<T>(list: ArrayLike<T>): T[] {
  return Array.prototype.slice.call(list) as T[];
}

function segmentFor(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const parent = el.parentElement;
  if (!parent) return tag;
  const siblings = toArray(parent.children);
  const classes = (el.getAttribute('class') ?? '').split(/\s+/).filter(stableClass);
  for (const c of classes.slice(0, 3)) {
    const sel = `${tag}.${CSS.escape(c)}`;
    if (siblings.filter(s => s.matches(sel)).length === 1) return sel;
  }
  const sameTag = siblings.filter(s => s.tagName === el.tagName);
  return sameTag.length === 1 ? tag : `${tag}:nth-of-type(${sameTag.indexOf(el) + 1})`;
}

// A selector that uniquely matches `el` now and is likely to keep matching
// after re-renders: stable attributes, then an id-anchored path.
function buildSelector(el: Element): string | null {
  const tag = el.tagName.toLowerCase();
  for (const attr of STABLE_ATTRS) {
    const v = el.getAttribute(attr);
    if (!v || v.length > 60) continue;
    const sel = `${tag}[${attr}="${CSS.escape(v)}"]`;
    if (isUnique(sel, el)) return sel;
  }
  if (stableId(el.id) && isUnique(`#${CSS.escape(el.id)}`, el)) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
    if (node !== el && stableId(node.id)) {
      const anchored = [`#${CSS.escape(node.id)}`, ...parts].join(' > ');
      if (isUnique(anchored, el)) return anchored;
    }
    parts.unshift(segmentFor(node));
    const sel = parts.join(' > ');
    if (isUnique(sel, el)) return sel;
  }
  return parts.length ? parts.join(' > ') : null;
}

function selectionTarget(el: Element): Element {
  const best = bestElementForPrice(el);
  // Amazon: the price reader understands the whole .a-price block, which is
  // also what exists in the server HTML the background fetches.
  if (/(^|\.)amazon\./.test(location.hostname)) return best.closest('.a-price') ?? best;
  return best;
}

function commitPick(el: Element): StartSelectResponse {
  const target = selectionTarget(el);
  const selector = buildSelector(target);
  const hit = readPickedElement(target, location.hostname);
  const raw = hit?.raw ?? readRaw(target);
  const price = hit?.price ?? cleanNumber(raw);
  const title = findTitle(document);
  browser.runtime.sendMessage({
    action: 'manualSelectResult',
    item: {
      url: location.href,
      selector,
      raw,
      price,
      title,
      image: productImage(),
      currency: hit?.currency ?? currencyCodeOf(raw)
    }
  }).catch(() => { /* background unavailable */ });
  isTracked = true;
  cachedTrackedSelector = selector;
  return { selector, raw, price, title };
}

const PICKER_CSS = `
:host { all: initial; }
.box { position: fixed; pointer-events: none; z-index: 2147483646; border: 2px solid #2563eb;
  background: rgba(37, 99, 235, 0.12); border-radius: 4px; transition: all 60ms ease-out; display: none; }
.bar { position: fixed; left: 12px; right: 12px; bottom: 12px; z-index: 2147483647; margin: 0 auto; max-width: 560px;
  display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 14px; border-radius: 12px;
  background: #1c1e23; color: #e6e9ef; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  font: 500 14px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.bar.top { top: 12px; bottom: auto; }
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.hint { color: #9aa4b2; font-size: 12px; }
.value { color: #fff; font-size: 15px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button { appearance: none; border: 0; border-radius: 8px; padding: 10px 14px; font: inherit; cursor: pointer;
  touch-action: manipulation; }
.ok { background: #2563eb; color: #fff; }
.ok:disabled { opacity: 0.45; cursor: default; }
.cancel { background: transparent; color: #e6e9ef; border: 1px solid rgba(255, 255, 255, 0.25); }
.toast { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 2147483647;
  padding: 10px 16px; border-radius: 10px; background: #1c1e23; color: #fff; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  font: 500 14px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.toast b { color: #93c5fd; }
`;

interface PickerUi {
  host: HTMLElement;
  bar: HTMLElement;
  box: HTMLElement;
  hint: HTMLElement;
  value: HTMLElement;
  ok: HTMLButtonElement;
  cancel: HTMLButtonElement;
  remove(): void;
}

// Everything lives in a closed shadow root so page CSS can't restyle it and
// the page's own elements are never modified.
function createPickerUi(touch: boolean): PickerUi {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = PICKER_CSS;
  const box = document.createElement('div');
  box.className = 'box';
  const bar = document.createElement('div');
  bar.className = 'bar';
  const info = document.createElement('div');
  info.className = 'info';
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = touch ? 'Tap the price you want to track' : 'Click the price you want to track · Esc to cancel';
  const value = document.createElement('span');
  value.className = 'value';
  value.textContent = '—';
  info.append(hint, value);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'cancel';
  cancel.textContent = 'Cancel';
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'ok';
  ok.textContent = 'Track';
  ok.disabled = true;
  bar.append(info, cancel);
  if (touch) bar.append(ok);
  root.append(style, box, bar);
  document.documentElement.appendChild(host);
  return { host, bar, box, hint, value, ok, cancel, remove: () => host.remove() };
}

function showToast(text: string, price: string): void {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = PICKER_CSS;
  const toast = document.createElement('div');
  toast.className = 'toast';
  const strong = document.createElement('b');
  strong.textContent = price;
  toast.append(text, ' ', strong);
  root.append(style, toast);
  document.documentElement.appendChild(host);
  setTimeout(() => host.remove(), 2800);
}

function placeBox(box: HTMLElement, el: Element): void {
  const r = el.getBoundingClientRect();
  box.style.display = 'block';
  box.style.left = `${r.left - 3}px`;
  box.style.top = `${r.top - 3}px`;
  box.style.width = `${r.width + 6}px`;
  box.style.height = `${r.height + 6}px`;
}

let pickerActive = false;

function startPicker(): Promise<StartSelectResponse> {
  if (pickerActive) return Promise.resolve({});
  pickerActive = true;
  const touch = isTouchDevice();
  const ui = createPickerUi(touch);
  let current: Element | null = null;

  return new Promise(resolve => {
    const ours = (e: Event) => e.composedPath().includes(ui.host);
    const select = (target: Element) => {
      current = selectionTarget(target);
      placeBox(ui.box, current);
      // Keep the bar from covering what was just selected.
      const r = current.getBoundingClientRect();
      ui.bar.classList.toggle('top', r.bottom > window.innerHeight - ui.bar.offsetHeight - 24);
      const raw = readRaw(current);
      ui.value.textContent = raw && CURRENCY_RE.test(raw) ? raw : (raw || 'No price in this element');
      ui.ok.disabled = !raw;
    };
    const onMove = (e: MouseEvent) => {
      if (ours(e) || !(e.target instanceof Element)) return;
      select(e.target);
    };
    const swallow = (e: Event) => {
      if (ours(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onClick = (e: MouseEvent) => {
      if (ours(e) || !(e.target instanceof Element)) return;
      e.preventDefault();
      e.stopPropagation();
      select(e.target);
      if (!touch) finish(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      if (e.key === 'Enter' && current) { e.preventDefault(); finish(true); }
    };
    const onScroll = () => { if (current) placeBox(ui.box, current); };
    const finish = (commit: boolean) => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick'] as const) {
        document.removeEventListener(t, swallow, true);
      }
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      ui.remove();
      pickerActive = false;
      if (commit && current) {
        const result = commitPick(current);
        showToast('Tracking', result.raw || String(result.price ?? ''));
        resolve(result);
      } else {
        resolve({});
      }
    };

    if (!touch) document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick'] as const) {
      document.addEventListener(t, swallow, true);
    }
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    ui.cancel.addEventListener('click', e => { e.preventDefault(); finish(false); });
    ui.ok.addEventListener('click', e => { e.preventDefault(); finish(true); });
  });
}

browser.runtime.onMessage.addListener((msg: Message) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.action === 'getPrice') {
    const hit = detect();
    if (hit) return Promise.resolve(describe(hit));
    return waitForDynamicPrice(1200);
  }
  if (msg.action === 'startSelect') {
    return startPicker();
  }
  if (msg.action === 'isProductPage') {
    return Promise.resolve({ isProduct: isProductPage(document, location.hostname) });
  }
  return undefined;
});

start();
// Pages that only reveal product markup after hydration get one more look.
if (document.readyState !== 'complete') {
  window.addEventListener('load', () => { setTimeout(start, 1500); }, { once: true });
} else {
  setTimeout(start, 1500);
}
