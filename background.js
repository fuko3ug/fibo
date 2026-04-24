/**
 * background.js – Service Worker
 *
 * Fetches real-time gold (XAU/USD) data from Yahoo Finance (no API key required),
 * calculates Fibonacci retracement levels, detects reversal signals,
 * and opens a chart tab whenever a new signal fires.
 */

// ─── Configuration ────────────────────────────────────────────────────────────
const FETCH_PERIOD_MIN = 1;      // default poll (minutes) – overridden by interval
const DEBOUNCE_MS      = 10 * 60 * 1000; // 10 minutes between notifications

// Interval configs – keyed by user-visible label
const INTERVAL_CONFIGS = {
  '1m':  { interval: '1m',  range: '1d',   pollMin: 1  },
  '5m':  { interval: '5m',  range: '5d',   pollMin: 5  },
  '15m': { interval: '15m', range: '5d',   pollMin: 15 },
  '30m': { interval: '30m', range: '30d',  pollMin: 30 },
  '1h':  { interval: '1h',  range: '60d',  pollMin: 60 },
};
const DEFAULT_INTERVAL = '1h';

// Fibonacci ratios used in calculations
const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];

// Key levels that can trigger a reversal signal
const KEY_LEVELS = [0.382, 0.5, 0.618];

// Price must be within this % of a key level to count
const PROXIMITY_PCT = 0.005; // 0.5%

// Look-back window (candles) used to find the dominant swing high/low
const SWING_LOOKBACK = 50;

// Forecast: how many future candles to project
const FORECAST_PERIODS = 12;

// ─── Lifecycle ────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const { selectedInterval = DEFAULT_INTERVAL } =
    await chrome.storage.local.get('selectedInterval');
  await updateAlarm(selectedInterval);
  fetchAndAnalyze();
});

chrome.runtime.onStartup.addListener(async () => {
  const { selectedInterval = DEFAULT_INTERVAL } =
    await chrome.storage.local.get('selectedInterval');
  await updateAlarm(selectedInterval);
  fetchAndAnalyze();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'fetchGoldData') fetchAndAnalyze();
});

/** Recreate the alarm with the period matching the selected interval. */
async function updateAlarm(intervalKey) {
  const cfg = INTERVAL_CONFIGS[intervalKey] || INTERVAL_CONFIGS[DEFAULT_INTERVAL];
  await chrome.alarms.clear('fetchGoldData');
  chrome.alarms.create('fetchGoldData', { periodInMinutes: cfg.pollMin });
}

// ─── Data Fetching ─────────────────────────────────────────────────────────

async function fetchGoldData() {
  const { selectedInterval = DEFAULT_INTERVAL } =
    await chrome.storage.local.get('selectedInterval');
  const cfg = INTERVAL_CONFIGS[selectedInterval] || INTERVAL_CONFIGS[DEFAULT_INTERVAL];

  // Yahoo Finance chart API – try query1 then query2, spot then futures.
  // Also fall back to daily (1d) in case the short interval returns no data.
  const hosts   = ['query1', 'query2'];
  const symbols = ['XAUUSD=X', 'GC=F'];
  const attempts = [];
  for (const host of hosts) {
    for (const symbol of symbols) {
      attempts.push({ host, symbol, interval: cfg.interval, range: cfg.range });
    }
  }
  // Always add a daily fallback so we have something to analyse
  if (cfg.interval !== '1d') {
    for (const host of hosts) {
      for (const symbol of symbols) {
        attempts.push({ host, symbol, interval: '1d', range: '6mo' });
      }
    }
  }

  for (const { host, symbol, interval, range } of attempts) {
    const url =
      `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?interval=${interval}&range=${range}`;

    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      });

      if (!res.ok) {
        console.warn(`[FiboGold] ${host} HTTP ${res.status} for ${symbol} ${interval}`);
        continue;
      }

      const json   = await res.json();
      const result = json?.chart?.result?.[0];

      if (!result) {
        console.warn(`[FiboGold] ${host} no result for ${symbol} ${interval}`);
        continue;
      }

      const timestamps = result.timestamp;
      const quote      = result.indicators?.quote?.[0];

      if (!timestamps || !quote) {
        console.warn(`[FiboGold] ${host} missing quote data for ${symbol} ${interval}`);
        continue;
      }

      const candles = timestamps
        .map((ts, i) => ({
          time  : ts * 1000,
          open  : quote.open[i],
          high  : quote.high[i],
          low   : quote.low[i],
          close : quote.close[i],
          volume: quote.volume?.[i] || 0,
        }))
        .filter(c => c.open  != null && c.high != null &&
                     c.low   != null && c.close != null &&
                     !isNaN(c.open)  && !isNaN(c.close));

      if (candles.length === 0) {
        console.warn(`[FiboGold] ${host} no valid candles for ${symbol} ${interval}`);
        continue;
      }

      console.log(`[FiboGold] OK: ${candles.length} candles (${host}, ${symbol}, ${interval})`);
      return { candles, intervalUsed: interval };
    } catch (err) {
      console.warn(`[FiboGold] fetch error (${host}, ${symbol}, ${interval}):`, err);
    }
  }

  console.error('[FiboGold] All Yahoo Finance attempts failed.');
  return null;
}

// ─── Fibonacci Analysis ───────────────────────────────────────────────────
function calcFibonacci(candles) {
  if (!candles || candles.length < 10) return null;

  const slice = candles.slice(-SWING_LOOKBACK);
  const high  = Math.max(...slice.map(c => c.high));
  const low   = Math.min(...slice.map(c => c.low));
  const range = high - low;

  if (range === 0) return null;

  // Determine direction of the dominant move
  const firstClose = slice[0].close;
  const lastClose  = slice[slice.length - 1].close;
  const bullish    = lastClose > firstClose; // trend = up → retrace from high to low

  const levels = FIB_RATIOS.map(r => ({
    ratio : r,
    price : bullish ? high - r * range : low + r * range,
    label : `${(r * 100).toFixed(1)}%`,
  }));

  return { high, low, range, bullish, levels };
}

// ─── Trend / Pattern Detection ────────────────────────────────────────────
/**
 * Returns 'up', 'down', or 'neutral' based on consecutive closes.
 * A candle whose body >= MIN_BODY_PCT of the recent range counts.
 */
function detectTrend(candles) {
  if (candles.length < 3) return 'neutral';
  const c = candles.slice(-5);
  const closes = c.map(x => x.close);

  let ups = 0, downs = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) ups++;
    else if (closes[i] < closes[i - 1]) downs++;
  }

  if (downs >= 3) return 'down';
  if (ups   >= 3) return 'up';
  return 'neutral';
}

// ─── Signal Detection ─────────────────────────────────────────────────────
function detectSignal(candles, fib) {
  if (!fib || !candles || candles.length < 5) return null;

  const last  = candles[candles.length - 1];
  const price = last.close;
  const trend = detectTrend(candles);

  if (trend === 'neutral') return null;

  for (const keyRatio of KEY_LEVELS) {
    const fibLevel = fib.levels.find(l => l.ratio === keyRatio);
    if (!fibLevel) continue;

    const proximity = Math.abs(price - fibLevel.price) / fibLevel.price;
    if (proximity > PROXIMITY_PCT) continue;

    // "down" trend near a fib support → BUY signal (bounce expected)
    // "up"   trend near a fib resistance → SELL signal (drop expected)
    const signalType = trend === 'down' ? 'BUY' : 'SELL';

    return {
      type      : signalType,
      price     : price,
      fibRatio  : keyRatio,
      fibPrice  : fibLevel.price,
      time      : last.time,
      proximity : proximity,
      message   : `${signalType} signal – price at ${fibLevel.label} Fibonacci level ($${fibLevel.price.toFixed(2)})`,
    };
  }

  return null;
}

// ─── Linear-Regression Forecast ───────────────────────────────────────────
function calcForecast(candles) {
  if (!candles || candles.length < 20) return [];

  const src = candles.slice(-30);
  const n   = src.length;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX  += i;
    sumY  += src[i].close;
    sumXY += i * src[i].close;
    sumX2 += i * i;
  }

  const denom    = n * sumX2 - sumX * sumX;
  const slope    = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const intercept = (sumY - slope * sumX) / n;

  // Average interval between candles (ms)
  const avgInterval = (src[n - 1].time - src[0].time) / (n - 1);
  const lastTime    = src[n - 1].time;

  const forecast = [];
  for (let i = 1; i <= FORECAST_PERIODS; i++) {
    forecast.push({
      time : lastTime + i * avgInterval,
      price: intercept + slope * (n - 1 + i),
    });
  }

  return forecast;
}

// ─── Technical Indicators ─────────────────────────────────────────────────

/** Computes a full EMA series; values before the warm-up period are null. */
function computeEMASeries(values, period) {
  const k   = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/** Wraps the existing Fibonacci analysis into the unified signal shape. */
function signalFromFibonacci(candles) {
  const empty = { type: null, strength: 0,
    message: 'Price not near a key Fibonacci retracement level.',
    time: candles[candles.length - 1].time };
  const fib = calcFibonacci(candles);
  const sig = detectSignal(candles, fib);
  if (!sig) return empty;
  return {
    type     : sig.type,
    strength : Math.round(Math.max(0, 1 - sig.proximity / PROXIMITY_PCT) * 100),
    value    : sig.price,
    fibRatio : sig.fibRatio,
    fibPrice : sig.fibPrice,
    proximity: sig.proximity,
    message  : sig.message,
    time     : sig.time,
  };
}

function signalFromRSI(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const closes = candles.map(c => c.close);
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al -= d;
  }
  ag /= period; al /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(0,  d)) / period;
    al = (al * (period - 1) + Math.max(0, -d)) / period;
  }
  const rsi = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  let type = null, strength = 0, message;
  if (rsi < 30) {
    type = 'BUY'; strength = Math.min(100, Math.round((30 - rsi) / 30 * 100));
    message = `RSI ${rsi.toFixed(1)} – oversold (< 30). Potential bounce.`;
  } else if (rsi > 70) {
    type = 'SELL'; strength = Math.min(100, Math.round((rsi - 70) / 30 * 100));
    message = `RSI ${rsi.toFixed(1)} – overbought (> 70). Potential pullback.`;
  } else {
    message = `RSI ${rsi.toFixed(1)} – neutral zone (30–70).`;
  }
  return { type, strength, value: rsi, message, time: candles[candles.length - 1].time };
}

function signalFromMACD(candles) {
  if (candles.length < 35) return null;
  const closes = candles.map(c => c.close);
  const ema12  = computeEMASeries(closes, 12);
  const ema26  = computeEMASeries(closes, 26);
  const macdArr = [];
  for (let i = 0; i < closes.length; i++) {
    if (ema12[i] != null && ema26[i] != null) macdArr.push(ema12[i] - ema26[i]);
  }
  if (macdArr.length < 9) return null;
  const sigSeries = computeEMASeries(macdArr, 9);
  const validSig  = sigSeries.filter(v => v != null);
  if (validSig.length < 2) return null;

  const macd     = macdArr[macdArr.length - 1];
  const sigLine  = validSig[validSig.length - 1];
  const prevMacd = macdArr[macdArr.length - 2];
  const prevSig  = validSig[validSig.length - 2];
  const hist     = macd - sigLine;
  const prevHist = prevMacd - prevSig;
  const price    = closes[closes.length - 1];
  const strength = Math.min(100, Math.round(Math.abs(hist) / price * 10000));

  let type, message;
  if (prevHist <= 0 && hist > 0) {
    type = 'BUY';  message = 'MACD crossed above signal line. Bullish momentum.';
  } else if (prevHist >= 0 && hist < 0) {
    type = 'SELL'; message = 'MACD crossed below signal line. Bearish momentum.';
  } else {
    type    = hist >= 0 ? 'BUY' : 'SELL';
    message = `MACD ${hist >= 0 ? 'above' : 'below'} signal (hist ${hist >= 0 ? '+' : ''}${hist.toFixed(2)}). ${hist >= 0 ? 'Bullish' : 'Bearish'} bias.`;
  }
  return { type, strength, value: macd, histogram: hist, signalLine: sigLine, message,
    time: candles[candles.length - 1].time };
}

function signalFromBollinger(candles, period = 20, mult = 2) {
  if (candles.length < period) return null;
  const closes = candles.slice(-period).map(c => c.close);
  const mean   = closes.reduce((a, b) => a + b, 0) / period;
  const std    = Math.sqrt(closes.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  const upper  = mean + mult * std;
  const lower  = mean - mult * std;
  const price  = candles[candles.length - 1].close;
  let type = null, strength = 0, message;
  if (price < lower) {
    type = 'BUY';
    strength = Math.min(100, Math.round((lower - price) / std * 50));
    message  = `Price below lower band ($${lower.toFixed(2)}). Oversold condition.`;
  } else if (price > upper) {
    type = 'SELL';
    strength = Math.min(100, Math.round((price - upper) / std * 50));
    message  = `Price above upper band ($${upper.toFixed(2)}). Overbought condition.`;
  } else {
    const pct = ((price - lower) / (upper - lower) * 100).toFixed(0);
    message   = `Price within bands at ${pct}% of range. Width: ${(4 * std / mean * 100).toFixed(2)}%.`;
  }
  return { type, strength, value: price, upper, middle: mean, lower, message,
    time: candles[candles.length - 1].time };
}

function signalFromStochastic(candles, kPeriod = 14, dPeriod = 3) {
  if (candles.length < kPeriod + dPeriod + 1) return null;
  const kArr = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const sl = candles.slice(i - kPeriod + 1, i + 1);
    const hi = Math.max(...sl.map(c => c.high));
    const lo = Math.min(...sl.map(c => c.low));
    kArr.push(hi === lo ? 50 : (candles[i].close - lo) / (hi - lo) * 100);
  }
  if (kArr.length < dPeriod + 1) return null;
  const k     = kArr[kArr.length - 1];
  const d     = kArr.slice(-dPeriod).reduce((a, b) => a + b, 0) / dPeriod;
  const prevK = kArr[kArr.length - 2];
  const prevD = kArr.slice(-dPeriod - 1, -1).reduce((a, b) => a + b, 0) / dPeriod;
  let type = null, strength = 0, message;
  if (k < 20) {
    type = 'BUY';  strength = Math.min(100, Math.round((20 - k) / 20 * 100));
    message = `%K ${k.toFixed(1)} / %D ${d.toFixed(1)} – oversold (< 20).`;
  } else if (k > 80) {
    type = 'SELL'; strength = Math.min(100, Math.round((k - 80) / 20 * 100));
    message = `%K ${k.toFixed(1)} / %D ${d.toFixed(1)} – overbought (> 80).`;
  } else if (prevK <= prevD && k > d) {
    type = 'BUY';  strength = 25;
    message = `%K crossed above %D (${k.toFixed(1)} vs ${d.toFixed(1)}). Bullish crossover.`;
  } else if (prevK >= prevD && k < d) {
    type = 'SELL'; strength = 25;
    message = `%K crossed below %D (${k.toFixed(1)} vs ${d.toFixed(1)}). Bearish crossover.`;
  } else {
    message = `%K ${k.toFixed(1)} / %D ${d.toFixed(1)} – neutral zone (20–80).`;
  }
  return { type, strength, k, d, message, time: candles[candles.length - 1].time };
}

function signalFromEMACross(candles, fast = 9, slow = 21) {
  if (candles.length < slow + 2) return null;
  const closes  = candles.map(c => c.close);
  const fastArr = computeEMASeries(closes, fast);
  const slowArr = computeEMASeries(closes, slow);
  const n = closes.length;
  const fNow = fastArr[n - 1], sNow = slowArr[n - 1];
  const fPrv = fastArr[n - 2], sPrv = slowArr[n - 2];
  if (fNow == null || sNow == null || fPrv == null || sPrv == null) return null;
  const price    = closes[n - 1];
  const spread   = (fNow - sNow) / price * 100;
  const strength = Math.min(100, Math.round(Math.abs(spread) * 20));
  let type, message;
  if (fPrv <= sPrv && fNow > sNow) {
    type = 'BUY';
    message = `EMA${fast} crossed above EMA${slow} (golden cross). Spread: ${spread.toFixed(3)}%.`;
  } else if (fPrv >= sPrv && fNow < sNow) {
    type = 'SELL';
    message = `EMA${fast} crossed below EMA${slow} (death cross). Spread: ${spread.toFixed(3)}%.`;
  } else {
    type    = fNow >= sNow ? 'BUY' : 'SELL';
    message = `EMA${fast} ($${fNow.toFixed(2)}) ${fNow >= sNow ? '>' : '<'} EMA${slow} ($${sNow.toFixed(2)}). ${fNow >= sNow ? 'Bullish' : 'Bearish'} trend.`;
  }
  return { type, strength, fastEMA: fNow, slowEMA: sNow, message,
    time: candles[candles.length - 1].time };
}

/** Computes all technical signals and returns them as a named object. */
function computeAllSignals(candles) {
  return {
    fibonacci  : signalFromFibonacci(candles),
    rsi        : signalFromRSI(candles),
    macd       : signalFromMACD(candles),
    bollinger  : signalFromBollinger(candles),
    stochastic : signalFromStochastic(candles),
    ema_cross  : signalFromEMACross(candles),
  };
}

// Signal definitions (id → display name) used for notifications
const SIGNAL_DEFS = [
  { id: 'fibonacci',  name: 'Fibonacci'      },
  { id: 'rsi',        name: 'RSI'            },
  { id: 'macd',       name: 'MACD'           },
  { id: 'bollinger',  name: 'Bollinger Bands'},
  { id: 'stochastic', name: 'Stochastic'     },
  { id: 'ema_cross',  name: 'EMA Cross'      },
];

// ─── Message Handler ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'FETCH_NOW') {
    fetchAndAnalyze();
  }
  if (msg?.type === 'SET_INTERVAL') {
    const key = msg.interval && INTERVAL_CONFIGS[msg.interval]
      ? msg.interval : DEFAULT_INTERVAL;
    chrome.storage.local.set({ selectedInterval: key }, async () => {
      await updateAlarm(key);
      fetchAndAnalyze();
    });
  }
});

// ─── Main Loop ────────────────────────────────────────────────────────────
async function fetchAndAnalyze() {
  const result = await fetchGoldData();
  if (!result) {
    // Record fetch failure so popup can show an error state
    await chrome.storage.local.set({ fetchError: true, lastUpdate: Date.now() });
    return;
  }
  await chrome.storage.local.set({ fetchError: false });

  const { candles } = result;

  const fib      = calcFibonacci(candles);
  const signals  = computeAllSignals(candles);
  const forecast = calcForecast(candles);
  const price    = candles[candles.length - 1].close;
  const fibSig   = signals.fibonacci;

  // Persist data so popup and chart page can read it
  await chrome.storage.local.set({
    candles   : candles.slice(-120),
    fib,
    signals,
    forecast,
    price,
    lastUpdate: Date.now(),
    // Keep lastSignal (Fibonacci) for chart.js backward-compat
    lastSignal: fibSig?.type
      ? { type: fibSig.type, price: fibSig.value, fibRatio: fibSig.fibRatio,
          fibPrice: fibSig.fibPrice, proximity: fibSig.proximity,
          message: fibSig.message, time: fibSig.time }
      : null,
  });

  // Badge = current gold price
  chrome.action.setBadgeText({ text: '$' + Math.round(price) });
  chrome.action.setBadgeBackgroundColor({ color: '#B8860B' });

  // Per-signal notifications (each independently debounced + threshold-gated)
  const { signalSettings = {}, lastNotifyTimes = {} } =
    await chrome.storage.local.get(['signalSettings', 'lastNotifyTimes']);
  const now            = Date.now();
  const newNotifyTimes = { ...lastNotifyTimes };

  for (const { id, name } of SIGNAL_DEFS) {
    const sig = signals[id];
    const cfg = { notify: id !== 'ema_cross', threshold: 5,
                  ...(signalSettings[id] || {}) };
    if (!sig?.type || !cfg.notify) continue;
    if ((sig.strength ?? 0) < (cfg.threshold ?? 0)) continue;
    if (now - (newNotifyTimes[id] ?? 0) < DEBOUNCE_MS) continue;

    newNotifyTimes[id] = now;
    chrome.notifications.create(`fibo-${id}`, {
      type   : 'basic',
      iconUrl: 'icons/icon128.png',
      title  : `${name} – ${sig.type} Signal`,
      message: sig.message,
    });

    // Open chart tab only for Fibonacci (original behaviour)
    if (id === 'fibonacci') {
      chrome.tabs.create({ url: chrome.runtime.getURL('chart.html') });
    }
  }

  await chrome.storage.local.set({ lastNotifyTimes: newNotifyTimes });
}
