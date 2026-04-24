/**
 * consensus.js – Logic for the Consensus page (consensus.html).
 *
 * Moved out of the HTML file so it can satisfy the Chrome extension
 * Content Security Policy (script-src 'self').
 */

const SIGNAL_DEFS = [
  { id: 'fibonacci',  name: 'Fibonacci',        icon: '📐' },
  { id: 'rsi',        name: 'RSI (14)',          icon: '📊' },
  { id: 'macd',       name: 'MACD',              icon: '📈' },
  { id: 'bollinger',  name: 'Bollinger Bands',   icon: '🎯' },
  { id: 'stochastic', name: 'Stochastic (14)',   icon: '⚡' },
  { id: 'ema_cross',  name: 'EMA Cross (9/21)',  icon: '✂️' },
];

function pct(n) {
  return n != null ? (n >= 0 ? '+' : '') + n.toFixed(2) + '%' : '–';
}

/** Build per-indicator stats from signal history.
 *  For indicators with no resolved signals yet, winRate defaults to 0.5 (50 %).
 *  This neutral default avoids artificially suppressing new indicators while
 *  their track record is still being established.
 */
function buildStats(signalHistory) {
  const map = {};
  for (const def of SIGNAL_DEFS) {
    const group    = signalHistory.filter(e => e.indicatorId === def.id);
    const resolved = group.filter(e => e.outcome !== 'pending');
    const wins     = resolved.filter(e => e.outcome === 'win').length;
    const total    = resolved.length;
    const winRate  = total > 0 ? wins / total : 0.5; // default 50% if no history
    map[def.id] = { wins, losses: total - wins, total, pending: group.filter(e => e.outcome === 'pending').length, winRate };
  }
  return map;
}

/** Compute weighted consensus from current signals and win-rate weights. */
function computeConsensus(signals, stats) {
  let weightedSum = 0;
  let totalWeight = 0;
  let buyWeight   = 0;
  let sellWeight  = 0;

  for (const def of SIGNAL_DEFS) {
    const sig     = signals?.[def.id];
    const type    = sig?.type || null;
    const weight  = stats[def.id].winRate;      // 0–1
    const dir     = type === 'BUY' ? 1 : type === 'SELL' ? -1 : 0;

    if (type) { // only count indicators with an active signal
      weightedSum  += dir * weight;
      totalWeight  += weight;
      if (dir === 1)  buyWeight  += weight;
      if (dir === -1) sellWeight += weight;
    }
  }

  const score    = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const totalW   = buyWeight + sellWeight || 1;
  const buyPct   = Math.round(buyWeight  / totalW * 100);
  const sellPct  = 100 - buyPct;

  return { score, buyPct, sellPct };
}

function renderConsensusMain(signals, stats) {
  const { score, buyPct, sellPct } = computeConsensus(signals, stats);

  const isNull  = Object.values(signals || {}).every(s => !s?.type);
  const bias    = score > 0.05 ? 'BULLISH' : score < -0.05 ? 'BEARISH' : 'NEUTRAL';
  const conf    = isNull ? 0 : Math.round(Math.abs(score) * 100);
  const cls     = bias === 'BULLISH' ? 'bullish' : bias === 'BEARISH' ? 'bearish' : 'neutral';

  const box = document.getElementById('consensusMain');
  box.className = `consensus-main ${cls}`;
  document.getElementById('consensusVal').textContent   = bias;
  document.getElementById('consensusConf').textContent  = isNull ? 'Yeterli sinyal yok' : `Güven: ${conf}%`;
  document.getElementById('dualBuy').style.width        = buyPct  + '%';
  document.getElementById('dualSell').style.width       = sellPct + '%';
  document.getElementById('buyPctLbl').textContent      = `AL ${buyPct}%`;
  document.getElementById('sellPctLbl').textContent     = `SAT ${sellPct}%`;
}

function renderBreakdown(signals, stats) {
  const grid = document.getElementById('breakdownGrid');

  grid.innerHTML = SIGNAL_DEFS.map(def => {
    const sig      = signals?.[def.id];
    const type     = sig?.type || null;
    const strength = sig?.strength ?? 0;
    const st       = stats[def.id];
    const winRate  = st.winRate;
    const weight   = winRate;          // weight ∈ [0,1]
    const dir      = type === 'BUY' ? 1 : type === 'SELL' ? -1 : 0;
    const contrib  = type ? dir * weight : null;

    const ringColor   = winRate >= 0.6 ? '#3fb950' : winRate >= 0.45 ? '#ff9800' : '#f85149';
    const ringCircumf = 2 * Math.PI * 24;
    const dashOffset  = ringCircumf * (1 - winRate);

    const weightColor = winRate >= 0.6 ? '#3fb950' : winRate >= 0.45 ? '#ff9800' : '#f85149';
    const badgeCls    = type === 'BUY' ? 'tb-buy' : type === 'SELL' ? 'tb-sell' : 'tb-neutral';
    const cardCls     = type === 'BUY' ? 'signal-buy' : type === 'SELL' ? 'signal-sell' : '';

    const contribLabel = contrib === null
      ? '<span style="color:#8b949e">aktif sinyal yok</span>'
      : contrib > 0
        ? `<span class="contrib-pos">+${(contrib * 100).toFixed(1)}% katkı (AL yönü)</span>`
        : contrib < 0
          ? `<span class="contrib-neg">${(contrib * 100).toFixed(1)}% katkı (SAT yönü)</span>`
          : '<span style="color:#8b949e">sıfır katkı</span>';

    return `
      <div class="ind-card ${cardCls}">
        <div class="ind-header">
          <span class="ind-icon">${def.icon}</span>
          <span class="ind-name">${def.name}</span>
          <span class="type-badge ${badgeCls}">${type || '—'}</span>
        </div>

        <div class="ring-wrap">
          <div class="ring">
            <svg viewBox="0 0 54 54" width="64" height="64">
              <circle class="ring-track" cx="27" cy="27" r="24"/>
              <circle class="ring-fill" cx="27" cy="27" r="24"
                stroke="${ringColor}"
                stroke-dasharray="${ringCircumf.toFixed(1)}"
                stroke-dashoffset="${dashOffset.toFixed(1)}"/>
            </svg>
            <div class="ring-label">
              <span class="ring-pct" style="color:${ringColor}">${(winRate * 100).toFixed(0)}%</span>
              <span class="ring-sub">win rate</span>
            </div>
          </div>
        </div>

        <div class="ind-stats">
          <div>
            <div class="ind-stat-lbl">Kazanan</div>
            <div class="ind-stat-val" style="color:#3fb950">${st.wins}</div>
          </div>
          <div>
            <div class="ind-stat-lbl">Kaybeden</div>
            <div class="ind-stat-val" style="color:#f85149">${st.losses}</div>
          </div>
          <div>
            <div class="ind-stat-lbl">Bekleyen</div>
            <div class="ind-stat-val" style="color:#8b949e">${st.pending}</div>
          </div>
          <div>
            <div class="ind-stat-lbl">Sinyal Gücü</div>
            <div class="ind-stat-val" style="color:#58a6ff">${strength}%</div>
          </div>
        </div>

        <div class="weight-row">
          <span class="weight-lbl">Ağırlık</span>
          <div class="weight-track">
            <div class="weight-fill" style="width:${(weight * 100).toFixed(0)}%;background:${weightColor}"></div>
          </div>
          <span class="weight-val" style="color:${weightColor}">${(weight * 100).toFixed(0)}%</span>
        </div>

        <div class="contrib">${contribLabel}</div>
      </div>`;
  }).join('');
}

function render({ signals, signalHistory }) {
  const stats = buildStats(signalHistory || []);
  renderConsensusMain(signals, stats);
  renderBreakdown(signals, stats);
}

// ── Boot ──
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnBack').addEventListener('click', () => window.close());
  document.getElementById('btnStats').addEventListener('click', () =>
    chrome.tabs.create({ url: chrome.runtime.getURL('stats.html') }));

  chrome.storage.local.get(['signals', 'signalHistory'], (data) => {
    document.getElementById('loadingOverlay').style.display = 'none';
    document.getElementById('page').style.display = 'block';
    render(data);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.signals || changes.signalHistory)) {
      chrome.storage.local.get(['signals', 'signalHistory'], render);
    }
  });
});
