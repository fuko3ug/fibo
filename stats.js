/**
 * stats.js – Statistics page controller
 *
 * Reads signalHistory from chrome.storage.local and renders:
 *  • Summary strip (total signals, win rate, total P&L, best/worst trade)
 *  • Per-indicator cards with ring charts and mini stats
 *  • Sortable, filterable, paginated signal history table
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const SIGNAL_DEFS = [
  { id: 'fibonacci',  name: 'Fibonacci',        icon: '📐' },
  { id: 'rsi',        name: 'RSI (14)',          icon: '📊' },
  { id: 'macd',       name: 'MACD',              icon: '📈' },
  { id: 'bollinger',  name: 'Bollinger Bands',   icon: '🎯' },
  { id: 'stochastic', name: 'Stochastic (14)',   icon: '⚡' },
  { id: 'ema_cross',  name: 'EMA Cross (9/21)',  icon: '✂️' },
];

const PAGE_SIZE = 20;

// Candle-duration thresholds used by inferInterval()
const MS = {
  _1m : 1 * 60 * 1000,
  _5m : 5 * 60 * 1000,
  _15m: 15 * 60 * 1000,
  _30m: 30 * 60 * 1000,
  _1h :  60 * 60 * 1000,
  _1d : 24 * 60 * 60 * 1000,
};

// ─── State ────────────────────────────────────────────────────────────────────
let allEntries    = [];   // enriched history (with pnl fields)
let filtered      = [];   // after filter + search
let sortCol       = 'time';
let sortDir       = -1;   // -1 = desc, 1 = asc
let filterVal     = 'all';
let intervalFilter = 'all';
let searchVal     = '';
let currentPage   = 1;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n)   { return n != null ? '$' + n.toFixed(2) : '–'; }
function pct(n)   { return n != null ? (n >= 0 ? '+' : '') + n.toFixed(2) + '%' : '–'; }

function fmtDate(ms) {
  if (!ms) return '–';
  const d = new Date(ms);
  return d.toLocaleDateString([], { day: '2-digit', month: 'short', year: '2-digit' })
    + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Returns a human-readable "how long until / since" label for the outcome deadline.
 *  pending  → remaining time or "geçti"
 *  resolved → outcome time (already evaluated)
 */
function fmtDeadline(entry) {
  if (!entry.outcomeDeadline) return '–';
  const now = Date.now();

  if (entry.outcome !== 'pending') {
    // Show when the outcome was measured
    return `<span class="deadline-label done">${fmtDate(entry.outcomeDeadline)}</span>`;
  }

  const remaining = entry.outcomeDeadline - now;
  if (remaining <= 0) {
    return `<span class="deadline-label overdue">Değerlendiriliyor…</span>`;
  }
  const mins  = Math.floor(remaining / 60000);
  const hours = Math.floor(mins / 60);
  const days  = Math.floor(hours / 24);
  let label;
  if (days > 0)        label = `${days}g ${hours % 24}s kaldı`;
  else if (hours > 0)  label = `${hours}s ${mins % 60}d kaldı`;
  else                 label = `${mins}d kaldı`;
  return `<span class="deadline-label due">${label}</span>`;
}

/**
 * Returns a short human-readable label for the signal's validity window.
 * e.g. "1h × 5 candles = ~5 saat"
 */
function fmtDuration(entry) {
  if (!entry.intervalMs) return '–';
  const totalMs = entry.intervalMs * 5; // OUTCOME_CANDLES = 5
  const mins  = Math.round(totalMs / 60000);
  const hours = Math.floor(mins / 60);
  const days  = Math.floor(hours / 24);
  if (days > 0)        return `~${days}g ${hours % 24}s`;
  if (hours > 0)       return `~${hours} saat`;
  return `~${mins} dk`;
}

/** Infer interval label from intervalMs for backwards-compatible display. */
function inferInterval(entry) {
  if (entry.interval) return entry.interval;
  if (!entry.intervalMs) return '–';
  const ms = entry.intervalMs;
  if (ms <= MS._1m)  return '1m';
  if (ms <= MS._5m)  return '5m';
  if (ms <= MS._15m) return '15m';
  if (ms <= MS._30m) return '30m';
  if (ms <= MS._1h)  return '1h';
  if (ms <= MS._1d)  return '1d';
  return '1d';
}

/** Compute P&L for a single history entry.
 *  BUY  → profit when outcomePrice > price
 *  SELL → profit when outcomePrice < price
 */
function calcPnl(entry) {
  if (entry.outcome === 'pending' || entry.outcomePrice == null) return null;
  const dir = entry.type === 'BUY' ? 1 : -1;
  const absVal = dir * (entry.outcomePrice - entry.price);
  const pctVal = (absVal / entry.price) * 100;
  return { abs: absVal, pct: pctVal };
}

/** Enrich raw history entries with pnlAbs / pnlPct fields. */
function enrich(history) {
  return history.map(e => {
    const p = calcPnl(e);
    return { ...e, pnlAbs: p?.abs ?? null, pnlPct: p?.pct ?? null };
  });
}

// ─── Summary strip ────────────────────────────────────────────────────────────
function renderSummary(entries) {
  const resolved = entries.filter(e => e.outcome !== 'pending');
  const wins     = entries.filter(e => e.outcome === 'win');
  const losses   = entries.filter(e => e.outcome === 'loss');
  const pending  = entries.filter(e => e.outcome === 'pending');
  const winRate  = resolved.length > 0 ? (wins.length / resolved.length * 100) : null;

  const pnls      = resolved.map(e => e.pnlAbs).filter(v => v != null);
  const totalPnl  = pnls.reduce((a, b) => a + b, 0);
  const bestPnl   = pnls.length > 0 ? Math.max(...pnls) : null;
  const worstPnl  = pnls.length > 0 ? Math.min(...pnls) : null;

  const pnlColor  = totalPnl >= 0 ? '#3fb950' : '#f85149';
  const wrColor   = winRate == null ? '#8b949e' : winRate >= 60 ? '#3fb950' : winRate >= 45 ? '#ff9800' : '#f85149';

  document.getElementById('summaryStrip').innerHTML = `
    <div class="summary-card">
      <div class="summary-value" style="color:#e6edf3">${entries.length}</div>
      <div class="summary-label">Toplam Sinyal</div>
    </div>
    <div class="summary-card">
      <div class="summary-value" style="color:${wrColor}">${winRate != null ? winRate.toFixed(1) + '%' : '–'}</div>
      <div class="summary-label">Kazanma Oranı</div>
    </div>
    <div class="summary-card highlight">
      <div class="summary-value" style="color:${pnlColor}">${pnls.length > 0 ? (totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(2) : '–'}</div>
      <div class="summary-label">Toplam P&amp;L</div>
    </div>
    <div class="summary-card">
      <div class="summary-value" style="color:#3fb950">${bestPnl != null ? '+$' + bestPnl.toFixed(2) : '–'}</div>
      <div class="summary-label">En İyi İşlem</div>
    </div>
    <div class="summary-card">
      <div class="summary-value" style="color:#f85149">${worstPnl != null ? (worstPnl >= 0 ? '+' : '') + '$' + worstPnl.toFixed(2) : '–'}</div>
      <div class="summary-label">En Kötü İşlem</div>
    </div>`;
}

// ─── Per-indicator cards ──────────────────────────────────────────────────────
function renderIndicatorCards(entries) {
  const grid = document.getElementById('indicatorGrid');

  grid.innerHTML = SIGNAL_DEFS.map(def => {
    const group    = entries.filter(e => e.indicatorId === def.id);
    const resolved = group.filter(e => e.outcome !== 'pending');
    const wins     = group.filter(e => e.outcome === 'win').length;
    const losses   = group.filter(e => e.outcome === 'loss').length;
    const pending  = group.filter(e => e.outcome === 'pending').length;
    const total    = resolved.length;
    const winRate  = total > 0 ? (wins / total * 100) : 0;

    const pnls    = resolved.map(e => e.pnlAbs).filter(v => v != null);
    const totPnl  = pnls.reduce((a, b) => a + b, 0);
    const avgPnl  = pnls.length > 0 ? totPnl / pnls.length : null;
    const bestPnl = pnls.length > 0 ? Math.max(...pnls) : null;
    const pctPnls = resolved.map(e => e.pnlPct).filter(v => v != null);
    const avgPct  = pctPnls.length > 0 ? pctPnls.reduce((a, b) => a + b, 0) / pctPnls.length : null;

    const ringColor    = winRate >= 60 ? '#3fb950' : winRate >= 45 ? '#ff9800' : '#f85149';
    const ringCircumf  = 2 * Math.PI * 27; // r=27
    const dashOffset   = ringCircumf * (1 - winRate / 100);
    const winBarWidth  = total > 0 ? (wins / total * 100) : 0;

    const pnlColor = totPnl >= 0 ? '#3fb950' : '#f85149';

    return `
      <div class="ind-card">
        <div class="ind-card-header">
          <span class="ind-icon">${def.icon}</span>
          <span class="ind-name">${def.name}</span>
          <span class="ind-total">${group.length} sinyal</span>
        </div>

        <div class="ring-wrap">
          <div class="ring">
            <svg viewBox="0 0 60 60" width="70" height="70">
              <circle class="ring-track" cx="30" cy="30" r="27"/>
              <circle class="ring-fill" cx="30" cy="30" r="27"
                stroke="${ringColor}"
                stroke-dasharray="${ringCircumf.toFixed(1)}"
                stroke-dashoffset="${dashOffset.toFixed(1)}"/>
            </svg>
            <div class="ring-label">
              <span class="ring-pct" style="color:${ringColor}">${winRate.toFixed(0)}%</span>
              <span class="ring-sub">win rate</span>
            </div>
          </div>
        </div>

        <div class="wl-bar">
          <div class="wl-win"  style="width:${winBarWidth}%"></div>
          <div class="wl-loss"></div>
        </div>

        <div class="ind-stats">
          <div class="ind-stat">
            <div class="ind-stat-lbl">Kazanan</div>
            <div class="ind-stat-val" style="color:#3fb950">${wins}</div>
          </div>
          <div class="ind-stat">
            <div class="ind-stat-lbl">Kaybeden</div>
            <div class="ind-stat-val" style="color:#f85149">${losses}</div>
          </div>
          <div class="ind-stat">
            <div class="ind-stat-lbl">Bekleyen</div>
            <div class="ind-stat-val" style="color:#8b949e">${pending}</div>
          </div>
          <div class="ind-stat">
            <div class="ind-stat-lbl">Ort. P&amp;L</div>
            <div class="ind-stat-val" style="color:${avgPnl == null ? '#8b949e' : avgPnl >= 0 ? '#3fb950' : '#f85149'}">
              ${avgPnl != null ? (avgPnl >= 0 ? '+' : '') + '$' + avgPnl.toFixed(2) : '–'}
            </div>
          </div>
          <div class="ind-stat">
            <div class="ind-stat-lbl">Ort. %</div>
            <div class="ind-stat-val" style="color:${avgPct == null ? '#8b949e' : avgPct >= 0 ? '#3fb950' : '#f85149'}">
              ${avgPct != null ? pct(avgPct) : '–'}
            </div>
          </div>
          <div class="ind-stat">
            <div class="ind-stat-lbl">Toplam P&amp;L</div>
            <div class="ind-stat-val" style="color:${pnlColor}">
              ${pnls.length > 0 ? (totPnl >= 0 ? '+' : '') + '$' + totPnl.toFixed(2) : '–'}
            </div>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ─── Table ────────────────────────────────────────────────────────────────────
function applyFilters() {
  let result = allEntries;

  if (filterVal !== 'all') {
    if (filterVal === 'win' || filterVal === 'loss' || filterVal === 'pending') {
      result = result.filter(e => e.outcome === filterVal);
    } else {
      result = result.filter(e => e.type === filterVal);
    }
  }

  if (intervalFilter !== 'all') {
    result = result.filter(e => e.interval === intervalFilter);
  }

  if (searchVal) {
    const q = searchVal.toLowerCase();
    result = result.filter(e =>
      (e.indicatorName || '').toLowerCase().includes(q) ||
      (e.type || '').toLowerCase().includes(q)
    );
  }

  // Sort
  result = [...result].sort((a, b) => {
    let av = a[sortCol], bv = b[sortCol];
    if (av == null) av = sortDir < 0 ? -Infinity : Infinity;
    if (bv == null) bv = sortDir < 0 ? -Infinity : Infinity;
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    return av < bv ? -sortDir : av > bv ? sortDir : 0;
  });

  filtered = result;
  currentPage = 1;
  renderTable();
  renderPagination();
}

function renderTable() {
  const tbody = document.getElementById('signalTableBody');
  const start = (currentPage - 1) * PAGE_SIZE;
  const slice = filtered.slice(start, start + PAGE_SIZE);

  if (slice.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" style="text-align:center;padding:30px;color:#8b949e">
      ${filtered.length === 0 ? '⚠️ Bu filtreyle eşleşen sinyal bulunamadı.' : ''}
    </td></tr>`;
    return;
  }

  // Find best/worst by pnlAbs among the full filtered set for highlighting
  const resolvedPnls = filtered.filter(e => e.pnlAbs != null).map(e => e.pnlAbs);
  const bestPnl  = resolvedPnls.length > 0 ? Math.max(...resolvedPnls) : null;
  const worstPnl = resolvedPnls.length > 0 ? Math.min(...resolvedPnls) : null;

  // Pre-build entry → index map to avoid O(n²) indexOf() inside map()
  const entryToIdx = new Map(allEntries.map((e, i) => [e, i]));

  tbody.innerHTML = slice.map(entry => {
    const outcomeIcon = entry.outcome === 'win'  ? '✓' :
                        entry.outcome === 'loss' ? '✗' : '⏳';
    const outcomeCls  = entry.outcome === 'win'  ? 'oc-win'  :
                        entry.outcome === 'loss' ? 'oc-loss' : 'oc-pending';
    const typeCls     = entry.type === 'BUY' ? 'tb-buy' : 'tb-sell';
    const pnlColor    = entry.pnlAbs == null ? '' :
                        entry.pnlAbs > 0 ? 'pnl-pos' : entry.pnlAbs < 0 ? 'pnl-neg' : 'pnl-neu';
    const isBest  = bestPnl  != null && entry.pnlAbs === bestPnl  && bestPnl  > 0;
    const isWorst = worstPnl != null && entry.pnlAbs === worstPnl && worstPnl < 0;
    const rowCls  = isBest ? 'is-best' : isWorst ? 'is-worst' : '';

    const strBarColor = entry.strength > 70 ? '#3fb950' : entry.strength > 40 ? '#ff9800' : '#58a6ff';
    const icon = SIGNAL_DEFS.find(d => d.id === entry.indicatorId)?.icon || '📊';
    const tfLabel = inferInterval(entry);
    const durLabel = fmtDuration(entry);
    const deadlineHtml = fmtDeadline(entry);
    const eIdx = entryToIdx.get(entry) ?? -1;

    return `<tr class="${rowCls}" data-idx="${eIdx}" style="cursor:pointer">
      <td><span class="outcome-chip ${outcomeCls}">${outcomeIcon}</span></td>
      <td style="color:#8b949e">${fmtDate(entry.time)}</td>
      <td>
        <span class="tf-badge">${tfLabel}</span>
        <span style="color:#8b949e;font-size:10px;margin-left:4px">${durLabel}</span>
      </td>
      <td><span style="font-weight:600">${icon} ${entry.indicatorName || entry.indicatorId}</span></td>
      <td><span class="type-badge ${typeCls}">${entry.type}</span></td>
      <td>${fmt(entry.price)}</td>
      <td>${entry.outcomePrice != null ? fmt(entry.outcomePrice) : '<span style="color:#8b949e">bekliyor</span>'}</td>
      <td>${deadlineHtml}</td>
      <td class="${pnlColor}">${entry.pnlAbs != null ? (entry.pnlAbs >= 0 ? '+' : '') + '$' + entry.pnlAbs.toFixed(2) : '<span class="pnl-neu">–</span>'}</td>
      <td class="${pnlColor}">${entry.pnlPct != null ? pct(entry.pnlPct) : '<span class="pnl-neu">–</span>'}</td>
      <td>
        <span class="str-bar" style="width:${entry.strength}px;max-width:50px;background:${strBarColor}"></span>
        ${entry.strength}%
      </td>
      <td>
        <span class="info-btn" data-idx="${eIdx}" title="Ayrıntıları göster">ℹ</span>
      </td>
    </tr>`;
  }).join('');

  // Update sort arrows
  document.querySelectorAll('table.signal-table th').forEach(th => {
    const col = th.dataset.col;
    th.classList.toggle('sorted', col === sortCol);
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = col === sortCol ? (sortDir < 0 ? '↓' : '↑') : '↕';
  });
}

function renderPagination() {
  const total = Math.ceil(filtered.length / PAGE_SIZE);
  const pg    = document.getElementById('pagination');

  if (total <= 1) { pg.innerHTML = ''; return; }

  let html = '';
  if (currentPage > 1) {
    html += `<button class="pg-btn" data-page="${currentPage - 1}">‹</button>`;
  }

  // Show up to 7 page buttons
  const start = Math.max(1, currentPage - 3);
  const end   = Math.min(total, start + 6);
  for (let p = start; p <= end; p++) {
    html += `<button class="pg-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
  }

  if (currentPage < total) {
    html += `<button class="pg-btn" data-page="${currentPage + 1}">›</button>`;
  }

  html += `<span class="pg-info">${filtered.length} sinyal / sayfa ${currentPage}/${total}</span>`;
  pg.innerHTML = html;

  pg.querySelectorAll('.pg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentPage = parseInt(btn.dataset.page, 10);
      renderTable();
      renderPagination();
      window.scrollTo({ top: document.getElementById('signalTableBody').getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' });
    });
  });
}

// ─── Detail Modal ─────────────────────────────────────────────────────────────

function buildPriceLine(entry) {
  // Build a mini SVG number-line showing entry → exit price
  if (entry.outcomePrice == null) return '<div style="color:#8b949e;font-size:11px">Sonuç bekleniyor…</div>';

  const entryP  = entry.price;
  const exitP   = entry.outcomePrice;
  const minP    = Math.min(entryP, exitP);
  const maxP    = Math.max(entryP, exitP);
  const range   = maxP - minP || 1;
  const isBuy   = entry.type === 'BUY';
  const isWin   = entry.outcome === 'win';
  const color   = isWin ? '#3fb950' : '#f85149';
  const W = 320, H = 54, pad = 40;

  const xEntry = pad + (entryP - minP) / range * (W - 2 * pad);
  const xExit  = pad + (exitP  - minP) / range * (W - 2 * pad);
  const yLine  = H / 2;

  // Axis labels might overlap if prices are very close: nudge them apart
  const entryLabel  = `$${entryP.toFixed(1)}`;
  const exitLabel   = `$${exitP.toFixed(1)}`;
  const labelOffset = Math.abs(xEntry - xExit) < 60 ? 16 : 0;
  const entryLY     = yLine + (xEntry < xExit ? -labelOffset : labelOffset) + 20;
  const exitLY      = yLine + (xEntry < xExit ? labelOffset : -labelOffset) + 20;

  return `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
         style="overflow:visible;display:block;margin:0 auto">
      <!-- axis line -->
      <line x1="${pad - 10}" y1="${yLine}" x2="${W - pad + 10}" y2="${yLine}"
            stroke="#30363d" stroke-width="1.5"/>

      <!-- segment between entry and exit -->
      <line x1="${xEntry}" y1="${yLine}" x2="${xExit}" y2="${yLine}"
            stroke="${color}" stroke-width="3" stroke-linecap="round"/>

      <!-- entry dot -->
      <circle cx="${xEntry}" cy="${yLine}" r="5" fill="#58a6ff" stroke="#0d1117" stroke-width="1.5"/>
      <!-- exit dot -->
      <circle cx="${xExit}"  cy="${yLine}" r="5" fill="${color}"   stroke="#0d1117" stroke-width="1.5"/>

      <!-- entry label -->
      <text x="${xEntry}" y="${yLine - 10}" fill="#58a6ff" font-size="10"
            text-anchor="middle" font-family="Segoe UI,sans-serif">${entryLabel}</text>
      <text x="${xEntry}" y="${yLine + 18}" fill="#8b949e" font-size="9"
            text-anchor="middle" font-family="Segoe UI,sans-serif">Giriş</text>

      <!-- exit label -->
      <text x="${xExit}" y="${yLine - 10}" fill="${color}" font-size="10"
            text-anchor="middle" font-family="Segoe UI,sans-serif">${exitLabel}</text>
      <text x="${xExit}" y="${yLine + 18}" fill="#8b949e" font-size="9"
            text-anchor="middle" font-family="Segoe UI,sans-serif">Çıkış</text>
    </svg>`;
}

function openDetailModal(entry) {
  const icon     = SIGNAL_DEFS.find(d => d.id === entry.indicatorId)?.icon || '📊';
  const typeCls  = entry.type === 'BUY' ? 'tb-buy' : 'tb-sell';
  const pnlColor = entry.pnlAbs == null ? '#8b949e' :
                   entry.pnlAbs > 0 ? '#3fb950' : entry.pnlAbs < 0 ? '#f85149' : '#8b949e';
  const outcomeIcon = entry.outcome === 'win' ? '✓ Kazandı' :
                      entry.outcome === 'loss' ? '✗ Kaybetti' : '⏳ Bekliyor';
  const outcomeCls  = entry.outcome === 'win' ? 'oc-win' :
                      entry.outcome === 'loss' ? 'oc-loss' : 'oc-pending';
  const tfLabel  = inferInterval(entry);
  const durLabel = fmtDuration(entry);
  const strColor = entry.strength > 70 ? '#3fb950' : entry.strength > 40 ? '#ff9800' : '#58a6ff';

  document.getElementById('modalBody').innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <span style="font-size:28px">${icon}</span>
      <div>
        <div style="font-size:17px;font-weight:700">${entry.indicatorName || entry.indicatorId}</div>
        <div style="margin-top:4px;display:flex;gap:6px;align-items:center">
          <span class="type-badge ${typeCls}">${entry.type}</span>
          <span class="tf-badge">${tfLabel}</span>
          <span style="font-size:11px;color:#8b949e">${durLabel}</span>
        </div>
      </div>
      <div style="margin-left:auto;text-align:right">
        <span class="outcome-chip ${outcomeCls}" style="width:auto;padding:4px 10px;border-radius:14px;font-size:12px">${outcomeIcon}</span>
      </div>
    </div>

    <div style="font-size:11px;color:#8b949e;margin-bottom:12px">${fmtDate(entry.time)}</div>

    ${entry.message ? `<div style="background:#161b22;border:1px solid #21262d;border-radius:8px;padding:10px 12px;font-size:12px;color:#c9d1d9;line-height:1.6;margin-bottom:16px">${entry.message}</div>` : ''}

    <!-- Price number-line -->
    <div style="background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:14px 10px 8px;margin-bottom:16px">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#8b949e;margin-bottom:10px;text-align:center">Fiyat Hareketi</div>
      ${buildPriceLine(entry)}
    </div>

    <!-- Stats grid -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px">
      <div style="background:#161b22;border:1px solid #21262d;border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:9px;text-transform:uppercase;color:#8b949e;margin-bottom:4px">Giriş Fiyatı</div>
        <div style="font-size:14px;font-weight:700;color:#58a6ff">$${entry.price.toFixed(2)}</div>
      </div>
      <div style="background:#161b22;border:1px solid #21262d;border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:9px;text-transform:uppercase;color:#8b949e;margin-bottom:4px">Çıkış Fiyatı</div>
        <div style="font-size:14px;font-weight:700;color:${pnlColor}">
          ${entry.outcomePrice != null ? '$' + entry.outcomePrice.toFixed(2) : '–'}
        </div>
      </div>
      <div style="background:#161b22;border:1px solid #21262d;border-radius:8px;padding:10px;text-align:center">
        <div style="font-size:9px;text-transform:uppercase;color:#8b949e;margin-bottom:4px">P&L</div>
        <div style="font-size:14px;font-weight:700;color:${pnlColor}">
          ${entry.pnlAbs != null ? (entry.pnlAbs >= 0 ? '+' : '') + '$' + entry.pnlAbs.toFixed(2) : '–'}
          ${entry.pnlPct != null ? `<span style="font-size:11px">(${pct(entry.pnlPct)})</span>` : ''}
        </div>
      </div>
    </div>

    <div style="display:flex;align-items:center;gap:8px">
      <span style="font-size:10px;text-transform:uppercase;color:#8b949e">Sinyal Gücü</span>
      <div style="flex:1;height:6px;background:#21262d;border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${entry.strength}%;background:${strColor};border-radius:3px"></div>
      </div>
      <span style="font-size:12px;font-weight:600;color:${strColor}">${entry.strength}%</span>
    </div>

    ${entry.outcomeDeadline ? `
    <div style="margin-top:10px;font-size:11px;color:#8b949e">
      Değerlendirme zamanı: ${fmtDate(entry.outcomeDeadline)}
    </div>` : ''}`;

  document.getElementById('detailModal').style.display = 'flex';
}

function closeDetailModal() {
  document.getElementById('detailModal').style.display = 'none';
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Navigation
  document.getElementById('btnBack').addEventListener('click', () => window.close());
  document.getElementById('btnClear').addEventListener('click', () => {
    if (!confirm('Tüm sinyal geçmişi silinecek. Emin misiniz?')) return;
    chrome.storage.local.set({ signalHistory: [] }, () => {
      allEntries = [];
      filtered   = [];
      renderSummary([]);
      renderIndicatorCards([]);
      renderTable();
      renderPagination();
    });
  });

  // Filter buttons (outcome / type)
  document.querySelectorAll('#filterRow .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#filterRow .filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filterVal = btn.dataset.filter;
      applyFilters();
    });
  });

  // Interval filter buttons
  document.querySelectorAll('#filterInterval .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#filterInterval .filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      intervalFilter = btn.dataset.interval;
      applyFilters();
    });
  });

  // Search
  document.getElementById('searchInput').addEventListener('input', e => {
    searchVal = e.target.value.trim();
    applyFilters();
  });

  // Sort headers
  document.querySelectorAll('table.signal-table th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortCol === col) {
        sortDir = -sortDir;
      } else {
        sortCol = col;
        sortDir = col === 'time' ? -1 : -1;
      }
      applyFilters();
    });
  });

  // Row click → detail modal; (i) button is handled inside
  document.getElementById('signalTableBody').addEventListener('click', (e) => {
    // (i) button click
    const infoBtnEl = e.target.closest('.info-btn');
    const rowEl     = e.target.closest('tr[data-idx]');

    if (infoBtnEl || rowEl) {
      e.stopPropagation();
      const idx = parseInt((infoBtnEl || rowEl).dataset.idx, 10);
      if (!isNaN(idx) && allEntries[idx]) openDetailModal(allEntries[idx]);
    }
  });

  // Ghost tooltip on (i) button hover
  const ghost = document.getElementById('ghostTooltip');
  document.getElementById('signalTableBody').addEventListener('mouseover', (e) => {
    const btn = e.target.closest('.info-btn');
    if (!btn) return;
    const idx   = parseInt(btn.dataset.idx, 10);
    const entry = allEntries[idx];
    if (!entry) return;

    const icon = SIGNAL_DEFS.find(d => d.id === entry.indicatorId)?.icon || '📊';
    const tfLabel = inferInterval(entry);
    const typeCls = entry.type === 'BUY' ? 'tb-buy' : 'tb-sell';
    const pnlColor = entry.pnlAbs == null ? '' : entry.pnlAbs > 0 ? 'pnl-pos' : entry.pnlAbs < 0 ? 'pnl-neg' : 'pnl-neu';

    ghost.innerHTML = `
      <div style="font-weight:700;margin-bottom:6px">${icon} ${entry.indicatorName || entry.indicatorId}</div>
      <div style="margin-bottom:4px">
        <span class="type-badge ${typeCls}">${entry.type}</span>
        <span class="tf-badge" style="margin-left:6px">${tfLabel}</span>
      </div>
      <div style="font-size:11px;color:#8b949e;margin-bottom:6px">${fmtDate(entry.time)}</div>
      <div style="font-size:11px;line-height:1.5;margin-bottom:6px;color:#c9d1d9">${entry.message || '–'}</div>
      <div style="display:flex;gap:16px;font-size:11px">
        <div><span style="color:#8b949e">Giriş:</span> ${fmt(entry.price)}</div>
        ${entry.outcomePrice != null ? `<div><span style="color:#8b949e">Çıkış:</span> ${fmt(entry.outcomePrice)}</div>` : ''}
        ${entry.pnlAbs != null ? `<div class="${pnlColor}">${entry.pnlAbs >= 0 ? '+' : ''}$${entry.pnlAbs.toFixed(2)}</div>` : ''}
      </div>`;

    const rect = btn.getBoundingClientRect();
    ghost.style.display = 'block';
    // Position: try to the left of the button
    const gtW = 280;
    let left = rect.left - gtW - 8;
    if (left < 8) left = rect.right + 8;
    ghost.style.left = left + 'px';
    ghost.style.top  = (rect.top + window.scrollY - 10) + 'px';
  });

  document.getElementById('signalTableBody').addEventListener('mouseout', (e) => {
    if (!e.target.closest('.info-btn')) return;
    ghost.style.display = 'none';
  });

  // Close modal
  document.getElementById('detailModal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('detailModal')) closeDetailModal();
  });
  document.getElementById('modalClose').addEventListener('click', closeDetailModal);

  // Load data
  chrome.storage.local.get(['signalHistory'], ({ signalHistory = [] }) => {
    allEntries = enrich(signalHistory);

    document.getElementById('loadingOverlay').style.display = 'none';
    document.getElementById('page').style.display = 'block';

    if (allEntries.length === 0) {
      document.getElementById('summaryStrip').innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <div class="empty-icon">📭</div>
          <p>Henüz sinyal geçmişi yok.<br>Birkaç sinyal üretildikten sonra burada istatistikleri göreceksiniz.</p>
        </div>`;
      document.getElementById('indicatorGrid').innerHTML = '';
      document.getElementById('signalTableBody').innerHTML = `
        <tr><td colspan="12" style="text-align:center;padding:30px;color:#8b949e">
          Sinyal geçmişi boş.
        </td></tr>`;
      return;
    }

    renderSummary(allEntries);
    renderIndicatorCards(allEntries);
    applyFilters();
  });

  // Live updates while page is open
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.signalHistory) {
      const updated = changes.signalHistory.newValue || [];
      allEntries = enrich(updated);
      renderSummary(allEntries);
      renderIndicatorCards(allEntries);
      applyFilters();
    }
  });
});
