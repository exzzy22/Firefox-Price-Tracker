// Background service worker: periodic checks of tracked URLs
async function parsePriceFromHTML(html, preferredSelector) {
  function cleanNumber(s) {
    if (!s) return null;
    const norm = String(s).replace(/[^0-9.,\-]/g, '').trim();
    if (!norm) return null;
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

  // Try meta JSON-LD (prefer structured data)
  // If a preferred CSS selector is provided, try it first against a parsed DOM
  try {
    if (preferredSelector) {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const el = doc.querySelector(preferredSelector);
        if (el) {
          const contentAttr = el.getAttribute && el.getAttribute('content');
          const rawVal = (contentAttr != null && contentAttr !== '') ? contentAttr : (el.textContent || el.value || '');
          const v = cleanNumber(rawVal);
          if (v != null) return { price: v, raw: rawVal };
        }
      } catch (e) {
        // fall through to other heuristics
      }
    }
  } catch(e) {}
  try {
    const ldMatches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    if (ldMatches) {
      for (const s of ldMatches) {
        const inner = s.replace(/<script[^>]*>([\s\S]*?)<\/script>/i, '$1');
        try {
          const o = JSON.parse(inner);
          // If JSON-LD is an array, iterate
          const objs = Array.isArray(o) ? o : [o];
          for (const obj of objs) {
            // common places for price: offers.price, price, offers.priceSpecification.price, lowPrice
            let price = null;
            if (obj) {
              if (obj.offers && obj.offers.price) price = obj.offers.price;
              if (!price && obj.price) price = obj.price;
              if (!price && obj.offers && obj.offers.priceSpecification && obj.offers.priceSpecification.price) price = obj.offers.priceSpecification.price;
              if (!price && obj.offers && obj.offers.lowPrice) price = obj.offers.lowPrice;
            }
            if (price) {
              const v = cleanNumber(String(price));
              if (v != null) return { price: v, raw: String(price) };
            }
          }
        } catch(e){}
      }
    }
  } catch(e){}

  // Try meta tags and itemprop meta (eg. <meta itemprop="price" content="..."> or product:price:amount)
  try {
    const metaRe = /<meta[^>]*(itemprop|property|name)=["']([^"']+)["'][^>]*content=["']([^"']+)["'][^>]*>/gi;
    let m;
    while ((m = metaRe.exec(html)) !== null) {
      const attr = m[2].toLowerCase();
      const content = m[3];
      if (attr.includes('price') || attr === 'price' || attr === 'product:price:amount' || attr === 'itemprop') {
        const v = cleanNumber(content);
        if (v != null) return { price: v, raw: content };
      }
    }
  } catch(e) {}

  // Fallback: try to regex-find currency patterns in page text (least-preferred)
  const m = html.match(/[\$£€¥]\s?[0-9][0-9,\.\s]*/);
  if (m) {
    const raw = m[0];
    const v = cleanNumber(raw);
    if (v != null) return { price: v, raw };
  }
  return null;
}

async function checkAll(force = false) {
  console.log('RUN CHECK: starting', { force });
  // load global interval (in minutes) from storage; default to 60
  const settings = await browser.storage.local.get('checkIntervalMinutes');
  const globalInterval = Number(settings.checkIntervalMinutes) || 60;
  const stored = await browser.storage.local.get('tracked');
  const list = stored.tracked || [];
  if (!list.length) {
    console.log('RUN CHECK: no tracked items');
    return { checked: 0, skipped: 0, durationMs: 0 };
  }
  const start = Date.now();
  let checked = 0, skipped = 0;
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    // Decide whether to check this item now based on the global interval
    try {
      if (!force) {
        const interval = globalInterval;
        const last = item.lastChecked || item.updatedAt || 0;
        const elapsed = Date.now() - last;
        if (elapsed < interval * 60 * 1000) {
          // skip this item for now
          skipped++;
          continue;
        }
      }
    } catch (e) {
      // if anything goes wrong determining interval, proceed to check
    }
    try {
      const resp = await fetch(item.url, { method: 'GET', mode: 'cors' });
      checked++;
      const text = await resp.text();
      // (no debug capture in production)
      const found = await parsePriceFromHTML(text, item && item.selector ? item.selector : null);
      if (found && typeof found.price === 'number') {
        // Ensure history exists
        item.history = item.history || [];
        // record that we checked this item now
        item.lastChecked = Date.now();

        if (item.lastPrice == null || found.price !== item.lastPrice) {
          const old = item.lastPrice;
          // append history entry only when price is new/changed
          item.history.push({ ts: Date.now(), price: found.price, raw: found.raw });
          // cap history length to avoid unbounded growth
          if (item.history.length > 200) item.history = item.history.slice(-200);
          item.lastPrice = found.price;
          item.lastRaw = found.raw;
          item.updatedAt = Date.now();
          await browser.storage.local.set({ tracked: list });
          // Notify user
          const title = item.title || item.url;
          const body = (old == null) ? `Now ${found.raw}` : `Price changed from ${old} → ${found.raw}`;
          browser.notifications.create('price-change-' + i + '-' + Date.now(), {
            type: 'basic',
            iconUrl: browser.runtime.getURL('icons/icon-128.png'),
            title: `Price update: ${title}`,
            message: body
          });
        } else {
          // Save lastChecked even if price unchanged
          await browser.storage.local.set({ tracked: list });
        }
      }
      } catch (e) {
      // ignore per-item fetch errors
      console.warn('Price check failed for', item.url, e);
    }
  }
  const duration = Date.now() - start;
  console.log('RUN CHECK: done', { checked, skipped, duration });
  return { checked, skipped, durationMs: duration };
}

browser.runtime.onInstalled.addListener(() => {
  // Check every 60 minutes
  browser.alarms.create('checkPrices', { periodInMinutes: 60 });
});

// When Firefox starts, run checks but respect per-item intervals so we don't
// hammer sites on every startup. This ensures checks occur on startup if the
// last check was older than the per-item interval.
if (browser.runtime && browser.runtime.onStartup) {
  browser.runtime.onStartup.addListener(() => {
    checkAll();
  });
}

browser.alarms.onAlarm.addListener(alarm => {
  if (alarm && alarm.name === 'checkPrices') checkAll();
});

// Also expose a message to trigger immediate check
browser.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.action === 'runCheck') {
    // return the promise so senders can await completion and show a loader
    // honor `msg.force` to bypass per-item/global intervals for user-triggered checks
    return checkAll(Boolean(msg.force));
  }
  if (msg.action === 'pageDebug' && msg.debug) {
    // Log debug info from content scripts so developer can inspect in the web-ext terminal
    console.log('PAGE DEBUG:', msg.debug);
  }
});

// (no one-time startup test notification)
