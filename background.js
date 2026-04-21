/**
 * background.js – Service Worker
 *
 * Fetches real-time gold (XAU/USD) data from Stooq (stooq.com),
 * calculates Fibonacci retracement levels, detects reversal signals,
 * and opens a chart tab whenever a new signal fires.
 */

// ─── Configuration ────────────────────────────────────────────────────────────
const GOLD_SYMBOL      = 'xauusd';  // Stooq symbol for XAU/USD
const FETCH_PERIOD_MIN = 1;      // how often to poll (minutes)
const DEBOUNCE_MS      = 10 * 60 * 1000; // 10 minutes between tab openings

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
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('fetchGoldData', { periodInMinutes: FETCH_PERIOD_MIN });
  fetchAndAnalyze();
});

chrome.runtime.onStartup.addListener(() => {
  fetchAndAnalyze();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'fetchGoldData') fetchAndAnalyze();
});

// ─── Data Fetching ─────────────────────────────────────────────────────────
/** Returns a date string in YYYYMMDD format required by the Stooq API. */
function fmtDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function fetchGoldData() {
  // Stooq free CSV API – no API key, globally accessible
  // Hourly (i=h) candles for the last ~8 calendar days (covers weekends)
  const now  = new Date();
  const past = new Date(now);
  past.setDate(past.getDate() - 8);

  const url =
    `https://stooq.com/q/d/l/?s=${GOLD_SYMBOL}&i=h` +
    `&d1=${fmtDate(past)}&d2=${fmtDate(now)}`;

  try {
    const res = await fetch(url);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text  = await res.text();
    const lines = text.trim().split('\n');

    // First line is the CSV header: Date,Time,Open,High,Low,Close,Volume
    if (lines.length < 2) throw new Error('empty response from Stooq');

    const candles = lines.slice(1)
      .map(line => {
        const [date, time, open, high, low, close, volume] = line.split(',');
        return {
          time  : new Date(`${date}T${time}Z`).getTime(),
          open  : parseFloat(open),
          high  : parseFloat(high),
          low   : parseFloat(low),
          close : parseFloat(close),
          volume: parseFloat(volume) || 0,
        };
      })
      .filter(c => !isNaN(c.time) && c.open != null && c.high != null &&
                   c.low != null && c.close != null &&
                   !isNaN(c.open) && !isNaN(c.close));

    if (candles.length === 0) throw new Error('no valid candles in Stooq response');

    return candles;
  } catch (err) {
    console.error('[FiboGold] Stooq fetch error:', err);
    return null;
  }
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

// ─── Message Handler (e.g. Refresh button in popup/chart) ────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'FETCH_NOW') fetchAndAnalyze();
});

// ─── Main Loop ────────────────────────────────────────────────────────────
async function fetchAndAnalyze() {
  const candles = await fetchGoldData();
  if (!candles || candles.length === 0) return;

  const fib      = calcFibonacci(candles);
  const signal   = detectSignal(candles, fib);
  const forecast = calcForecast(candles);
  const price    = candles[candles.length - 1].close;

  // Persist data so popup and chart page can read it
  await chrome.storage.local.set({
    candles    : candles.slice(-120), // keep last 120 candles
    fib,
    forecast,
    price,
    lastUpdate : Date.now(),
    lastSignal : signal || null,
  });

  // Badge = current gold price
  chrome.action.setBadgeText({ text: '$' + Math.round(price) });
  chrome.action.setBadgeBackgroundColor({ color: '#B8860B' });

  // Open chart tab when a new signal fires (debounced)
  if (signal) {
    const { lastSignalTime = 0 } = await chrome.storage.local.get('lastSignalTime');
    const now = Date.now();

    if (now - lastSignalTime > DEBOUNCE_MS) {
      await chrome.storage.local.set({ lastSignalTime: now });

      chrome.tabs.create({ url: chrome.runtime.getURL('chart.html') });

      chrome.notifications.create('fibo-signal', {
        type   : 'basic',
        iconUrl: 'icons/icon128.png',
        title  : `Fibonacci Gold Signal – ${signal.type}`,
        message: signal.message,
      });
    }
  }
}
