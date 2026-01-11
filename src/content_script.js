// Content script: respond to getPrice message with detected price and title
(function(){
  function cleanNumber(s) {
    if (!s) return null;
    // Remove non-digit except dot and comma and minus
    const norm = s.replace(/[^0-9.,\-]/g, '').trim();
    if (!norm) return null;
    // Normalize comma decimal when appropriate
    const commaCount = (norm.match(/,/g) || []).length;
    const dotCount = (norm.match(/\./g) || []).length;
    let cleaned = norm;
    if (commaCount && !dotCount) {
      cleaned = norm.replace(/,/g, '.');
    } else if (commaCount && dotCount && norm.indexOf(',') > norm.indexOf('.')) {
      cleaned = norm.replace(/\./g, '').replace(/,/g, '.');
    } else {
      cleaned = norm.replace(/,/g, '');
    }
    const v = parseFloat(cleaned);
    return isFinite(v) ? v : null;
  }

  function findPrice() {
    // Site-specific heuristics: Amazon uses many non-standard selectors
    // If product title exists, prefer prices near that title
    try {
      const prod = document.querySelector('#productTitle');
      if (prod) {
        const container = prod.closest('#centerCol') || prod.parentElement || document;
        const nearSelectors = ['#priceblock_ourprice','#priceblock_dealprice','#priceblock_saleprice','#price_inside_buybox','.a-price .a-offscreen','.priceToPay .a-offscreen','#corePrice_feature_div .a-offscreen'];
        for (const sel of nearSelectors) {
          try {
            const el = container.querySelector(sel);
            if (el) {
              const raw = el.getAttribute && el.getAttribute('content') || el.textContent || el.value || '';
              const v = cleanNumber(raw);
              if (v != null) return { price: v, raw };
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    try {
      const host = (location.hostname || '').toLowerCase();
      if (host.includes('amazon.')) {
        const amazonSelectors = [
          '#priceblock_ourprice',
          '#priceblock_dealprice',
          '#priceblock_saleprice',
          '#price_inside_buybox',
          '#tp_price_block_total_price_ww .a-offscreen',
          '.a-price .a-offscreen',
          '.priceToPay .a-offscreen',
          '#corePrice_feature_div .a-offscreen',
          '#corePriceDisplay_desktop_feature_div .a-offscreen'
        ];
        for (const sel of amazonSelectors) {
          try {
            const el = document.querySelector(sel);
            if (el) {
              const raw = el.getAttribute && el.getAttribute('content') || el.textContent || el.value || '';
              const v = cleanNumber(raw);
              if (v != null) return { price: v, raw };
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
    // 1) Microdata / JSON-LD
    try {
      // JSON-LD
      const ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(s => s.textContent);
      for (const j of ld) {
        try {
          const o = JSON.parse(j);
          const price = (o && (o.offers && o.offers.price) || o.price);
          const currency = (o && (o.offers && o.offers.priceCurrency) || o.priceCurrency);
          if (price) return { price: cleanNumber(String(price)), raw: String(price), currency };
        } catch(e){}
      }
    } catch(e){}

    // 2) Itemprop
    const item = document.querySelector('[itemprop~=price], [itemprop=price]');
    if (item) {
      const contentAttr = item.getAttribute && item.getAttribute('content');
      const rawVal = (contentAttr != null && contentAttr !== '') ? contentAttr : (item.textContent || item.value || '');
      return { price: cleanNumber(rawVal), raw: rawVal };
    }

    // 3) Common selectors with price-like classes
    const candidates = Array.from(document.querySelectorAll('[class*="price"],[id*="price"],[data-price]'));
    for (const c of candidates) {
      const text = c.textContent || c.getAttribute('content') || c.value || '';
      const m = text.match(/[\$£€¥]\s?[0-9][0-9,\.\s]*/);
      if (m) return { price: cleanNumber(m[0]), raw: m[0] };
      const digits = text.match(/[0-9][0-9,\.]{1,}[0-9]/);
      if (digits) {
        const maybe = digits[0];
        const v = cleanNumber(maybe);
        if (v != null) return { price: v, raw: maybe };
      }
    }

    // If we reach here and found nothing, try a broader search for elements containing currency symbols
    const broader = Array.from(document.querySelectorAll('span,div,li,p'));
    for (const el of broader) {
      const text = el.textContent || '';
      const m = text.match(/[\$£€¥]\s?[0-9][0-9,\.\s]*/);
      if (m) return { price: cleanNumber(m[0]), raw: m[0] };
    }

    // 4) Search entire text for currency patterns
    const bodyText = document.body ? document.body.innerText : document.documentElement.innerText;
    if (bodyText) {
      const m = bodyText.match(/[\$£€¥]\s?[0-9][0-9,\.\s]*/);
      if (m) return { price: cleanNumber(m[0]), raw: m[0] };
      const digits = bodyText.match(/\d{1,3}[,\.\s]\d{2,3}[,\.\d]*/);
      if (digits) return { price: cleanNumber(digits[0]), raw: digits[0] };
    }

    return null;
  }

  function findTitle() {
    // Prefer explicit product title on Amazon and similar sites
    try {
      const prod = document.querySelector('#productTitle');
      if (prod && prod.textContent && prod.textContent.trim()) return prod.textContent.trim();
    } catch (e) {}
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) return og.content;
    const t = document.querySelector('meta[name="twitter:title"]');
    if (t && t.content) return t.content;
    return document.title || null;
  }

  function gatherDebug() {
    const out = { url: location.href, inFrame: window.top !== window.self, title: findTitle(), jsonld: [], itemprop: null, candidates: [], bodyMatch: null };
    // JSON-LD
    Array.from(document.querySelectorAll('script[type="application/ld+json"]')).forEach(s => {
      const txt = s.textContent && s.textContent.trim().slice(0,1000);
      out.jsonld.push(txt);
      try { out.jsonld.push(JSON.parse(s.textContent)); } catch(e) { out.jsonld.push({parseError: e && e.message}); }
    });
    // itemprop
    const ip = document.querySelector('[itemprop~=price],[itemprop=price]');
    if (ip) out.itemprop = { text: (ip.textContent||ip.value||'').trim().slice(0,200), html: ip.outerHTML && ip.outerHTML.slice(0,500) };
    // candidates
    const re = /[$£€¥]/;
    Array.from(document.querySelectorAll('[class*="price"],[id*="price"],[data-price], *')).forEach(el => {
      try {
        const text = (el.textContent||el.getAttribute('content')||el.value||'').trim();
        if (text && re.test(text)) out.candidates.push({ tag: el.tagName.toLowerCase(), class: el.className, id: el.id, text: text.slice(0,500) });
      } catch(e) {}
    });
    // body search
    const bodyText = document.body ? document.body.innerText : (document.documentElement && document.documentElement.innerText) || '';
    const m = bodyText && bodyText.match(/[\$£€¥]\s?[0-9][0-9,\.\s]*/);
    if (m) out.bodyMatch = m[0];
    return out;
  }

  // send debug payload to background for inspection
  function sendDebug() {
    try {
      const payload = gatherDebug();
      browser.runtime.sendMessage({ action: 'pageDebug', debug: payload }).catch(()=>{});
    } catch(e) {}
  }

  // send on load and immediately
  try { sendDebug(); } catch(e){}
  window.addEventListener('load', () => { try { sendDebug(); } catch(e){} });

  // Persist detected price (top-frame only) so popup can read it if messaging fails
  try {
    if (window.top === window.self) {
      const detected = findPrice();
      const title = findTitle();
      if (detected && detected.price != null) {
        try { browser.storage.local.set({ lastDetected: { url: location.href, price: detected.price, raw: detected.raw, title, updatedAt: Date.now() } }); } catch(e) {}
      }
    }
  } catch(e) {}

  browser.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.action === 'getPrice') {
      const p = findPrice();
      const title = findTitle();
      if (p) return Promise.resolve({ price: p.price, raw: p.raw, title });
      // If no price yet, wait briefly for dynamic content (e.g., Amazon) using a MutationObserver
      return new Promise(resolve => {
        let settled = false;
        const tryResolve = () => {
          if (settled) return;
          const q = findPrice();
          if (q) {
            settled = true;
            obs.disconnect();
            resolve({ price: q.price, raw: q.raw, title: findTitle() });
            return true;
          }
          return false;
        };
        const obs = new MutationObserver(() => { tryResolve(); });
        try {
          obs.observe(document, { childList: true, subtree: true, characterData: true });
        } catch (e) {
          // if observe fails, fall back to timeout
        }
        // also try resolving after a short timeout
        setTimeout(() => {
          if (!tryResolve()) {
            settled = true;
            try { obs.disconnect(); } catch(e) {}
            resolve({});
          }
        }, 1200);
      });
    }
    if (msg && msg.action === 'startSelect') {
      // start selection mode and return selector when user clicks
      return new Promise(resolve => {
        let lastEl = null;
        const style = document.createElement('style');
        style.textContent = '.__price_picker_highlight{outline:3px solid rgba(37,99,235,0.9) !important; cursor:crosshair !important}';
        document.head.appendChild(style);

        function getSelector(el) {
          if (!el) return null;
          if (el.id) return '#' + el.id;
          const parts = [];
          let node = el;
          while (node && node.nodeType === 1 && node !== document.body) {
            let name = node.tagName.toLowerCase();
            // include nth-child to make selector unique
            try {
              const parent = node.parentNode;
              if (parent) {
                const children = Array.from(parent.children);
                const idx = children.indexOf(node) + 1;
                name += `:nth-child(${idx})`;
              }
            } catch (e) {}
            parts.unshift(name);
            node = node.parentNode;
          }
          return parts.length ? parts.join(' > ') : null;
        }

        function over(e) {
          const el = e.target;
          if (lastEl && lastEl !== el) lastEl.classList && lastEl.classList.remove('__price_picker_highlight');
          lastEl = el;
          el.classList && el.classList.add('__price_picker_highlight');
          e.stopPropagation();
        }
        function out(e) {
          const el = e.target;
          el.classList && el.classList.remove('__price_picker_highlight');
          e.stopPropagation();
        }
        function clickHandler(e) {
          e.preventDefault(); e.stopPropagation();
          cleanup();
          // If user clicked an offscreen/hidden duplicate (common on Amazon), prefer the visible counterpart
          let clicked = e.target;
          try {
            const cls = clicked.className || '';
            if (typeof cls === 'string' && (/(-offscreen$)|(^|\s)a-offscreen(\s|$)/.test(cls))) {
              // find nearest price-like container and pick the first visible offscreen-like element
              let container = clicked.closest('#corePrice_feature_div, #price, #centerCol, .a-price, .priceToPay, body');
              if (!container) container = document;
              const candidates = Array.from(container.querySelectorAll('[class*="-offscreen"], .a-offscreen'));
              for (const c of candidates) {
                try {
                  const rects = c.getClientRects();
                  if (rects && rects.length && c.offsetWidth > 0 && c.offsetHeight > 0) { clicked = c; break; }
                } catch (err) {}
              }
            }
          } catch (e2) {}

          // Prefer accessible/single-line descendant when clicked element contains multi-line or duplicate parts
          function bestElementForPrice(el) {
            try {
              const currencyRe = /[$£€¥]\s?[0-9]/;
              // prefer aria-label/title if they contain a currency snippet
              const aria = el.getAttribute && el.getAttribute('aria-label');
              if (aria && currencyRe.test(aria)) return { el, raw: aria };
              const titleAttr = el.getAttribute && el.getAttribute('title');
              if (titleAttr && currencyRe.test(titleAttr)) return { el, raw: titleAttr };
              // look for visible descendant elements that contain a single-line currency snippet
              const descendants = Array.from(el.querySelectorAll('*'));
              for (const d of descendants) {
                try {
                  if (!(d.offsetWidth > 0 && d.offsetHeight > 0)) continue;
                  const txt = (d.innerText || d.textContent || '').trim();
                  if (!txt) continue;
                  if (currencyRe.test(txt) && !/\n/.test(txt)) return { el: d, raw: txt };
                } catch (ee) {}
              }
              // fallback to element text if it contains currency
              const txt = (el.innerText || el.textContent || '').trim();
              if (txt && currencyRe.test(txt)) return { el, raw: txt };
            } catch (e) {}
            return { el };
          }

          try {
            const best = bestElementForPrice(clicked);
            if (best && best.el) clicked = best.el;
          } catch (be) {}

          // Build a selector that targets the visible price element or its container
          let sel = getSelector(clicked);
          try {
            const cls = clicked.className || '';
            if (typeof cls === 'string' && (/(-offscreen$)|(^|\s)a-offscreen(\s|$)/.test(cls))) {
              const container = clicked.closest('#corePrice_feature_div, #price, #centerCol, .a-price, .priceToPay, body') || clicked.parentElement;
              if (container) {
                let containerSel = container.id ? ('#' + container.id) : getSelector(container) || null;
                if (containerSel) {
                  // Prefer first visible .a-offscreen within the container
                  sel = containerSel + ' .a-offscreen:first-of-type';
                }
              }
            }
          } catch (se) {}
          const contentAttr = clicked.getAttribute && clicked.getAttribute('content');
          // Prefer accessible labels or visible single-line text; collapse whitespace to a single space
          const ariaLabel = clicked.getAttribute && clicked.getAttribute('aria-label');
          const titleAttr = clicked.getAttribute && clicked.getAttribute('title');
          const rawSource = ariaLabel || titleAttr || ((typeof clicked.innerText === 'string' && clicked.innerText.trim()) ? clicked.innerText : (clicked.textContent || clicked.value || ''));
          const visibleText = String(rawSource).replace(/\s+/g, ' ').trim();
          const rawVal = (contentAttr != null && contentAttr !== '') ? contentAttr : visibleText;
          // Prepare a normalized raw to send to background: prefer first currency match and collapse whitespace
          let sendRaw = String(rawVal || '').trim();
          try {
            const m = sendRaw.match(/[\$£€¥]\s?[0-9][0-9,\.\s]*/);
            if (m && m[0]) sendRaw = m[0].trim();
            sendRaw = sendRaw.replace(/\s+/g, ' ').trim();
          } catch (e) {}
          const priceVal = cleanNumber(rawVal);
          const title = findTitle();
          // send the manual pick result to the background so it can persist even after popup closes
          try {
            browser.runtime.sendMessage({ action: 'manualSelectResult', item: { url: location.href, selector: sel, raw: sendRaw, price: priceVal, title } }).catch(()=>{});
          } catch (e) {}
          resolve({ selector: sel, raw: rawVal, price: priceVal, title });
        }
        function keyHandler(e) {
          if (e.key === 'Escape') { cleanup(); resolve({}); }
        }
        function cleanup() {
          document.removeEventListener('mouseover', over, true);
          document.removeEventListener('mouseout', out, true);
          document.removeEventListener('click', clickHandler, true);
          document.removeEventListener('keydown', keyHandler, true);
          if (lastEl) lastEl.classList && lastEl.classList.remove('__price_picker_highlight');
          style.remove();
        }

        document.addEventListener('mouseover', over, true);
        document.addEventListener('mouseout', out, true);
        document.addEventListener('click', clickHandler, true);
        document.addEventListener('keydown', keyHandler, true);
      });
    }
  });
})();
