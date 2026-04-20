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

function detect() {
  return findPriceOnPage(document, { hostname: location.hostname });
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

function persistLastDetected(): void {
  if (window.top !== window.self) return;
  if (!isProductPage(document)) return;
  const detected = detect();
  if (!detected || detected.price == null) return;
  browser.storage.local.set({
    lastDetected: {
      url: location.href,
      price: detected.price,
      raw: detected.raw,
      title: findTitle(),
      image: findProductImage(),
      updatedAt: Date.now()
    }
  }).catch(() => { /* best-effort persistence */ });
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

function startPicker(): Promise<StartSelectResponse> {
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
      cleanup();
      const refined = bestElementForPrice(e.target as Element);
      const selector = refineAmazonSelector(refined, getSelector(refined));
      const raw = readRawForSelector(refined);
      const price = cleanNumber(raw);
      const title = findTitle();
      const result: StartSelectResponse = { selector, raw, price, title };
      browser.runtime.sendMessage({
        action: 'manualSelectResult',
        item: { url: location.href, selector, raw, price, title, image: findProductImage() }
      }).catch(() => { /* best-effort persist from content */ });
      resolve(result);
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

persistLastDetected();
window.addEventListener('load', persistLastDetected, { once: true });
