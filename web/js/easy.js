/* 쉬운 주식 도우미 (초보자용) — 기존 대시보드 데이터를 재활용해 '신호등 한 줄 결론'으로 보여준다.
   판정은 '회사가 얼마나 튼튼한가'(안전성)일 뿐, 매수 신호가 아니다. 전문용어는 쉬운 말로 번역한다. */

const state = { companies: [], picks: [], fundCache: {}, curCode: null };

async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(path + " " + res.status);
  return res.json();
}

async function fetchQuote(code) {
  const url = typeof quoteUrl === "function" ? quoteUrl(code) : null;
  if (!url) return null;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const d = await res.json();
    return d && !d.error ? d : null;
  } catch (_) { return null; }
}

function _num(x) { return (typeof x === "number" && x === x) ? x : null; }
function _bae(s) { const v = parseFloat(String(s || "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(v) ? v : null; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }

/* ---------------- 초보자 신호등 판정 ---------------- */
function beginnerVerdict(fund, quote) {
  const ok = fund && fund.status === "ok";
  const ss = ok ? _num(fund.stability_score) : null;                // 재무 안정성 1~5
  const q = ok ? (fund.quality || {}) : {};
  const roe = _num(q.roe_pct);
  const fs = q.f_score || {};
  const fsr = fs.max_score ? fs.score / fs.max_score : null;        // 재무건전성 0~1
  const div = ok ? (fund.dividend || {}) : {};
  const dy = div.status === "ok" ? _num(div.dividend_yield_pct) : null;
  const et = ok ? (fund.earnings_trend || []) : [];
  const nis = et.map((r) => _num(r.net_income)).filter((x) => x != null);
  const recent = nis.slice(-3);
  const lossNow = recent.length ? recent[recent.length - 1] <= 0 : (roe != null && roe <= 0);
  const someLoss = recent.some((x) => x <= 0);
  const warnings = ok ? (fund.warnings || []) : [];
  const perV = (quote && _bae(quote.per)) || (ok && fund.valuation ? _num(fund.valuation.per) : null);

  // 52주 위치(최근 많이 올랐나)
  let pos = null;
  if (quote && _num(quote.price) && _num(quote.week52_high) && _num(quote.week52_low) && quote.week52_high > quote.week52_low) {
    pos = (quote.price - quote.week52_low) / (quote.week52_high - quote.week52_low);
  }

  // ── 신호등: 회사가 튼튼한가(안전성). 매수신호 아님 ──
  const weakFin = (ss != null && ss < 2.5) || (fsr != null && fsr < 0.35) || warnings.length > 0;
  let light, headline;
  if (lossNow || weakFin) {
    light = "red"; headline = "초보자에게는 위험할 수 있어요. 신중하세요.";
  } else if (!someLoss && ss != null && ss >= 3.5 && (fsr == null || fsr >= 0.55) && (roe == null || roe > 0)) {
    light = "green"; headline = "초보자가 봐도 비교적 안심인 회사예요. (그래도 주가는 오르내려요)";
  } else {
    light = "yellow"; headline = "나쁘진 않지만 초보자는 조심스럽게 접근하세요.";
  }
  const label = { green: "🟢 안심", yellow: "🟡 주의", red: "🔴 조심" }[light];

  // ── 쉬운 불릿 ──
  const b = [];
  // 1) 돈벌이(수익성)
  if (lossNow) b.push(["❗", "지금 <b>적자</b>예요 — 돈을 벌지 못하고 있어요.", "이익이 없으면 초보자에겐 특히 위험해요"]);
  else if (roe != null && roe >= 15) b.push(["💰", "돈을 <b>아주 잘</b> 벌어요.", `수익성(ROE) ${roe.toFixed(0)}%`]);
  else if (roe != null && roe >= 8) b.push(["💰", "<b>꾸준히</b> 돈을 벌어요.", `수익성(ROE) ${roe.toFixed(0)}%`]);
  else if (roe != null && roe > 0) b.push(["🙂", "돈은 벌지만 수익성은 크지 않아요.", `수익성(ROE) ${roe.toFixed(0)}%`]);

  // 2) 재무 안정(빚)
  if (ss != null && ss >= 4) b.push(["🛡️", "<b>빚이 적고</b> 재무가 탄탄해요.", "망할 걱정이 상대적으로 적어요"]);
  else if (ss != null && ss >= 3) b.push(["🛡️", "재무는 <b>보통</b> 수준이에요.", null]);
  else if (ss != null) b.push(["⚠️", "빚이 많거나 재무가 <b>약한</b> 편이에요.", null]);

  // 3) 배당
  if (dy != null && dy >= 1) b.push(["🎁", `1년에 약 <b>${dy.toFixed(1)}%</b> 배당(현금)을 줘요.`, "가진 것만으로 조금씩 받는 돈이에요"]);
  else if (dy != null && dy > 0) b.push(["🎁", "배당은 <b>조금</b> 줘요.", null]);
  else b.push(["·", "배당은 거의 없어요.", "이익을 회사에 다시 쓰는 편"]);

  // 4) 주가 수준(비싼가)
  if (lossNow) b.push(["🏷️", "이익이 없어 주가가 비싼지 판단이 어려워요.", null]);
  else if (perV != null && perV >= 40) b.push(["🏷️", "지금 주가가 <b>비싼 편</b>이에요.", "기대가 많이 반영돼 실망 시 하락 위험"]);
  else if (perV != null && perV > 0 && perV < 12) b.push(["🏷️", "주가는 <b>부담이 적은</b> 수준이에요.", `이익 대비(PER) ${perV.toFixed(0)}배`]);
  else if (perV != null) b.push(["🏷️", "주가는 무난한 수준이에요.", `이익 대비(PER) ${perV.toFixed(0)}배`]);

  // 5) 최근 급등 경고(초보자가 뒤늦게 따라 사는 위험)
  if (pos != null && pos >= 0.85) b.push(["📈", "최근 1년 중 <b>높은 편</b>이에요 (많이 올랐어요).", "뒤늦게 따라 사는 건 조심"]);

  // ── 주의문 ──
  const cautions = [];
  cautions.push("주식은 오르내리며 <b>원금을 잃을 수</b> 있어요.");
  cautions.push("이 신호는 '회사가 튼튼한지'를 쉽게 본 것일 뿐, <b>사라는 뜻이 아니에요.</b>");
  if (light !== "green") cautions.push("잘 모르면 무리하지 말고, 여러 회사에 <b>나눠</b> 담으세요.");

  return { light, label, headline, bullets: b, cautions };
}

/* ---------------- 렌더 ---------------- */
function renderVerdict(code, name, fund, quote) {
  const v = beginnerVerdict(fund, quote);
  const el = document.getElementById("verdict");
  document.getElementById("verdict-empty").hidden = true;

  let priceHtml = "";
  if (quote && _num(quote.price)) {
    const up = (quote.change_pct || 0) >= 0;
    const arrow = up ? "▲" : "▼";
    const cls = up ? "up" : "down";
    priceHtml = ` · <span class="v-price">현재가 ${quote.price.toLocaleString("ko-KR")}원 ` +
      `<span class="${cls}">${arrow}${Math.abs(quote.change_pct || 0).toFixed(1)}%</span></span>`;
    if (quote.market_cap_text) priceHtml += ` · 시총 ${esc(quote.market_cap_text)}`;
  }

  const bullets = v.bullets.map(([ic, tx, sub]) =>
    `<li><span class="ic">${ic}</span><span class="tx">${tx}${sub ? `<small>${esc(sub)}</small>` : ""}</span></li>`
  ).join("");

  el.innerHTML =
    `<div class="v-top ${v.light}">
       <div class="v-light">${v.label.split(" ")[0]}</div>
       <div class="v-head"><b>${v.label.split(" ")[1]}</b><span>${esc(v.headline)}</span></div>
     </div>
     <div class="v-name"><b>${esc(name)}</b> <span class="code">${esc(code)}</span>${priceHtml}</div>
     <ul class="v-bullets">${bullets}</ul>
     <div class="v-caution">⚠️ ${v.cautions.join("<br>")}</div>`;
  el.hidden = false;
}

async function selectStock(code, name) {
  state.curCode = code;
  document.getElementById("q-results").hidden = true;
  document.getElementById("q").value = name || "";
  const el = document.getElementById("verdict");
  el.hidden = false;
  el.innerHTML = `<div class="verdict-empty" style="border:none">‘${esc(name || code)}’ 살펴보는 중…</div>`;
  document.getElementById("verdict-empty").hidden = true;

  let fund = state.fundCache[code];
  if (!fund) {
    try { fund = await loadJSON(`data/fundamental/${code}.json`); }
    catch (_) { fund = { status: "error" }; }
    state.fundCache[code] = fund;
  }
  if (state.curCode !== code) return;

  if (!fund || fund.status !== "ok") {
    el.innerHTML = `<div class="verdict-empty" style="border:none">이 회사는 아직 쉬운 분석 데이터가 없어요. 다른 큰 회사를 검색해 보세요.</div>`;
    return;
  }
  const quote = await fetchQuote(code);
  if (state.curCode !== code) return;
  renderVerdict(code, name || (quote && quote.name) || fund.name || code, fund, quote);
  window.scrollTo({ top: document.querySelector(".wrap").offsetTop - 8, behavior: "smooth" });
}

/* ---- 검색 ---- */
function runSearch(term) {
  const box = document.getElementById("q-results");
  const t = term.trim().toLowerCase();
  if (!t) { box.hidden = true; return; }
  const hits = [];
  for (const c of state.companies) {
    if (c.name.toLowerCase().includes(t) || c.code.includes(t)) { hits.push(c); if (hits.length >= 8) break; }
  }
  if (!hits.length) { box.innerHTML = `<div class="q-empty">찾는 회사가 없어요. 이름을 다시 확인해 주세요.</div>`; box.hidden = false; return; }
  box.innerHTML = hits.map((c) =>
    `<div class="q-item" data-code="${esc(c.code)}" data-name="${esc(c.name)}"><b>${esc(c.name)}</b> <span class="code">${esc(c.code)}</span></div>`
  ).join("");
  box.hidden = false;
  box.querySelectorAll(".q-item").forEach((it) =>
    it.addEventListener("click", () => selectStock(it.dataset.code, it.dataset.name)));
}

/* ---- 안심 리스트 ---- */
function renderPicks() {
  const el = document.getElementById("picks");
  if (!state.picks.length) { el.innerHTML = `<div class="picks-loading">지금은 추천 목록을 불러올 수 없어요.</div>`; return; }
  el.innerHTML = state.picks.map((p) => {
    const tags = (p.tags || []).map((t) => `<span class="tag ${t === "대형" ? "big" : ""}">${esc(t)}</span>`).join("");
    return `<button class="pick" data-code="${esc(p.code)}" data-name="${esc(p.name)}">
        <div class="pick-top"><span class="pick-dot"></span><span class="pick-name">${esc(p.name)}</span><span class="pick-sector">${esc(p.sector || "")}</span></div>
        <div class="pick-reason">${esc(p.reason || "")}</div>
        <div class="pick-tags">${tags}</div>
      </button>`;
  }).join("");
  el.querySelectorAll(".pick").forEach((b) =>
    b.addEventListener("click", () => selectStock(b.dataset.code, b.dataset.name)));
}

/* ---------------- 시작 ---------------- */
async function init() {
  const input = document.getElementById("q");
  input.addEventListener("input", () => runSearch(input.value));
  input.addEventListener("focus", () => { if (input.value.trim()) runSearch(input.value); });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search")) document.getElementById("q-results").hidden = true;
  });

  try {
    const ci = await loadJSON("data/company_index.json");
    state.companies = (ci && ci.companies) ? ci.companies : [];
  } catch (_) { state.companies = []; }

  try {
    const bp = await loadJSON("data/beginner_picks.json");
    state.picks = (bp && bp.status === "ok" && bp.picks) ? bp.picks : [];
  } catch (_) { state.picks = []; }
  renderPicks();

  // ?code=로 특정 종목 바로 보기(부모님이 링크를 저장해 두는 용도)
  const urlCode = new URLSearchParams(location.search).get("code");
  if (urlCode) {
    const c = state.companies.find((x) => x.code === urlCode);
    selectStock(urlCode, c ? c.name : urlCode);
  }
}

init();
