/**
 * popup.js – Popup UI controller
 *
 * Reads cached data from chrome.storage.local (written by background.js)
 * and renders the current gold price, Fibonacci levels, and last signal.
 */

const KEY_RATIOS = new Set([0.382, 0.5, 0.618]);

// Delay (ms) to wait for background to update storage after a refresh request
const REFRESH_DELAY_MS = 1500;

function fmt(n)   { return n != null ? '$' + n.toFixed(2) : '–'; }
function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderContent({ price, fib, lastSignal, lastUpdate }) {
  const content = document.getElementById('content');

  let html = '';

  // Price
  html += `
    <div class="price-block">
      <div class="price-label">Gold (XAU/USD)</div>
      <div class="price-value">${fmt(price)}</div>
      <div class="price-update">Last update: ${fmtTime(lastUpdate)}</div>
    </div>`;

  // Signal banner
  if (lastSignal) {
    const cls  = lastSignal.type === 'BUY' ? 'buy' : 'sell';
    html += `
      <div class="signal-block ${cls}" style="display:block">
        <div class="signal-badge">${lastSignal.type}</div>
        <div class="signal-msg">${lastSignal.message}</div>
        <div class="signal-time">At ${fmtTime(lastSignal.time)} • proximity ${(lastSignal.proximity * 100).toFixed(2)}%</div>
      </div>`;
  } else {
    html += `<div class="no-signal">⏳ No active reversal signal detected</div>`;
  }

  // Fibonacci levels
  if (fib && fib.levels && fib.levels.length) {
    html += `<div class="section-title">Fibonacci Levels</div>`;
    html += `<div class="fib-grid">`;
    for (const lvl of fib.levels) {
      const isKey = KEY_RATIOS.has(lvl.ratio);
      html += `
        <div class="fib-row${isKey ? ' key' : ''}">
          <span class="fib-label">${lvl.label}</span>
          <span class="fib-price">${fmt(lvl.price)}</span>
        </div>`;
    }
    html += `</div>`;
  }

  // Buttons
  html += `
    <div class="btn-row">
      <button class="btn btn-primary" id="btnChart">Open Chart</button>
      <button class="btn btn-secondary" id="btnRefresh">Refresh</button>
    </div>`;

  content.innerHTML = html;

  document.getElementById('btnChart').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('chart.html') });
  });

  document.getElementById('btnRefresh').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'FETCH_NOW' }, () => {
      // Re-render after a short delay to let background update storage
      setTimeout(loadData, REFRESH_DELAY_MS);
    });
  });
}

function loadData() {
  chrome.storage.local.get(
    ['price', 'fib', 'lastSignal', 'lastUpdate'],
    (data) => {
      if (!data.price) {
        document.getElementById('content').innerHTML =
          '<div class="status-msg">⏳ Fetching gold data… please wait a moment.</div>';
        return;
      }
      renderContent(data);
    }
  );
}

// Listen for storage changes (background updates while popup is open)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.price) loadData();
});

loadData();
