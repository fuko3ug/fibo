/**
 * popup.js – Popup UI controller
 *
 * Reads cached data from chrome.storage.local (written by background.js)
 * and renders: gold price, collapsible signal cards (each with notify toggle
 * + min-strength threshold), Fibonacci level grid, and a timeframe selector.
 */

const KEY_RATIOS = new Set([0.382, 0.5, 0.618]);

const REFRESH_DELAY_MS = 2000;

const SIGNAL_DEFS = [
  { id: 'fibonacci',  name: 'Fibonacci',        icon: '📐' },
  { id: 'rsi',        name: 'RSI (14)',          icon: '📊' },
  { id: 'macd',       name: 'MACD',              icon: '📈' },
  { id: 'bollinger',  name: 'Bollinger Bands',   icon: '🎯' },
  { id: 'stochastic', name: 'Stochastic (14)',   icon: '⚡' },
  { id: 'ema_cross',  name: 'EMA Cross (9/21)',  icon: '✂️' },
];

const DEFAULT_SETTINGS = {
  fibonacci  : { notify: true,  threshold: 5  },
  rsi        : { notify: true,  threshold: 10 },
  macd       : { notify: true,  threshold: 5  },
  bollinger  : { notify: true,  threshold: 5  },
  stochastic : { notify: true,  threshold: 10 },
  ema_cross  : { notify: false, threshold: 5  },
};

// Icon map for history entries
const INDICATOR_ICONS = {
  fibonacci: '📐', rsi: '📊', macd: '📈',
  bollinger: '🎯', stochastic: '⚡', ema_cross: '✂️',
};

function fmt(n)      { return n != null ? '$' + n.toFixed(2) : '–'; }
function fmtTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Returns the current market session based on UTC hour. */
function getMarketSession() {
  const h = new Date().getUTCHours();
  if (h >= 22 || h < 7)  return { name: 'Asia',    color: '#FFD700', bg: 'rgba(255,215,0,.12)'   };
  if (h >= 7  && h < 12) return { name: 'Europe',  color: '#58a6ff', bg: 'rgba(88,166,255,.12)'  };
  if (h >= 12 && h < 17) return { name: 'US',      color: '#3fb950', bg: 'rgba(63,185,80,.12)'   };
  return                          { name: 'Overlap', color: '#ff9800', bg: 'rgba(255,152,0,.12)'  };
}

// ─── Interval bar ────────────────────────────────────────────────────────────
function initIntervalBar() {
  chrome.storage.local.get('selectedInterval', ({ selectedInterval = '1h' }) => {
    setActiveInterval(selectedInterval);
  });

  document.querySelectorAll('.interval-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const iv = btn.dataset.interval;
      setActiveInterval(iv);
      // Tell background to switch interval and re-fetch
      chrome.runtime.sendMessage({ type: 'SET_INTERVAL', interval: iv });
      // Show loading while waiting for new data
      document.getElementById('content').innerHTML =
        '<div class="status-msg">⏳ Fetching data…</div>';
      setTimeout(loadData, REFRESH_DELAY_MS);
    });
  });
}

function setActiveInterval(iv) {
  document.querySelectorAll('.interval-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.interval === iv);
  });
}

// ─── Rendering ──────────────────────────────────────────────────────────────
function renderContent({ price, priceChangePct, fib, signals, signalSettings,
                         lastUpdate, fetchError, signalHistory, forecast }) {
  if (fetchError && !price) {
    document.getElementById('content').innerHTML = `
      <div class="error-block">
        ⚠️ Altın verisi alınamadı.<br>
        İnternet bağlantınızı kontrol edin veya birkaç dakika bekleyin.
        <br><br>
        <small style="color:#8b949e">Yahoo Finance erişimi geçici olarak engellenmiş olabilir.</small>
      </div>
      <div class="btn-row" style="padding:12px 16px;display:flex;gap:8px;">
        <button class="btn btn-primary" id="btnChart">Open Chart</button>
        <button class="btn btn-secondary" id="btnRefresh">Retry</button>
      </div>`;
    document.getElementById('btnChart')?.addEventListener('click', () =>
      chrome.tabs.create({ url: chrome.runtime.getURL('chart.html') }));
    document.getElementById('btnRefresh')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'FETCH_NOW' });
      document.getElementById('content').innerHTML =
        '<div class="status-msg">⏳ Yeniden deneniyor…</div>';
      setTimeout(loadData, REFRESH_DELAY_MS);
    });
    return;
  }

  // Merge saved settings with defaults (per signal)
  const cfg = {};
  for (const { id } of SIGNAL_DEFS) {
    cfg[id] = { ...DEFAULT_SETTINGS[id], ...(signalSettings?.[id] || {}) };
  }

  const content = document.getElementById('content');
  let html = '';

  // ── Price block ──────────────────────────────────────────────────────────
  const pct     = priceChangePct ?? 0;
  const pctCls  = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const pctSign = pct > 0 ? '+' : '';
  const session = getMarketSession();

  html += `
    <div class="price-block">
      <div style="display:flex;align-items:flex-start;justify-content:space-between">
        <div>
          <div class="price-label">Gold (XAU/USD)</div>
          <div class="price-value">${fmt(price)}</div>
          <div class="price-change ${pctCls}">${pctSign}${pct.toFixed(2)}%</div>
        </div>
        <div style="text-align:right">
          <span class="session-badge" style="background:${session.bg};color:${session.color};border:1px solid ${session.color}">
            ${session.name} Session
          </span>
          <div class="price-update" style="margin-top:6px">Updated: ${fmtTime(lastUpdate)}</div>
        </div>
      </div>
    </div>`;

  // ── Stats bar (win/loss from history) ─────────────────────────────────────
  html += renderStatsBar(signalHistory);

  // ── Signal consensus ──────────────────────────────────────────────────────
  html += renderConsensus(signals);

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

  // ── Forecast / prediction levels ─────────────────────────────────────────
  if (forecast && forecast.length > 0) {
    const first = forecast[0].price;
    const last  = forecast[forecast.length - 1].price;
    const dir   = last >= first ? '▲' : '▼';
    const dClr  = last >= first ? '#3fb950' : '#f85149';
    html += `<div class="section-title" style="margin-top:2px">📡 Tahmin Seviyeleri</div>`;
    html += `<div style="padding:0 16px 8px">`;
    html += `<div style="font-size:10px;color:#8b949e;margin-bottom:4px">
      ${dir} Genel yön: <span style="color:${dClr};font-weight:600">${last >= first ? 'YUKARI' : 'AŞAĞI'}</span>
      &nbsp;<span style="color:${dClr}">${last >= first ? '+' : ''}${(last - first).toFixed(2)}</span>
    </div>`;
    for (let i = 0; i < forecast.length; i++) {
      const pt   = forecast[i];
      const ts   = new Date(pt.time);
      const lbl  = ts.toLocaleDateString([], { month: 'short', day: 'numeric' })
                 + ' ' + ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const diff = pt.price - (i === 0 ? (price || first) : forecast[i - 1].price);
      const clr  = diff >= 0 ? '#3fb950' : '#f85149';
      html += `
        <div style="display:flex;justify-content:space-between;align-items:center;
                    padding:3px 0;border-bottom:1px solid #21262d;font-size:11px">
          <span style="color:#8b949e;font-size:10px">+${i + 1} bar&ensp;${lbl}</span>
          <span style="color:${clr};font-weight:600">$${pt.price.toFixed(2)}</span>
        </div>`;
    }
    html += `</div>`;
  }

  // ── Signal history ────────────────────────────────────────────────────────
  html += renderHistorySection(signalHistory);

  // ── Buttons ───────────────────────────────────────────────────────────────
  html += `
    <div class="btn-row">
      <button class="btn btn-primary" id="btnChart">📊 Open Chart</button>
      <button class="btn btn-consensus" id="btnConsensus">🧭</button>
      <button class="btn btn-stats" id="btnStats">📈 Stats</button>
      <button class="btn btn-secondary" id="btnRefresh">⟳</button>
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
      if (input) input.disabled = !chk.checked;
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

  // Chart / Refresh / Stats buttons
  document.getElementById('btnChart').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('chart.html') });
  });
  document.getElementById('btnConsensus').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('consensus.html') });
  });
  document.getElementById('btnStats').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('stats.html') });
  });
  document.getElementById('btnRefresh').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'FETCH_NOW' });
    document.getElementById('content').innerHTML =
      '<div class="status-msg">⏳ Yenileniyor…</div>';
    setTimeout(loadData, REFRESH_DELAY_MS);
  });
}

// ─── Stats bar ───────────────────────────────────────────────────────────────
function renderStatsBar(signalHistory) {
  if (!signalHistory || signalHistory.length === 0) return '';

  const wins    = signalHistory.filter(s => s.outcome === 'win').length;
  const losses  = signalHistory.filter(s => s.outcome === 'loss').length;
  const pending = signalHistory.filter(s => s.outcome === 'pending').length;
  const total   = wins + losses;
  const winRate = total > 0 ? Math.round(wins / total * 100) : null;

  return `
    <div class="stats-bar">
      <div class="stat-item">
        <div class="stat-value" style="color:#3fb950">${wins}</div>
        <div class="stat-label">Wins</div>
      </div>
      <div class="stat-divider"></div>
      <div class="stat-item">
        <div class="stat-value" style="color:#f85149">${losses}</div>
        <div class="stat-label">Losses</div>
      </div>
      <div class="stat-divider"></div>
      <div class="stat-item">
        <div class="stat-value" style="color:#58a6ff">${winRate !== null ? winRate + '%' : '–'}</div>
        <div class="stat-label">Win Rate</div>
      </div>
      <div class="stat-divider"></div>
      <div class="stat-item">
        <div class="stat-value" style="color:#8b949e">${pending}</div>
        <div class="stat-label">Pending</div>
      </div>
    </div>`;
}

// ─── Signal consensus bar ─────────────────────────────────────────────────────
function renderConsensus(signals) {
  if (!signals) return '';

  let buys = 0, sells = 0;
  for (const { id } of SIGNAL_DEFS) {
    const t = signals[id]?.type;
    if (t === 'BUY')  buys++;
    if (t === 'SELL') sells++;
  }
  const total = buys + sells;
  if (total === 0) return '';

  const buyPct  = Math.round(buys  / total * 100);
  const sellPct = 100 - buyPct;
  const bias    = buys > sells ? 'BULLISH' : buys < sells ? 'BEARISH' : 'NEUTRAL';
  const bColor  = buys > sells ? '#3fb950' : buys < sells ? '#f85149' : '#8b949e';

  return `
    <div class="consensus-row">
      <span class="consensus-label">🧭 Consensus:</span>
      <div class="consensus-bar">
        <div class="consensus-fill" style="width:${buyPct}%;background:linear-gradient(90deg,#3fb950,#238636)"></div>
      </div>
      <span class="consensus-pct" style="color:${bColor}">${bias}</span>
    </div>`;
}

// ─── Signal history section ───────────────────────────────────────────────────
function renderHistorySection(signalHistory) {
  if (!signalHistory || signalHistory.length === 0) return '';

  const items = signalHistory.slice(0, 25).map(entry => {
    const outcomeIcon = entry.outcome === 'win'  ? '✓' :
                        entry.outcome === 'loss' ? '✗' : '⏳';
    const outcomeCls  = entry.outcome === 'win'  ? 'outcome-win'  :
                        entry.outcome === 'loss' ? 'outcome-loss' : 'outcome-pending';
    const typeCls     = entry.type === 'BUY' ? 'badge-buy' : 'badge-sell';
    const icon        = INDICATOR_ICONS[entry.indicatorId] || '📊';
    const dt          = new Date(entry.time);
    const dateStr     = dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const timeStr     = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    return `
      <div class="history-item">
        <div class="history-outcome ${outcomeCls}">${outcomeIcon}</div>
        <div class="history-info">
          <div class="history-name">${icon} ${entry.indicatorName}</div>
          <div class="history-time">${dateStr} ${timeStr}</div>
        </div>
        <div class="history-right">
          <span class="signal-type-badge ${typeCls}">${entry.type}</span>
          <div class="history-price">${fmt(entry.price)}</div>
          <div class="history-strength">${entry.strength}%</div>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="signals-section" style="border-top:1px solid #21262d">
      <div class="section-title">📜 Signal History</div>
      <div class="history-list">${items}</div>
    </div>`;
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
    ['price', 'priceChangePct', 'fib', 'signals', 'signalSettings',
     'lastUpdate', 'fetchError', 'signalHistory', 'forecast', 'selectedInterval'],
    (data) => {
      if (!data.price && !data.fetchError) {
        document.getElementById('content').innerHTML =
          '<div class="status-msg">⏳ Altın verisi yükleniyor… lütfen bekleyin.</div>';
        return;
      }
      renderContent(data);
    }
  );
}

// Listen for storage changes (background updates while popup is open)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' &&
      (changes.price || changes.signals || changes.fetchError || changes.signalHistory)) {
    // Keep interval bar in sync if interval was changed from elsewhere
    if (changes.selectedInterval) {
      setActiveInterval(changes.selectedInterval.newValue || '1h');
    }
    loadData();
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
initIntervalBar();
loadData();
