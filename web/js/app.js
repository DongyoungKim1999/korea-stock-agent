// AI 투자 에이전트 대시보드 — web/data/*.json(자동 생성 정적 데이터)을 읽어 렌더링만 수행한다.
// build: 매매판단 컨텍스트 포함 (2026-08-06)
// 이 페이지는 정적 사이트라 실시간 LLM 대화는 없다 — 하단 어시스턴트는 안내 메시지만 표시한다.

const state = {
  watchlist: [],
  watchlistCodes: new Set(),
  companyIndex: [],   // 코스피+코스닥 전체 검색 인덱스 (data/company_index.json)
  meta: null,
  currentCode: null,
  currentRange: 300,
  techCache: {},
  fundCache: {},
  chartCache: {},     // code → 장기(≈5년) OHLCV rows (차트·패턴용, Worker /ohlcv)
  lastRenderedItems: [],
};

const RESULT_LIST_CAP = 60;

function humanizeWarnings(warnings) {
  // 스크립트 내부 함수명이 섞인 원본 로그성 문구를 일반 사용자에게 보여줄 문장으로 정리한다.
  const seen = new Set();
  const out = [];
  for (const w of warnings || []) {
    if (!w) continue;
    if (/시가총액/.test(w)) continue; // 참고용 부가정보라 UI에서는 숨김(분석에 영향 없음)
    if (/재시도\(\d+회?\)\s*소진|자동재시도/.test(w)) continue; // 내부 재시도 로그는 숨김
    const text = w;
    if (!seen.has(text)) { seen.add(text); out.push(text); }
  }
  return out.join(" · ");
}

async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} (${res.status})`);
  return res.json();
}

function showToast(msg, ms = 3200) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1c2436;border:1px solid rgba(255,255,255,.14);color:#f2f4f8;padding:10px 18px;border-radius:999px;font-size:12.5px;z-index:200;max-width:80vw;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.4);";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = "1";
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.transition = "opacity .4s"; el.style.opacity = "0"; }, ms);
}

function openModal(html) {
  document.getElementById("modal-body").innerHTML = html;
  document.getElementById("modal").hidden = false;
}
function wireModal() {
  document.getElementById("modal-close").onclick = () => (document.getElementById("modal").hidden = true);
  document.getElementById("modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") document.getElementById("modal").hidden = true;
  });
}

// ---------- freshness ----------

function renderFreshness() {
  const bar = document.getElementById("freshness-bar");
  if (!bar) return;
  if (!state.meta) {
    bar.textContent = "아직 자동 데이터가 생성되지 않았습니다 — GitHub Actions 워크플로우가 최소 1회 실행되어야 합니다.";
    return;
  }
  const dt = new Date(state.meta.generated_at);
  const stamp = isNaN(dt) ? state.meta.generated_at : dt.toLocaleString("ko-KR", { hour12: false });
  const failed = Object.entries(state.meta.steps_ok || {}).filter(([, ok]) => !ok).map(([k]) => k);
  let text = `데이터 기준: ${stamp} · 워치리스트 ${state.meta.watchlist_count}종목 자동 갱신`;
  if (failed.length) text += ` · ⚠ 일부 갱신 실패: ${failed.join(", ")}`;
  bar.textContent = text;
}

// ---------- search / result list ----------

function searchUniverse() {
  // 검색은 전체 상장사 인덱스 대상. 아직 못 불러왔으면 워치리스트로 축소 동작.
  if (state.companyIndex.length) return state.companyIndex;
  return state.watchlist.map((w) => ({ ...w, has_detail: true }));
}

function renderResultList(items) {
  state.lastRenderedItems = items;
  const list = document.getElementById("result-list");
  list.innerHTML = "";
  if (items.length === 0) {
    list.innerHTML = '<li class="panel-empty">일치하는 종목이 없습니다</li>';
    return;
  }
  const capped = items.slice(0, RESULT_LIST_CAP);
  for (const item of capped) {
    const hasDetail = item.has_detail !== false;
    const li = document.createElement("li");
    li.className = "result-item" + (item.code === state.currentCode ? " active" : "");
    if (item.direct) li.dataset.direct = "1";
    const tag = item.direct
      ? `<span class="r-tag r-tag-muted">코드 직접조회</span>`
      : hasDetail
      ? `<span class="r-tag">${item.sector || "상세분석 지원"}</span>`
      : `<span class="r-tag r-tag-muted">상세분석 미지원</span>`;
    li.innerHTML = `
      <div class="r-title">${item.name} <span style="color:var(--text-muted);font-weight:400">${item.code}</span></div>
      <div class="r-meta">${tag}<span class="r-price" data-code="${item.code}"></span></div>`;
    li.onclick = () => selectStock(item.code);
    list.appendChild(li);
  }
  if (items.length > capped.length) {
    const more = document.createElement("li");
    more.className = "panel-empty";
    more.textContent = `외 ${items.length - capped.length}개 더 있음 — 검색어를 구체적으로 입력하면 좁혀집니다`;
    list.appendChild(more);
  }
  attachLivePreviews(list);
}

// 검색결과에 라이브 시세(현재가·등락)를 붙인다 — 화면에 보이는 항목만 지연 로딩(과도한 호출 방지).
let _resultObserver = null;
const RESULT_QUOTE_CAP = 40;

function attachLivePreviews(list) {
  if (typeof quoteUrl !== "function" || !quoteUrl("000000")) return; // Worker 미설정이면 미리보기 생략
  state.quotePreviewCache = state.quotePreviewCache || {};
  if (_resultObserver) { _resultObserver.disconnect(); _resultObserver = null; }
  let loaded = 0;
  _resultObserver = new IntersectionObserver((entries, obs) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      obs.unobserve(e.target);
      const span = e.target.querySelector(".r-price");
      if (span && loaded < RESULT_QUOTE_CAP) { loaded++; fillPreview(span.dataset.code, span); }
    }
  }, { threshold: 0.1 });
  list.querySelectorAll(".result-item").forEach((li) => _resultObserver.observe(li));
}

async function fillPreview(code, span) {
  if (!span || !code) return;
  const cache = state.quotePreviewCache;
  const q = cache[code] !== undefined ? cache[code] : (cache[code] = await fetchQuote(code));
  if (!q || q.price == null) return;
  // 코드 직접조회 항목은 이름이 코드로만 떠 있으니 라이브 데이터의 종목명으로 채운다
  const li = span.closest(".result-item");
  if (li && li.dataset.direct && q.name) {
    const t = li.querySelector(".r-title");
    if (t) t.innerHTML = `${_esc(q.name)} <span style="color:var(--text-muted);font-weight:400">${code}</span>`;
  }
  const up = q.change_pct > 0, down = q.change_pct < 0;
  const c = up ? "var(--candle-up)" : down ? "var(--candle-down)" : "var(--text-muted)";
  const arr = up ? "▲" : down ? "▼" : "–";
  const cap = q.market_cap_text ? `<span class="r-cap">${_esc(q.market_cap_text)}</span>` : "";
  span.innerHTML = `${Math.round(q.price).toLocaleString("ko-KR")} <span style="color:${c}">${arr}${Math.abs(q.change_pct ?? 0).toFixed(1)}%</span>${cap}`;
}

function updateSearchSummary(filteredCount, query) {
  const summary = document.getElementById("search-summary");
  const totalLabel = state.companyIndex.length ? `코스피·코스닥 전체 ${state.companyIndex.length}` : `워치리스트 ${state.watchlist.length}`;
  summary.textContent = query ? `검색 결과 "${query}" (${filteredCount})` : `전체 종목 (${totalLabel})`;
}

function wireSearch() {
  const input = document.getElementById("search-input");
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      updateSearchSummary(state.watchlist.length, "");
      renderResultList(state.watchlist);
      return;
    }
    const universe = searchUniverse();
    const filtered = universe.filter(
      (s) => s.name.toLowerCase().includes(q) || s.code.includes(q) || (s.sector || "").toLowerCase().includes(q)
    );
    // 상세분석 지원 종목을 검색결과 상단에 먼저 보여준다
    filtered.sort((a, b) => (b.has_detail !== false) - (a.has_detail !== false));

    // 숫자 코드를 치면 인덱스에 없어도 직접 조회 항목을 최상단에 추가한다 — 우선주·ETF 등
    // DART 기업목록엔 없지만 네이버 시세/차트는 되는 종목까지 코드로 조회 가능하게 하는 폴백.
    const asCode = /^\d{1,6}$/.test(input.value.trim()) ? input.value.trim().padStart(6, "0") : null;
    if (asCode && !filtered.some((s) => s.code === asCode)) {
      filtered.unshift({ code: asCode, name: asCode, sector: "코드 직접조회", has_detail: false, direct: true });
    }

    updateSearchSummary(filtered.length, input.value);
    renderResultList(filtered);
    if (filtered.length === 0) {
      showToast("일치하는 상장사를 찾을 수 없습니다. 종목명이나 6자리 코드로 다시 검색해보세요.");
    }
  });
}

// ---------- technical panel ----------

const TECH_LABELS = { bullish: "(상승 추세 · 정배열)", bearish: "(하락 추세 · 역배열)", mixed: "(혼조세)", insufficient_data: "" };

function scoreBadge(score) {
  if (score == null) return { text: "산출불가", cls: "" };
  if (score >= 4) return { text: "매수", cls: "" };
  if (score <= 2) return { text: "매도", cls: "critical" };
  return { text: "중립", cls: "warning" };
}

function displayIndicatorScore(kind, ind) {
  // 표/레이더 표시용 1~5 매핑. 종목 간 변별력을 위해 이산 버킷(예전엔 MA가 4.3/3.0/1.7 세 값뿐이라
  // 대부분 3.0에 뭉쳤다) 대신, 실제 지표값 크기에 비례하는 '연속·민감' 점수를 쓴다. (참고용 표시 점수)
  const clamp5 = (v) => Math.max(1, Math.min(5, v));
  const cl = (v, a, b) => Math.max(a, Math.min(b, v));
  const px = ind.latest_close || null;
  switch (kind) {
    case "ma": {
      const m = ind.moving_averages || {};
      const a = m.ma5 && m.ma5.latest, b = m.ma20 && m.ma20.latest, c = m.ma60 && m.ma60.latest;
      if (!a || !b || !c || !px) return ({ bullish: 4.3, mixed: 3.0, bearish: 1.7 }[m.alignment]) || 2.5;
      const spread = ((a - c) / c) * 100;  // 단기-장기 이격(%) — 추세의 방향·강도
      const pos = ((px - b) / b) * 100;     // 현재가의 20일선 대비 위치(%)
      return clamp5(3 + cl(spread * 0.6 + pos * 0.4, -8, 8) / 4);
    }
    case "macd": {
      const md = ind.macd || {};
      if (md.macd_latest == null || !px) return 2.5;
      const line = (md.macd_latest / px) * 100;                 // MACD선의 주가 대비 위치(%)
      const hist = ((md.histogram_latest || 0) / px) * 100;     // 히스토그램(모멘텀) 강도(%)
      let v = 3 + cl(line * 3, -1.3, 1.3) + cl(hist * 10, -1.3, 1.3);
      const cr = md.signal_cross_recent;
      if (cr && cr.occurred && cr.days_ago <= 5) v += cr.direction === "golden" ? 0.4 : -0.4;
      return clamp5(v);
    }
    case "rsi":
      // 50 기준 ±12로 1점 변동(예전 ±20보다 민감) — 45 vs 55도 점수 차이가 보이게
      return ind.rsi14.latest == null ? 2.5 : clamp5(3 + (ind.rsi14.latest - 50) / 12);
    case "bollinger":
      return ind.bollinger.percent_b == null ? 2.5 : clamp5(3 + (ind.bollinger.percent_b - 0.5) * 5);
    case "volume": {
      const r = ind.volume.ratio_to_avg20;
      if (r == null) return 2.5;
      if (ind.volume.abnormally_low) return 2.2;  // 거래 급감은 신뢰도 하향
      const rc = ind.candles.recent || [];
      const bullish = rc.length && rc[rc.length - 1].bullish;
      return clamp5(3 + cl((r - 1) * 1.6, -2, 2) * (bullish ? 1 : -1));
    }
    case "stochastic":
      // %K(0~100)를 1~5로 선형 매핑 (0→1, 50→3, 100→5)
      return ind.stochastic.k_latest == null ? 2.5 : clamp5(1 + ind.stochastic.k_latest / 25);
    default:
      return 2.5;
  }
}

function renderTechnical(data) {
  const warnEl = document.getElementById("tech-warning");
  if (!data || data.status !== "ok") {
    const delisted = data && data.status === "delisted";
    document.getElementById("tech-score-num").textContent = "-";
    document.getElementById("tech-score-badge").textContent =
      data && data.status === "unsupported" ? "미지원 종목" : delisted ? "상폐·거래정지 추정" : "데이터 없음";
    document.getElementById("tech-score-sub").textContent = "";
    renderGauge(3);
    document.getElementById("price-chart").innerHTML =
      data && data.status === "unsupported"
        ? '<div class="panel-empty">이 종목은 상시분석 대상(시가총액 상위 우량주)이 아니라 상세분석을 제공하지 않습니다.<br>Claude Code 에이전트에게 직접 물어보시면 이 종목도 분석해 드립니다.</div>'
        : delisted
        ? '<div class="panel-empty">📉 상장폐지·거래정지되었거나 거래되지 않는 종목으로 보입니다.<br>시세·차트·재무 데이터가 없어 분석을 제공할 수 없습니다.</div>'
        : '<div class="panel-empty">기술적분석 데이터를 아직 생성하지 못했습니다</div>';
    document.getElementById("indicator-table").innerHTML = "";
    clearRadar();
    renderRisk(null);
    renderLevels(null);
    renderRS(null);
    renderTradeContext(null);
    warnEl.textContent = data && data.reason ? `사유: ${data.reason}` : "";
    return;
  }

  document.getElementById("tech-score-num").textContent = data.score != null ? data.score.toFixed(1) : "-";
  const badge = scoreBadge(data.score);
  const badgeEl = document.getElementById("tech-score-badge");
  badgeEl.textContent = badge.text;
  badgeEl.className = "badge" + (badge.cls ? " " + badge.cls : "");
  document.getElementById("tech-score-sub").textContent = TECH_LABELS[data.indicators.moving_averages.alignment] || "";
  renderGauge(data.score);

  renderTechnicalChart(data);

  const ind = data.indicators;
  const rowsDef = [
    ["이동평균선 정배열", displayIndicatorScore("ma", ind)],
    ["MACD (12,26,9)", displayIndicatorScore("macd", ind)],
    ["RSI (14)", displayIndicatorScore("rsi", ind)],
    ["볼린저 밴드", displayIndicatorScore("bollinger", ind)],
    ["거래량 분석", displayIndicatorScore("volume", ind)],
    ["스토캐스틱 (14,3,3)", displayIndicatorScore("stochastic", ind)],
  ];
  const table = document.getElementById("indicator-table");
  table.innerHTML = rowsDef
    .map(([label, v]) => `<tr><td>${label}</td><td>${v.toFixed(1)}</td><td style="color:${v >= 3 ? "var(--good)" : "var(--critical)"}">${v >= 3 ? "▲" : "▼"}</td></tr>`)
    .join("");
  renderRadar(document.getElementById("indicator-radar"), rowsDef.map(([label, v]) => ({ label: label.split(" ")[0], value: v })));

  renderRisk(ind.risk);
  renderLevels(ind.levels, ind.latest_close);
  renderRiskReward(data.code); // 지지선 확보 — 목표주가(라이브)와 합쳐 손익비 산출
  applyRelativeStrength(data);  // 상대강도(vs 코스피) 반영 → 점수 재보정 + RS 표시
  warnEl.textContent = humanizeWarnings(data.warnings);
}

// 캔들 차트 렌더 + 패턴 마커. 장기(≈5년) 데이터를 우선 쓰되, 짧은 시계열밖에 없으면(워치리스트 300일)
// 우선 그걸로 즉시 그리고, 백그라운드로 Worker /ohlcv에서 장기 데이터를 받아 패턴과 함께 업그레이드한다.
function renderTechnicalChart(data) {
  const el = document.getElementById("price-chart");
  const code = data.code || state.currentCode;
  const base = state.chartCache[code] || data.price_series || [];
  const draw = (rows) => {
    const sliced = rows.slice(-state.currentRange);
    const patterns = typeof detectCandlePatterns === "function" ? detectCandlePatterns(sliced) : [];
    renderPriceChart(el, sliced, data.indicators && data.indicators.levels, patterns);
  };
  draw(base);
  if (!state.chartCache[code] && base.length < 800) {
    ensureChartRows(code, data.price_series).then((long) => {
      if (state.currentCode !== code || !long || long.length <= base.length) return;
      state.chartCache[code] = long;
      draw(long);
    });
  }
}

// 차트용 장기 OHLCV(≈5년)를 Worker /ohlcv에서 받아 캐시. 실패 시 넘겨받은 짧은 시계열로 폴백.
async function ensureChartRows(code, shortRows) {
  if (state.chartCache[code]) return state.chartCache[code];
  const url = typeof ohlcvUrl === "function" ? ohlcvUrl(code) : null;
  if (!url) return shortRows;
  try {
    const res = await fetch(url, { cache: "no-store" });
    const d = await res.json();
    const rows = d && Array.isArray(d.rows) ? d.rows : null;
    if (rows && rows.length) { state.chartCache[code] = rows; return rows; }
  } catch (_) {}
  return shortRows;
}

// ---------- 상대강도(RS) — 시장(코스피) 대비 수익률로 점수를 벌려 비교 가능하게 ----------

async function ensureKospi() {
  if (state.kospiSeries) return state.kospiSeries;
  if (state._kospiPromise) return state._kospiPromise;
  const url = typeof ohlcvUrl === "function" ? ohlcvUrl("KOSPI") : null;
  if (!url) { state.kospiSeries = []; return []; }
  state._kospiPromise = (async () => {
    try {
      const res = await fetch(url, { cache: "no-store" });
      const d = await res.json();
      state.kospiSeries = d && Array.isArray(d.rows) ? d.rows : [];
    } catch (e) { state.kospiSeries = []; }
    return state.kospiSeries;
  })();
  return state._kospiPromise;
}

function computeRS(priceSeries) {
  const k = state.kospiSeries;
  if (!k || !k.length || !priceSeries || priceSeries.length < 40) return null;
  const sp = priceSeries.map((r) => r.close), kp = k.map((r) => r.close);
  const rel = (N) => {
    if (sp.length < N || kp.length < N) return null;
    const sr = sp[sp.length - 1] / sp[sp.length - N] - 1;
    const kr = kp[kp.length - 1] / kp[kp.length - N] - 1;
    return (sr - kr) * 100; // %p
  };
  return { rs3m: rel(60), rs6m: rel(120) }; // ~3개월/6개월 거래일
}

// 절대 기술신호(4개 서브점수)에 상대강도를 더해 1~5로 재보정 — 시장 주도주/소외주를 벌린다.
function recalibratedScore(subs, rs) {
  if (!subs || !rs || rs.rs3m == null) return null;
  const base = 0.4 * (subs.trend || 0) + 0.3 * (subs.momentum_volatility || 0) + 0.2 * (subs.volume || 0) + 0.1 * (subs.candle || 0);
  const rsSub = Math.max(-2, Math.min(2, rs.rs3m / 12)); // ±24%p → ±2
  const blended = 0.55 * base + 0.45 * rsSub;
  return Math.round(Math.max(1, Math.min(5, 3 + 1.4 * blended)) * 10) / 10;
}

function renderRS(rs) {
  const el = document.getElementById("tech-rs");
  if (!rs || rs.rs3m == null) { el.textContent = ""; return; }
  const v = rs.rs3m;
  const label = v >= 15 ? "시장 대비 매우 강함(주도주)" : v >= 3 ? "시장 대비 강함" : v > -3 ? "시장과 비슷" : v > -15 ? "시장 대비 약함" : "시장 대비 매우 약함(소외주)";
  const c = v >= 3 ? "var(--good)" : v <= -3 ? "var(--critical)" : "var(--text-secondary)";
  el.innerHTML = `상대강도 <b style="color:${c}">${v >= 0 ? "+" : ""}${v.toFixed(0)}%p</b> <span style="color:var(--text-muted)">(3개월·vs 코스피)</span> · <span style="color:${c}">${label}</span>`;
}

async function applyRelativeStrength(data) {
  if (!data || data.status !== "ok" || !data.price_series) { renderRS(null); renderTradeContext(null); return; }
  const code = data.code;
  await ensureKospi();
  if (state.currentCode !== code) return; // 종목이 바뀌었으면 무시
  const rs = computeRS(data.price_series);
  renderRS(rs);
  const s = recalibratedScore(data.category_subscores, rs);
  if (s != null) {
    document.getElementById("tech-score-num").textContent = s.toFixed(1);
    renderGauge(s);
    const badge = scoreBadge(s);
    const be = document.getElementById("tech-score-badge");
    be.textContent = badge.text;
    be.className = "badge" + (badge.cls ? " " + badge.cls : "");
    data._displayScore = s; // 종합요약 태그에서 재사용
    if (state.currentCode === code) renderSummaryStrip(code); // 재보정 점수로 태그 갱신
  }
  renderTradeContext(buildTradeContext(data, rs)); // 매매 판단 컨텍스트(추세국면·계획·보유관리)
}

// ---------- 매매 판단 컨텍스트 — 점수가 아니라 '실제 의사결정'을 돕는 뷰 ----------
// 기술적 분석의 정직한 쓸모: ①추세의 옳은 편에 서기 ②리스크 정의된 매매계획 ③상대강도(모멘텀 팩터).
// price_series(OHLCV)만 있으면 워치리스트/온디맨드 모두에서 동일하게 계산된다(파이프라인 무관).

const _won = (v) => (v == null || !isFinite(v)) ? "-" : Math.round(v).toLocaleString("ko-KR");

function _atr(rows, period = 14) {
  if (!rows || rows.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < rows.length; i++) {
    const h = rows[i].high, l = rows[i].low, pc = rows[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function _avgValueTradedEok(rows, n = 20) {
  const recent = (rows || []).slice(-n);
  let sum = 0, cnt = 0;
  for (const r of recent) if (r.close && r.volume) { sum += r.close * r.volume; cnt++; }
  return cnt ? (sum / cnt) / 1e8 : null; // 원 → 억원
}

function buildTradeContext(data, rs) {
  const rows = data && data.price_series, ind = data && data.indicators;
  if (!rows || rows.length < 60 || !ind || ind.latest_close == null) return null;
  const close = ind.latest_close, ma = ind.moving_averages || {}, levels = ind.levels || {}, risk = ind.risk || {};
  const ma20 = ma.ma20 && ma.ma20.latest, ma60 = ma.ma60 && ma.ma60.latest, ma120 = ma.ma120 && ma.ma120.latest;
  const support = levels.support, resistance = levels.resistance;
  const atr = _atr(rows, 14), atrPct = (atr && close) ? atr / close * 100 : null;
  const d20 = (ma20 && close) ? (close / ma20 - 1) * 100 : null;

  // ── 추세 국면(다중 시간프레임): 단기 close vs 20일 · 중기 20>60 정배열 · 장기 close vs 120일 ──
  const longUp = (ma120 != null) ? close > ma120 : null;
  const midUp = (ma20 != null && ma60 != null) ? ma20 > ma60 : null;
  const shortUp = (ma20 != null) ? close > ma20 : null;
  let regime, regimeLabel, regimeColor;
  if (longUp && midUp) { regime = "up"; regimeLabel = "상승추세"; regimeColor = "var(--good)"; }
  else if (longUp === false && midUp === false) { regime = "down"; regimeLabel = "하락추세"; regimeColor = "var(--critical)"; }
  else { regime = "range"; regimeLabel = "혼조 · 방향 불명확"; regimeColor = "var(--warning)"; }

  // ── 상대강도(모멘텀 — 유일한 학술적 우위 팩터) ──
  const rsVal = rs ? rs.rs3m : null;
  const rsLabel = rsVal == null ? null
    : rsVal >= 10 ? "시장 주도주" : rsVal >= 2 ? "시장 대비 강세" : rsVal > -2 ? "시장과 비슷" : rsVal > -10 ? "시장 대비 약세" : "시장 소외주";

  // ── 타이밍 ──
  let timing;
  if (regime === "up") {
    if (d20 != null && d20 >= -3 && d20 <= 3) timing = "상승추세 중 눌림목 — 진입 관심 구간";
    else if (d20 != null && d20 > 10) timing = "20일선 대비 과열 — 눌림 기다림이 유리";
    else if (d20 != null && d20 < -3) timing = "20일선 하회 — 단기 약화, 지지 확인 필요";
    else timing = "상승추세 진행 중";
  } else if (regime === "down") timing = "하락추세 — 기술적 매수 근거 부족 (역추세 위험)";
  else timing = "박스권 — 지지 매수 / 저항 매도 관점";

  // ── 매매 시나리오(눌림목 매수 관점). 하락추세면 계획 제시하지 않음 ──
  // 진입은 '지지 근처(눌림)'로 잡아 손익비를 이상적 진입 기준으로 계산한다 — 현재가가 저항에 붙어 있으면
  // 지금 사는 게 아니라 '눌림 대기'가 정답이므로, 현재가 기준으로 계산해 손익비가 나빠 보이게 하지 않는다.
  let plan = null;
  if (regime !== "down" && support != null && resistance != null && atr != null && support < close && resistance > support) {
    const entry = support;                                        // 이상적 눌림 진입(지지 근처)
    const stop = support - Math.max(0.8 * atr, support * 0.02);   // 지지 하단
    const target = resistance;                                    // 박스 상단 저항
    if (stop < entry && target > entry) {
      const nearEntry = close <= support + 1.5 * atr;             // 현재가가 지지 근처면 지금 진입 관심
      plan = { entry, stop, target, rr: (target - entry) / (entry - stop), nearEntry,
               stopPct: (stop / entry - 1) * 100, targetPct: (target / entry - 1) * 100,
               distToEntry: (close / support - 1) * 100 };
    }
  }

  // ── 보유 관리 / 매도 신호 ──
  let manage;
  if (regime === "up") manage = (d20 != null && d20 > 12)
    ? "과열 구간 — 일부 차익실현 고려, 추격매수 자제. 20일선 회귀 시 재평가"
    : `추세 유지 → 보유. 60일선(${_won(ma60)}) 이탈 시 추세훼손으로 매도 고려`;
  else if (regime === "down") manage = "하락추세 → 반등 시 비중축소 관점. 60일선·저항 회복 전 신규매수 자제";
  else manage = "박스권 → 지지 이탈 시 매도 / 저항 돌파+거래량 동반 시 추세전환 관찰";

  // ── 한 줄 판단 ──
  const rsp = rsLabel ? ` + ${rsLabel}` : "";
  let oneLiner;
  if (regime === "up" && plan && plan.nearEntry)
    oneLiner = `상승추세${rsp} + 지지 근접 → ${_won(plan.entry)} 부근 진입 관심, ${_won(plan.stop)}(${plan.stopPct.toFixed(0)}%) 이탈 시 손절 (목표 ${_won(plan.target)})`;
  else if (regime === "up" && plan)
    oneLiner = `상승추세${rsp} 이나 지지보다 ${plan.distToEntry.toFixed(0)}% 위 → ${_won(plan.entry)} 눌림 기다렸다 진입, 추격 자제`;
  else if (regime === "up")
    oneLiner = `상승추세${rsp} → 지지 형성 후 눌림목 진입 관점`;
  else if (regime === "down")
    oneLiner = `하락추세${rsp} → 기술적 매수 근거 부족, 관망. 60일선 회복 전 신규진입 위험`;
  else if (plan)
    oneLiner = `박스권${rsp} → ${_won(plan.entry)} 지지 매수 / ${_won(plan.target)} 저항 매도, 돌파 시 추세추종`;
  else
    oneLiner = `박스권${rsp} → 방향성 확인 전 관망`;

  return { regime, regimeLabel, regimeColor, longUp, midUp, shortUp, d20, close,
           rsVal, rsLabel, support, resistance, atrPct, valEok: _avgValueTradedEok(rows, 20),
           w52: risk.week52_position_pct, timing, plan, manage, oneLiner, ma20, ma60, ma120 };
}

function renderTradeContext(ctx) {
  const el = document.getElementById("trade-context");
  if (!el) return;
  if (!ctx) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  const tf = (name, up) => `<span style="color:${up == null ? "var(--text-muted)" : up ? "var(--good)" : "var(--critical)"}">${name}${up == null ? " -" : up ? " ▲" : " ▼"}</span>`;
  const rsColor = ctx.rsVal == null ? "var(--text-secondary)" : ctx.rsVal >= 2 ? "var(--good)" : ctx.rsVal <= -2 ? "var(--critical)" : "var(--text-secondary)";
  const liq = ctx.valEok == null ? "" : `<span class="tc-cell"><span class="tc-k">거래대금</span>${ctx.valEok >= 10000 ? (ctx.valEok / 10000).toFixed(1) + "조" : Math.round(ctx.valEok).toLocaleString("ko-KR") + "억"}/일${ctx.valEok < 10 ? ' <b style="color:var(--warning)">⚠유동성낮음</b>' : ""}</span>`;

  let planHtml;
  if (ctx.plan) {
    const p = ctx.plan, rr = p.rr;
    const rrColor = rr == null ? "var(--text-secondary)" : rr >= 2 ? "var(--good)" : rr >= 1 ? "var(--warning)" : "var(--critical)";
    const rrVerdict = rr == null ? "" : rr >= 2 ? "양호" : rr >= 1 ? "보통" : "불리";
    const status = p.nearEntry
      ? `<b style="color:var(--good)">✅ 현재 진입 관심권</b>`
      : `<b style="color:var(--warning)">⏳ 눌림 대기</b> <span class="tc-muted">(지지보다 +${p.distToEntry.toFixed(0)}%)</span>`;
    planHtml = `<div class="tc-plan">
      <div class="tc-plan-title">📋 매매 시나리오 <span class="tc-muted">(눌림목 매수)</span> · ${status}</div>
      <div class="tc-plan-grid">
        <span><span class="tc-k">진입</span>${_won(p.entry)} 부근 <span class="tc-muted">(지지)</span></span>
        <span><span class="tc-k">손절</span><b style="color:var(--critical)">${_won(p.stop)}</b> (${p.stopPct.toFixed(0)}%)</span>
        <span><span class="tc-k">목표</span><b style="color:var(--good)">${_won(p.target)}</b> (+${p.targetPct.toFixed(0)}%)</span>
        <span><span class="tc-k">손익비</span><b style="color:${rrColor}">${rr == null ? "-" : rr.toFixed(1) + " : 1"}</b> ${rrVerdict}</span>
      </div></div>`;
  } else {
    planHtml = `<div class="tc-plan tc-noplan">📋 매매 시나리오: <b>제시 안 함</b> — ${ctx.regime === "down" ? "하락추세라 기술적 진입 근거가 부족합니다(역추세 매수 위험)." : "지지·저항이 불명확합니다."}</div>`;
  }

  el.innerHTML = `
    <div class="tc-regime" style="border-left:3px solid ${ctx.regimeColor}">
      <span class="tc-regime-label" style="color:${ctx.regimeColor}">${ctx.regimeLabel}</span>
      <span class="tc-tf">${tf("단기", ctx.shortUp)} · ${tf("중기", ctx.midUp)} · ${tf("장기", ctx.longUp)}</span>
    </div>
    <div class="tc-signals">
      <span class="tc-cell"><span class="tc-k">상대강도</span><b style="color:${rsColor}">${ctx.rsVal == null ? "-" : (ctx.rsVal >= 0 ? "+" : "") + ctx.rsVal.toFixed(0) + "%p"}</b> ${ctx.rsLabel || ""}</span>
      <span class="tc-cell"><span class="tc-k">위치</span>지지 ${_won(ctx.support)} · 저항 ${_won(ctx.resistance)}${ctx.w52 != null ? ` · 52주 ${ctx.w52.toFixed(0)}%` : ""}</span>
      ${liq}
    </div>
    <div class="tc-timing">⏱ ${ctx.timing}</div>
    ${planHtml}
    <div class="tc-manage">📌 <span class="tc-k">보유관리</span>${ctx.manage}</div>
    <div class="tc-oneliner">💡 ${ctx.oneLiner}</div>`;
}

// ---------- 손익비 (Risk/Reward): 목표주가(컨센서스) vs 지지선 ----------

function renderRiskReward(code) {
  const block = document.getElementById("rr-block");
  if (!block) return;
  const tech = state.techCache[code];
  const q = state.currentQuote;
  const support = tech && tech.status === "ok" && tech.indicators.levels ? tech.indicators.levels.support : null;
  const target = q && q.target_price != null ? q.target_price : null;
  const price = (q && q.price != null) ? q.price
    : (tech && tech.status === "ok" ? tech.indicators.latest_close : null);

  // 손익비가 의미 있으려면 지지 < 현재가 < 목표 여야 한다(아니면 이미 목표 근접/지지 이탈 → 숨김)
  if (support == null || target == null || price == null || !(support < price && price < target)) {
    block.hidden = true;
    return;
  }
  const upside = (target - price) / price * 100;
  const downside = (price - support) / price * 100;
  const rr = (target - price) / (price - support);
  const total = target - support;
  const curPos = (price - support) / total * 100;

  document.getElementById("rr-fill-down").style.width = `${curPos}%`;
  document.getElementById("rr-fill-up").style.width = `${100 - curPos}%`;
  document.getElementById("rr-marker").style.left = `${curPos}%`;
  const fmt = (v) => Math.round(v).toLocaleString("ko-KR");
  document.getElementById("rr-support").textContent = fmt(support);
  document.getElementById("rr-target").textContent = fmt(target);
  document.getElementById("rr-current").textContent = fmt(price);

  const verdict = rr >= 3 ? "매우 양호" : rr >= 2 ? "양호" : rr >= 1 ? "보통" : "불리";
  const vc = rr >= 2 ? "var(--good)" : rr >= 1 ? "var(--warning)" : "var(--critical)";
  document.getElementById("rr-verdict").innerHTML =
    `상승여력 <b style="color:var(--good)">+${upside.toFixed(0)}%</b> · ` +
    `하락위험 <b style="color:var(--critical)">-${downside.toFixed(0)}%</b> · ` +
    `손익비 <b style="color:${vc}">${rr.toFixed(1)} : 1</b> <span style="color:${vc};font-weight:700">${verdict}</span>`;
  block.hidden = false;
}

function renderLevels(levels, close) {
  const sEl = document.getElementById("lv-support");
  const rEl = document.getElementById("lv-resistance");
  const fmt = (v) => (v == null ? "-" : Math.round(v).toLocaleString("ko-KR"));
  sEl.textContent = levels ? fmt(levels.support) : "-";
  rEl.textContent = levels ? fmt(levels.resistance) : "-";
  // 현재가와의 거리(%)를 툴팁으로
  if (levels && close) {
    if (levels.support) sEl.title = `현재가 대비 ${((levels.support / close - 1) * 100).toFixed(1)}%`;
    if (levels.resistance) rEl.title = `현재가 대비 +${((levels.resistance / close - 1) * 100).toFixed(1)}%`;
  }
}

// ---------- risk panel ----------

function volatilityBand(volPct) {
  // 국내 개별주 연변동성 대략적 감각: 20 미만 낮음 / 20~40 보통 / 40~60 높음 / 60+ 매우 높음
  if (volPct == null) return { label: "", cls: "" };
  if (volPct < 20) return { label: "낮음", cls: "risk-low" };
  if (volPct < 40) return { label: "보통", cls: "risk-mid" };
  if (volPct < 60) return { label: "높음", cls: "risk-high" };
  return { label: "매우 높음", cls: "risk-vhigh" };
}

function renderRisk(risk) {
  const volEl = document.getElementById("risk-vol");
  const volNote = document.getElementById("risk-vol-note");
  const mddEl = document.getElementById("risk-mdd");
  const posEl = document.getElementById("risk-pos");
  const fill = document.getElementById("risk-52-fill");
  if (!risk) {
    volEl.textContent = mddEl.textContent = posEl.textContent = "-";
    volNote.textContent = "";
    volEl.className = "risk-tile-value";
    if (fill) fill.style.width = "0%";
    return;
  }
  const vol = risk.annualized_volatility_pct;
  const band = volatilityBand(vol);
  volEl.textContent = vol == null ? "-" : `${vol.toFixed(1)}%`;
  volEl.className = "risk-tile-value " + band.cls;
  volNote.textContent = band.label;

  mddEl.textContent = risk.max_drawdown_pct == null ? "-" : `${risk.max_drawdown_pct.toFixed(1)}%`;
  mddEl.className = "risk-tile-value risk-high";

  const pos = risk.week52_position_pct;
  posEl.textContent = pos == null ? "-" : `${pos.toFixed(0)}%`;
  posEl.className = "risk-tile-value";
  if (fill) fill.style.width = `${pos == null ? 0 : Math.max(0, Math.min(100, pos))}%`;
}

// ---------- fundamental panel ----------

const RATIO_LABELS = {
  debt_ratio: "부채비율(%)", current_ratio: "유동비율(%)", interest_coverage: "이자보상배율(배)",
  revenue_growth_yoy: "매출액증가율(%)", operating_income_growth_yoy: "영업이익증가율(%)", net_income_growth_yoy: "순이익증가율(%)",
  asset_turnover: "총자산회전율(회)", receivables_turnover: "매출채권회전율(회)", inventory_turnover: "재고자산회전율(회)",
};
const BASIS_LABELS = { industry_average: "동일업종 중앙값", market_average_fallback: "시장 전체 중앙값(대체)", unavailable: "비교불가" };

function fmtRatio(v) { return v == null ? "-" : (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)); }

function renderFundamental(data) {
  const warnEl = document.getElementById("fund-warning");
  const ids = ["fund-stability", "fund-growth", "fund-activity"];
  if (!data || data.status !== "ok") {
    ids.forEach((id) => { document.getElementById(id).textContent = "-"; document.getElementById(id).style.color = ""; });
    document.getElementById("fin-table").innerHTML = "";
    document.getElementById("fund-summary-list").innerHTML =
      data && data.status === "unsupported"
        ? '<li>이 종목은 DART 재무제표가 없어 재무분석을 제공하지 않습니다(ETF·우선주 등). 기술적분석·시세·목표주가는 확인할 수 있습니다.</li>'
        : "";
    document.getElementById("fund-footnote").textContent = "";
    renderValuation(null);
    renderQuality(null);
    renderDividend(null);
    renderTrend(null);
    warnEl.textContent = data && data.reason ? `사유: ${data.reason}` : "";
    return;
  }

  renderValuation(data.valuation);
  renderQuality(data.quality);
  renderDividend(data.dividend);
  renderTrend(data.earnings_trend);

  document.getElementById("fund-stability").textContent = fmtRatio(data.stability_score);
  document.getElementById("fund-growth").textContent = fmtRatio(data.growth_score);
  document.getElementById("fund-activity").textContent = fmtRatio(data.activity_score);
  [["fund-stability", data.stability_score], ["fund-growth", data.growth_score], ["fund-activity", data.activity_score]].forEach(([id, v]) => {
    document.getElementById(id).style.color = v == null ? "var(--text-muted)" : scoreStatusColor(v);
  });

  const byr = data.latest_period ? Number(data.latest_period.bsns_year) : null;
  const stale = byr && (new Date().getFullYear() - byr) >= 2; // 최근 사업보고서가 2년 이상 과거 → 상폐/정지 의심
  document.getElementById("fund-table-title").innerHTML =
    `주요 재무 지표 (${byr ? byr + "년" : ""})` +
    (stale
      ? ` <span style="color:var(--critical);font-size:.72em;font-weight:700;border:1px solid var(--critical);border-radius:4px;padding:1px 5px;vertical-align:middle" title="최근 사업보고서가 ${byr}년입니다. 상장폐지·거래정지·결산변경 등으로 최신 재무가 없을 수 있어, 아래 지표는 과거 시점 값일 수 있습니다.">⚠ 최신 아님 · ${byr}년 기준</span>`
      : "");

  const groups = [["안정성", data.stability], ["성장성", data.growth], ["활동성", data.activity]];
  let rowsHtml = `<tr><th>지표</th><th>종목값</th><th>${data.comparison_basis === "industry_average" ? "업종중앙값" : "비교중앙값"}</th><th>상대위치</th></tr>`;
  for (const [cat, obj] of groups) {
    if (!obj) continue;
    for (const [key, v] of Object.entries(obj)) {
      const label = RATIO_LABELS[key] || key;
      const fav = v.relative_favorability;
      const favColor = fav == null ? "var(--text-muted)" : fav >= 1 ? "var(--good)" : "var(--critical)";
      rowsHtml += `<tr><td>${label}</td><td>${fmtRatio(v.target)}</td><td>${fmtRatio(v.peer_average)}</td><td style="color:${favColor}">${fav == null ? "-" : fav.toFixed(2) + "x"}</td></tr>`;
    }
  }
  document.getElementById("fin-table").innerHTML = rowsHtml;

  const summary = [];
  if (data.stability_score != null) summary.push(`안정성 ${data.stability_score}/5.0 — ${data.stability_score >= 3.5 ? "산업평균 대비 재무구조가 우수합니다" : data.stability_score <= 2.5 ? "산업평균 대비 재무구조가 취약할 수 있습니다" : "산업평균과 유사한 수준입니다"}`);
  if (data.growth_score != null) summary.push(`성장성 ${data.growth_score}/5.0 — ${data.growth_score >= 3.5 ? "매출·이익 성장이 업종 평균을 상회합니다" : data.growth_score <= 2.5 ? "성장세가 업종 평균에 못 미칩니다" : "업종 평균과 유사한 성장세입니다"}`);
  if (data.activity_score != null) summary.push(`활동성 ${data.activity_score}/5.0 — ${data.activity_score >= 3.5 ? "자산 활용 효율이 양호합니다" : data.activity_score <= 2.5 ? "자산 활용 효율이 낮은 편입니다" : "업종 평균과 유사합니다"}`);
  document.getElementById("fund-summary-list").innerHTML = summary.map((s) => `<li>${s}</li>`).join("") || '<li>요약할 데이터가 부족합니다</li>';

  document.getElementById("fund-footnote").textContent =
    `* 비교기준: ${BASIS_LABELS[data.comparison_basis] || data.comparison_basis} (전 종목 동일 기준)`;

  warnEl.textContent = humanizeWarnings(data.warnings);
}

// ---------- 팩터 랭킹 (전종목 횡단면 멀티팩터) — 퀀트식 '줄 세우기' ----------

function renderFactorProfile(code) {
  const el = document.getElementById("factor-profile");
  if (!el) return;
  const fr = state.factorRanking;
  const r = fr && fr.status === "ok" && fr.ranks ? fr.ranks[code] : null;
  if (!r) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  const topPct = Math.max(1, 100 - r.pct);
  const rankColor = r.decile <= 2 ? "var(--good)" : r.decile <= 5 ? "var(--warning)" : "var(--critical)";
  const bar = (z) => z == null ? null : Math.max(2, Math.min(100, (z + 2.5) / 5 * 100));
  const zColor = (z) => z == null ? "var(--text-muted)" : z >= 0.5 ? "var(--good)" : z <= -0.5 ? "var(--critical)" : "var(--text-secondary)";
  const pillar = (label, z) => {
    const w = bar(z);
    return `<div class="fp-pillar"><span class="fp-plabel">${label}</span>` +
      `<span class="fp-track">${w == null ? "" : `<span class="fp-mid"></span><span class="fp-fill" style="width:${w}%;background:${zColor(z)}"></span>`}</span>` +
      `<span class="fp-pz" style="color:${zColor(z)}">${z == null ? "—" : (z >= 0 ? "+" : "") + z.toFixed(1)}</span></div>`;
  };
  el.innerHTML =
    `<div class="fp-head"><span class="fp-title">🏆 팩터 종합 <span class="fp-muted">(전종목 ${(fr.universe || 0).toLocaleString("ko-KR")}개 중)</span></span>` +
    `<span class="fp-rank" style="color:${rankColor}">상위 ${topPct}% · ${r.decile}분위</span></div>` +
    pillar("모멘텀", r.momentum) + pillar("퀄리티", r.quality) + pillar("밸류", r.value) + pillar("성장", r.growth) +
    `<div class="fp-note">모멘텀·퀄리티·밸류·성장을 전종목 z-점수로 표준화한 랭킹. 0=평균, +면 우수. 밸류는 PER 역산 가능 종목만 반영(점진 확대).</div>`;
}

function renderFactorTop() {
  const fr = state.factorRanking;
  if (!fr || fr.status !== "ok" || !Array.isArray(fr.top)) { showToast("팩터 랭킹 데이터가 아직 생성되지 않았습니다."); return; }
  const items = fr.top.map((t) => ({
    code: t.code, name: t.name, has_detail: true,
    sector: `상위 ${Math.max(1, 100 - t.pct)}% · 모멘${t.momentum ?? "-"}/퀄${t.quality ?? "-"}`,
  }));
  const s = document.getElementById("search-summary");
  if (s) s.textContent = `🏆 팩터 종합 TOP ${items.length} — 퀄리티·성장·밸류 (클릭해 분석)`;
  document.getElementById("search-input").value = "";
  renderResultList(items);
}

function wireFactorTop() {
  const btn = document.getElementById("factor-top-btn");
  if (btn) btn.onclick = renderFactorTop;
}

// ---------- 애널리스트 추정치 리비전 (컨센서스 변화 추적) ----------
function renderRevision(code) {
  const el = document.getElementById("ss-revision");
  if (!el) return;
  const er = state.estimateRevisions;
  const r = er && er.status === "ok" && er.revisions ? er.revisions[code] : null;
  if (!r) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  const bits = [];
  if (r.target_rev_pct != null && Math.abs(r.target_rev_pct) >= 0.5) {
    const up = r.target_rev_pct > 0;
    bits.push(`목표가 <b style="color:${up ? "var(--good)" : "var(--critical)"}">${up ? "▲+" : "▼"}${r.target_rev_pct.toFixed(1)}%</b>`);
  }
  if (r.recomm_change != null && Math.abs(r.recomm_change) >= 0.05) {
    const up = r.recomm_change > 0; // 투자의견 1(매도)~5(매수) → 상승=상향
    bits.push(`투자의견 <b style="color:${up ? "var(--good)" : "var(--critical)"}">${up ? "상향" : "하향"} ${up ? "+" : ""}${r.recomm_change.toFixed(2)}</b>`);
  }
  el.innerHTML = bits.length
    ? `📊 추정치 리비전 <span class="ss-src">(최근 ${r.span_days}일)</span> · ${bits.join(" · ")}`
    : `<span class="ss-src">📊 추정치 리비전: 최근 ${r.span_days}일 변화 미미 (추적 ${r.n}회)</span>`;
}

// ---------- LLM 공시 인사이트 (사업보고서 → 가이던스·톤·레드플래그) ----------
function renderFilingInsight(code) {
  const el = document.getElementById("filing-insight");
  if (!el) return;
  const fi = state.filingInsights;
  const r = fi && fi.status === "ok" && fi.insights ? fi.insights[code] : null;
  if (!r) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  const tone = r.tone || "";
  const toneColor = /자신감|긍정|낙관/.test(tone) ? "var(--good)" : /우려|부정|악화/.test(tone) ? "var(--critical)" : /신중/.test(tone) ? "var(--warning)" : "var(--text-secondary)";
  const rf = r.redflags || "";
  const rfNone = rf.length < 15 && /특이사항\s*없음|없음|없습니다/.test(rf);
  const rows = [];
  if (r.guidance) rows.push(`<div class="fi-row"><span class="fi-k">📈 가이던스</span><span>${_esc(r.guidance)}</span></div>`);
  if (tone) rows.push(`<div class="fi-row"><span class="fi-k">🗣 경영진 톤</span><span style="color:${toneColor}">${_esc(tone)}</span></div>`);
  if (rf) rows.push(`<div class="fi-row"><span class="fi-k">${rfNone ? "✅" : "⚠️"} 레드플래그</span><span style="color:${rfNone ? "var(--text-secondary)" : "var(--critical)"}">${_esc(rf)}</span></div>`);
  el.innerHTML = `<div class="fi-head">📄 공시 인사이트 <span class="fi-src">${_esc(r.report_nm || "")} · AI 요약</span></div>${rows.join("")}`;
}

function _esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
}

// 관심도(검색·뉴스 급증) — 워치리스트+팩터TOP은 사전생성(attention.json). 단기 관심 신호 표시.
function renderAttention(code) {
  const el = document.getElementById("attention");
  if (!el) return;
  const at = state.attention;
  const s = at && at.status === "ok" && at.signals ? at.signals[code] : null;
  if (!s) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  const lvClass = { hot: "att-hot", up: "att-up", calm: "att-calm" }[s.level] || "att-calm";

  const bits = [];
  const sr = s.search || {};
  if (sr.available) {
    const rt = sr.new_spike ? "신규 급등" : (sr.surge_ratio != null ? `${sr.surge_ratio}배` : "-");
    bits.push(`검색량 <b>${_esc(rt)}</b> <span class="att-sub">(최근 ${sr.recent_avg} vs 직전 ${sr.prior_avg})</span>`);
  }
  const nw = s.news || {};
  if (nw.recent_count != null) {
    bits.push(`뉴스 <b>${nw.recent_count}${nw.capped ? "+" : ""}건</b> <span class="att-sub">(최근 ${at.recent_window_days || 7}일)</span>`);
  }
  const dc = s.disclosures || {};
  if (dc.available && dc.recent_count != null) bits.push(`공시 <b>${dc.recent_count}건</b>`);

  const titles = (nw.sample_titles || []).slice(0, 3).map(_esc);
  const newsLine = titles.length ? `<div class="att-news">📰 ${titles.join(" · ")}</div>` : "";
  const reasons = (s.reasons || []).join(" · ");

  el.innerHTML =
    `<div class="att-head">` +
      `<span class="att-badge ${lvClass}">${s.emoji} ${_esc(s.label)}</span>` +
      (reasons ? `<span class="att-reasons">${_esc(reasons)}</span>` : "") +
    `</div>` +
    (bits.length ? `<div class="att-detail">${bits.join(" · ")}</div>` : "") +
    newsLine;
}

function _parseBae(t) { // "19.40배" → 19.40
  if (t == null) return null;
  const n = parseFloat(String(t).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function renderValuation(val) {
  const perEl = document.getElementById("val-per");
  const pbrEl = document.getElementById("val-pbr");
  const perNote = document.getElementById("val-per-note");
  const pbrNote = document.getElementById("val-pbr-note");
  // 라이브 트레일링 PER/PBR을 우선한다 — 시세 strip·밴드와 같은 숫자로 통일해 '화면에 PER이 여러 개'
  // 보이던 혼란을 없앤다. 라이브가 없으면(장애 등) DART 역산값으로 대체.
  const q = state.currentQuote;
  const livePer = q ? _parseBae(q.per) : null;
  const livePbr = q ? _parseBae(q.pbr) : null;
  const per = livePer != null ? livePer : (val ? val.per : null);
  const pbr = livePbr != null ? livePbr : (val ? val.pbr : null);
  const src = livePer != null ? " (시세)" : "";

  if (per == null && pbr == null) {
    perEl.textContent = pbrEl.textContent = "-";
    perNote.textContent = pbrNote.textContent = (val && val.basis === "unavailable") ? "산출 불가" : "";
    perEl.className = pbrEl.className = "val-tile-value";
    return;
  }
  // PER
  if (per == null) { perEl.textContent = "-"; perNote.textContent = ""; perEl.className = "val-tile-value"; }
  else if (per < 0) { perEl.textContent = "적자"; perEl.className = "val-tile-value val-warn"; perNote.textContent = "순이익 마이너스"; }
  else {
    perEl.textContent = `${per.toFixed(1)}배`;
    perEl.className = "val-tile-value";
    perNote.textContent = (per < 10 ? "이익 대비 낮은 편" : per > 30 ? "이익 대비 높은 편" : "") + (src && !(per < 10 || per > 30) ? src.trim() : src);
  }
  // PBR: 1배 미만은 순자산가치 이하지만, 퀄리티가 약하면 저평가가 아니라 '가치 함정'일 수 있다
  // (무형자산 비중↑로 PBR의 유효성이 낮아진 점도 감안 — 무조건 긍정 표시하지 않음).
  if (pbr == null) { pbrEl.textContent = "-"; pbrNote.textContent = ""; pbrEl.className = "val-tile-value"; }
  else {
    pbrEl.textContent = `${pbr.toFixed(2)}배`;
    if (pbr < 1) {
      const q = (state.fundCache[state.currentCode] || {}).quality;
      const fs = q && q.f_score;
      const weakQuality = q && ((q.roe_pct != null && q.roe_pct < 5) || (fs && fs.max_score && fs.score / fs.max_score < 4 / 9));
      if (weakQuality) { pbrEl.className = "val-tile-value val-warn"; pbrNote.textContent = "PBR<1 · 저ROE라 가치함정 주의"; }
      else { pbrEl.className = "val-tile-value val-cheap"; pbrNote.textContent = "순자산가치 이하(저평가 신호)"; }
    } else { pbrEl.className = "val-tile-value"; pbrNote.textContent = (pbr > 3 ? "순자산 대비 높음" : "") + src; }
  }
}

// 밸류에이션 밴드 — 네이버 연간 PER 이력으로 현재가 위치(역사적 저평가/고평가) 표시.
function renderValBand(fin) {
  const band = document.getElementById("val-band");
  if (!fin || !Array.isArray(fin.per)) { band.hidden = true; return; }
  // 미완결 당해연도(추정 PER)는 밴드에서 제외 — 완결 사업연도만으로 역사적 범위를 만든다. 당해 추정
  // PER은 실적 급증 시 트레일링보다 훨씬 낮아(예: 삼성 5.0배) '역사적 저평가'로 오인시켰다.
  const curYear = new Date().getFullYear();
  const valid = fin.per.map((v, i) => ({ v, y: Number(fin.years[i]) })).filter((o) => o.v != null && o.v > 0 && o.y < curYear);
  if (valid.length < 2) { band.hidden = true; return; }
  const vals = valid.map((o) => o.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  // 현재 PER = 라이브 트레일링(시세 strip과 동일 숫자), 없으면 최근 완결연도 PER으로 대체.
  const livePer = state.currentQuote ? _parseBae(state.currentQuote.per) : null;
  const cur = (livePer != null && livePer > 0) ? livePer : valid[valid.length - 1].v;
  const pos = max > min ? ((cur - min) / (max - min)) * 100 : 50;
  band.hidden = false;
  document.getElementById("vb-marker").style.left = `${Math.max(0, Math.min(100, pos))}%`;
  const verdict = pos <= 30 ? "역사적 저평가권" : pos >= 70 ? "역사적 고평가권" : "중간 수준";
  const vc = pos <= 30 ? "var(--good)" : pos >= 70 ? "var(--critical)" : "var(--text-secondary)";
  document.getElementById("vb-verdict").innerHTML = `<span style="color:${vc}">${verdict}</span> · 현재 ${cur.toFixed(1)}배 (완결연도 범위 ${min.toFixed(1)}~${max.toFixed(1)})`;
  document.getElementById("vb-years").textContent = valid.map((o) => `${String(o.y).slice(2)} ${o.v.toFixed(1)}`).join("  ·  ");
}

async function loadValuationBand(code) {
  document.getElementById("val-band").hidden = true;
  const url = typeof financeUrl === "function" ? financeUrl(code) : null;
  if (!url) return;
  state.financeCache = state.financeCache || {};
  try {
    if (state.financeCache[code] === undefined) {
      const r = await fetch(url, { cache: "no-store" });
      const d = await r.json();
      state.financeCache[code] = d && !d.error ? d : null;
    }
    if (state.currentCode !== code) return;
    renderValBand(state.financeCache[code]);
  } catch (e) { /* 밴드는 부가정보 — 실패해도 무시 */ }
}

function renderQuality(q) {
  const badge = document.getElementById("fscore-badge");
  const maxEl = document.getElementById("fscore-max");
  const roeEl = document.getElementById("q-roe");
  const roaEl = document.getElementById("q-roa");
  const interp = document.getElementById("fscore-interp");
  if (!q) {
    badge.textContent = "-"; badge.className = "fscore-badge"; maxEl.textContent = "/9";
    roeEl.textContent = roaEl.textContent = "-"; interp.textContent = "";
    return;
  }
  const fs = q.f_score || {};
  const score = fs.score, max = fs.max_score || 9;
  badge.textContent = score == null ? "-" : score;
  maxEl.textContent = `/${max}`;
  // 색: 통과비율 기준(7/9↑ 우량, 4/9↑ 보통, 그 아래 취약)
  const ratio = (score != null && max) ? score / max : null;
  badge.className = "fscore-badge " + (ratio == null ? "" : ratio >= 7 / 9 ? "fs-good" : ratio >= 4 / 9 ? "fs-mid" : "fs-bad");
  interp.textContent = fs.interpretation && fs.interpretation !== "산출불가" ? fs.interpretation : "";

  roeEl.textContent = q.roe_pct == null ? "-" : `${q.roe_pct.toFixed(1)}%`;
  roeEl.style.color = q.roe_pct == null ? "var(--text-muted)" : q.roe_pct >= 15 ? "var(--good)" : q.roe_pct < 5 ? "var(--critical)" : "";
  roaEl.textContent = q.roa_pct == null ? "-" : `${q.roa_pct.toFixed(1)}%`;
}

function renderDividend(div) {
  const tiles = document.getElementById("div-tiles");
  const none = document.getElementById("div-none");
  const y = document.getElementById("div-yield");
  const p = document.getElementById("div-payout");
  const d = document.getElementById("div-dps");
  const q = state.currentQuote;
  // 배당수익률은 '현재가 기준'이 정확하다 — 라이브 시세배당수익률(네이버, 현재가 기준)을 우선한다.
  // DART dividend_yield_pct는 core 종목에서 '과거 배당기준일 시가배당률'이라 주가가 변하면 어긋난다
  // (예: 기업은행 DART 4.2% vs 현재 5.15%). 라이브가 없을 때만 DART 값으로 대체하고, 배당성향(payout)은
  // DART만 제공하므로 항상 DART에서 가져온다.
  const liveYield = q && q.dividend_yield && q.dividend_yield !== "0.00%" ? parseFloat(q.dividend_yield) : null;
  const dartYield = div && div.status === "ok" && div.dividend_yield_pct != null ? div.dividend_yield_pct : null;
  const yieldPct = liveYield != null ? liveYield : dartYield;
  const payout = div && div.payout_pct != null ? div.payout_pct : null;
  const dps = (div && div.dps != null) ? `${Math.round(div.dps).toLocaleString("ko-KR")}원` : (q && q.dividend ? q.dividend : null);

  if (yieldPct != null) {
    tiles.hidden = false; none.hidden = true;
    y.textContent = `${yieldPct.toFixed(1)}%`;
    y.style.color = yieldPct >= 4 ? "var(--good)" : "";
    p.textContent = payout == null ? "-" : `${Math.round(payout)}%`;
    d.textContent = dps || "-";
    return;
  }
  // 무배당 또는 데이터 없음
  tiles.hidden = true;
  none.hidden = !(div && div.status === "none");
}

function fmtEok(v) {
  // 원 단위를 조/억으로 축약
  if (v == null) return "-";
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(1)}조`;
  if (abs >= 1e8) return `${Math.round(v / 1e8).toLocaleString("ko-KR")}억`;
  return Math.round(v).toLocaleString("ko-KR");
}

function renderTrend(trend) {
  const table = document.getElementById("trend-table");
  const block = document.getElementById("trend-block");
  if (!trend || !trend.length) {
    table.innerHTML = "";
    block.hidden = true;
    return;
  }
  block.hidden = false;
  const maxRev = Math.max(...trend.map((t) => t.revenue || 0), 1);
  let html = `<tr><th>연도</th><th>매출</th><th>영업이익률</th><th>순이익률</th></tr>`;
  for (const t of trend) {
    const barW = t.revenue ? Math.max(3, (t.revenue / maxRev) * 100) : 0;
    const om = t.op_margin_pct, nm = t.net_margin_pct;
    html += `<tr>
      <td>${String(t.year).slice(2)}</td>
      <td class="tr-rev"><span class="tr-bar" style="width:${barW}%"></span><span class="tr-rev-val">${fmtEok(t.revenue)}</span></td>
      <td style="color:${om == null ? "var(--text-muted)" : om < 0 ? "var(--critical)" : ""}">${om == null ? "-" : om.toFixed(1) + "%"}</td>
      <td style="color:${nm == null ? "var(--text-muted)" : nm < 0 ? "var(--critical)" : ""}">${nm == null ? "-" : nm.toFixed(1) + "%"}</td>
    </tr>`;
  }
  table.innerHTML = html;
}

// ---------- 종합 투자 요약 (4개 축 통합) ----------

function renderSummaryStrip(code) {
  const strip = document.getElementById("summary-strip");
  if (!code) { strip.hidden = true; return; }
  // 비워치리스트(심층분석 미지원) 종목도 strip은 띄운다 — 라이브 시세/컨센서스는 전종목 제공.
  strip.hidden = false;
  const tech = state.techCache[code];
  const fund = state.fundCache[code];
  const okT = tech && tech.status === "ok";
  const okF = fund && fund.status === "ok";

  const tags = [];
  const q = okF ? fund.quality : null;
  const fs = q && q.f_score ? q.f_score : null;
  const weakQuality = q && ((q.roe_pct != null && q.roe_pct < 5) || (fs && fs.max_score && fs.score / fs.max_score < 4 / 9));
  // 밸류에이션 (PBR<1은 퀄리티 약하면 저평가가 아니라 가치함정)
  // DART 역산값 우선, 없으면 라이브 시세 PER/PBR — core(비워치) 종목도 밸류 태그가 나오게(파리티).
  const val = okF ? fund.valuation : null;
  const quote = state.currentQuote;
  // 밸류 태그도 타일·밴드와 동일하게 라이브 트레일링 PER/PBR 우선(일관성). DART 역산은 라이브 없을 때만.
  const livePbr = quote ? _parseBae(quote.pbr) : null;
  const livePer = quote ? _parseBae(quote.per) : null;
  const vpbr = livePbr != null ? livePbr : (val ? val.pbr : null);
  const vper = livePer != null ? livePer : (val ? val.per : null);
  if (vpbr != null && vpbr < 1) tags.push(weakQuality ? { t: "PBR<1 가치함정 주의", c: "warn" } : { t: "PBR<1 저평가", c: "good" });
  else if (vper != null && vper > 0 && vper < 10) tags.push({ t: "이익 대비 저평가", c: "good" });
  else if (vper != null && vper > 40) tags.push({ t: "밸류에이션 부담", c: "warn" });
  // 퀄리티
  if (fs && fs.max_score) {
    const r = fs.score / fs.max_score;
    if (r >= 7 / 9) tags.push({ t: `우량(F${fs.score})`, c: "good" });
    else if (r < 4 / 9) tags.push({ t: `재무취약(F${fs.score})`, c: "bad" });
  }
  if (q && q.roe_pct != null && q.roe_pct >= 15) tags.push({ t: `고ROE ${q.roe_pct.toFixed(0)}%`, c: "good" });
  // 배당 — 현재가 기준 라이브 수익률 우선(DART는 core에서 과거 배당기준일 기준이라 어긋남)
  const dv = okF ? fund.dividend : null;
  const liveDy = quote && quote.dividend_yield && quote.dividend_yield !== "0.00%" ? parseFloat(quote.dividend_yield) : null;
  const dyPct = liveDy != null ? liveDy : (dv && dv.status === "ok" ? dv.dividend_yield_pct : null);
  if (dyPct != null && dyPct >= 4) tags.push({ t: `고배당 ${dyPct.toFixed(1)}%`, c: "good" });
  // 기술 (상대강도 반영된 재보정 점수 우선)
  const ts = okT ? (tech._displayScore ?? tech.score) : null;
  if (ts != null) {
    if (ts >= 4) tags.push({ t: "기술적 강세", c: "good" });
    else if (ts <= 2) tags.push({ t: "기술적 약세", c: "bad" });
  }
  // 리스크
  const risk = okT ? (tech.indicators || {}).risk : null;
  if (risk && risk.annualized_volatility_pct != null) {
    if (risk.annualized_volatility_pct >= 60) tags.push({ t: "고변동성", c: "warn" });
  }
  if (risk && risk.week52_position_pct != null) {
    if (risk.week52_position_pct <= 15) tags.push({ t: "52주 바닥권", c: "warn" });
    else if (risk.week52_position_pct >= 90) tags.push({ t: "52주 고점권", c: "warn" });
  }

  const hasAnalysis = okT || okF;
  // 코드 직접조회 종목은 인덱스에 이름이 없으니 라이브 시세의 종목명을 우선 사용
  const nm = (state.currentQuote && state.currentQuote.name) || stockName(code);
  document.getElementById("ss-name").textContent = `${nm} 종합`;
  document.getElementById("ss-tags").innerHTML = tags.length
    ? tags.map((x) => `<span class="ss-tag ss-${x.c}">${x.t}</span>`).join("")
    : (hasAnalysis ? `<span class="ss-tag">특이 신호 없음</span>` : "");
  document.getElementById("ss-oneliner").textContent = hasAnalysis
    ? buildOneliner(tags)
    : "심층분석 미지원 종목입니다 — 아래 라이브 시세·목표주가 컨센서스는 제공됩니다.";
  strip.hidden = false;
}

function buildOneliner(tags) {
  const has = (kw) => tags.some((x) => x.t.includes(kw));
  const parts = [];
  if (has("저평가")) parts.push("밸류에이션은 매력적");
  else if (has("부담")) parts.push("밸류에이션은 부담");
  if (has("우량") || has("고ROE")) parts.push("재무 퀄리티 양호");
  else if (has("취약")) parts.push("재무 건전성 주의");
  if (has("고배당")) parts.push("배당 매력 있음");
  if (has("강세")) parts.push("단기 기술적 강세");
  else if (has("약세")) parts.push("단기 기술적 약세");
  if (has("고변동성") || has("바닥권") || has("고점권")) parts.push("리스크 유의");
  const body = parts.length ? parts.join(" · ") : "네 축 모두 뚜렷한 편중 없이 중립적";
  return `${body}.`;
}

// ---------- 밸류에이션 계산기 (2단계 FCFF DCF) ----------

function _valcNum(id) {
  // 콤마 제거 후 파싱 — 사용자가 큰 수를 "377,929"·"246,000"처럼 천단위 콤마로 넣으면 parseFloat가
  // 콤마에서 잘려(→377) 적정주가가 통째로 틀어지던 문제 방지.
  const v = parseFloat(String(document.getElementById(id).value).replace(/,/g, ""));
  return Number.isFinite(v) ? v : null;
}

// 계산기 모드: "dcf"(잉여현금흐름) | "psr"(매출 기반). FCFF 적자기업은 DCF가 무의미해 매출배수(PSR)로 평가한다.
let valcMode = "dcf";

function setValcMode(mode) {
  valcMode = mode === "psr" ? "psr" : "dcf";
  document.getElementById("valc-grid-dcf").hidden = valcMode !== "dcf";
  document.getElementById("valc-grid-psr").hidden = valcMode !== "psr";
  document.querySelectorAll("#valc-mode button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === valcMode));
  computeValuation();
}

function computeValuation() {
  return valcMode === "psr" ? computeValuationPSR() : computeValuationDCF();
}

// 매출 기반(PSR): 적정 시가총액 = 예상매출 × 목표PSR, 적정주가 = 시총 ÷ 발행주식수.
// 적자로 이익·현금흐름이 무의미한 성장기업에 쓰는 표준 간이법(PSR=시총/매출, 부채는 미반영).
function computeValuationPSR() {
  const revenue = _valcNum("valc-revenue");   // 억원/년
  const psr = _valcNum("valc-psr");           // 배
  const shares = _valcNum("valc-shares");     // 백만주
  const price = _valcNum("valc-price");       // 원

  const fairEl = document.getElementById("valc-fair");
  const upEl = document.getElementById("valc-upside");
  const bdEl = document.getElementById("valc-breakdown");

  if (revenue == null || psr == null || shares == null) {
    fairEl.textContent = "-"; upEl.textContent = ""; bdEl.textContent = "예상 매출·목표 PSR·주식수를 입력하면 적정주가가 계산됩니다.";
    return;
  }
  if (revenue <= 0 || psr <= 0 || shares <= 0) {
    fairEl.textContent = "-"; upEl.textContent = ""; bdEl.innerHTML = `<span style="color:var(--warning)">매출·PSR·주식수는 0보다 커야 합니다.</span>`;
    return;
  }
  const mktCap = revenue * psr;                // 적정 시가총액(주주가치, 억원)
  const perShare = (mktCap * 100) / shares;    // 원 (억*100/백만주)

  fairEl.textContent = `${Math.round(perShare).toLocaleString("ko-KR")}원`;
  const fmt = (v) => (Math.abs(v) >= 10000 ? `${(v / 10000).toFixed(1)}조` : `${Math.round(v).toLocaleString("ko-KR")}억`);
  bdEl.innerHTML = `적정 시가총액 ${fmt(mktCap)} = 매출 ${fmt(revenue)} × PSR ${psr}배 <span style="color:var(--text-muted)">· 순부채 미반영(간이)</span>`;

  if (price && perShare > 0) {
    const upside = (perShare / price - 1) * 100;
    const near = Math.abs(upside) < 1.5;   // 사실상 현재가와 동일 — '±0% 고평가'로 오해되지 않게 중립 표기
    const c = near ? "var(--text-secondary)" : (upside >= 0 ? "var(--good)" : "var(--critical)");
    const label = near ? "(현재가 수준)" : (upside >= 0 ? "(저평가 여력)" : "(고평가)");
    upEl.innerHTML = `현재가 ${Math.round(price).toLocaleString("ko-KR")} 대비 <b style="color:${c}">${upside >= 0 ? "+" : ""}${upside.toFixed(0)}%</b> ${label}`;
  } else {
    upEl.textContent = "";
  }
}

function computeValuationDCF() {
  const fcff0 = _valcNum("valc-fcff");        // 억원
  const g1 = _valcNum("valc-g1");             // %
  const years = _valcNum("valc-years");
  const gt = _valcNum("valc-gt");             // %
  const wacc = _valcNum("valc-wacc");         // %
  const netDebt = _valcNum("valc-netdebt") ?? 0; // 억원
  const shares = _valcNum("valc-shares");     // 백만주
  const price = _valcNum("valc-price");       // 원

  const fairEl = document.getElementById("valc-fair");
  const upEl = document.getElementById("valc-upside");
  const bdEl = document.getElementById("valc-breakdown");

  if (fcff0 == null || g1 == null || years == null || gt == null || wacc == null || shares == null) {
    fairEl.textContent = "-"; upEl.textContent = ""; bdEl.textContent = "FCFF·성장률·할인율·주식수를 입력하면 적정주가가 계산됩니다.";
    return;
  }
  const r = wacc / 100, gr = g1 / 100, gtr = gt / 100, N = Math.round(years);
  if (r <= gtr) {
    fairEl.textContent = "-"; upEl.textContent = ""; bdEl.innerHTML = `<span style="color:var(--warning)">할인율(WACC)은 영구성장률보다 커야 합니다.</span>`;
    return;
  }
  // 1단계: 고성장기 FCFF 현재가치 합
  let pvExplicit = 0, fcff = fcff0;
  for (let t = 1; t <= N; t++) {
    fcff = fcff0 * Math.pow(1 + gr, t);
    pvExplicit += fcff / Math.pow(1 + r, t);
  }
  // 2단계: 영구성장 잔존가치(고든 성장모형) → 현재가치
  const fcffN = fcff0 * Math.pow(1 + gr, N);
  const terminal = (fcffN * (1 + gtr)) / (r - gtr);
  const pvTerminal = terminal / Math.pow(1 + r, N);

  const ev = pvExplicit + pvTerminal;        // 기업가치(억원)
  const equity = ev - netDebt;               // 주주가치(억원)
  const perShare = (equity * 100) / shares;  // 원 (억원*1e8 / (백만주*1e6) = 억*100/백만주)

  fairEl.textContent = `${Math.round(perShare).toLocaleString("ko-KR")}원`;
  const fmt = (v) => (Math.abs(v) >= 10000 ? `${(v / 10000).toFixed(1)}조` : `${Math.round(v).toLocaleString("ko-KR")}억`);
  // 잔존가치(영구성장 구간) 비중이 높으면 적정주가가 영구성장률·할인율 가정에 극도로 민감해진다 — 경고.
  const termFrac = ev > 0 ? pvTerminal / ev : 0;
  const termNote = termFrac > 0.75 ? ` <span style="color:var(--warning)">⚠ 가치의 ${Math.round(termFrac * 100)}%가 잔존가치 — 영구성장률·할인율에 매우 민감</span>` : "";
  bdEl.innerHTML = `기업가치 ${fmt(ev)} · 주주가치 ${fmt(equity)} <span style="color:var(--text-muted)">(잔존가치 비중 ${Math.round(termFrac * 100)}%)</span>${termNote}`;

  if (price && perShare > 0) {
    const upside = (perShare / price - 1) * 100;
    const near = Math.abs(upside) < 1.5;   // 사실상 현재가와 동일 — '±0% 고평가'로 오해되지 않게 중립 표기
    const c = near ? "var(--text-secondary)" : (upside >= 0 ? "var(--good)" : "var(--critical)");
    const label = near ? "(현재가 수준)" : (upside >= 0 ? "(저평가 여력)" : "(고평가)");
    upEl.innerHTML = `현재가 ${Math.round(price).toLocaleString("ko-KR")} 대비 <b style="color:${c}">${upside >= 0 ? "+" : ""}${upside.toFixed(0)}%</b> ${label}`;
  } else {
    upEl.textContent = "";
  }
}

// "1,403조 1,069억" → 억원 숫자
function parseMarketCapEok(text) {
  if (!text) return null;
  const s = String(text).replace(/,/g, "");
  const jo = (s.match(/(\d+)조/) || [])[1];
  const eok = (s.match(/(\d+)억/) || [])[1];
  let v = 0;
  if (jo) v += parseInt(jo, 10) * 10000;
  if (eok) v += parseInt(eok, 10);
  if (!jo && !eok) { const n = parseFloat(s); return Number.isFinite(n) ? n : null; }
  return v || null;
}

// DCF 가정의 회사별 기본값 — 외부에 '발표된' 값이 아니라(그건 애널리스트 가정),
// 회사 자체 데이터로 계산한다. 무위험 3.3%(국고10Y 근사)·시장위험프리미엄 6.5%·법인세 22%.
const _RF = 3.3, _ERP = 6.5, _TAX = 0.22, _RD = 5.0;

function computeBeta(priceSeries) {
  const k = state.kospiSeries;
  if (!k || !k.length || !priceSeries || priceSeries.length < 60) return null;
  const N = Math.min(priceSeries.length, k.length, 250);
  const sp = priceSeries.slice(-N).map((r) => r.close), kp = k.slice(-N).map((r) => r.close);
  const sr = [], kr = [];
  for (let i = 1; i < N; i++) { sr.push(sp[i] / sp[i - 1] - 1); kr.push(kp[i] / kp[i - 1] - 1); }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const ms = mean(sr), mk = mean(kr);
  let cov = 0, vk = 0;
  for (let i = 0; i < sr.length; i++) { cov += (sr[i] - ms) * (kr[i] - mk); vk += (kr[i] - mk) ** 2; }
  return vk > 0 ? cov / vk : null;
}

function companyWacc(beta, equityEok, netDebtEok) {
  const raw = beta == null ? 1.0 : Math.max(0.3, Math.min(2.0, beta));
  // Blume(1971) 조정 — 회귀 raw 베타는 표본노이즈가 크고 장기적으로 1로 평균회귀한다. 0.67·raw+0.33으로
  // 1쪽으로 당겨 안정화한다(블룸버그 'adjusted beta' 기본식). CAPM 자기자본비용의 과대·과소를 완화.
  const b = 0.67 * raw + 0.33;
  const re = _RF + b * _ERP;                 // 자기자본비용(CAPM)
  const E = Math.max(equityEok || 0, 1), D = Math.max(netDebtEok || 0, 0);
  const wacc = (E * re + D * (_RD * (1 - _TAX))) / (E + D); // 자본구조 가중(D=순부채 근사, 순현금이면 0)
  return Math.round(Math.max(6, Math.min(15, wacc)) * 10) / 10;
}

function growthYears(roe, fscore, fmax) {
  let y = 5;
  if (roe != null) { if (roe >= 20) y = 9; else if (roe >= 15) y = 8; else if (roe >= 10) y = 6; else if (roe < 5) y = 3; }
  if (fscore != null && fmax && fscore / fmax >= 7 / 9) y += 1; // 우량이면 성장 지속 길게
  return Math.max(3, Math.min(10, y));
}

function terminalGrowth(roe) {
  if (roe == null) return 2.5;
  return roe >= 15 ? 3.0 : roe < 5 ? 2.0 : 2.5; // 장기 경제성장률 근방에서 퀄리티로 미세조정
}

async function autofillValuation(code) {
  // 선택 종목의 실제 데이터로 계산기 가정을 채운다(전부 사용자가 덮어쓸 수 있음).
  const q = state.currentQuote;
  const fund = state.fundCache[code];
  const val = fund && fund.status === "ok" ? fund.valuation : null;
  const vi = fund && fund.status === "ok" ? fund.valuation_inputs : null;
  const set = (id, v) => { if (v != null && Number.isFinite(v)) document.getElementById(id).value = v; };

  if (q && q.price != null) set("valc-price", Math.round(q.price));

  // 발행주식수(백만주): 시총/현재가(시장 내재)를 우선 — 라이브 시총과 일관돼 PSR·시총 기반 계산이
  // 자기모순 없이 맞아떨어진다(현재 배수로 자동채움 시 적정주가≈현재가). EPS 역산 주식수는 가중평균·
  // 발표시점 차이로 시총과 어긋나 자동채움 결과가 몇 % 틀어질 수 있어 후순위. 시총 없으면 EPS 역산 사용.
  const mcEok = q ? parseMarketCapEok(q.market_cap_text) : null;
  let sharesM = (mcEok && q && q.price) ? (mcEok * 100) / q.price : null;
  if (sharesM == null && val && val.shares_estimated) sharesM = val.shares_estimated / 1e6;
  if (sharesM != null) set("valc-shares", Math.round(sharesM * 100) / 100);

  // FCFF(억원)·순부채(억원) — 재무 파이프라인 valuation_inputs
  if (vi) { set("valc-fcff", vi.fcff_eok); set("valc-netdebt", vi.net_debt_eok); }

  // 매출 기반(PSR) 입력: 예상매출(earnings_trend 최신 연도, 원→억)·목표PSR(현재 PSR=시총/매출 기본값)
  let revEok = null;
  if (fund && fund.status === "ok" && Array.isArray(fund.earnings_trend)) {
    for (let i = fund.earnings_trend.length - 1; i >= 0; i--) {
      const rv = fund.earnings_trend[i] && fund.earnings_trend[i].revenue;
      if (rv) { revEok = rv / 1e8; break; }
    }
  }
  if (revEok != null) set("valc-revenue", Math.round(revEok * 10) / 10);
  if (revEok && mcEok) {
    // 목표 기본값 = 현재 PSR(시총/매출). 이러면 자동채움 상태의 적정주가=현재가(중립 출발점)라 왜곡이 없다.
    // 상한을 넉넉히(500) 둬 고PSR 적자 바이오까지 실제 배수로 채운다 — 낮은 상한에 걸려 기본값으로
    // 폴백하면 정상 종목이 '심각한 고평가'로 잘못 표시되므로 폴백을 만들지 않는다(못 채우면 빈칸).
    // 3자리까지 채운다: 저PSR(1 미만) 종목을 1자리로 반올림하면(예 0.432→0.4) 7~8% 오차가 나
    // 중립이어야 할 자동채움이 '고평가'로 왜곡되던 문제를 없앤다.
    const curPsr = mcEok / revEok;
    if (curPsr > 0 && curPsr < 500) set("valc-psr", Math.round(curPsr * 1000) / 1000);
  }

  // FCFF 적자면 DCF가 무의미 → 매출 기반(PSR)으로 자동 전환하고 안내. 그 외엔 현금흐름(DCF).
  const modeNote = document.getElementById("valc-modenote");
  if (vi && vi.fcff_eok != null && vi.fcff_eok < 0) {
    setValcMode("psr");
    modeNote.hidden = false;
    modeNote.innerHTML = `이 기업은 잉여현금흐름(FCFF)이 <b>적자</b>라 DCF가 부적합 — <b>매출 기반(PSR)</b>으로 전환했습니다. 적자기업은 매출성장·시장점유로 평가합니다.`;
  } else {
    setValcMode("dcf");
    modeNote.hidden = true;
    modeNote.textContent = "";
  }

  // 고성장률: 매출성장률을 합리적 범위로 보정
  const roe = fund && fund.status === "ok" && fund.quality ? fund.quality.roe_pct : null;
  const fs = fund && fund.status === "ok" && fund.quality ? fund.quality.f_score : null;
  if (fund && fund.status === "ok" && fund.growth) {
    const rg = fund.growth.revenue_growth_yoy && fund.growth.revenue_growth_yoy.target;
    set("valc-g1", rg != null && rg >= 0 && rg <= 30 ? Math.round(rg * 10) / 10 : 8);
  }

  // 회사별 WACC(베타 기반)·고성장기간(퀄리티)·영구성장률 — 코스피 로드 후 베타 계산
  await ensureKospi();
  if (state.currentCode !== code) return;
  const tech = state.techCache[code];
  const beta = tech && tech.status === "ok" ? computeBeta(tech.price_series) : null;
  set("valc-wacc", companyWacc(beta, mcEok, vi ? vi.net_debt_eok : null));
  set("valc-years", growthYears(roe, fs && fs.score, fs && fs.max_score));
  set("valc-gt", terminalGrowth(roe));
  computeValuation();
}

function wireValuationCalc() {
  ["valc-fcff", "valc-g1", "valc-years", "valc-gt", "valc-wacc", "valc-netdebt", "valc-revenue", "valc-psr", "valc-shares", "valc-price"]
    .forEach((id) => document.getElementById(id).addEventListener("input", computeValuation));
  document.querySelectorAll("#valc-mode button").forEach((b) =>
    b.addEventListener("click", () => setValcMode(b.dataset.mode)));
  const toggle = document.getElementById("valc-toggle");
  const body = document.getElementById("valc-body");
  toggle.addEventListener("click", () => {
    body.hidden = !body.hidden;
    toggle.textContent = body.hidden ? "▸" : "▾";
  });
}

// ---------- 라이브 시세 (Worker /quote 프록시, 네이버 포털) ----------

let _quoteTimer = null;

function stockName(code) {
  const w = state.watchlist.find((x) => x.code === code);
  if (w) return w.name;
  const c = state.companyIndex.find((x) => x.code === code);
  return c ? c.name : code;
}

function recommLabel(mean) {
  // 네이버 컨센서스: 1(매도)~5(매수). 높을수록 매수 우위.
  if (mean == null) return null;
  if (mean >= 4.5) return "강력매수";
  if (mean >= 3.5) return "매수";
  if (mean >= 2.5) return "중립";
  if (mean >= 1.5) return "매도";
  return "강력매도";
}

async function fetchQuote(code) {
  const url = typeof quoteUrl === "function" ? quoteUrl(code) : null;
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const d = await res.json();
    return d && !d.error ? d : null;
  } catch (_) {
    return null;
  }
}

function renderQuote(q) {
  const qEl = document.getElementById("ss-quote");
  const cEl = document.getElementById("ss-consensus");
  if (!q || q.price == null) {
    qEl.innerHTML = "";
    cEl.hidden = true;
    return;
  }
  // 등락 색: 한국 관례(상승=빨강, 하락=파랑)
  const up = q.change_pct > 0, down = q.change_pct < 0;
  const color = up ? "var(--candle-up)" : down ? "var(--candle-down)" : "var(--text-secondary)";
  const arrow = up ? "▲" : down ? "▼" : "–";
  const sign = q.change_pct > 0 ? "+" : "";
  const status = q.market_open ? '<span class="ss-live">● 장중</span>' : '<span class="ss-closed">장마감</span>';
  qEl.innerHTML = `<b class="ss-price">${Math.round(q.price).toLocaleString("ko-KR")}</b>` +
    `<span class="ss-chg" style="color:${color}">${arrow} ${sign}${(q.change_pct ?? 0).toFixed(2)}%</span>${status}`;

  const bits = [];
  if (q.target_price != null && q.price) {
    const upside = (q.target_price / q.price - 1) * 100;
    const uc = upside >= 0 ? "var(--good)" : "var(--critical)";
    bits.push(`목표주가 <b>${Math.round(q.target_price).toLocaleString("ko-KR")}</b> <span style="color:${uc}">(${upside >= 0 ? "+" : ""}${upside.toFixed(0)}%)</span>`);
  }
  const rl = recommLabel(q.recomm_mean);
  if (rl) bits.push(`투자의견 <b>${rl}</b> (${q.recomm_mean.toFixed(1)})`);
  if (q.per) {
    // 현재 PER + 컨센서스(forward) PER — 추정이익 기준이라 실적 성장 종목은 fwd가 크게 낮음
    const fwd = q.cns_per ? ` <span class="ss-fwd" title="컨센서스(추정이익) 기준 forward PER">(fwd ${q.cns_per})</span>` : "";
    bits.push(`PER ${q.per}${fwd}`);
  }
  if (q.dividend_yield && q.dividend_yield !== "0.00%") bits.push(`배당 ${q.dividend_yield}`);
  if (q.market_cap_text) bits.push(`시총 ${q.market_cap_text}`);
  if (q.foreign_rate) bits.push(`외인 ${q.foreign_rate}`);
  cEl.innerHTML = bits.join(" · ") + (bits.length ? ' <span class="ss-src">· 네이버 포털 기준</span>' : "");
  cEl.hidden = bits.length === 0;
}

async function refreshQuote(code) {
  if (state.currentCode !== code) return; // 종목이 바뀌었으면 무시(경쟁 방지)
  const q = await fetchQuote(code);
  if (state.currentCode !== code) return;
  state.currentQuote = q;
  renderQuote(q);
  renderRiskReward(code); // 목표주가가 들어왔으니 손익비 갱신
  const fund = state.fundCache[code];
  renderDividend(fund && fund.status === "ok" ? fund.dividend : null); // 시세 배당 폴백 반영
  renderValuation(fund && fund.status === "ok" ? fund.valuation : null); // 시세 PER/PBR 폴백 반영(core 종목)
  if (state.financeCache && state.financeCache[code]) renderValBand(state.financeCache[code]); // 라이브 트레일링 PER로 밴드 현재위치 갱신
  // 종합요약 이름을 라이브 데이터로 보정(비워치리스트 종목 등)
  if (q && q.name) document.getElementById("ss-name").textContent = `${q.name} 종합`;
}

function startQuoteAutoRefresh(code) {
  if (_quoteTimer) { clearInterval(_quoteTimer); _quoteTimer = null; }
  state.currentQuote = null;
  renderQuote(null); // 이전 종목 시세 지우기
  renderRiskReward(code);
  // 즉시 1회 — 시세가 오면 계산기 현재가/주식수를 자동 채운다(최초 1회만, 이후 60초 갱신은 계산기 안 건드림)
  refreshQuote(code).then(() => { if (state.currentCode === code) autofillValuation(code); });
  // 장중에는 60초마다 갱신(장마감이면 자동갱신 불필요)
  _quoteTimer = setInterval(() => {
    if (state.currentCode !== code) { clearInterval(_quoteTimer); _quoteTimer = null; return; }
    refreshQuote(code);
  }, 60000);
}

// ---------- select stock ----------

// 워치리스트 밖 종목: 네이버 차트(Worker /ohlcv)를 받아 브라우저에서 지표를 즉석 계산 → 전종목 기술분석.
async function loadOnDemandTechnical(code) {
  if (state.techCache[code] && state.techCache[code].status === "ok") {
    renderTechnical(state.techCache[code]); // 세션 내 재조회 방지
    renderSummaryStrip(code);
    return;
  }
  const url = typeof ohlcvUrl === "function" ? ohlcvUrl(code) : null;
  if (!url || typeof computeTechnicalFromRows !== "function") {
    renderTechnical({ status: "unsupported" });
    return;
  }
  document.getElementById("tech-score-badge").textContent = "불러오는 중…";
  document.getElementById("tech-score-num").textContent = "-";
  document.getElementById("price-chart").innerHTML = '<div class="panel-empty">차트를 불러오는 중…</div>';
  try {
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json().catch(() => null);
    if (state.currentCode !== code) return; // 종목이 바뀌었으면 무시
    const rows = data && Array.isArray(data.rows) ? data.rows : null;
    if (!rows || rows.length === 0) {
      // 캔들이 하나도 없음. 서버가 본문(JSON)으로 '데이터 없음/부족'을 명시적으로 응답했다면
      // (상폐주는 HTTP 502여도 {error:'차트 데이터 부족', rows:0} 형태로 온다) 상장폐지·거래정지·
      // 비거래 종목이다(위다스 등). 본문 파싱조차 실패(data=null)면 네트워크 일시 오류로 본다.
      if (data && (data.error || "rows" in data)) {
        renderTechnical({ status: "delisted", reason: "시세·차트 데이터가 없습니다 — 상장폐지·거래정지되었거나 거래되지 않는 종목으로 보입니다." });
      } else {
        renderTechnical({ status: "error", reason: "차트를 불러오지 못했습니다 (잠시 후 다시 시도)" });
      }
      return;
    }
    const tech = computeTechnicalFromRows(code, stockName(code), rows);
    state.techCache[code] = tech;
    renderTechnical(tech);
    renderSummaryStrip(code); // 기술 태그 반영
  } catch (e) {
    if (state.currentCode === code) renderTechnical({ status: "error", reason: "차트를 불러오지 못했습니다" });
  }
}

// 재무 기본적분석은 전종목 pre-generated(업종평균) — 어떤 코드든 fundamental JSON을 로드한다.
// 없으면(ETF·우선주 등 DART 미등록) 미지원 안내.
async function loadFundamental(code) {
  let fund;
  try {
    if (!state.fundCache[code]) state.fundCache[code] = await loadJSON(`data/fundamental/${code}.json`);
    fund = state.fundCache[code];
  } catch (e) {
    fund = { status: "unsupported" }; // 캐시에는 남기지 않음 — 다음 호출에서 재시도 가능
  }
  if (state.currentCode !== code) return; // 그 사이 다른 종목으로 전환됐으면 화면을 덮어쓰지 않음
  renderFundamental(fund);
  renderFactorProfile(code); // 전종목 횡단면 팩터 랭킹 프로파일
  renderFilingInsight(code); // LLM 공시 인사이트(가이던스·톤·레드플래그)
  renderSummaryStrip(code);
  autofillValuation(code); // 재무 태그 + 계산기 주식수 자동채움
}

async function selectStock(code) {
  state.currentCode = code;
  // 딥링크: 현재 종목을 URL에 반영(북마크·공유 가능)
  try { history.replaceState(null, "", `?code=${code}`); } catch (e) {}
  renderResultList(state.lastRenderedItems.length ? state.lastRenderedItems : state.watchlist);
  startQuoteAutoRefresh(code); // 라이브 시세는 전종목 대상
  loadFundamental(code);       // 재무 기본적분석도 전종목 대상(업종평균)
  loadValuationBand(code);     // 밸류에이션 밴드(과거 대비 PER 위치)
  renderSummaryStrip(code);
  renderRevision(code);        // 애널리스트 추정치 리비전(누적되면 표시)
  renderAttention(code);       // 관심도(검색·뉴스 급증) — 단기 관심 신호

  if (state.watchlistCodes.has(code)) {
    // 워치리스트: 사전생성 기술적분석(결정론적 점수 포함) 사용
    try {
      if (!state.techCache[code]) state.techCache[code] = await loadJSON(`data/technical/${code}.json`);
      renderTechnical(state.techCache[code]);
    } catch (e) {
      renderTechnical({ status: "error", reason: "데이터 파일을 찾을 수 없습니다" });
    }
  } else {
    // 그 외 전종목: 네이버 차트로 즉석 계산
    await loadOnDemandTechnical(code);
  }
}

function wireRangeTabs() {
  document.getElementById("range-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-range]");
    if (!btn) return;
    document.querySelectorAll("#range-tabs button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.currentRange = parseInt(btn.dataset.range, 10);
    if (state.currentCode && state.techCache[state.currentCode]) renderTechnical(state.techCache[state.currentCode]);
  });
}

// ---------- AI 어시스턴트 (우측 컬럼 채팅 패널) ----------
// GPT_WORKER_URL(js/config.js)이 비어있으면 안내 토스트만 표시(기존 동작 그대로).
// 설정돼 있으면 cloudflare-worker를 통해 실제 GPT와 대화한다 — OpenAI 키는 이 페이지에 없다.

state.chatHistory = [];

function isGptConfigured() {
  return typeof GPT_WORKER_URL === "string" && GPT_WORKER_URL.trim().length > 0;
}

function appendChatMessage(role, content, extraClass = "") {
  const log = document.getElementById("assistant-log");
  const hint = document.getElementById("chat-empty-hint");
  if (hint) hint.remove();
  const div = document.createElement("div");
  div.className = `chat-msg ${role} ${extraClass}`.trim();
  div.textContent = content;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function currentStockContext() {
  const code = state.currentCode;
  if (!code) return null;
  const tech = state.techCache[code];
  const fund = state.fundCache[code];
  const quote = state.currentQuote;
  // 전 종목 지원(파리티): 워치리스트가 아니어도 온디맨드 기술+전종목 재무+라이브 시세가 있으면 맥락 제공.
  if ((!tech || tech.status !== "ok") && (!fund || fund.status !== "ok") && !quote) return null;
  const ind = tech && tech.status === "ok" ? tech.indicators : null;
  const risk = ind ? ind.risk : null;
  const levels = ind ? ind.levels : null;
  const val = fund && fund.status === "ok" ? fund.valuation : null;
  const q = fund && fund.status === "ok" ? fund.quality : null;
  const dv = fund && fund.status === "ok" ? fund.dividend : null;
  const trend = fund && fund.status === "ok" ? fund.earnings_trend : null;
  // 배당수익률은 현재가 기준 라이브값 우선(화면과 동일) — DART는 core에서 과거 배당기준일 기준이라 어긋남
  const liveDy = quote && quote.dividend_yield && quote.dividend_yield !== "0.00%" ? parseFloat(quote.dividend_yield) : null;
  const divYield = liveDy != null ? liveDy : (dv && dv.status === "ok" ? dv.dividend_yield_pct : null);
  return {
    code,
    name: (quote && quote.name) || stockName(code),
    live: quote ? { price: quote.price, change_pct: quote.change_pct, target_price: quote.target_price, per: quote.per, recomm_mean: quote.recomm_mean } : null,
    technical_score: tech && tech.status === "ok" ? (tech._displayScore ?? tech.score) : null,
    fundamental_scores: fund && fund.status === "ok"
      ? { stability: fund.stability_score, growth: fund.growth_score, activity: fund.activity_score }
      : null,
    valuation: (quote && _parseBae(quote.per) != null) ? { per: _parseBae(quote.per), pbr: _parseBae(quote.pbr) } : (val ? { per: val.per, pbr: val.pbr } : null),
    quality: q ? { f_score: q.f_score && q.f_score.score, f_score_max: q.f_score && q.f_score.max_score, roe_pct: q.roe_pct, roa_pct: q.roa_pct } : null,
    risk: risk ? { annualized_volatility_pct: risk.annualized_volatility_pct, max_drawdown_pct: risk.max_drawdown_pct, week52_position_pct: risk.week52_position_pct } : null,
    support_resistance: levels ? { support: levels.support, resistance: levels.resistance } : null,
    dividend: divYield != null ? { yield_pct: divYield, payout_pct: dv && dv.payout_pct != null ? dv.payout_pct : null } : (dv && dv.status === "none" ? "무배당" : null),
    earnings_trend: trend && trend.length ? trend.map((t) => ({ year: t.year, revenue: t.revenue, op_margin_pct: t.op_margin_pct })) : null,
  };
}

async function sendToGpt(userText) {
  appendChatMessage("user", userText);
  state.chatHistory.push({ role: "user", content: userText });
  const pending = appendChatMessage("assistant", "생각 중...", "pending");

  try {
    const res = await fetch(GPT_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: state.chatHistory.slice(-12), stockContext: currentStockContext() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
    pending.textContent = data.reply;
    pending.className = "chat-msg assistant";
    state.chatHistory.push({ role: "assistant", content: data.reply });
  } catch (err) {
    pending.textContent = `연결 실패: ${err.message}`;
    pending.className = "chat-msg error-msg";
  }
}

function wireAssistant() {
  const send = () => {
    const input = document.getElementById("assistant-input");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    if (isGptConfigured()) {
      sendToGpt(text);
    } else {
      showToast("GPT가 아직 연결되지 않았습니다. cloudflare-worker/README.md대로 배포 후 js/config.js에 주소를 넣으면 실제 대화가 가능합니다. 그 전까지는 Claude Code 에이전트에게 직접 물어보세요.", 5500);
    }
  };
  document.getElementById("assistant-send").onclick = send;
  document.getElementById("assistant-input").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
  document.getElementById("assistant-reset").onclick = () => {
    state.chatHistory = [];
    const log = document.getElementById("assistant-log");
    log.innerHTML = '<div class="chat-empty" id="chat-empty-hint">보고 있는 종목이나 분석 결과에 대해 궁금한 점을 물어보세요.</div>';
    showToast("대화를 초기화했습니다.");
  };
}

// ---------- init ----------

async function init() {
  try { state.watchlist = await loadJSON("data/watchlist.json"); } catch (e) { state.watchlist = []; }
  state.watchlistCodes = new Set(state.watchlist.map((w) => w.code));
  try {
    const idx = await loadJSON("data/company_index.json");
    state.companyIndex = idx.status === "ok" ? idx.companies : [];
  } catch (e) { state.companyIndex = []; }
  try { state.meta = await loadJSON("data/meta.json"); } catch (e) { state.meta = null; }
  try { state.factorRanking = await loadJSON("data/factor_ranking.json"); } catch (e) { state.factorRanking = null; }
  try { state.estimateRevisions = await loadJSON("data/estimate_revisions.json"); } catch (e) { state.estimateRevisions = null; }
  try { state.filingInsights = await loadJSON("data/filing_insights.json"); } catch (e) { state.filingInsights = null; }
  try { state.attention = await loadJSON("data/attention.json"); } catch (e) { state.attention = null; }
  renderFreshness();
  wireFactorTop();

  updateSearchSummary(state.watchlist.length, "");
  renderResultList(state.watchlist);
  wireSearch();
  wireRangeTabs();
  wireAssistant();
  wireModal();
  wireValuationCalc();

  // 딥링크: ?range=(거래일 수, 예 1250=5년)로 초기 차트 기간 설정
  const urlRange = parseInt(new URLSearchParams(location.search).get("range"), 10);
  const rangeBtn = urlRange && document.querySelector(`#range-tabs button[data-range="${urlRange}"]`);
  if (rangeBtn) {
    document.querySelectorAll("#range-tabs button").forEach((b) => b.classList.remove("active"));
    rangeBtn.classList.add("active");
    state.currentRange = urlRange;
  }

  // 딥링크: URL의 ?code=가 있으면 그 종목을, 없으면 워치리스트 첫 종목을 연다
  const urlCode = new URLSearchParams(location.search).get("code");
  if (urlCode && /^\d{6}$/.test(urlCode)) {
    if (!state.companyIndex.some((c) => c.code === urlCode) && !state.watchlistCodes.has(urlCode)) {
      // 인덱스에 없어도(우선주·ETF) 직접 조회로 표시
      renderResultList([{ code: urlCode, name: urlCode, sector: "코드 직접조회", has_detail: false, direct: true }]);
    }
    selectStock(urlCode);
  } else if (state.watchlist.length) {
    selectStock(state.watchlist[0].code);
  }
}

init();
