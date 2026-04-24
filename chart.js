/**
 * chart.js – Chart page renderer
 *
 * Reads candle data, Fibonacci levels, forecast, and signal from
 * chrome.storage.local (populated by background.js) and renders
 * a full candlestick chart with Fibonacci overlay and forecast line
 * on an HTML5 Canvas element.
 */

// ─── Constants ──────────────────────────────────────────────────────────────
const KEY_RATIOS = new Set([0.382, 0.5, 0.618]);
// Must match OUTCOME_CANDLES in background.js
const OUTCOME_CANDLES = 5;
// Fallback candle duration used when intervalMs is absent (1 hour in ms)
const DEFAULT_CANDLE_MS = 3_600_000;

const FIB_COLORS = {
  0     : { color: '#8b949e', alpha: 0.40 },
  0.236 : { color: '#6e7681', alpha: 0.35 },
  0.382 : { color: '#ff9800', alpha: 0.70 },
  0.5   : { color: '#FFD700', alpha: 0.80 },
  0.618 : { color: '#ff9800', alpha: 0.70 },
  0.786 : { color: '#6e7681', alpha: 0.35 },
  1.0   : { color: '#8b949e', alpha: 0.40 },
};

// Padding inside the canvas (px)
const PAD = { top: 20, right: 80, bottom: 50, left: 80 };

// Delay (ms) to wait for background to update storage after a refresh request
const REFRESH_DELAY_MS = 1500;

// ─── State ──────────────────────────────────────────────────────────────────
let state = { candles: [], fib: null, forecast: [], signal: null, signals: {}, price: null, signalHistory: [], selectedInterval: '1h' };
let canvas, ctx;
let crosshairX = null;
let crosshairY = null;

// ─── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  canvas = document.getElementById('chartCanvas');
  ctx    = canvas.getContext('2d');

  // Resize canvas to match CSS size
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width  = rect.width  * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    render();
  }

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  // Crosshair
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    crosshairX = e.clientX - rect.left;
    crosshairY = e.clientY - rect.top;
    render();
    showTooltip(e);
  });
  canvas.addEventListener('mouseleave', () => {
    crosshairX = null;
    crosshairY = null;
    render();
    document.getElementById('tooltip').style.display = 'none';
  });

  // Refresh button
  document.getElementById('btnRefresh').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'FETCH_NOW' });
    setTimeout(loadData, REFRESH_DELAY_MS);
  });

  // Listen for storage changes while the page is open
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.candles) loadData();
  });

  loadData();
});

// ─── Data Loading ────────────────────────────────────────────────────────────
function loadData() {
  chrome.storage.local.get(
    ['candles', 'fib', 'forecast', 'lastSignal', 'signals', 'price', 'signalHistory', 'selectedInterval'],
    (data) => {
      if (!data.candles || data.candles.length === 0) {
        // Data not ready yet – retry
        setTimeout(loadData, REFRESH_DELAY_MS);
        return;
      }

      state.candles          = data.candles       || [];
      state.fib              = data.fib           || null;
      state.forecast         = data.forecast      || [];
      state.signal           = data.lastSignal    || null;
      state.signals          = data.signals       || {};
      state.price            = data.price         || null;
      state.signalHistory    = data.signalHistory || [];
      state.selectedInterval = data.selectedInterval || '1h';

      document.getElementById('loading').style.display = 'none';

      updateTopBar();
      updateSignalBar();
      updateSidebar();
      render();
    }
  );
}

// ─── Top Bar ─────────────────────────────────────────────────────────────────
function updateTopBar() {
  const el = document.getElementById('topPrice');
  if (state.price != null) el.textContent = '$' + state.price.toFixed(2);
}

// ─── Signal Bar ───────────────────────────────────────────────────────────────
function updateSignalBar() {
  const bar = document.getElementById('signalBar');
  const sig = state.signal;
  if (!sig) { bar.style.display = 'none'; return; }

  bar.className = `signal-bar ${sig.type === 'BUY' ? 'buy' : 'sell'}`;
  bar.innerHTML =
    `${sig.type === 'BUY' ? '🟢' : '🔴'} <strong>${sig.type} Signal</strong> – ${sig.message}`;
  bar.style.display = 'block';
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function updateSidebar() {
  updateFibTable();
  updateSignalPanel();
  updateAllSignalsPanel();
  updateForecastPanel();
  updateHistoryPanel();
}

function updateFibTable() {
  const tbody = document.querySelector('#fibTable tbody');
  if (!state.fib || !state.fib.levels) { tbody.innerHTML = '<tr><td colspan="2" style="color:#8b949e">N/A</td></tr>'; return; }

  tbody.innerHTML = state.fib.levels.map(lvl => {
    const isKey  = KEY_RATIOS.has(lvl.ratio);
    const cfg    = FIB_COLORS[lvl.ratio] || { color: '#8b949e' };
    const dot    = `<span class="fib-dot" style="background:${cfg.color}"></span>`;
    return `<tr${isKey ? ' class="key"' : ''}>
      <td class="lbl">${dot}${lvl.label}</td>
      <td class="prc">$${lvl.price.toFixed(2)}</td>
    </tr>`;
  }).join('');
}

function updateSignalPanel() {
  const panel = document.getElementById('signalPanel');
  const sig   = state.signal;

  if (!sig) {
    panel.className  = 'signal-panel';
    panel.innerHTML  = '<div class="signal-detail">No active signal</div>';
    return;
  }

  const cls = sig.type === 'BUY' ? 'buy' : 'sell';
  panel.className = `signal-panel ${cls}`;
  panel.innerHTML = `
    <div class="signal-type">${sig.type === 'BUY' ? '▲ BUY' : '▼ SELL'} Signal</div>
    <div class="signal-detail">
      Price: <strong>$${sig.price.toFixed(2)}</strong><br>
      Fib level: <strong>${(sig.fibRatio * 100).toFixed(1)}% ($${sig.fibPrice.toFixed(2)})</strong><br>
      Proximity: <strong>${(sig.proximity * 100).toFixed(2)}%</strong><br>
      Time: ${new Date(sig.time).toLocaleTimeString()}
    </div>`;
}

function updateAllSignalsPanel() {
  const el = document.getElementById('allSignals');
  if (!el) return;

  const defs = [
    { id: 'fibonacci',  name: 'Fibonacci'      },
    { id: 'rsi',        name: 'RSI (14)'        },
    { id: 'macd',       name: 'MACD'            },
    { id: 'bollinger',  name: 'Bollinger'       },
    { id: 'stochastic', name: 'Stochastic'      },
    { id: 'ema_cross',  name: 'EMA Cross (9/21)'},
  ];

  if (!state.signals || Object.keys(state.signals).length === 0) {
    el.innerHTML = '<div style="color:#8b949e;font-size:11px">No signal data yet.</div>';
    return;
  }

  el.innerHTML = defs.map(({ id, name }) => {
    const sig      = state.signals[id];
    const type     = sig?.type || null;
    const strength = sig?.strength ?? 0;
    const cls      = type === 'BUY' ? 'pill-buy' : type === 'SELL' ? 'pill-sell' : 'pill-neutral';
    return `
      <div class="signal-pill" title="${sig?.message || ''}">
        <span class="signal-pill-name">${name}</span>
        <span class="signal-pill-badge ${cls}">${type || '—'}</span>
        <span class="signal-pill-str">${strength}%</span>
      </div>`;
  }).join('');
}


function updateForecastPanel() {
  const el = document.getElementById('forecastInfo');
  const fc = state.forecast;

  if (!fc || fc.length === 0) { el.textContent = 'Insufficient data'; return; }

  const first     = fc[0].price;
  const last      = fc[fc.length - 1].price;
  const dir       = last > first ? '▲ Upward' : '▼ Downward';
  const color     = last > first ? '#3fb950' : '#f85149';

  // Format each forecast point with its target price and date
  const rows = fc.map((pt, i) => {
    const ts  = new Date(pt.time);
    const lbl = ts.toLocaleDateString([], { month: 'short', day: 'numeric' })
              + ' ' + ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const diff = pt.price - (i === 0 ? state.price || first : fc[i - 1].price);
    const dColor = diff >= 0 ? '#3fb950' : '#f85149';
    return `<div style="display:flex;justify-content:space-between;align-items:center;
                        padding:2px 0;border-bottom:1px solid #21262d;font-size:10px">
      <span style="color:#8b949e;font-size:9px">+${i + 1} bar · ${lbl}</span>
      <span class="forecast-target" style="color:${dColor}">$${pt.price.toFixed(2)}</span>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div style="margin-bottom:6px">
      Yön: <span style="color:${color};font-weight:600">${dir}</span>&nbsp;
      <span style="color:#8b949e;font-size:10px">${(last - first >= 0 ? '+' : '')}${(last - first).toFixed(2)}</span>
    </div>
    ${rows}`;
}

function updateHistoryPanel() {
  const el = document.getElementById('histList');
  if (!el) return;

  const history = state.signalHistory;
  if (!history || history.length === 0) {
    el.innerHTML = '<div style="color:#8b949e;font-size:11px">No history yet.</div>';
    return;
  }

  const ICONS = {
    fibonacci: '📐', rsi: '📊', macd: '📈',
    bollinger: '🎯', stochastic: '⚡', ema_cross: '✂️',
  };

  el.innerHTML = history.slice(0, 15).map(entry => {
    const outcomeIcon = entry.outcome === 'win'  ? '✓' :
                        entry.outcome === 'loss' ? '✗' : '⏳';
    const outcomeCls  = entry.outcome === 'win'  ? 'ho-win'  :
                        entry.outcome === 'loss' ? 'ho-loss' : 'ho-pending';
    const typeCls     = entry.type === 'BUY' ? 'pill-buy' : 'pill-sell';
    const icon        = ICONS[entry.indicatorId] || '📊';
    const time        = new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    return `
      <div class="hist-item">
        <div class="hist-outcome ${outcomeCls}">${outcomeIcon}</div>
        <span class="hist-name">${icon} ${entry.indicatorName}</span>
        <span class="hist-badge ${typeCls}">${entry.type}</span>
        <span style="font-size:9px;color:#8b949e;flex-shrink:0">${time}</span>
      </div>`;
  }).join('');
}

// ─── Canvas Rendering ─────────────────────────────────────────────────────────
function render() {
  if (!canvas || !ctx) return;

  const dpr    = window.devicePixelRatio || 1;
  const W      = canvas.width  / dpr;
  const H      = canvas.height / dpr;

  ctx.clearRect(0, 0, W, H);
  drawBackground(W, H);

  if (!state.candles || state.candles.length === 0) {
    drawPlaceholder(W, H);
    return;
  }

  // Build combined price series (candles + forecast) for Y scale
  const allCandles = state.candles;
  const forecast   = state.forecast || [];

  const allPrices = [
    ...allCandles.flatMap(c => [c.high, c.low]),
    ...forecast.map(f => f.price),
  ];
  const minP = Math.min(...allPrices);
  const maxP = Math.max(...allPrices);
  const priceRange = maxP - minP || 1;
  const padding    = priceRange * 0.06;

  const yMin = minP - padding;
  const yMax = maxP + padding;

  // Chart area (CSS pixels)
  const chartL = PAD.left;
  const chartR = W - PAD.right;
  const chartT = PAD.top;
  const chartB = H - PAD.bottom;
  const chartW = chartR - chartL;
  const chartH = chartB - chartT;

  // Y helpers
  const yScale = (price) => chartB - ((price - yMin) / (yMax - yMin)) * chartH;

  // X helpers
  const totalBars  = allCandles.length + forecast.length;
  const barWidth   = Math.max(3, chartW / totalBars);
  const xForIndex  = (i) => chartL + (i + 0.5) * (chartW / totalBars);

  // Draw grid + axes
  drawGrid(ctx, W, H, chartL, chartR, chartT, chartB, yMin, yMax, yScale);
  drawXAxis(ctx, allCandles, forecast, chartL, chartB, chartW, totalBars);

  // Draw Fibonacci levels (behind candles)
  if (state.fib && state.fib.levels) {
    drawFibLevels(ctx, state.fib.levels, chartL, chartR, chartT, chartB, yScale);
  }

  // Draw forecast line
  if (forecast.length > 0) {
    const lastClose = allCandles[allCandles.length - 1].close;
    drawForecast(ctx, allCandles.length, forecast, xForIndex, yScale, lastClose);
  }

  // Draw candles
  drawCandles(ctx, allCandles, xForIndex, yScale, barWidth);

  // Draw historical signal outcome markers (✓ / ✗)
  if (state.signalHistory && state.signalHistory.length > 0) {
    drawHistoricalSignals(ctx, state.signalHistory, allCandles, xForIndex, yScale);
    // Draw entry→exit price segments for resolved signals
    drawSignalPriceLines(ctx, state.signalHistory, allCandles, xForIndex, yScale, chartL, chartR);
  }

  // Draw signal marker
  if (state.signal) {
    const sigIndex = allCandles.findLastIndex(c => c.time <= state.signal.time);
    if (sigIndex >= 0) {
      drawSignalMarker(ctx, sigIndex, allCandles[sigIndex], state.signal, xForIndex, yScale, barWidth);
    }
  }

  // Draw Y-axis price labels
  drawYAxis(ctx, W, H, chartR, chartT, chartB, yMin, yMax, yScale);

  // Crosshair
  if (crosshairX != null && crosshairX >= chartL && crosshairX <= chartR) {
    drawCrosshair(ctx, crosshairX, crosshairY, chartT, chartB, chartL, chartR,
                  allCandles, forecast, xForIndex, chartW, totalBars, yScale, yMin, yMax);
  }
}

// ─── Drawing Helpers ──────────────────────────────────────────────────────────
function drawBackground(W, H) {
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, W, H);
}

function drawPlaceholder(W, H) {
  ctx.fillStyle = '#8b949e';
  ctx.font = '14px Segoe UI, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Loading chart data…', W / 2, H / 2);
}

function drawGrid(ctx, W, H, cL, cR, cT, cB, yMin, yMax, yScale) {
  const steps = 6;
  ctx.strokeStyle = '#21262d';
  ctx.lineWidth   = 1;

  for (let i = 0; i <= steps; i++) {
    const price = yMin + (i / steps) * (yMax - yMin);
    const y     = yScale(price);
    ctx.beginPath();
    ctx.moveTo(cL, y);
    ctx.lineTo(cR, y);
    ctx.stroke();
  }

  // Border
  ctx.strokeStyle = '#30363d';
  ctx.strokeRect(cL, cT, cR - cL, cB - cT);
}

function drawYAxis(ctx, W, H, cR, cT, cB, yMin, yMax, yScale) {
  const steps = 6;
  ctx.fillStyle  = '#8b949e';
  ctx.font       = '11px Segoe UI, system-ui, sans-serif';
  ctx.textAlign  = 'left';

  for (let i = 0; i <= steps; i++) {
    const price = yMin + (i / steps) * (yMax - yMin);
    const y     = yScale(price);
    ctx.fillText('$' + price.toFixed(1), cR + 6, y + 4);
  }
}

function drawXAxis(ctx, candles, forecast, cL, cB, chartW, totalBars) {
  ctx.fillStyle  = '#8b949e';
  ctx.font       = '10px Segoe UI, system-ui, sans-serif';
  ctx.textAlign  = 'center';

  // Show ~8 time labels
  const step = Math.max(1, Math.floor(candles.length / 8));
  for (let i = 0; i < candles.length; i += step) {
    const x  = cL + (i + 0.5) * (chartW / totalBars);
    const ts = new Date(candles[i].time);
    const lbl = ts.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
                ' ' + ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    ctx.save();
    ctx.translate(x, cB + 16);
    ctx.rotate(-Math.PI / 6);
    ctx.fillText(lbl, 0, 0);
    ctx.restore();
  }
}

function drawFibLevels(ctx, levels, cL, cR, cT, cB, yScale) {
  for (const lvl of levels) {
    const y   = yScale(lvl.price);
    if (y < cT || y > cB) continue;

    const cfg = FIB_COLORS[lvl.ratio] || { color: '#8b949e', alpha: 0.4 };

    // Filled band between adjacent levels (very subtle)
    ctx.globalAlpha = 0.06;
    ctx.fillStyle   = cfg.color;
    // (bands are optional – skip for clarity)

    ctx.globalAlpha = cfg.alpha;
    ctx.strokeStyle = cfg.color;
    ctx.lineWidth   = KEY_RATIOS.has(lvl.ratio) ? 1.5 : 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(cL, y);
    ctx.lineTo(cR, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Label on the right side
    ctx.fillStyle = cfg.color;
    ctx.globalAlpha = Math.min(1, cfg.alpha + 0.2);
    ctx.font      = KEY_RATIOS.has(lvl.ratio) ? 'bold 11px Segoe UI,sans-serif' : '10px Segoe UI,sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(lvl.label, cL - 4, y + 4);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  }
}

function drawForecast(ctx, candleCount, forecast, xForIndex, yScale, lastClose) {
  if (forecast.length === 0) return;

  ctx.save();
  ctx.strokeStyle = '#58a6ff';
  ctx.lineWidth   = 2;
  ctx.setLineDash([6, 4]);
  ctx.globalAlpha = 0.85;

  ctx.beginPath();
  // Connect last candle close to first forecast point
  ctx.moveTo(xForIndex(candleCount - 1), yScale(lastClose));

  for (let i = 0; i < forecast.length; i++) {
    ctx.lineTo(xForIndex(candleCount + i), yScale(forecast[i].price));
  }
  ctx.stroke();

  // Dots on forecast points
  ctx.setLineDash([]);
  ctx.fillStyle = '#58a6ff';
  for (let i = 0; i < forecast.length; i++) {
    ctx.beginPath();
    ctx.arc(xForIndex(candleCount + i), yScale(forecast[i].price), 3, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawCandles(ctx, candles, xForIndex, yScale, barW) {
  const bodyW = Math.max(2, barW * 0.65);

  for (let i = 0; i < candles.length; i++) {
    const c       = candles[i];
    const x       = xForIndex(i);
    const bullish = c.close >= c.open;
    const color   = bullish ? '#26a69a' : '#ef5350';

    ctx.strokeStyle = color;
    ctx.fillStyle   = bullish ? color : color;
    ctx.lineWidth   = 1;

    const openY  = yScale(c.open);
    const closeY = yScale(c.close);
    const highY  = yScale(c.high);
    const lowY   = yScale(c.low);

    // Wick
    ctx.beginPath();
    ctx.moveTo(x, highY);
    ctx.lineTo(x, lowY);
    ctx.stroke();

    // Body
    const bodyTop = Math.min(openY, closeY);
    const bodyH   = Math.max(1, Math.abs(openY - closeY));
    ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyH);
  }
}

function drawSignalMarker(ctx, idx, candle, signal, xForIndex, yScale, barW) {
  const x      = xForIndex(idx);
  const isBuy  = signal.type === 'BUY';
  const price  = isBuy ? candle.low : candle.high;
  const y      = yScale(price) + (isBuy ? 12 : -12);
  const size   = 8;

  ctx.save();
  ctx.fillStyle = isBuy ? '#3fb950' : '#f85149';
  ctx.strokeStyle = '#0d1117';
  ctx.lineWidth   = 1;

  // Triangle
  ctx.beginPath();
  if (isBuy) {
    ctx.moveTo(x, y - size);
    ctx.lineTo(x + size * 0.7, y + size * 0.5);
    ctx.lineTo(x - size * 0.7, y + size * 0.5);
  } else {
    ctx.moveTo(x, y + size);
    ctx.lineTo(x + size * 0.7, y - size * 0.5);
    ctx.lineTo(x - size * 0.7, y - size * 0.5);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Glow ring
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  ctx.arc(x, y, size * 1.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Label
  ctx.fillStyle  = '#e6edf3';
  ctx.font       = 'bold 10px Segoe UI, sans-serif';
  ctx.textAlign  = 'center';
  ctx.fillText(signal.type, x, isBuy ? y + size + 12 : y - size - 4);

  ctx.restore();
}

/**
 * Draws ✓ (win) or ✗ (loss) markers for each resolved historical signal.
 * Pending signals are skipped – they show no marker until evaluated.
 */

/** Returns the candle array index for a given timestamp.
 *  Uses the pre-built time→index map for O(1) lookup and falls back to a
 *  linear scan when the exact timestamp is absent.
 */
function findCandleIndex(time, candles, timeToIdx) {
  let idx = timeToIdx.get(time);
  if (idx !== undefined) return idx;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].time >= time) return i;
  }
  return -1;
}

function drawHistoricalSignals(ctx, signalHistory, candles, xForIndex, yScale) {
  if (!signalHistory || signalHistory.length === 0) return;

  // Build a time→index map for O(1) candle lookup
  const timeToIdx = new Map();
  for (let i = 0; i < candles.length; i++) {
    timeToIdx.set(candles[i].time, i);
  }

  for (const entry of signalHistory) {
    if (entry.outcome === 'pending') continue;

    const idx = findCandleIndex(entry.time, candles, timeToIdx);
    if (idx < 0 || idx >= candles.length) continue;

    const c     = candles[idx];
    const isBuy = entry.type === 'BUY';
    const isWin = entry.outcome === 'win';
    const x     = xForIndex(idx);
    const baseY = yScale(isBuy ? c.low : c.high);
    const y     = baseY + (isBuy ? 22 : -22);

    ctx.save();

    // Subtle circle background
    ctx.globalAlpha = 0.85;
    ctx.fillStyle   = isWin ? 'rgba(63,185,80,0.2)' : 'rgba(248,81,73,0.2)';
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fill();

    // Draw ✓ or ✗
    ctx.globalAlpha    = 1;
    ctx.fillStyle      = isWin ? '#3fb950' : '#f85149';
    ctx.font           = 'bold 10px Segoe UI, sans-serif';
    ctx.textAlign      = 'center';
    ctx.textBaseline   = 'middle';
    ctx.fillText(isWin ? '✓' : '✗', x, y);

    ctx.restore();
  }
}

/**
 * For each resolved signal in history: draw a horizontal line from the entry
 * price to the outcome candle's position, with dots and price labels at both
 * ends – like a number-line segment on the price axis.
 */
function drawSignalPriceLines(ctx, signalHistory, candles, xForIndex, yScale, chartL, chartR) {
  if (!signalHistory || signalHistory.length === 0) return;

  // Map candle times for quick lookup
  const timeToIdx = new Map();
  for (let i = 0; i < candles.length; i++) timeToIdx.set(candles[i].time, i);

  for (const entry of signalHistory) {
    if (entry.outcome === 'pending' || entry.outcomePrice == null) continue;

    // Find entry candle
    const entryIdx = findCandleIndex(entry.time, candles, timeToIdx);
    if (entryIdx < 0 || entryIdx >= candles.length) continue;
    const deadline = entry.outcomeDeadline || (entry.time + OUTCOME_CANDLES * (entry.intervalMs || DEFAULT_CANDLE_MS));
    const exitIdx  = Math.max(0, (() => {
      const i = candles.findIndex(c => c.time >= deadline);
      return i < 0 ? candles.length - 1 : i;
    })());

    const isWin    = entry.outcome === 'win';
    const isBuy    = entry.type   === 'BUY';
    const color    = isWin ? '#3fb950' : '#f85149';
    const xEntry   = xForIndex(entryIdx);
    const xExit    = xForIndex(exitIdx);
    const yEntry   = yScale(entry.price);
    const yExit    = yScale(entry.outcomePrice);

    ctx.save();
    ctx.globalAlpha = 0.55;

    // Horizontal line at entry price from entry candle to exit candle
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(xEntry, yEntry);
    ctx.lineTo(xExit,  yEntry);
    ctx.stroke();

    // Vertical line at exit candle from entry price to exit price
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(xExit, yEntry);
    ctx.lineTo(xExit, yExit);
    ctx.stroke();

    ctx.globalAlpha = 0.9;

    // Entry dot
    ctx.fillStyle = '#58a6ff';
    ctx.beginPath();
    ctx.arc(xEntry, yEntry, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Exit dot
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(xExit, yExit, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Price labels (only if there is room)
    ctx.globalAlpha = 0.85;
    ctx.font        = '9px Segoe UI, sans-serif';
    ctx.textBaseline = 'middle';

    const entryLabel = '$' + entry.price.toFixed(1);
    const exitLabel  = '$' + entry.outcomePrice.toFixed(1);

    ctx.fillStyle  = '#58a6ff';
    ctx.textAlign  = xEntry > chartL + 40 ? 'right' : 'left';
    ctx.fillText(entryLabel, xEntry + (ctx.textAlign === 'right' ? -5 : 5), yEntry);

    ctx.fillStyle  = color;
    ctx.textAlign  = xExit < chartR - 40 ? 'left' : 'right';
    ctx.fillText(exitLabel, xExit + (ctx.textAlign === 'left' ? 5 : -5), yExit);

    ctx.restore();
  }
}

/**
 * Draws a full crosshair with:
 * – yellow vertical line snapped to the nearest candle (or forecast) bar
 * – yellow horizontal line at the exact mouse Y
 * – price label on the right Y-axis (yellow pill)
 * – time label on the bottom X-axis (yellow pill)
 */
function drawCrosshair(ctx, mouseX, mouseY, cT, cB, cL, cR,
                       candles, forecast, xForIndex, chartW, totalBars, yScale, yMin, yMax) {
  const barW  = chartW / totalBars;
  const idx   = Math.max(0, Math.min(candles.length - 1, Math.floor((mouseX - cL) / barW)));
  const snapX = xForIndex(idx);
  const snapY = (mouseY != null && mouseY >= cT && mouseY <= cB) ? mouseY : null;

  ctx.save();

  // ── Vertical line (yellow, snapped to candle) ────────────────────────────
  ctx.strokeStyle = 'rgba(255,215,0,0.6)';
  ctx.lineWidth   = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(snapX, cT);
  ctx.lineTo(snapX, cB);
  ctx.stroke();

  // ── Horizontal line (yellow, exact mouse Y) ───────────────────────────────
  if (snapY != null) {
    ctx.beginPath();
    ctx.moveTo(cL, snapY);
    ctx.lineTo(cR, snapY);
    ctx.stroke();
  }

  ctx.setLineDash([]);

  // ── Time label on X-axis ─────────────────────────────────────────────────
  if (idx < candles.length) {
    const c   = candles[idx];
    const ts  = new Date(c.time);
    const lbl = ts.toLocaleDateString([], { month: 'short', day: 'numeric' })
              + ' ' + ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const lblW = ctx.measureText(lbl).width + 16;
    const lblH = 18;
    const lblX = snapX - lblW / 2;
    const lblY = cB + 4;

    ctx.fillStyle   = '#FFD700';
    ctx.strokeStyle = '#0d1117';
    ctx.lineWidth   = 1;
    roundRect(ctx, lblX, lblY, lblW, lblH, 3);
    ctx.fill();

    ctx.fillStyle    = '#0d1117';
    ctx.font         = 'bold 10px Segoe UI, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(lbl, snapX, lblY + lblH / 2);
  }

  // ── Price label on Y-axis ─────────────────────────────────────────────────
  if (snapY != null) {
    const price  = yMin + (1 - (snapY - cT) / (cB - cT)) * (yMax - yMin);
    const lbl    = '$' + price.toFixed(2);
    const lblW   = ctx.measureText(lbl).width + 14;
    const lblH   = 18;
    const lblX   = cR + 4;
    const lblY   = snapY - lblH / 2;

    ctx.fillStyle   = '#FFD700';
    ctx.strokeStyle = '#0d1117';
    ctx.lineWidth   = 1;
    roundRect(ctx, lblX, lblY, lblW, lblH, 3);
    ctx.fill();

    ctx.fillStyle    = '#0d1117';
    ctx.font         = 'bold 10px Segoe UI, sans-serif';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(lbl, lblX + 7, snapY);
  }

  ctx.restore();
}

/** Draws a rounded rectangle path (fill/stroke is up to caller). */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y,     x + w, y + r,     r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x,     y + h, x,     y + h - r, r);
  ctx.lineTo(x,     y + r);
  ctx.arcTo(x,     y,     x + r, y,         r);
  ctx.closePath();
}

// ─── Tooltip on mousemove ─────────────────────────────────────────────────────
function showTooltip(e) {
  if (!state.candles || state.candles.length === 0) return;

  const rect    = canvas.getBoundingClientRect();
  const dpr     = window.devicePixelRatio || 1;
  const W       = canvas.width  / dpr;
  const H       = canvas.height / dpr;
  const chartL  = PAD.left;
  const chartW  = W - PAD.right - PAD.left;
  const mouseX  = e.clientX - rect.left;

  if (mouseX < chartL || mouseX > W - PAD.right) {
    document.getElementById('tooltip').style.display = 'none';
    return;
  }

  const totalBars = state.candles.length + (state.forecast || []).length;
  const barW      = chartW / totalBars;
  const idx       = Math.max(0, Math.min(state.candles.length - 1, Math.floor((mouseX - chartL) / barW)));
  const c         = state.candles[idx];
  if (!c) return;

  const tooltip = document.getElementById('tooltip');
  const ts      = new Date(c.time).toLocaleString();
  const bullish = c.close >= c.open;

  tooltip.innerHTML = `
    <strong style="color:#FFD700">XAU/USD</strong><br>
    <span style="color:#8b949e">${ts}</span><br>
    O: <strong>$${c.open.toFixed(2)}</strong>
    H: <strong style="color:#3fb950">$${c.high.toFixed(2)}</strong><br>
    L: <strong style="color:#f85149">$${c.low.toFixed(2)}</strong>
    C: <strong style="color:${bullish ? '#3fb950' : '#f85149'}">$${c.close.toFixed(2)}</strong>
  `;

  // Position tooltip near cursor but not off-screen
  const ttW = 160, ttH = 90;
  let left = e.clientX + 16;
  let top  = e.clientY - 20;
  if (left + ttW > window.innerWidth)  left = e.clientX - ttW - 16;
  if (top  + ttH > window.innerHeight) top  = window.innerHeight - ttH - 10;

  tooltip.style.left    = left + 'px';
  tooltip.style.top     = top  + 'px';
  tooltip.style.display = 'block';
}
