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

  // Site-specific: Amazon often embeds prices in elements like .a-offscreen
  try {
    if (html && /<[^>]+amazon\./i.test(html) || (typeof preferredSelector === 'string' && preferredSelector.toLowerCase().includes('amazon'))) {
      try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
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
            const el = doc.querySelector(sel);
            if (el) {
              const raw = el.getAttribute && el.getAttribute('content') || el.textContent || el.value || '';
              const v = cleanNumber(raw);
              if (v != null) return { price: v, raw };
            }
          } catch (e) {}
        }
      } catch (e) {}
    }
  } catch (e) {}
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

// Normalize a raw string to a single currency snippet and numeric value.
function normalizePriceString(raw) {
  try {
    const txt = raw == null ? '' : String(raw).trim();
    // first try to find a currency-prefixed match
    const currencyMatch = txt.match(/[\$£€¥]\s?[0-9][0-9,\.\s]*/);
    const firstRaw = (currencyMatch && currencyMatch[0]) ? currencyMatch[0].trim() : (txt.match(/[0-9][0-9,\.]{1,}[0-9]/) || [txt])[0];
    const price = cleanNumber(firstRaw);
    const sym = (txt.match(/[$£€¥]/) || [null])[0];
    return { raw: firstRaw, price, currencySymbol: sym };
  } catch (e) { return { raw: raw, price: null }; }
}

// Produce a canonical string used for comparisons: prefer numeric normalization when possible,
// otherwise collapse whitespace and strip currency symbols.
function canonicalForCompare(raw) {
  try {
    // try central normalizer first
    const n = normalizePriceString(raw || '');
    if (n && typeof n.price === 'number' && isFinite(n.price)) return String(n.price);
  } catch (e) {}
  try {
    // fallback: attempt numeric parse by stripping non-numeric chars and using common comma/dot rules
    let txt = String(raw || '');
    txt = txt.replace(/[^0-9,\.\-]/g, '').trim();
    if (txt) {
      const commaCount = (txt.match(/,/g) || []).length;
      const dotCount = (txt.match(/\./g) || []).length;
      let cleaned = txt;
      if (commaCount && !dotCount) {
        cleaned = txt.replace(/,/g, '.');
      } else if (commaCount && dotCount && txt.indexOf(',') > txt.indexOf('.')) {
        cleaned = txt.replace(/\./g, '').replace(/,/g, '.');
      } else {
        cleaned = txt.replace(/,/g, '');
      }
      const v = parseFloat(cleaned);
      if (isFinite(v)) return String(v);
    }
  } catch (e) {}
  try {
    return String(raw || '').replace(/[$£€¥]/g, '').replace(/\s+/g, ' ').trim();
  } catch (e) { return String(raw || ''); }
}

async function checkAll(force = false) {
  
  // load global interval (in minutes) from storage; default to 60
  const settings = await browser.storage.local.get('checkIntervalMinutes');
  const globalInterval = Number(settings.checkIntervalMinutes) || 60;
  const stored = await browser.storage.local.get('tracked');
  const list = stored.tracked || [];
  if (!list.length) {
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
      if (found) {
        // Ensure history exists
        item.history = item.history || [];
        // record that we checked this item now
        item.lastChecked = Date.now();

        // Always compare the element/text raw string using canonical normalization
        const foundRawTrim = String(found.raw || '').trim();
        const lastRawTrim = String(item.lastRaw || '').trim();
        const normFound = canonicalForCompare(foundRawTrim);
        const normLast = canonicalForCompare(lastRawTrim);
        try {
          const a = normalizePriceString(item.lastRaw || '');
          const b = normalizePriceString(found.raw || '');
        } catch (logErr) {
          // ignore normalize debug errors
        }
        if (normLast !== normFound) {
          // If the canonical comparison differs, double-check numeric equality using the normalizer
          try {
            const a = normalizePriceString(item.lastRaw || '');
            const b = normalizePriceString(found.raw || '');
            const EPS = 0.0001;
            if (a && b && typeof a.price === 'number' && typeof b.price === 'number' && Math.abs(a.price - b.price) <= EPS) {
              // Numeric values equal; standardize stored raw to normalized form but do not notify
              item.lastRaw = b.raw || item.lastRaw;
              if (b.price != null) item.lastPrice = b.price;
              item.updatedAt = Date.now();
              if (item.history && item.history.length && item.history[item.history.length-1] && item.history[item.history.length-1].raw === item.lastRaw) {
                // avoid duplicate history entry
              } else {
                // Optionally update history to include normalized form
                item.history.push({ ts: Date.now(), price: b.price, raw: b.raw });
                if (item.history.length > 200) item.history = item.history.slice(-200);
              }
              await browser.storage.local.set({ tracked: list });
            } else {
              // append history entry only when element/text changed
              item.history.push({ ts: Date.now(), raw: found.raw });
              if (item.history.length > 200) item.history = item.history.slice(-200);
              // store raw and preserve any parsed price if present
              item.lastRaw = found.raw;
              if (found.price != null) item.lastPrice = found.price;
              item.updatedAt = Date.now();
              await browser.storage.local.set({ tracked: list });
              // Notify user using raw string change
              const title = item.title || item.url;
              const body = (lastRawTrim === '') ? `Now ${found.raw}` : `Price changed from ${lastRawTrim} → ${found.raw}`;
              browser.notifications.create('price-change-' + i + '-' + Date.now(), {
                type: 'basic',
                iconUrl: browser.runtime.getURL('icons/icon-128.png'),
                title: `Price update: ${title}`,
                message: body
              });
            }
          } catch (e) {
            // fallback: treat as change
            item.history.push({ ts: Date.now(), raw: found.raw });
            if (item.history.length > 200) item.history = item.history.slice(-200);
            item.lastRaw = found.raw;
            if (found.price != null) item.lastPrice = found.price;
            item.updatedAt = Date.now();
            await browser.storage.local.set({ tracked: list });
            const title = item.title || item.url;
            const body = (lastRawTrim === '') ? `Now ${found.raw}` : `Price changed from ${lastRawTrim} → ${found.raw}`;
            browser.notifications.create('price-change-' + i + '-' + Date.now(), {
              type: 'basic',
              iconUrl: browser.runtime.getURL('icons/icon-128.png'),
              title: `Price update: ${title}`,
              message: body
            });
          }
        } else {
          // Save lastChecked even if price/text unchanged
          await browser.storage.local.set({ tracked: list });
        }
      }
      } catch (e) {
      // ignore per-item fetch errors
      console.warn('Price check failed for', item.url, e);
    }
  }
  const duration = Date.now() - start;
  return { checked, skipped, durationMs: duration };
}

browser.runtime.onInstalled.addListener(() => {
  // Check every 60 minutes
  browser.alarms.create('checkPrices', { periodInMinutes: 60 });
  // Normalize stored tracked items on install/update
  try { migrateStoredTracked().catch(()=>{}); } catch(e) {}
});

// When Firefox starts, run checks but respect per-item intervals so we don't
// hammer sites on every startup. This ensures checks occur on startup if the
// last check was older than the per-item interval.
if (browser.runtime && browser.runtime.onStartup) {
  browser.runtime.onStartup.addListener(() => {
    checkAll();
    // ensure stored tracked items are normalized on startup
    try { migrateStoredTracked().catch(()=>{}); } catch(e) {}
  });
}

browser.alarms.onAlarm.addListener(alarm => {
  if (alarm && alarm.name === 'checkPrices') checkAll();
});

// Also expose a message to trigger immediate check
browser.runtime.onMessage.addListener(async (msg) => {
  if (!msg) return;
  if (msg.action === 'runCheck') {
    // return the promise so senders can await completion and show a loader
    // honor `msg.force` to bypass per-item/global intervals for user-triggered checks
    return checkAll(Boolean(msg.force));
  }
  if (msg.action === 'normalizePrice') {
    try {
      const res = normalizePriceString(msg.raw);
      return res;
    } catch (e) { return { raw: msg.raw, price: null }; }
  }
  if (msg.action === 'manualSelectResult' && msg.item) {
    try {
      const it = msg.item;
      // ensure tracked list exists
      const s = await browser.storage.local.get('tracked');
      const list = s.tracked || [];
      // Use the central normalizer so manual picks and background checks parse formats identically
      const norm = normalizePriceString(it.raw || '');
      const newItem = {
        url: it.url || '',
        title: it.title || it.url || '',
        lastPrice: (typeof norm.price === 'number') ? norm.price : (it.price != null ? it.price : null),
        lastRaw: norm.raw || String(it.raw || ''),
        updatedAt: Date.now(),
        history: [{ ts: Date.now(), price: (typeof norm.price === 'number' ? norm.price : it.price), raw: norm.raw || it.raw }],
        selector: it.selector || null,
        lastChecked: Date.now()
      };
      const existing = list.find(i => i.url === newItem.url);
      if (existing) {
        existing.lastPrice = newItem.lastPrice;
        existing.lastRaw = newItem.lastRaw;
        existing.updatedAt = newItem.updatedAt;
        existing.history = existing.history || [];
        existing.history.push({ ts: newItem.updatedAt, price: newItem.lastPrice, raw: newItem.lastRaw });
        existing.selector = newItem.selector;
      } else {
        list.push(newItem);
      }
      await browser.storage.local.set({ tracked: list });
    } catch (e) { console.warn('Failed to save manual pick', e); }
  }
  if (msg.action === 'logSaved' && msg.item) {
    // no-op for saved logging in production
  }
  if (msg.action === 'pageDebug' && msg.debug) {
    // ignore page debug in production
  }
});

// Migrate existing stored tracked items to normalized lastRaw/lastPrice and history entries.
async function migrateStoredTracked() {
  try {
    const flag = await browser.storage.local.get('normalizedV1');
    if (flag && flag.normalizedV1) return;
    const s = await browser.storage.local.get('tracked');
    const list = s.tracked || [];
    let changed = false;
    for (const item of list) {
      const norm = normalizePriceString(item.lastRaw || (item.lastPrice != null ? String(item.lastPrice) : ''));
      if (norm) {
        if (item.lastRaw !== norm.raw || item.lastPrice !== norm.price) {
          item.lastRaw = norm.raw;
          item.lastPrice = norm.price;
          changed = true;
        }
      }
      if (Array.isArray(item.history)) {
        for (const h of item.history) {
          const hn = normalizePriceString(h.raw || (h.price != null ? String(h.price) : ''));
          if (hn) {
            if (h.raw !== hn.raw || h.price !== hn.price) {
              h.raw = hn.raw;
              h.price = hn.price;
              changed = true;
            }
          }
        }
      }
    }
    if (changed) {
      await browser.storage.local.set({ tracked: list });
    }
    await browser.storage.local.set({ normalizedV1: true });
  } catch (e) {
    console.warn('MIGRATION failed', e);
  }
}

// (no one-time startup test notification)
