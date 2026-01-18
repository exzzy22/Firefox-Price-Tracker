async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

function normalizeStoredRaw(raw) {
  try {
    let s = String(raw || '').trim();
    // prefer first currency-like match to avoid double captures
    const m = s.match(/[\$£€¥]\s?[0-9][0-9,\.\s]*/);
    if (m && m[0]) s = m[0].trim();
    // collapse whitespace to single spaces
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  } catch (e) { return String(raw || ''); }
}

function formatCurrency(price, currency) {
  if (price == null) return '-';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(price); } catch(e) { return price; }
}

// Use background normalization to ensure consistency between pick and recheck

async function showCurrent() {
  const el = document.getElementById('current');
  const tab = await getActiveTab();
  if (!tab) { el.textContent = 'No active tab'; return; }
  // load any stored selector for this URL
  try {
    const st = await browser.storage.local.get('tracked');
    const list = st.tracked || [];
    const existing = list.find(i => i.url && tab.url && i.url.split('#')[0] === tab.url.split('#')[0]);
    if (existing && existing.selector) {
      selectedSelector = existing.selector;
    }
  } catch (e) {}
  try {
    const resp = await browser.tabs.sendMessage(tab.id, { action: 'getPrice' });
    if (!resp || !resp.price) {
      // fallback to storage-detected value
      const st = await browser.storage.local.get('lastDetected');
      const last = st.lastDetected;
      if (last && last.url && last.url.split('#')[0] === tab.url.split('#')[0]) {
        el.textContent = '';
        const titleWrap = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = compactTitle(last.title || tab.title);
        titleWrap.appendChild(strong);
        const priceWrap = document.createElement('div');
        priceWrap.className = 'price';
        priceWrap.textContent = String(last.raw || '');
        el.appendChild(titleWrap);
        el.appendChild(priceWrap);
        return;
      }
      el.textContent = 'No price found on this page';
      return;
    }
    el.textContent = '';
    const titleWrap = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = compactTitle(resp.title || tab.title);
    titleWrap.appendChild(strong);
    const priceWrap = document.createElement('div');
    priceWrap.className = 'price';
    priceWrap.textContent = String(resp.raw || '');
    el.appendChild(titleWrap);
    el.appendChild(priceWrap);
  } catch (e) {
    // try storage fallback
    try {
      const st = await browser.storage.local.get('lastDetected');
      const last = st.lastDetected;
      if (last && last.url && last.url.split('#')[0] === tab.url.split('#')[0]) {
        el.textContent = '';
        const titleWrap = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = compactTitle(last.title || tab.title);
        titleWrap.appendChild(strong);
        const priceWrap = document.createElement('div');
        priceWrap.className = 'price';
        priceWrap.textContent = String(last.raw || '');
        el.appendChild(titleWrap);
        el.appendChild(priceWrap);
        return;
      }
    } catch (e2) {}
    el.textContent = 'Unable to read page (frame or unsupported)';
  }
}

let selectedSelector = null;

// show currently selected selector (if any)
function showSelectorNote() {
  const el = document.getElementById('selectorNote');
  if (!el) return;
  el.textContent = selectedSelector ? ('Using selector: ' + selectedSelector) : '';
}

// Return a compact title suitable for the small popup by stripping common
// site-name suffixes. Heuristic: split on common separators and pick the
// longest segment (usually the product name), fallback to the original.
function compactTitle(fullTitle) {
  if (!fullTitle) return '';
  try {
    const parts = fullTitle.split(/[-–—|:\u00B7]/).map(p=>p.trim()).filter(Boolean);
    if (!parts.length) return fullTitle;
    let longest = parts[0];
    for (const p of parts) if (p.length > longest.length) longest = p;
    return longest;
  } catch (e) { return fullTitle; }
}

async function loadTracked() {
  const data = await browser.storage.local.get('tracked');
  const list = data.tracked || [];
  const container = document.getElementById('list');
  if (!list.length) { container.textContent = '(none)'; return; }
  container.innerHTML = '';
  list.forEach((item, idx) => {
    const d = document.createElement('div');
      d.className = 'item';
      // two-column layout: title | price
      const left = document.createElement('div');
      left.className = 'meta';
      left.style.display = 'flex'; left.style.alignItems = 'center'; left.style.minWidth = '0';
      const title = document.createElement('div'); title.className = 'title'; title.textContent = compactTitle(item.title || item.url); title.style.minWidth = '0';
    left.appendChild(title);

    const right = document.createElement('div'); right.className = 'price-col';
    const price = document.createElement('div'); price.className = 'price';
    // sanitize display: prefer first currency-like match to avoid duplicate strings like "€26.51€26.51"
    try {
      let display = item.lastRaw || (item.lastPrice != null ? String(item.lastPrice) : '');
      if (display) {
        const m = String(display).match(/[\$£€¥]\s?[0-9][0-9,\.\s]*/);
        if (m && m[0]) display = m[0].trim();
      }
      price.textContent = display || item.lastPrice || '';
    } catch (e) { price.textContent = item.lastRaw || item.lastPrice; }
    const actions = document.createElement('div'); actions.className = 'actions';
    const open = document.createElement('button'); open.textContent = 'Open'; open.className = 'secondary';
    open.addEventListener('click', () => { browser.tabs.create({ url: item.url }); });
    const remove = document.createElement('button'); remove.textContent = 'Remove'; remove.className = 'secondary';
    remove.addEventListener('click', async () => {
      const stored = await browser.storage.local.get('tracked');
      const newList = (stored.tracked || []).filter(x => x.url !== item.url);
      await browser.storage.local.set({ tracked: newList });
      loadTracked();
    });
    actions.appendChild(open); actions.appendChild(remove);
    right.appendChild(price); right.appendChild(actions);

    d.appendChild(left); d.appendChild(right);
    container.appendChild(d);
  });
}

async function trackCurrent() {
  const tab = await getActiveTab();
  if (!tab) return;
  let resp;
  try { resp = await browser.tabs.sendMessage(tab.id, { action: 'getPrice' }); } catch(e) { resp = null; }
  if (!resp || !resp.price) {
    // fallback to storage
    const st = await browser.storage.local.get('lastDetected');
    const last = st.lastDetected;
    if (last && last.url && last.url.split('#')[0] === tab.url.split('#')[0]) {
      resp = { price: last.price, raw: last.raw, title: last.title };
    }
  }
  if (!resp || !resp.price) { alert('No price detected on this page.'); return; }
  // normalize using background logic
  let normalizedRaw = resp.raw || '';
  let normalizedPrice = resp.price != null ? resp.price : null;
  try {
    const norm = await browser.runtime.sendMessage({ action: 'normalizePrice', raw: normalizedRaw });
    if (norm) { normalizedRaw = norm.raw; normalizedPrice = norm.price; }
  } catch (e) {}
  // If background normalization failed or returned null price, do a local fallback:
  try {
    const txt = String(normalizedRaw || '');
    const all = txt.match(/[\$£€¥]\s?[0-9][0-9,\.\s]*/g);
    if (all && all.length) {
      // prefer the first currency match (avoid double-capture like "€26.51€26.51")
      normalizedRaw = all[0].trim();
    }
    if (normalizedPrice == null) {
      // local numeric parse
      let norm = String(normalizedRaw).replace(/[^0-9.,\-]/g, '').trim();
      const commaCount = (norm.match(/,/g) || []).length;
      const dotCount = (norm.match(/\./g) || []).length;
      if (commaCount && !dotCount) norm = norm.replace(/,/g, '.');
      else if (commaCount && dotCount && norm.indexOf(',') > norm.indexOf('.')) norm = norm.replace(/\./g, '').replace(/,/g, '.');
      else norm = norm.replace(/,/g, '');
      const v = parseFloat(norm);
      if (isFinite(v)) normalizedPrice = v;
    }
  } catch (e) {}
  // normalize stored raw for consistent comparisons (collapse whitespace, prefer first currency match)
  normalizedRaw = normalizeStoredRaw(normalizedRaw);
  const stored = await browser.storage.local.get('tracked');
  const list = stored.tracked || [];
  const existing = list.find(i => i.url === tab.url);
  const newItem = {
    url: tab.url,
    title: resp.title || tab.title,
    lastPrice: normalizedPrice,
    lastRaw: normalizedRaw,
    updatedAt: Date.now(),
    history: [{ ts: Date.now(), price: normalizedPrice, raw: normalizedRaw }],
    selector: selectedSelector || null,
    // timestamp of last automatic/background check
    lastChecked: Date.now()
  };
  if (existing) {
    existing.lastPrice = newItem.lastPrice;
    existing.lastRaw = newItem.lastRaw;
    existing.updatedAt = newItem.updatedAt;
    existing.history = existing.history || [];
    existing.history.push({ ts: newItem.updatedAt, price: newItem.lastPrice, raw: newItem.lastRaw });
    if (selectedSelector) existing.selector = selectedSelector;
  } else {
    list.push(newItem);
  }
  await browser.storage.local.set({ tracked: list });
  try { browser.runtime.sendMessage({ action: 'logSaved', item: newItem }).catch(()=>{}); } catch(e) {}
  await loadTracked();
  alert('Tracked: ' + newItem.title);
}

document.getElementById('trackBtn').addEventListener('click', trackCurrent);
document.getElementById('pickBtn').addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab) return alert('No active tab');
  try {
    // Start selection in page and close popup immediately so it doesn't get in the way.
    // The content script will send the selection result to background for persistence.
    browser.tabs.sendMessage(tab.id, { action: 'startSelect' }).catch(()=>{});
    window.close();
    return;
  } catch (e) {
    console.warn('selection failed', e);
    alert('Could not start selection (page may be in a different frame or not supported)');
  }
});
document.getElementById('refreshBtn').addEventListener('click', async () => {
  const btn = document.getElementById('refreshBtn');
  const spin = document.getElementById('refreshSpinner');
    try {
      btn.disabled = true;
      spin.style.display = 'inline-block';
      const result = await browser.runtime.sendMessage({ action: 'runCheck', force: true });
      // refresh UI after checks
      await showCurrent();
      await loadTracked();
      // show brief status
      const statusEl = document.getElementById('refreshStatus');
      if (statusEl && result) {
        statusEl.textContent = `Checked ${result.checked || 0} items, skipped ${result.skipped || 0} in ${(result.durationMs||0)/1000 .toFixed(1)}s`;
        setTimeout(()=>{ statusEl.textContent = ''; }, 4000);
      }
    } catch (e) {
      console.warn('runCheck failed', e);
    } finally {
      spin.style.display = 'none';
      btn.disabled = false;
    }
});
document.getElementById('openDetailsBtn').addEventListener('click', () => {
  const url = browser.runtime.getURL('src/details.html');
  browser.tabs.create({ url });
});
document.addEventListener('DOMContentLoaded', () => { showCurrent(); loadTracked(); try { browser.runtime.sendMessage({ action: 'clearBadge' }).catch(()=>{}); } catch(e) {} });
document.addEventListener('DOMContentLoaded', showSelectorNote);
