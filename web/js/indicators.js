// 전종목 on-demand 기술분석용 — compute_indicators.py + deterministic_scoring.py(기술)를 JS로 이식.
// Worker /ohlcv로 받은 캔들(rows)로 지표·리스크·지지저항·1~5점을 브라우저에서 즉석 계산해,
// 파이썬 사전생성본과 동일한 형태의 객체를 만들어 renderTechnical에 그대로 먹인다.
// 워치리스트 120종목은 여전히 사전생성(JSON)을 쓰고, 그 밖의 전종목은 이 경로를 쓴다.

const MA_PERIODS = [5, 20, 60, 120];
const RSI_PERIOD = 14, BB_WINDOW = 20, VOL_WINDOW = 20, LOW_VOL_RATIO = 0.3;
const TRADING_YEAR = 252, WEEK52_WINDOW = 250;

function _round(v, d = 4) {
  if (v == null || !isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function _smaSeries(arr, p) {
  const out = new Array(arr.length).fill(null);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    s += arr[i];
    if (i >= p) s -= arr[i - p];
    if (i >= p - 1) out[i] = s / p;
  }
  return out;
}

function _emaSeries(arr, span) {
  const k = 2 / (span + 1);
  const out = new Array(arr.length).fill(null);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    prev = prev == null ? arr[i] : arr[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function _stdSeries(arr, p) {
  const out = new Array(arr.length).fill(null);
  for (let i = p - 1; i < arr.length; i++) {
    let m = 0;
    for (let k = i - p + 1; k <= i; k++) m += arr[k];
    m /= p;
    let v = 0;
    for (let k = i - p + 1; k <= i; k++) v += (arr[k] - m) ** 2;
    out[i] = Math.sqrt(v / p); // 모표준편차(ddof=0) — 파이썬과 동일
  }
  return out;
}

// RSI (Wilder). pandas ewm(alpha=1/period, adjust=False, min_periods=period)와 근사.
function _rsiSeries(close) {
  const n = close.length, out = new Array(n).fill(null);
  if (n < 2) return out;
  const a = 1 / RSI_PERIOD;
  let eg = null, el = null;
  for (let i = 0; i < n; i++) {
    const delta = i === 0 ? 0 : close[i] - close[i - 1];
    const gain = Math.max(delta, 0), loss = Math.max(-delta, 0);
    eg = eg == null ? gain : gain * a + eg * (1 - a);
    el = el == null ? loss : loss * a + el * (1 - a);
    if (i >= RSI_PERIOD) {
      if (el === 0) out[i] = 100;
      else out[i] = 100 - 100 / (1 + eg / el);
    }
  }
  return out;
}

function _detectRecentCross(fast, slow, lookback = 10) {
  const diff = [];
  for (let i = 0; i < fast.length; i++) {
    if (fast[i] != null && slow[i] != null) diff.push(fast[i] - slow[i]);
  }
  if (diff.length < 2) return { occurred: false, days_ago: null, direction: null };
  const recent = diff.slice(-(lookback + 1));
  const sign = recent.map((v) => Math.sign(v));
  for (let i = sign.length - 1; i > 0; i--) {
    if (sign[i - 1] < 0 && sign[i] > 0) return { occurred: true, days_ago: sign.length - 1 - i, direction: "golden" };
    if (sign[i - 1] > 0 && sign[i] < 0) return { occurred: true, days_ago: sign.length - 1 - i, direction: "dead" };
  }
  return { occurred: false, days_ago: null, direction: null };
}

function _maAlignment(latest) {
  const vals = MA_PERIODS.map((p) => latest[p]).filter((v) => v != null);
  if (vals.length < 3) return "insufficient_data";
  if (vals.every((v, i) => i === 0 || vals[i - 1] > v)) return "bullish";
  if (vals.every((v, i) => i === 0 || vals[i - 1] < v)) return "bearish";
  return "mixed";
}

function _stochastic(high, low, close, kP = 14, dP = 3, slowP = 3) {
  const n = close.length, fastK = new Array(n).fill(null);
  for (let i = kP - 1; i < n; i++) {
    let lo = Infinity, hi = -Infinity;
    for (let k = i - kP + 1; k <= i; k++) { lo = Math.min(lo, low[k]); hi = Math.max(hi, high[k]); }
    fastK[i] = hi === lo ? null : (100 * (close[i] - lo)) / (hi - lo);
  }
  const slowK = _smaNullable(fastK, dP);
  const slowD = _smaNullable(slowK, slowP);
  return { slowK, slowD };
}
function _smaNullable(arr, p) {
  const out = new Array(arr.length).fill(null);
  for (let i = p - 1; i < arr.length; i++) {
    let s = 0, ok = true;
    for (let k = i - p + 1; k <= i; k++) { if (arr[k] == null) { ok = false; break; } s += arr[k]; }
    if (ok) out[i] = s / p;
  }
  return out;
}

function _classifyCandles(rows, n = 3) {
  const tail = rows.slice(-(n + 1)), results = [];
  for (let i = 1; i < tail.length; i++) {
    const cur = tail[i], prev = tail[i - 1];
    const body = Math.abs(cur.close - cur.open);
    const rng = Math.max(cur.high - cur.low, 1e-9);
    const bullish = cur.close > cur.open;
    const patterns = [];
    if (body <= rng * 0.1) patterns.push("doji");
    else if (body >= rng * 0.7) patterns.push(bullish ? "장대양봉" : "장대음봉");
    const pLow = Math.min(prev.open, prev.close), pHigh = Math.max(prev.open, prev.close);
    const cLow = Math.min(cur.open, cur.close), cHigh = Math.max(cur.open, cur.close);
    if (cLow <= pLow && cHigh >= pHigh && body > Math.abs(prev.close - prev.open)) {
      if (bullish && prev.close < prev.open) patterns.push("상승장악형");
      else if (!bullish && prev.close > prev.open) patterns.push("하락장악형");
    }
    results.push({ date: cur.date, bullish, body_to_range_ratio: _round(body / rng, 3), patterns });
  }
  return results.slice(-n);
}

function _computeRisk(rows) {
  const close = rows.map((r) => r.close), n = close.length;
  const rets = [];
  for (let i = 1; i < n; i++) if (close[i - 1]) rets.push(close[i] / close[i - 1] - 1);
  let vol = null;
  if (rets.length >= 20) {
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    const varr = rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length;
    vol = _round(Math.sqrt(varr) * Math.sqrt(TRADING_YEAR) * 100, 4);
  }
  let peak = -Infinity, mdd = 0;
  for (const c of close) { peak = Math.max(peak, c); mdd = Math.min(mdd, c / peak - 1); }
  const win = close.slice(-WEEK52_WINDOW);
  const hi = Math.max(...win), lo = Math.min(...win), last = close[n - 1];
  return {
    annualized_volatility_pct: vol,
    max_drawdown_pct: n >= 2 ? _round(mdd * 100, 4) : null,
    week52_high: _round(hi, 4), week52_low: _round(lo, 4),
    week52_position_pct: hi > lo ? _round(((last - lo) / (hi - lo)) * 100, 4) : null,
    period_return_pct: n >= 2 && close[0] ? _round((last / close[0] - 1) * 100, 4) : null,
    period_trading_days: n,
  };
}

function _supportResistance(rows, window = 120, k = 5) {
  const look = rows.slice(-window);
  if (look.length < 2 * k + 1) return { support: null, resistance: null };
  const highs = look.map((r) => r.high), lows = look.map((r) => r.low);
  const close = rows[rows.length - 1].close, sHigh = [], sLow = [];
  for (let i = k; i < look.length - k; i++) {
    let hmax = -Infinity, lmin = Infinity;
    for (let j = i - k; j <= i + k; j++) { hmax = Math.max(hmax, highs[j]); lmin = Math.min(lmin, lows[j]); }
    if (highs[i] === hmax) sHigh.push(highs[i]);
    if (lows[i] === lmin) sLow.push(lows[i]);
  }
  const above = sHigh.filter((h) => h > close), below = sLow.filter((l) => l < close);
  const resistance = above.length ? Math.min(...above) : (sHigh.length ? Math.max(...sHigh) : null);
  const support = below.length ? Math.max(...below) : (sLow.length ? Math.min(...sLow) : null);
  return { support: _round(support, 4), resistance: _round(resistance, 4) };
}

// ---------- 기술점수(1~5) — deterministic_scoring.py 이식 ----------
const _clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function _trendSub(ind) {
  const ma = ind.moving_averages;
  let s = { bullish: 1.4, bearish: -1.4, mixed: 0.0, insufficient_data: 0.0 }[ma.alignment];
  const c = ma.ma5_ma20_cross_recent;
  if (c.occurred && c.days_ago != null) {
    const w = c.days_ago <= 5 ? 0.6 : c.days_ago <= 10 ? 0.3 : 0.0;
    s += c.direction === "golden" ? w : -w;
  }
  const mc = ind.macd.signal_cross_recent;
  if (mc.occurred && mc.days_ago != null) {
    const w = mc.days_ago <= 5 ? 0.4 : 0.2;
    s += mc.direction === "golden" ? w : -w;
  }
  if (ind.macd.above_zero === true) s += 0.2;
  else if (ind.macd.above_zero === false) s -= 0.2;
  return _clamp(s, -2, 2);
}
function _momentumSub(ind) {
  let base = 0;
  const rsi = ind.rsi14;
  if (rsi.latest != null) {
    base = _clamp((rsi.latest - 50) / 25, -2, 2);
    if (rsi.zone === "overbought") base = Math.min(base, 1.0);
    else if (rsi.zone === "oversold") base = Math.max(base, -1.0);
  }
  let bb = 0;
  if (ind.bollinger.percent_b != null) bb = _clamp((ind.bollinger.percent_b - 0.5) * 2, -1.5, 1.5);
  return _clamp(0.6 * base + 0.4 * bb, -2, 2);
}
function _volumeSub(ind) {
  const r = ind.volume.ratio_to_avg20;
  if (r == null) return 0;
  const rec = ind.candles.recent;
  const dir = rec.length && rec[rec.length - 1].bullish ? 1 : -1;
  let s = _clamp(_clamp(r - 1, -1, 3) * dir, -2, 2);
  if (r < 0.5) s *= 0.5;
  return s;
}
function _candleSub(ind) {
  const rec = ind.candles.recent;
  if (!rec.length) return 0;
  const last = rec[rec.length - 1], strong = ["장대양봉", "상승장악형"], weak = ["장대음봉", "하락장악형"];
  if (last.patterns.some((p) => strong.includes(p))) return 1.5;
  if (last.patterns.some((p) => weak.includes(p))) return -1.5;
  if (last.patterns.includes("doji")) return 0;
  return last.bullish ? 0.3 : -0.3;
}
function _score(ind) {
  let trend = _trendSub(ind), momentum = _momentumSub(ind);
  const volume = _volumeSub(ind), candle = _candleSub(ind);
  if (ind.volume.abnormally_low) { trend *= 0.7; momentum *= 0.7; }
  const weighted = 0.4 * trend + 0.3 * momentum + 0.2 * volume + 0.1 * candle;
  return {
    score: Math.round(_clamp(3 + weighted, 1, 5)),
    category_subscores: { trend: _round(trend, 3), momentum_volatility: _round(momentum, 3), volume: _round(volume, 3), candle: _round(candle, 3) },
  };
}

// ---------- 메인: rows → 사전생성본과 동일 형태의 technical 데이터 ----------
function computeTechnicalFromRows(code, name, rows) {
  if (!rows || rows.length < 20) return { status: "error", code, name, reason: `데이터 부족(${rows ? rows.length : 0}일 < 20일)` };
  const close = rows.map((r) => r.close), high = rows.map((r) => r.high), low = rows.map((r) => r.low), vol = rows.map((r) => r.volume);
  const n = rows.length, last = n - 1, warnings = [];

  const maSeries = {}, latestMa = {};
  for (const p of MA_PERIODS) { maSeries[p] = _smaSeries(close, p); latestMa[p] = _round(maSeries[p][last]); }

  const ema12 = _emaSeries(close, 12), ema26 = _emaSeries(close, 26);
  const macdLine = close.map((_, i) => (ema12[i] != null && ema26[i] != null ? ema12[i] - ema26[i] : null));
  const signal = _emaSeries(macdLine.map((v) => v ?? 0), 9);
  const hist = macdLine.map((v, i) => (v != null ? v - signal[i] : null));

  const rsi = _rsiSeries(close);
  const rsiLatest = _round(rsi[last]);
  const rsiZone = rsiLatest == null ? null : rsiLatest >= 70 ? "overbought" : rsiLatest <= 30 ? "oversold" : "neutral";

  const mid = maSeries[20], std20 = _stdSeries(close, BB_WINDOW);
  const upper = mid.map((m, i) => (m != null && std20[i] != null ? m + 2 * std20[i] : null));
  const lower = mid.map((m, i) => (m != null && std20[i] != null ? m - 2 * std20[i] : null));
  const pctB = upper[last] != null && upper[last] !== lower[last] ? (close[last] - lower[last]) / (upper[last] - lower[last]) : null;
  const bw = mid[last] ? (upper[last] - lower[last]) / mid[last] : null;

  const volMa20 = _smaSeries(vol, VOL_WINDOW);
  const volRatio = volMa20[last] ? _round(vol[last] / volMa20[last]) : null;
  const abLow = volRatio != null && volRatio < LOW_VOL_RATIO;

  const { slowK, slowD } = _stochastic(high, low, close);

  const indicators = {
    status: "ok",
    latest_close: _round(close[last]),
    moving_averages: Object.assign(
      Object.fromEntries(MA_PERIODS.map((p) => [`ma${p}`, { latest: latestMa[p] }])),
      { alignment: _maAlignment(latestMa), ma5_ma20_cross_recent: _detectRecentCross(maSeries[5], maSeries[20], 10) }
    ),
    macd: {
      macd_latest: _round(macdLine[last]), signal_latest: _round(signal[last]), histogram_latest: _round(hist[last]),
      signal_cross_recent: _detectRecentCross(macdLine, signal, 10),
      above_zero: macdLine[last] != null ? macdLine[last] > 0 : null,
    },
    rsi14: { latest: rsiLatest, zone: rsiZone },
    stochastic: { k_latest: _round(slowK[last]), d_latest: _round(slowD[last]) },
    bollinger: { upper: _round(upper[last]), mid: _round(mid[last]), lower: _round(lower[last]), percent_b: _round(pctB), bandwidth: _round(bw) },
    volume: { latest: vol[last], avg20: _round(volMa20[last]), ratio_to_avg20: volRatio, abnormally_low: abLow },
    candles: { recent: _classifyCandles(rows, 3) },
    risk: _computeRisk(rows),
    levels: _supportResistance(rows),
    warnings,
  };
  if (abLow) warnings.push("거래량이 20일 평균의 30% 미만 — 가격지표 신뢰도 하향");

  const scored = _score(indicators);
  return {
    status: "ok", code, name,
    score: scored.score, category_subscores: scored.category_subscores,
    price_series: rows,
    indicators,
    warnings,
    on_demand: true, // 사전생성이 아니라 브라우저 즉석 계산본임을 표시
  };
}
