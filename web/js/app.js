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
    const tag = hasDetail
      ? `<span class="r-tag">${item.sector || "상세분석 지원"}</span>`
      : `<span class="r-tag r-tag-muted">상세분석 미지원</span>`;
    li.innerHTML = `
      <div class="r-title">${item.name} <span style="color:var(--text-muted);font-weight:400">${item.code}</span></div>
      <div class="r-meta">${tag}</div>`;
    li.onclick = () => selectStock(item.code);
    list.appendChild(li);
  }
  if (items.length > capped.length) {
    const more = document.createElement("li");
    more.className = "panel-empty";
    more.textContent = `외 ${items.length - capped.length}개 더 있음 — 검색어를 구체적으로 입력하면 좁혀집니다`;
    list.appendChild(more);
  }
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
    document.getElementById("tech-score-num").textContent = "-";
    document.getElementById("tech-score-badge").textContent = data && data.status === "unsupported" ? "미지원 종목" : "데이터 없음";
    document.getElementById("tech-score-sub").textContent = "";
    renderGauge(3);
    document.getElementById("price-chart").innerHTML =
      data && data.status === "unsupported"
        ? '<div class="panel-empty">이 종목은 상시분석 대상(시가총액 상위 우량주)이 아니라 상세분석을 제공하지 않습니다.<br>Claude Code 에이전트에게 직접 물어보시면 이 종목도 분석해 드립니다.</div>'
        : '<div class="panel-empty">기술적분석 데이터를 아직 생성하지 못했습니다</div>';
    document.getElementById("indicator-table").innerHTML = "";
    clearRadar();
    renderRisk(null);
    renderLevels(null);
    warnEl.textContent = data && data.reason ? `사유: ${data.reason}` : "";
    return;
  }

  document.getElementById("tech-score-num").textContent = data.score ?? "-";
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
  warnEl.textContent = humanizeWarnings(data.warnings);
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
const BASIS_LABELS = { industry_average: "동일업종 평균", market_average_fallback: "시장 전체 평균(대체)", unavailable: "비교불가" };

function fmtRatio(v) { return v == null ? "-" : (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)); }

function renderFundamental(data) {
  const warnEl = document.getElementById("fund-warning");
  const ids = ["fund-stability", "fund-growth", "fund-activity"];
  if (!data || data.status !== "ok") {
    ids.forEach((id) => { document.getElementById(id).textContent = "-"; document.getElementById(id).style.color = ""; });
    document.getElementById("fin-table").innerHTML = "";
    document.getElementById("fund-summary-list").innerHTML =
      data && data.status === "unsupported" ? '<li>상세분석 미지원 종목입니다.</li>' : "";
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

  document.getElementById("fund-table-title").textContent = `주요 재무 지표 (${data.latest_period ? data.latest_period.bsns_year + "년" : ""})`;

  const groups = [["안정성", data.stability], ["성장성", data.growth], ["활동성", data.activity]];
  let rowsHtml = `<tr><th>지표</th><th>종목값</th><th>${data.comparison_basis === "industry_average" ? "업종평균" : "비교평균"}</th><th>상대위치</th></tr>`;
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

function renderValuation(val) {
  const perEl = document.getElementById("val-per");
  const pbrEl = document.getElementById("val-pbr");
  const perNote = document.getElementById("val-per-note");
  const pbrNote = document.getElementById("val-pbr-note");
  if (!val || val.basis !== "eps_derived") {
    perEl.textContent = pbrEl.textContent = "-";
    perNote.textContent = pbrNote.textContent = val && val.basis === "unavailable" ? "산출 불가(EPS 미공시 등)" : "";
    perEl.className = pbrEl.className = "val-tile-value";
    return;
  }
  // PER: 음수면 적자. 절대 저평가/고평가 단정은 피하고 방향성만 가볍게.
  if (val.per == null) { perEl.textContent = "-"; perNote.textContent = ""; }
  else if (val.per < 0) { perEl.textContent = "적자"; perEl.className = "val-tile-value val-warn"; perNote.textContent = "순이익 마이너스"; }
  else {
    perEl.textContent = `${val.per.toFixed(1)}배`;
    perEl.className = "val-tile-value";
    perNote.textContent = val.per < 10 ? "이익 대비 낮은 편" : val.per > 30 ? "이익 대비 높은 편" : "";
  }
  // PBR: 1배 미만은 순자산가치 이하 — 명확히 의미 있는 신호라 표시.
  if (val.pbr == null) { pbrEl.textContent = "-"; pbrNote.textContent = ""; pbrEl.className = "val-tile-value"; }
  else {
    pbrEl.textContent = `${val.pbr.toFixed(2)}배`;
    if (val.pbr < 1) { pbrEl.className = "val-tile-value val-cheap"; pbrNote.textContent = "순자산가치 이하"; }
    else { pbrEl.className = "val-tile-value"; pbrNote.textContent = val.pbr > 3 ? "순자산 대비 높음" : ""; }
  }
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
  if (!div || div.status === "none") {
    // 무배당(확정) 또는 데이터 없음
    tiles.hidden = true;
    none.hidden = !(div && div.status === "none");
    if (!div) none.hidden = true;
    return;
  }
  tiles.hidden = false;
  none.hidden = true;
  y.textContent = div.dividend_yield_pct == null ? "-" : `${div.dividend_yield_pct.toFixed(1)}%`;
  y.style.color = div.dividend_yield_pct == null ? "" : div.dividend_yield_pct >= 4 ? "var(--good)" : "";
  p.textContent = div.payout_pct == null ? "-" : `${Math.round(div.payout_pct)}%`;
  d.textContent = div.dps == null ? "-" : `${Math.round(div.dps).toLocaleString("ko-KR")}원`;
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
  // 밸류에이션
  const val = okF ? fund.valuation : null;
  if (val && val.basis === "eps_derived") {
    if (val.pbr != null && val.pbr < 1) tags.push({ t: "PBR<1 저평가", c: "good" });
    else if (val.per != null && val.per > 0 && val.per < 10) tags.push({ t: "이익 대비 저평가", c: "good" });
    else if (val.per != null && val.per > 40) tags.push({ t: "밸류에이션 부담", c: "warn" });
  }
  // 퀄리티
  const q = okF ? fund.quality : null;
  const fs = q && q.f_score ? q.f_score : null;
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
  // 기술
  if (okT && tech.score != null) {
    if (tech.score >= 4) tags.push({ t: "기술적 강세", c: "good" });
    else if (tech.score <= 2) tags.push({ t: "기술적 약세", c: "bad" });
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
  document.getElementById("ss-name").textContent = `${stockName(code)} 종합`;
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
  if (q.market_cap_text) bits.push(`시총 ${q.market_cap_text}`);
  if (q.foreign_rate) bits.push(`외인 ${q.foreign_rate}`);
  cEl.innerHTML = bits.join(" · ") + (bits.length ? ' <span class="ss-src">· 네이버 포털 기준</span>' : "");
  cEl.hidden = bits.length === 0;
}

async function refreshQuote(code) {
  if (state.currentCode !== code) return; // 종목이 바뀌었으면 무시(경쟁 방지)
  const q = await fetchQuote(code);
  if (state.currentCode !== code) return;
  renderQuote(q);
  // 종합요약 이름을 라이브 데이터로 보정(비워치리스트 종목 등)
  if (q && q.name) document.getElementById("ss-name").textContent = `${q.name} 종합`;
}

function startQuoteAutoRefresh(code) {
  if (_quoteTimer) { clearInterval(_quoteTimer); _quoteTimer = null; }
  renderQuote(null); // 이전 종목 시세 지우기
  refreshQuote(code); // 즉시 1회
  // 장중에는 60초마다 갱신(장마감이면 자동갱신 불필요)
  _quoteTimer = setInterval(() => {
    if (state.currentCode !== code) { clearInterval(_quoteTimer); _quoteTimer = null; return; }
    refreshQuote(code);
  }, 60000);
}

// ---------- select stock ----------

async function selectStock(code) {
  state.currentCode = code;
  renderResultList(state.lastRenderedItems.length ? state.lastRenderedItems : state.watchlist);
  startQuoteAutoRefresh(code); // 라이브 시세는 전종목 대상(심층분석 지원 여부와 무관)

  if (!state.watchlistCodes.has(code)) {
    renderTechnical({ status: "unsupported" });
    renderFundamental({ status: "unsupported" });
    renderSummaryStrip(code); // 미지원 종목도 strip(이름+라이브 시세)은 표시
    return;
  }

  try {
    if (!state.techCache[code]) state.techCache[code] = await loadJSON(`data/technical/${code}.json`);
    renderTechnical(state.techCache[code]);
  } catch (e) {
    renderTechnical({ status: "error", reason: "데이터 파일을 찾을 수 없습니다" });
  }

  try {
    if (!state.fundCache[code]) state.fundCache[code] = await loadJSON(`data/fundamental/${code}.json`);
    renderFundamental(state.fundCache[code]);
  } catch (e) {
    renderFundamental({ status: "error", reason: "데이터 파일을 찾을 수 없습니다" });
  }

  renderSummaryStrip(code);
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

  if (state.watchlist.length) selectStock(state.watchlist[0].code);
}

init();
