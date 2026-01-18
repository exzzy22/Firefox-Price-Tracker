async function loadDetails() {
  const container = document.getElementById('list');
  
  const data = await browser.storage.local.get('tracked');
  const list = data.tracked || [];
  if (!list.length) { container.textContent = '(none)'; return; }
  container.innerHTML = '';
  // Global settings: check interval for all items - create once and reuse
  let settingsDiv = document.getElementById('global-settings');
  let gInput, gSave;
  if (!settingsDiv) {
    settingsDiv = document.createElement('div');
    settingsDiv.id = 'global-settings';
    settingsDiv.style.marginBottom = '12px';
    settingsDiv.style.display = 'flex';
    settingsDiv.style.alignItems = 'center';
    settingsDiv.style.justifyContent = 'flex-start';
    const gLabel = document.createElement('label'); gLabel.className = 'small'; gLabel.textContent = 'Global check interval (min):';
    gInput = document.createElement('input'); gInput.type = 'number'; gInput.min = '1'; gInput.value = '60'; gInput.style.width = '80px'; gInput.style.padding='4px'; gInput.style.border='1px solid #e6e7eb'; gInput.style.borderRadius='6px'; gInput.style.marginLeft='8px';
    gSave = document.createElement('button'); gSave.textContent = 'Save'; gSave.className = 'secondary'; gSave.style.marginLeft = '8px';
    settingsDiv.appendChild(gLabel); settingsDiv.appendChild(gInput); settingsDiv.appendChild(gSave);
    container.parentNode.insertBefore(settingsDiv, container);
    // load existing global setting
    (async () => {
      const s = await browser.storage.local.get('checkIntervalMinutes');
      if (s.checkIntervalMinutes && gInput) gInput.value = s.checkIntervalMinutes;
    })();
    gSave.addEventListener('click', async () => {
      const val = Math.max(1, Number(gInput.value) || 60);
      await browser.storage.local.set({ checkIntervalMinutes: val });
      gSave.textContent = 'Saved';
      setTimeout(() => { gSave.textContent = 'Save'; }, 1200);
    });
  } else {
    // reuse existing elements
    gInput = settingsDiv.querySelector('input[type=number]');
    gSave = settingsDiv.querySelector('button');
    // refresh displayed value from storage
    (async () => {
      const s = await browser.storage.local.get('checkIntervalMinutes');
      if (s.checkIntervalMinutes && gInput) gInput.value = s.checkIntervalMinutes;
    })();
  }
  for (const item of list) {
    const card = document.createElement('div'); card.className = 'card';

    // Name / title column
    const nameCol = document.createElement('div'); nameCol.className = 'meta';
    const title = document.createElement('a'); title.className = 'title'; title.textContent = item.title || item.url; title.href = '#';
    title.addEventListener('click', (e) => { e.preventDefault(); browser.tabs.create({ url: item.url }); });
    const updated = document.createElement('div'); updated.className = 'small'; updated.textContent = item.updatedAt ? ('Updated: ' + new Date(item.updatedAt).toLocaleString()) : '';
    const lastChecked = document.createElement('div'); lastChecked.className = 'small'; lastChecked.textContent = item.lastChecked ? ('Last checked: ' + new Date(item.lastChecked).toLocaleString()) : '';
    nameCol.appendChild(title); nameCol.appendChild(updated); nameCol.appendChild(lastChecked);

    // Website column
    const siteCol = document.createElement('div'); siteCol.className = 'site';
    const site = document.createElement('div'); site.className = 'small'; site.textContent = item.url;
    siteCol.appendChild(site);

    // Price column
    const priceCol = document.createElement('div'); priceCol.className = 'price-col';
    const price = document.createElement('div');
    // sanitize display: prefer first currency-like match to avoid duplicate strings
    try {
      let display = item.lastRaw || (item.lastPrice != null ? String(item.lastPrice) : '');
      if (display) {
        const m = String(display).match(/[$£€¥]\s?[0-9][0-9,\.\s]*/);
        if (m && m[0]) display = m[0].trim();
      }
      price.textContent = display || item.lastPrice || '';
    } catch (e) { price.textContent = item.lastRaw || item.lastPrice; }
    price.style.fontWeight = '700'; price.style.textAlign = 'center';
    priceCol.appendChild(price);

    // Buttons column
    const btnCol = document.createElement('div'); btnCol.className = 'btn-col'; btnCol.style.display = 'flex'; btnCol.style.flexDirection = 'column'; btnCol.style.gap = '8px';
    const open = document.createElement('button'); open.textContent = 'Open'; open.className = 'btn btn-primary'; open.addEventListener('click', () => { browser.tabs.create({ url: item.url }); });
    const remove = document.createElement('button'); remove.textContent = 'Remove'; remove.className = 'btn btn-light'; remove.addEventListener('click', async () => { const s = await browser.storage.local.get('tracked'); const newList = (s.tracked || []).filter(x => x.url !== item.url); await browser.storage.local.set({ tracked: newList }); loadDetails(); });
    btnCol.appendChild(open); btnCol.appendChild(remove);

    // History column (toggle only)
    const histCol = document.createElement('div'); histCol.className = 'hist-col';
    const historyToggle = document.createElement('button'); historyToggle.textContent = 'Show history'; historyToggle.className = 'btn btn-light'; historyToggle.style.display = 'inline-block';
    histCol.appendChild(historyToggle);

    // assemble card columns
    card.appendChild(nameCol);
    card.appendChild(siteCol);
    card.appendChild(priceCol);
    card.appendChild(btnCol);
    card.appendChild(histCol);

    container.appendChild(card);

    // History container (full width, placed after card)
    const historyContainer = document.createElement('div'); historyContainer.style.display = 'none'; historyContainer.style.margin = '8px 0 12px 0'; historyContainer.style.width = '100%';
    container.appendChild(historyContainer);

    historyToggle.addEventListener('click', () => {
      const nowShown = historyContainer.style.display === 'block';
      historyContainer.style.display = nowShown ? 'none' : 'block';
      historyToggle.textContent = nowShown ? 'Show history' : 'Hide history';
      if (!nowShown) renderHistory();
    });

    // Render history entries
    function renderHistory() {
      historyContainer.innerHTML = '';
      const h = item.history || [];
      if (!h.length) {
        historyContainer.textContent = '(no history)';
        return;
      }
      const listEl = document.createElement('div'); listEl.style.display = 'flex'; listEl.style.flexDirection = 'column'; listEl.style.gap = '4px';
      for (const entry of h.slice().reverse()) {
        const row = document.createElement('div'); row.style.display = 'flex'; row.style.justifyContent = 'space-between'; row.style.fontSize = '13px'; row.style.padding = '6px 8px'; row.style.background = '#fff'; row.style.border = '1px solid #eef2f6'; row.style.borderRadius = '6px';
        const left = document.createElement('div');
        try {
          let display = entry.raw || (entry.price != null ? String(entry.price) : '');
          if (display) {
            const m = String(display).match(/[$£€¥]\s?[0-9][0-9,\.\s]*/);
            if (m && m[0]) display = m[0].trim();
          }
          left.textContent = display || entry.price || '';
        } catch (e) { left.textContent = entry.raw || entry.price; }
        const rightTime = document.createElement('div'); rightTime.className = 'small'; rightTime.style.color = '#6b7280'; rightTime.textContent = entry.ts ? new Date(entry.ts).toLocaleString() : '';
        row.appendChild(left); row.appendChild(rightTime);
        listEl.appendChild(row);
      }
      historyContainer.appendChild(listEl);
    }
  }
}

document.getElementById('refreshBtn').addEventListener('click', async () => {
  const btn = document.getElementById('refreshBtn');
  const spin = document.getElementById('detailsSpinner');
  try {
    btn.disabled = true;
    spin.style.display = 'inline-block';
    const result = await browser.runtime.sendMessage({ action: 'runCheck', force: true });
    await loadDetails();
    const statusEl = document.getElementById('detailsStatus');
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
document.getElementById('closeBtn').addEventListener('click', () => { window.close(); });
document.addEventListener('DOMContentLoaded', loadDetails);
