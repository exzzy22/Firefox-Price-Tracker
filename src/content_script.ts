// Content script: detects a product price on the current page and handles
// the user-driven manual-pick selector flow. Top frame only.
import {
  cleanNumber,
  extractCurrencySnippet,
  findPriceOnPage,
  isProductPage
} from './lib/price.js';
import type {
  GetPriceResponse,
  Message,
  StartSelectResponse
} from './lib/types.js';

const HIGHLIGHT_CLASS = '__price_picker_highlight';
const PICKER_STYLE_ID = '__price_picker_style';
const PICKER_BAR_ID = '__price_picker_bar';

function isTouchDevice(): boolean {
  try { return window.matchMedia('(pointer: coarse)').matches; }
  catch { return false; }
}

let cachedTrackedSelector: string | null = null;

async function loadTrackedSelectorForThisUrl(): Promise<void> {
  try {
    const { tracked } = await browser.storage.local.get('tracked');
    const list = (tracked ?? []) as Array<{ url: string; selector: string | null }>;
    const match = list.find(i => sameUrl(i.url, location.href));
    cachedTrackedSelector = match?.selector ?? null;
  } catch { /* ignore */ }
}

function detect() {
  return findPriceOnPage(document, {
    hostname: location.hostname,
    preferredSelector: cachedTrackedSelector
  });
}

function findProductImage(): string | null {
  const og = document.querySelector('meta[property="og:image"]');
  const ogUrl = og?.getAttribute('content');
  if (ogUrl && /^https?:\/\//i.test(ogUrl)) return ogUrl;
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(s.textContent ?? '') as unknown;
      const objs = Array.isArray(parsed) ? parsed : [parsed];
      for (const obj of objs) {
        if (!obj || typeof obj !== 'object') continue;
        const o = obj as Record<string, unknown>;
        const graphs: unknown[] = Array.isArray(o['@graph']) ? (o['@graph'] as unknown[]) : [];
        for (const node of [o, ...graphs]) {
          if (!node || typeof node !== 'object') continue;
          const img = (node as Record<string, unknown>).image;
          const url = Array.isArray(img) ? img[0] : img;
          if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url;
        }
      }
    } catch { /* ignore malformed JSON-LD */ }
  }
  const tw = document.querySelector('meta[name="twitter:image"]');
  const twUrl = tw?.getAttribute('content');
  if (twUrl && /^https?:\/\//i.test(twUrl)) return twUrl;

  // Amazon: main product image lives in #landingImage; og/twitter tags are absent or unusable
  if (document.querySelector('#productTitle')) {
    const amzImg = document.querySelector<HTMLImageElement>(
      '#landingImage[src], #imgTagWrappingDiv img[src], #main-image-container img[src]'
    );
    const amzUrl = amzImg?.getAttribute('data-old-hires') || amzImg?.getAttribute('src');
    if (amzUrl && /^https?:\/\//i.test(amzUrl)) return amzUrl;
  }

  return null;
}

function findTitle(): string | null {
  const prod = document.querySelector('#productTitle');
  if (prod?.textContent?.trim()) return prod.textContent.trim();
  const og = document.querySelector('meta[property="og:title"]');
  if (og?.getAttribute('content')) return og.getAttribute('content');
  const tw = document.querySelector('meta[name="twitter:title"]');
  if (tw?.getAttribute('content')) return tw.getAttribute('content');
  return document.title || null;
}

function sameUrl(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.split('#')[0] === b.split('#')[0];
}

async function updateTrackedFromVisit(price: number, raw: string, image: string | null): Promise<void> {
  const { tracked } = await browser.storage.local.get('tracked');
  const list = (tracked ?? []) as Array<{
    url: string;
    lastPrice: number | null;
    lastRaw: string;
    updatedAt: number;
    lastChecked: number;
    failedChecks?: number;
    image?: string | null;
    history?: Array<{ ts: number; price: number | null; raw: string }>;
  }>;
  const it = list.find(i => sameUrl(i.url, location.href));
  if (!it) return;
  const now = Date.now();
  const changed = it.lastPrice !== price || (it.lastRaw || '') !== raw;
  it.lastChecked = now;
  it.failedChecks = 0;
  if (image && !it.image) it.image = image;
  if (changed) {
    it.lastPrice = price;
    it.lastRaw = raw;
    it.updatedAt = now;
    it.history = it.history ?? [];
    it.history.push({ ts: now, price, raw });
  }
  await browser.storage.local.set({ tracked: list });
}

function persistHit(hit: { price: number; raw: string }): void {
  const image = findProductImage();
  browser.storage.local.set({
    lastDetected: {
      url: location.href,
      price: hit.price,
      raw: hit.raw,
      title: findTitle(),
      image,
      updatedAt: Date.now()
    }
  }).catch(() => { /* best-effort */ });
  updateTrackedFromVisit(hit.price, hit.raw, image).catch(() => { /* best-effort */ });
}

async function persistLastDetected(): Promise<void> {
  if (window.top !== window.self) return;
  await loadTrackedSelectorForThisUrl();
  // Product signal or a saved selector is enough. Skip if neither (e.g. news pages).
  if (!cachedTrackedSelector && !isProductPage(document)) return;

  const immediate = detect();
  if (immediate) { persistHit(immediate); return; }

  // JS-rendered pages populate the price after load. Watch for up to 8s.
  let settled = false;
  const obs = new MutationObserver(() => {
    if (settled) return;
    const hit = detect();
    if (hit) {
      settled = true;
      obs.disconnect();
      persistHit(hit);
    }
  });
  try {
    obs.observe(document, { childList: true, subtree: true, characterData: true });
  } catch { /* detached */ }
  setTimeout(() => { if (!settled) obs.disconnect(); }, 8000);
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
        finish({ price: p.price, raw: p.raw, title: findTitle() });
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

function getSelector(el: Element | null): string | null {
  if (!el) return null;
  if (el.id) return '#' + el.id;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && node !== document.body) {
    let name = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (parent) {
      const idx = Array.prototype.indexOf.call(parent.children, node) + 1;
      name += `:nth-child(${idx})`;
    }
    parts.unshift(name);
    node = node.parentElement;
  }
  return parts.length ? parts.join(' > ') : null;
}

// Amazon duplicates prices into hidden `.a-offscreen` spans near the
// visible price. Rewrite selectors so background fetches (parsing raw
// HTML, no layout) match the same element.
function refineAmazonSelector(clicked: Element, selector: string | null): string | null {
  const cls = typeof clicked.className === 'string' ? clicked.className : '';
  const isOffscreen = /(-offscreen$)|(^|\s)a-offscreen(\s|$)/.test(cls);
  if (!isOffscreen) return selector;
  const container = clicked.closest(
    '#corePrice_feature_div, #price, #centerCol, .a-price, .priceToPay, body'
  ) ?? clicked.parentElement;
  if (!container) return selector;
  const containerSel = container.id ? '#' + container.id : getSelector(container);
  if (!containerSel) return selector;
  return containerSel + ' .a-offscreen:first-of-type';
}

function bestElementForPrice(el: Element): Element {
  const currencyRe = /[$£€¥]\s?[0-9]/;
  const aria = el.getAttribute('aria-label');
  if (aria && currencyRe.test(aria)) return el;
  const title = el.getAttribute('title');
  if (title && currencyRe.test(title)) return el;
  const html = el as HTMLElement;
  for (const d of Array.from(el.querySelectorAll('*'))) {
    const dh = d as HTMLElement;
    if (!(dh.offsetWidth > 0 && dh.offsetHeight > 0)) continue;
    const txt = (dh.innerText || d.textContent || '').trim();
    if (!txt) continue;
    if (currencyRe.test(txt) && !/\n/.test(txt)) return d;
  }
  void html;
  return el;
}

function readRawForSelector(el: Element): string {
  const aria = el.getAttribute('aria-label');
  const title = el.getAttribute('title');
  const contentAttr = el.getAttribute('content');
  const innerText = (el as HTMLElement).innerText;
  const textSource = aria
    || title
    || ((typeof innerText === 'string' && innerText.trim()) ? innerText : (el.textContent || ''));
  const visible = String(textSource).replace(/\s+/g, ' ').trim();
  const raw = (contentAttr != null && contentAttr !== '') ? contentAttr : visible;
  return extractCurrencySnippet(raw);
}

function commitPick(el: Element): StartSelectResponse {
  const refined = bestElementForPrice(el);
  const selector = refineAmazonSelector(refined, getSelector(refined));
  const raw = readRawForSelector(refined);
  const price = cleanNumber(raw);
  const title = findTitle();
  const result: StartSelectResponse = { selector, raw, price, title };
  browser.runtime.sendMessage({
    action: 'manualSelectResult',
    item: { url: location.href, selector, raw, price, title, image: findProductImage() }
  }).catch(() => { /* best-effort persist from content */ });
  return result;
}

function startTouchPicker(): Promise<StartSelectResponse> {
  return new Promise(resolve => {
    let selected: Element | null = null;
    const style = document.createElement('style');
    style.id = PICKER_STYLE_ID;
    style.textContent = `
      .${HIGHLIGHT_CLASS}{outline:3px solid rgba(37,99,235,0.9) !important}
      #${PICKER_BAR_ID}{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#1c1e23;color:#fff;display:flex;gap:8px;padding:10px 12px;font:500 14px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;box-shadow:0 -2px 12px rgba(0,0,0,0.4);align-items:center}
      #${PICKER_BAR_ID} .ppb-info{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#e6e9ef}
      #${PICKER_BAR_ID} button{appearance:none;border:0;border-radius:6px;padding:10px 14px;font:inherit;cursor:pointer;touch-action:manipulation}
      #${PICKER_BAR_ID} .ppb-ok{background:#2563eb;color:#fff}
      #${PICKER_BAR_ID} .ppb-ok:disabled{opacity:0.5}
      #${PICKER_BAR_ID} .ppb-cancel{background:transparent;color:#e6e9ef;border:1px solid rgba(255,255,255,0.25)}
    `;
    document.head.appendChild(style);

    const bar = document.createElement('div');
    bar.id = PICKER_BAR_ID;
    const info = document.createElement('span');
    info.className = 'ppb-info';
    info.textContent = 'Tap a price on the page';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ppb-cancel';
    cancelBtn.textContent = 'Cancel';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'ppb-ok';
    okBtn.textContent = 'Confirm';
    okBtn.disabled = true;
    bar.append(info, cancelBtn, okBtn);
    document.body.appendChild(bar);

    const onTap = (e: Event) => {
      const t = e.target as Element | null;
      if (!t || bar.contains(t)) return;
      e.preventDefault();
      e.stopPropagation();
      if (selected) selected.classList.remove(HIGHLIGHT_CLASS);
      const refined = bestElementForPrice(t);
      selected = refined;
      refined.classList.add(HIGHLIGHT_CLASS);
      const raw = readRawForSelector(refined);
      info.textContent = raw || '(selected, no currency text)';
      okBtn.disabled = false;
    };
    const onOk = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!selected) return;
      const target = selected;
      cleanup();
      resolve(commitPick(target));
    };
    const onCancel = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      resolve({});
    };
    function cleanup() {
      document.removeEventListener('click', onTap, true);
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      selected?.classList.remove(HIGHLIGHT_CLASS);
      bar.remove();
      style.remove();
    }

    document.addEventListener('click', onTap, true);
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

function startHoverPicker(): Promise<StartSelectResponse> {
  return new Promise(resolve => {
    let hovered: Element | null = null;
    const style = document.createElement('style');
    style.id = PICKER_STYLE_ID;
    style.textContent = `.${HIGHLIGHT_CLASS}{outline:3px solid rgba(37,99,235,0.9) !important;cursor:crosshair !important}`;
    document.head.appendChild(style);

    const onMouseOver = (e: MouseEvent) => {
      const t = e.target as Element;
      if (hovered && hovered !== t) hovered.classList.remove(HIGHLIGHT_CLASS);
      hovered = t;
      hovered.classList?.add(HIGHLIGHT_CLASS);
      e.stopPropagation();
    };
    const onMouseOut = (e: MouseEvent) => {
      (e.target as Element).classList?.remove(HIGHLIGHT_CLASS);
      e.stopPropagation();
    };
    const onClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.target as Element;
      cleanup();
      resolve(commitPick(target));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { cleanup(); resolve({}); }
    };
    function cleanup() {
      document.removeEventListener('mouseover', onMouseOver, true);
      document.removeEventListener('mouseout', onMouseOut, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      hovered?.classList?.remove(HIGHLIGHT_CLASS);
      style.remove();
    }

    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseout', onMouseOut, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  });
}

function startPicker(): Promise<StartSelectResponse> {
  return isTouchDevice() ? startTouchPicker() : startHoverPicker();
}

browser.runtime.onMessage.addListener((msg: Message) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.action === 'getPrice') {
    const hit = detect();
    if (hit) return Promise.resolve({ price: hit.price, raw: hit.raw, title: findTitle(), image: findProductImage() });
    return waitForDynamicPrice(1200);
  }
  if (msg.action === 'startSelect') {
    return startPicker();
  }
  if (msg.action === 'isProductPage') {
    return Promise.resolve({ isProduct: isProductPage(document) });
  }
  return undefined;
});

loadTrackedSelectorForThisUrl();
persistLastDetected();
window.addEventListener('load', persistLastDetected, { once: true });
