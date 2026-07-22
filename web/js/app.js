// AI 투자 에이전트 대시보드 — web/data/*.json(자동 생성 정적 데이터)을 읽어 렌더링만 수행한다.
// 이 페이지는 정적 사이트라 실시간 LLM 대화는 없다 — 하단 어시스턴트는 안내 메시지만 표시한다.

const state = {
  watchlist: [],
  watchlistCodes: new Set(),
  companyIndex: [],   // 코스피+코스닥 전체 검색 인덱스 (data/company_index.json)
  meta: null,
  attention: null,
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
    let text = w;
    if (/시가총액/.test(w)) text = "시가총액 정보는 이번 갱신에서 가져오지 못했습니다(참고용 부가정보라 분석에는 영향 없음).";
    else if (/재시도\(\d+회?\)\s*소진|자동재시도/.test(w)) continue; // 내부 재시도 로그는 숨김
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
    el.style.cssText = "position:fixed;left:50%;bottom:78px;transform:translateX(-50%);background:#1c2436;border:1px solid rgba(255,255,255,.14);color:#f2f4f8;padding:10px 18px;border-radius:999px;font-size:12.5px;z-index:200;max-width:80vw;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.4);";
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
  let text = `데이터 기준: ${stamp} · 워치리스트 ${state.meta.watchlist_count}종목 자동 갱신 (결정론적 채점 — 대화형 에이전트의 LLM 판단과는 별개입니다)`;
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
  renderPriceChart(document.getElementById("price-chart"), rows);

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

  warnEl.textContent = humanizeWarnings(data.warnings);
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
    warnEl.textContent = data && data.reason ? `사유: ${data.reason}` : "";
    return;
  }

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

// ---------- select stock ----------

async function selectStock(code) {
  state.currentCode = code;
  renderResultList(state.lastRenderedItems.length ? state.lastRenderedItems : state.watchlist);

  if (!state.watchlistCodes.has(code)) {
    renderTechnical({ status: "unsupported" });
    renderFundamental({ status: "unsupported" });
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

// ---------- attention panel ----------

state.attentionTab = "overall";

const ATTENTION_TAB_EMPTY_MSG = {
  overall: "오늘은 통계적으로 뚜렷하게 주목할 만한 종목이 없습니다.",
  by_search: "오늘은 검색량이 뚜렷하게 급증한 종목이 없습니다 (네이버 데이터랩 키 미설정일 수도 있습니다).",
};

function currentAttentionRanked() {
  if (!state.attention || state.attention.status !== "ok") return [];
  const rankings = state.attention.rankings;
  if (rankings && rankings[state.attentionTab]) return rankings[state.attentionTab];
  return state.attentionTab === "overall" ? state.attention.ranked_stocks || [] : [];
}

function renderAttentionList() {
  const list = document.getElementById("attention-list");
  const timeEl = document.getElementById("attention-time");

  if (!state.attention || state.attention.status !== "ok") {
    list.innerHTML = '<li class="attention-empty">주목종목 데이터를 아직 생성하지 못했습니다.<br>GitHub Actions 실행 후 표시됩니다.</li>';
    timeEl.textContent = "기준 시간: -";
    return;
  }

  const ranked = currentAttentionRanked();
  const dt = new Date(state.attention.generated_at);
  timeEl.textContent = `기준 시간: ${isNaN(dt) ? state.attention.generated_at : dt.toLocaleString("ko-KR", { hour12: false })} · 1차 스크리닝 통과 ${state.attention.screened_candidate_count}개 중 상위 ${ranked.length}개`;

  if (ranked.length === 0) {
    list.innerHTML = `<li class="attention-empty">${ATTENTION_TAB_EMPTY_MSG[state.attentionTab] || "표시할 종목이 없습니다."}</li>`;
    return;
  }

  list.innerHTML = "";
  ranked.forEach((s) => {
    const li = document.createElement("li");
    li.className = "attention-item";
    const changeCls = (s.today_change_pct ?? 0) >= 0 ? "pos" : "neg";
    const scoreForDisplay = state.attentionTab === "by_search" ? s.search_component : s.composite_score;
    const displayMax = state.attentionTab === "by_search" ? 3 : 11;
    const displayScore = Math.max(0, Math.min(5, (scoreForDisplay / displayMax) * 5));
    li.innerHTML = `
      <div class="rank-badge">${s.rank}</div>
      <div class="a-main">
        <div class="a-name">${s.name || s.code}</div>
        <div class="a-code">${s.code}</div>
      </div>
      <canvas class="a-spark" width="54" height="24"></canvas>
      <div class="a-price">
        <div>${s.today_close != null ? Number(s.today_close).toLocaleString() : "-"}</div>
        <div class="a-change ${changeCls}">${s.today_change_pct != null ? (s.today_change_pct >= 0 ? "+" : "") + s.today_change_pct + "%" : ""}</div>
      </div>
      <div class="a-score" style="color:${scoreStatusColor(displayScore)}">${displayScore.toFixed(1)}</div>`;
    li.onclick = () => showAttentionDetail(s);
    list.appendChild(li);
    if (s.sparkline && s.sparkline.length > 1) renderSparkline(li.querySelector(".a-spark"), s.sparkline);
  });
}

function wireAttentionTabs() {
  document.getElementById("attention-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-key]");
    if (!btn) return;
    document.querySelectorAll("#attention-tabs button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.attentionTab = btn.dataset.key;
    renderAttentionList();
  });
}

function showAttentionDetail(s) {
  const inWatchlist = state.watchlistCodes.has(s.code);
  openModal(`
    <h3>${s.rank}. ${s.name || s.code} (${s.code})</h3>
    <p>${s.reason}</p>
    <ul class="check-list">${(s.evidence || []).map((e) => `<li>${e}</li>`).join("")}</ul>
    <p style="color:var(--text-muted);font-size:11px;margin-top:14px;">자동 생성된 요약이며 LLM 서술이 아닌 규칙 기반 근거입니다. 심층분석은 Claude Code 에이전트에게 "${s.name} 분석해줘"라고 요청하세요.</p>
    ${inWatchlist ? `<button class="ghost-btn" id="goto-stock" style="margin-top:10px;">이 종목 상세분석 보기 →</button>` : ""}
  `);
  const gotoBtn = document.getElementById("goto-stock");
  if (gotoBtn) gotoBtn.onclick = () => { document.getElementById("modal").hidden = true; selectStock(s.code); window.scrollTo({ top: 0, behavior: "smooth" }); };
}

function wireAttentionCriteria() {
  document.getElementById("attention-criteria-btn").onclick = () => {
    openModal(`
      <h3>추천 기준</h3>
      <p>① 전종목 거래량·등락률을 최근 20거래일 자기 자신의 평균과 비교(Z-score)해 상위 30~50개 후보를 뽑고,
      ② 후보들의 네이버 검색량 급증·뉴스 언급·DART 공시 빈도를 추가로 확인합니다.</p>
      <p><b>실시간 급상승</b> 탭: 통계 이상탐지 점수(최대 4점) + 검색량(최대 3점) + 뉴스(최대 2.5점) + 공시(최대 1.5점)를 합산한 점수로 순위화.<br>
      <b>검색량 급증</b> 탭: 위 후보군 중 네이버 검색어트렌드 상승폭만으로 다시 순위화 — 시세는 아직 크게 안 움직였어도 관심이 몰리기 시작한 종목을 먼저 보고 싶을 때 사용.</p>
      <p style="color:var(--text-muted);font-size:11px;">대화형 Claude Code 에이전트(market-scanner)는 이 데이터를 LLM이 직접 종합판단하지만,
      이 자동 갱신 웹페이지는 무인 실행이라 규칙 기반 점수로 대체합니다.</p>
    `);
  };
}

// ---------- assistant bar ----------
// GPT_WORKER_URL(js/config.js)이 비어있으면 안내 토스트만 표시(기존 동작 그대로).
// 설정돼 있으면 cloudflare-worker를 통해 실제 GPT와 대화한다 — OpenAI 키는 이 페이지에 없다.

state.chatHistory = [];

function isGptConfigured() {
  return typeof GPT_WORKER_URL === "string" && GPT_WORKER_URL.trim().length > 0;
}

function appendChatMessage(role, content, extraClass = "") {
  const log = document.getElementById("assistant-log");
  log.hidden = false;
  const div = document.createElement("div");
  div.className = `assistant-msg ${role} ${extraClass}`.trim();
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
  return {
    code,
    name: (state.watchlist.find((w) => w.code === code) || {}).name,
    technical_score: tech && tech.status === "ok" ? tech.score : null,
    fundamental_scores: fund && fund.status === "ok"
      ? { stability: fund.stability_score, growth: fund.growth_score, activity: fund.activity_score }
      : null,
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
    pending.className = "assistant-msg assistant";
    state.chatHistory.push({ role: "assistant", content: data.reply });
  } catch (err) {
    pending.textContent = `연결 실패: ${err.message}`;
    pending.className = "assistant-msg error-msg";
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
    log.innerHTML = "";
    log.hidden = true;
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

  try { state.attention = await loadJSON("data/attention.json"); } catch (e) { state.attention = null; }
  renderAttentionList();

  updateSearchSummary(state.watchlist.length, "");
  renderResultList(state.watchlist);
  wireSearch();
  wireRangeTabs();
  wireAssistant();
  wireModal();
  wireAttentionCriteria();
  wireAttentionTabs();

  if (state.watchlist.length) selectStock(state.watchlist[0].code);
}

init();
