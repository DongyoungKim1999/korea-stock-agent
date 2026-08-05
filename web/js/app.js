// AI 투자 에이전트 대시보드 — web/data/*.json(자동 생성 정적 데이터)을 읽어 렌더링만 수행한다.
// 이 페이지는 정적 사이트라 실시간 LLM 대화는 없다 — 하단 어시스턴트는 안내 메시지만 표시한다.

const state = {
  watchlist: [],
  watchlistCodes: new Set(),
  companyIndex: [],   // 코스피+코스닥 전체 검색 인덱스 (data/company_index.json)
  meta: null,
  currentCode: null,
  currentRange: 90,
  techCache: {},
  fundCache: {},
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
    if (t) t.innerHTML = `${q.name} <span style="color:var(--text-muted);font-weight:400">${code}</span>`;
  }
  const up = q.change_pct > 0, down = q.change_pct < 0;
  const c = up ? "var(--candle-up)" : down ? "var(--candle-down)" : "var(--text-muted)";
  const arr = up ? "▲" : down ? "▼" : "–";
  const cap = q.market_cap_text ? `<span class="r-cap">${q.market_cap_text}</span>` : "";
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
  // 표/레이더 표시 전용 0~5 매핑(참고용) — 실제 채점은 automation/deterministic_scoring.py.
  const clamp5 = (v) => Math.max(0, Math.min(5, v));
  switch (kind) {
    case "ma": {
      const m = { bullish: 4.3, mixed: 3.0, bearish: 1.7, insufficient_data: 2.5 }[ind.moving_averages.alignment];
      return clamp5(m);
    }
    case "macd": {
      let v = 3.0 + (ind.macd.above_zero ? 0.8 : -0.8);
      const c = ind.macd.signal_cross_recent;
      if (c.occurred && c.days_ago <= 5) v += c.direction === "golden" ? 0.9 : -0.9;
      return clamp5(v);
    }
    case "rsi":
      return ind.rsi14.latest == null ? 2.5 : clamp5(3.0 + (ind.rsi14.latest - 50) / 20);
    case "bollinger":
      return ind.bollinger.percent_b == null ? 2.5 : clamp5(3.0 + (ind.bollinger.percent_b - 0.5) * 4);
    case "volume": {
      const r = ind.volume.ratio_to_avg20;
      if (r == null) return 2.5;
      const bullish = ind.candles.recent.length && ind.candles.recent[ind.candles.recent.length - 1].bullish;
      return clamp5(3.0 + (r - 1) * (bullish ? 1 : -1));
    }
    case "stochastic":
      return ind.stochastic.k_latest == null ? 2.5 : clamp5(ind.stochastic.k_latest / 20);
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

  const rows = data.price_series.slice(-state.currentRange);
  renderPriceChart(document.getElementById("price-chart"), rows, data.indicators.levels);

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
  if (!data || data.status !== "ok" || !data.price_series) { renderRS(null); return; }
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
}

// ---------- 손익비 (Risk/Reward): 목표주가(컨센서스) vs 지지선 ----------

function renderRiskReward(code) {
  const block = document.getElementById("rr-block");
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
    `* 비교기준: ${BASIS_LABELS[data.comparison_basis] || data.comparison_basis} · 업종 민감도 조정: ` +
    (data.sensitivity_applied ? Object.entries(data.sensitivity_applied).filter(([, v]) => v !== 1.0).map(([k, v]) => `${k}×${v}`).join(", ") || "없음" : "없음");

  warnEl.textContent = humanizeWarnings(data.warnings);
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
  // DART 역산값(120 full)이 있으면 그걸, 없으면(core 전종목) 라이브 시세의 PER/PBR을 쓴다.
  const q = state.currentQuote;
  const hasDart = val && val.basis === "eps_derived";
  const per = hasDart ? val.per : (q ? _parseBae(q.per) : null);
  const pbr = hasDart ? val.pbr : (q ? _parseBae(q.pbr) : null);
  const src = !hasDart && q ? " (시세)" : "";

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
  const valid = fin.per.map((v, i) => ({ v, y: fin.years[i] })).filter((o) => o.v != null && o.v > 0);
  if (valid.length < 2) { band.hidden = true; return; }
  const vals = valid.map((o) => o.v);
  const min = Math.min(...vals), max = Math.max(...vals), cur = valid[valid.length - 1].v;
  const pos = max > min ? ((cur - min) / (max - min)) * 100 : 50;
  band.hidden = false;
  document.getElementById("vb-marker").style.left = `${Math.max(0, Math.min(100, pos))}%`;
  const verdict = pos <= 30 ? "역사적 저평가권" : pos >= 70 ? "역사적 고평가권" : "중간 수준";
  const vc = pos <= 30 ? "var(--good)" : pos >= 70 ? "var(--critical)" : "var(--text-secondary)";
  document.getElementById("vb-verdict").innerHTML = `<span style="color:${vc}">${verdict}</span> · 현재 ${cur.toFixed(1)}배 (범위 ${min.toFixed(1)}~${max.toFixed(1)})`;
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
  const hasDart = div && div.status === "ok" && div.dividend_yield_pct != null;
  // 라이브 시세 배당(네이버) — DART 배당이 없는 전종목(core)도 배당수익률/주당배당금 표시
  const qYield = q && q.dividend_yield && q.dividend_yield !== "0.00%" ? q.dividend_yield : null;

  if (hasDart) {
    tiles.hidden = false; none.hidden = true;
    y.textContent = `${div.dividend_yield_pct.toFixed(1)}%`;
    y.style.color = div.dividend_yield_pct >= 4 ? "var(--good)" : "";
    p.textContent = div.payout_pct == null ? "-" : `${Math.round(div.payout_pct)}%`;
    d.textContent = div.dps == null ? "-" : `${Math.round(div.dps).toLocaleString("ko-KR")}원`;
    return;
  }
  if (qYield) {
    tiles.hidden = false; none.hidden = true;
    y.textContent = qYield;
    y.style.color = parseFloat(qYield) >= 4 ? "var(--good)" : "";
    p.textContent = div && div.payout_pct != null ? `${Math.round(div.payout_pct)}%` : "-"; // 배당성향은 DART만 제공
    d.textContent = q.dividend || "-"; // "1,668원"
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
  const val = okF ? fund.valuation : null;
  if (val && val.basis === "eps_derived") {
    if (val.pbr != null && val.pbr < 1) tags.push(weakQuality ? { t: "PBR<1 가치함정 주의", c: "warn" } : { t: "PBR<1 저평가", c: "good" });
    else if (val.per != null && val.per > 0 && val.per < 10) tags.push({ t: "이익 대비 저평가", c: "good" });
    else if (val.per != null && val.per > 40) tags.push({ t: "밸류에이션 부담", c: "warn" });
  }
  // 퀄리티
  if (fs && fs.max_score) {
    const r = fs.score / fs.max_score;
    if (r >= 7 / 9) tags.push({ t: `우량(F${fs.score})`, c: "good" });
    else if (r < 4 / 9) tags.push({ t: `재무취약(F${fs.score})`, c: "bad" });
  }
  if (q && q.roe_pct != null && q.roe_pct >= 15) tags.push({ t: `고ROE ${q.roe_pct.toFixed(0)}%`, c: "good" });
  // 배당
  const dv = okF ? fund.dividend : null;
  if (dv && dv.status === "ok" && dv.dividend_yield_pct != null && dv.dividend_yield_pct >= 4)
    tags.push({ t: `고배당 ${dv.dividend_yield_pct.toFixed(1)}%`, c: "good" });
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
  return `${body}. (투자 판단·책임은 본인에게 있으며, 매수·매도 권유가 아닌 특성 요약입니다.)`;
}

// ---------- 밸류에이션 계산기 (2단계 FCFF DCF) ----------

function _valcNum(id) {
  const v = parseFloat(document.getElementById(id).value);
  return Number.isFinite(v) ? v : null;
}

function computeValuation() {
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
  bdEl.innerHTML = `기업가치 ${fmt(ev)} · 주주가치 ${fmt(equity)} <span style="color:var(--text-muted)">(잔존가치 비중 ${Math.round(pvTerminal / ev * 100)}%)</span>`;

  if (price && perShare > 0) {
    const upside = (perShare / price - 1) * 100;
    const c = upside >= 0 ? "var(--good)" : "var(--critical)";
    upEl.innerHTML = `현재가 ${Math.round(price).toLocaleString("ko-KR")} 대비 <b style="color:${c}">${upside >= 0 ? "+" : ""}${upside.toFixed(0)}%</b> ${upside >= 0 ? "(저평가 여력)" : "(고평가)"}`;
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
  const b = beta == null ? 1.0 : Math.max(0.3, Math.min(2.0, beta));
  const re = _RF + b * _ERP;                 // 자기자본비용(CAPM)
  const E = Math.max(equityEok || 0, 1), D = Math.max(netDebtEok || 0, 0);
  const wacc = (E * re + D * (_RD * (1 - _TAX))) / (E + D); // 자본구조 가중
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

  // 발행주식수(백만주): EPS 역산값 우선, 없으면 시총/현재가로 역산(전종목 가능)
  const mcEok = q ? parseMarketCapEok(q.market_cap_text) : null;
  let sharesM = val && val.shares_estimated ? val.shares_estimated / 1e6 : null;
  if (sharesM == null && mcEok && q && q.price) sharesM = (mcEok * 100) / q.price;
  if (sharesM != null) set("valc-shares", Math.round(sharesM * 10) / 10);

  // FCFF(억원)·순부채(억원) — 재무 파이프라인 valuation_inputs
  if (vi) { set("valc-fcff", vi.fcff_eok); set("valc-netdebt", vi.net_debt_eok); }

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
  ["valc-fcff", "valc-g1", "valc-years", "valc-gt", "valc-wacc", "valc-netdebt", "valc-shares", "valc-price"]
    .forEach((id) => document.getElementById(id).addEventListener("input", computeValuation));
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
  try {
    if (!state.fundCache[code]) state.fundCache[code] = await loadJSON(`data/fundamental/${code}.json`);
    renderFundamental(state.fundCache[code]);
  } catch (e) {
    renderFundamental({ status: "unsupported" });
  }
  if (state.currentCode === code) { renderSummaryStrip(code); autofillValuation(code); } // 재무 태그 + 계산기 주식수 자동채움
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
  if (!code || !state.watchlistCodes.has(code)) return null;
  const tech = state.techCache[code];
  const fund = state.fundCache[code];
  const ind = tech && tech.status === "ok" ? tech.indicators : null;
  const risk = ind ? ind.risk : null;
  const levels = ind ? ind.levels : null;
  const val = fund && fund.status === "ok" ? fund.valuation : null;
  const q = fund && fund.status === "ok" ? fund.quality : null;
  const dv = fund && fund.status === "ok" ? fund.dividend : null;
  const trend = fund && fund.status === "ok" ? fund.earnings_trend : null;
  return {
    code,
    name: (state.watchlist.find((w) => w.code === code) || {}).name,
    technical_score: tech && tech.status === "ok" ? tech.score : null,
    fundamental_scores: fund && fund.status === "ok"
      ? { stability: fund.stability_score, growth: fund.growth_score, activity: fund.activity_score }
      : null,
    valuation: val && val.basis === "eps_derived" ? { per: val.per, pbr: val.pbr } : null,
    quality: q ? { f_score: q.f_score && q.f_score.score, f_score_max: q.f_score && q.f_score.max_score, roe_pct: q.roe_pct, roa_pct: q.roa_pct } : null,
    risk: risk ? { annualized_volatility_pct: risk.annualized_volatility_pct, max_drawdown_pct: risk.max_drawdown_pct, week52_position_pct: risk.week52_position_pct } : null,
    support_resistance: levels ? { support: levels.support, resistance: levels.resistance } : null,
    dividend: dv && dv.status === "ok" ? { yield_pct: dv.dividend_yield_pct, payout_pct: dv.payout_pct } : (dv && dv.status === "none" ? "무배당" : null),
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
  renderFreshness();

  updateSearchSummary(state.watchlist.length, "");
  renderResultList(state.watchlist);
  wireSearch();
  wireRangeTabs();
  wireAssistant();
  wireModal();
  wireValuationCalc();

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
