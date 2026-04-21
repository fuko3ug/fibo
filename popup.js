/**
 * popup.js – Popup UI controller
 *
 * Reads cached data from chrome.storage.local (written by background.js)
 * and renders: gold price, collapsible signal cards (each with notify toggle
 * + min-strength threshold), and Fibonacci level grid.
 */

const KEY_RATIOS = new Set([0.382, 0.5, 0.618]);

// Delay (ms) to wait for background to update storage after a refresh request
const REFRESH_DELAY_MS = 1500;

const SIGNAL_DEFS = [
  { id: 'fibonacci',  name: 'Fibonacci',        icon: '📐' },
  { id: 'rsi',        name: 'RSI (14)',          icon: '📊' },
  { id: 'macd',       name: 'MACD',              icon: '📈' },
  { id: 'bollinger',  name: 'Bollinger Bands',   icon: '🎯' },
  { id: 'stochastic', name: 'Stochastic (14)',   icon: '⚡' },
  { id: 'ema_cross',  name: 'EMA Cross (9/21)',  icon: '✂️' },
];

// Default per-signal notification settings
const DEFAULT_SETTINGS = {
  fibonacci  : { notify: true,  threshold: 5  },
  rsi        : { notify: true,  threshold: 10 },
  macd       : { notify: true,  threshold: 5  },
  bollinger  : { notify: true,  threshold: 5  },
  stochastic : { notify: true,  threshold: 10 },
  ema_cross  : { notify: false, threshold: 5  },
};

function fmt(n)      { return n != null ? '$' + n.toFixed(2) : '–'; }
function fmtTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── Rendering ──────────────────────────────────────────────────────────────
function renderContent({ price, fib, signals, signalSettings, lastUpdate }) {
  // Merge saved settings with defaults (per signal)
  const cfg = {};
  for (const { id } of SIGNAL_DEFS) {
    cfg[id] = { ...DEFAULT_SETTINGS[id], ...(signalSettings?.[id] || {}) };
  }

  const content = document.getElementById('content');
  let html = '';

  // ── Price block ──────────────────────────────────────────────────────────
  html += `
    <div class="price-block">
      <div class="price-label">Gold (XAU/USD)</div>
      <div class="price-value">${fmt(price)}</div>
      <div class="price-update">Last update: ${fmtTime(lastUpdate)}</div>
    </div>`;

  // ── Signal cards ─────────────────────────────────────────────────────────
  html += `<div class="signals-section">`;
  html += `<div class="section-title">Signals &amp; Alerts</div>`;

  for (const def of SIGNAL_DEFS) {
    const sig      = signals?.[def.id];
    const type     = sig?.type || null;
    const strength = sig?.strength ?? 0;
    const badgeCls = type === 'BUY' ? 'badge-buy' : type === 'SELL' ? 'badge-sell' : 'badge-neutral';
    const barColor = type === 'BUY' ? '#3fb950' : type === 'SELL' ? '#f85149' : '#8b949e';
    const settings = cfg[def.id];

    html += `
      <div class="signal-card" id="card-${def.id}">
        <div class="signal-card-header" data-id="${def.id}">
          <span class="signal-chevron">▶</span>
          <span class="signal-card-name">${def.icon} ${def.name}</span>
          <span class="signal-type-badge ${badgeCls}">${type || '—'}</span>
        </div>
        <div class="signal-card-body">
          <div class="signal-card-msg">${sig?.message || 'Insufficient data for this indicator.'}</div>
          <div class="strength-row">
            <span class="strength-label">Strength</span>
            <div class="strength-bar-track">
              <div class="strength-bar-fill"
                   style="width:${strength}%;background:${barColor}"></div>
            </div>
            <span class="strength-pct">${strength}%</span>
          </div>
          <div class="notify-row">
            <span class="notify-label">🔔 Notify</span>
            <label class="toggle">
              <input type="checkbox" class="notify-chk" data-id="${def.id}"
                     ${settings.notify ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
            <div class="threshold-row">
              <span class="threshold-lbl">Min:</span>
              <input type="number" class="threshold-input" data-id="${def.id}"
                     min="0" max="100" value="${settings.threshold}"
                     ${!settings.notify ? 'disabled' : ''}>
              <span class="threshold-unit">%</span>
            </div>
          </div>
        </div>
      </div>`;
  }

  html += `</div>`;

  // ── Fibonacci levels grid ─────────────────────────────────────────────────
  if (fib?.levels?.length) {
    html += `<div class="section-title" style="margin-top:2px">Fibonacci Levels</div>`;
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

  // ── Buttons ───────────────────────────────────────────────────────────────
  html += `
    <div class="btn-row">
      <button class="btn btn-primary" id="btnChart">Open Chart</button>
      <button class="btn btn-secondary" id="btnRefresh">Refresh</button>
    </div>`;

  content.innerHTML = html;

  // ── Event wiring ──────────────────────────────────────────────────────────

  // Card expand / collapse
  document.querySelectorAll('.signal-card-header').forEach(header => {
    header.addEventListener('click', () => {
      document.getElementById(`card-${header.dataset.id}`).classList.toggle('open');
    });
  });

  // Auto-expand cards that have an active signal
  if (signals) {
    for (const { id } of SIGNAL_DEFS) {
      if (signals[id]?.type) {
        document.getElementById(`card-${id}`)?.classList.add('open');
      }
    }
  }

  // Notify toggle
  document.querySelectorAll('.notify-chk').forEach(chk => {
    chk.addEventListener('change', () => {
      const id    = chk.dataset.id;
      const input = document.querySelector(`.threshold-input[data-id="${id}"]`);
      input.disabled = !chk.checked;
      saveSignalSetting(id, { notify: chk.checked });
    });
  });

  // Threshold input
  document.querySelectorAll('.threshold-input').forEach(inp => {
    inp.addEventListener('change', () => {
      const id  = inp.dataset.id;
      const val = Math.max(0, Math.min(100, parseFloat(inp.value) || 0));
      inp.value = val;
      saveSignalSetting(id, { threshold: val });
    });
  });

  // Chart / Refresh buttons
  document.getElementById('btnChart').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('chart.html') });
  });
  document.getElementById('btnRefresh').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'FETCH_NOW' }, () => {
      setTimeout(loadData, REFRESH_DELAY_MS);
    });
  });
}

// ─── Storage helpers ─────────────────────────────────────────────────────────
function saveSignalSetting(id, changes) {
  chrome.storage.local.get('signalSettings', ({ signalSettings = {} }) => {
    chrome.storage.local.set({
      signalSettings: {
        ...signalSettings,
        [id]: { ...DEFAULT_SETTINGS[id], ...(signalSettings[id] || {}), ...changes },
      },
    });
  });
}

// ─── Data Loading ─────────────────────────────────────────────────────────────
function loadData() {
  chrome.storage.local.get(
    ['price', 'fib', 'signals', 'signalSettings', 'lastUpdate'],
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
  if (area === 'local' && (changes.price || changes.signals)) loadData();
});

loadData();
