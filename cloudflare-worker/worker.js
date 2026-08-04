/**
 * GPT 프록시 — 대시보드(GitHub Pages)의 AI 어시스턴트가 OpenAI API를 안전하게 쓸 수 있게 중계한다.
 *
 * OPENAI_API_KEY는 이 Worker의 환경변수(Secret)로만 존재하고 브라우저로는 절대 내려가지 않는다.
 * 대시보드 JS는 이 Worker의 URL만 알고 있으면 되고, 그 URL이 공개되어도 키 자체는 노출되지 않는다
 * (다만 이 Worker를 다른 사람이 직접 호출해 당신의 OpenAI 크레딧을 쓸 수는 있으니, OpenAI 대시보드에서
 * 반드시 월 지출 한도(Hard limit)를 걸어두는 걸 권장한다 — README 참고).
 *
 * 배포: wrangler.toml README 참고. wrangler secret put OPENAI_API_KEY 로 키 등록.
 */

// 대시보드가 배포된 GitHub Pages 주소로 바꿔야 한다 (예: https://아이디.github.io)
// 정확히 이 오리진에서 온 브라우저 요청만 허용한다 — 다른 웹사이트가 이 Worker를 자기 페이지에
// 끌어다 쓰는 걸 막는 최소한의 방어선이다(직접 curl 등으로 호출하는 것까지 막지는 못한다 —
// 그건 OpenAI 쪽 지출 한도로 방어할 것).
const ALLOWED_ORIGIN = "https://dongyoungkim1999.github.io";

const OPENAI_MODEL = "gpt-4o-mini"; // 저렴하고 빠른 기본 모델. 필요시 바꿔도 됨.
const MAX_TOKENS = 500;
const MAX_MESSAGES = 12; // 대화 기록이 너무 길어지는 것 방지(토큰 비용 관리)
const MAX_MESSAGE_CHARS = 2000;

// Cloudflare Worker가 OpenAI를 직접 호출하면 엣지 IP가 간헐적으로
// "unsupported_country_region_territory"로 거부당하는 사례가 있어(실배포 테스트로 확인됨),
// Cloudflare AI Gateway를 경유한다. dash.cloudflare.com → AI → AI Gateway에서 생성.
const CF_ACCOUNT_ID = "6148ebede20f6e32cf8907ba23298817";
const AI_GATEWAY_NAME = "korea-stock-agent";
const OPENAI_ENDPOINT = `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${AI_GATEWAY_NAME}/openai/chat/completions`;

const SYSTEM_PROMPT = `당신은 한국 상장주식 투자 참고 정보를 제공하는 AI 어시스턴트입니다.
사용자가 보고 있는 대시보드 데이터(기술적분석/기본적분석 점수 등)를 참고해 질문에 답하세요.
반드시 지킬 것:
- 이것은 투자자문이 아니며 투자 판단과 책임은 사용자 본인에게 있음을 필요시 자연스럽게 상기시킬 것
- "사세요/파세요" 같은 직접적 매매 권유 표현을 쓰지 말 것 — "~한 신호로 해석됩니다" 같은 참고 표현 사용
- 모르는 사실을 지어내지 말고, 대시보드에 없는 실시간 시세나 최신 뉴스는 모른다고 명확히 말할 것
- 한국어로, 간결하게 답할 것`;

function corsHeaders(origin) {
  const allow = origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

// "239,500" 같은 문자열 → 239500 (콤마 제거). 실패 시 null.
function num(text) {
  if (text == null) return null;
  const n = parseFloat(String(text).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function isKrxMarketOpen() {
  // 현재 KST 기준 평일 09:00~15:30이면 장중으로 간주(공휴일까지는 판별 안 함 — 참고용)
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const day = kst.getUTCDay(); // 0=일,6=토
  if (day === 0 || day === 6) return false;
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return mins >= 540 && mins <= 930;
}

// 네이버 포털 시세/지표를 프록시한다. KRX가 클라우드 IP에서 막는 실시간가·시총·컨센서스를
// 개별 종목 단위로 확보 — 브라우저는 CORS 때문에 직접 못 부르므로 Worker가 중계한다.
async function handleQuote(code, origin) {
  if (!/^\d{6}$/.test(code || "")) {
    return jsonResponse({ error: "종목코드(6자리 숫자)가 필요합니다" }, 400, origin);
  }
  const headers = { "User-Agent": "Mozilla/5.0" };
  const [pollRes, integRes] = await Promise.allSettled([
    fetch(`https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`, { headers }),
    fetch(`https://m.stock.naver.com/api/stock/${code}/integration`, { headers }),
  ]);

  const out = { code, source: "naver", market_open: isKrxMarketOpen(), updated_at: new Date().toISOString() };

  try {
    if (pollRes.status === "fulfilled" && pollRes.value.ok) {
      const d = (await pollRes.value.json())?.datas?.[0];
      if (d) {
        out.name = d.stockName;
        out.price = num(d.closePrice);
        out.change = num(d.compareToPreviousClosePrice);
        out.change_pct = num(d.fluctuationsRatio);
        out.direction = d.compareToPreviousPrice?.name || null; // RISING/FALLING/STEADY
      }
    }
  } catch (_) {}

  try {
    if (integRes.status === "fulfilled" && integRes.value.ok) {
      const g = await integRes.value.json();
      if (!out.name) out.name = g.stockName;
      const infos = {};
      for (const it of g.totalInfos || []) infos[it.code] = it.value;
      out.market_cap_text = infos.marketValue || null;
      out.foreign_rate = infos.foreignRate || null;
      out.per = infos.per || null;             // 현재 PER(최근 실적 기준)
      out.eps = infos.eps || null;
      out.cns_per = infos.cnsPer || null;      // 컨센서스(forward) PER — 추정이익 기준
      out.cns_eps = infos.cnsEps || null;      // 컨센서스(추정) EPS
      out.pbr = infos.pbr || null;
      out.bps = infos.bps || null;
      out.dividend_yield = infos.dividendYieldRatio || null;  // 시가배당률
      out.dividend = infos.dividend || null;                  // 주당배당금
      out.week52_high = num(infos.highPriceOf52Weeks);
      out.week52_low = num(infos.lowPriceOf52Weeks);
      const c = g.consensusInfo;
      if (c) {
        out.target_price = num(c.priceTargetMean);
        out.recomm_mean = num(c.recommMean); // 1(강력매도)~5(강력매수)
        out.consensus_date = c.createDate || null;
      }
    }
  } catch (_) {}

  if (out.price == null && out.market_cap_text == null) {
    return jsonResponse({ error: "시세를 가져오지 못했습니다(종목코드 확인)", code }, 502, origin);
  }
  return jsonResponse(out, 200, origin);
}

// 네이버 일봉 차트(siseJson) 프록시 — 전종목 on-demand 기술분석용. KRX 전종목 조회가 클라우드에서
// 막혀도 개별종목 차트는 네이버에서 받을 수 있어, 브라우저가 이걸로 지표를 즉석 계산한다.
async function handleOhlcv(code, origin) {
  // 6자리 종목코드 또는 지수 심볼(KOSPI/KOSDAQ/KPI200 등, 상대강도 계산용) 허용
  if (!/^(\d{6}|[A-Z0-9]{3,8})$/.test(code || "")) {
    return jsonResponse({ error: "종목코드(6자리) 또는 지수 심볼이 필요합니다" }, 400, origin);
  }
  const end = new Date(Date.now() + 9 * 3600 * 1000); // KST
  const start = new Date(end.getTime() - 460 * 24 * 3600 * 1000); // ~300 거래일 확보용 여유
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const upstream = `https://api.finance.naver.com/siseJson.naver?symbol=${code}&requestType=1&startTime=${fmt(start)}&endTime=${fmt(end)}&timeframe=day`;
  let text;
  try {
    const res = await fetch(upstream, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://finance.naver.com" } });
    if (!res.ok) return jsonResponse({ error: `차트 조회 실패(${res.status})`, code }, 502, origin);
    text = await res.text();
  } catch (e) {
    return jsonResponse({ error: "차트 조회 실패", code }, 502, origin);
  }
  // 응답은 [['날짜',...header], ["20260102", 시,고,저,종,거래량,외인율], ...] 형태(엄격 JSON 아님).
  // 데이터 행만 정규식으로 뽑는다.
  const rows = [];
  const re = /\["(\d{8})",\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?\d+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    rows.push({
      date: `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`,
      open: +m[2], high: +m[3], low: +m[4], close: +m[5], volume: +m[6],
    });
  }
  if (rows.length < 20) return jsonResponse({ error: "차트 데이터 부족", code, rows: rows.length }, 502, origin);
  return jsonResponse({ code, source: "naver", rows }, 200, origin);
}

// 네이버 연간 재무(finance/annual) 프록시 — 연도별 PER/PBR/ROE/EPS/매출/마진 이력.
// 밸류에이션 밴드(현재 PER이 과거 대비 싼가/비싼가) + 전종목 실적추이에 쓴다.
async function handleFinance(code, origin) {
  if (!/^\d{6}$/.test(code || "")) {
    return jsonResponse({ error: "종목코드(6자리)가 필요합니다" }, 400, origin);
  }
  let j;
  try {
    const res = await fetch(`https://m.stock.naver.com/api/stock/${code}/finance/annual`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return jsonResponse({ error: `재무이력 조회 실패(${res.status})`, code }, 502, origin);
    j = await res.json();
  } catch (e) {
    return jsonResponse({ error: "재무이력 조회 실패", code }, 502, origin);
  }
  const rows = (j.financeInfo || {}).rowList || [];
  const titleOf = (r) => (r.title && (r.title.main || r.title)) || "";
  const perRow = rows.find((r) => titleOf(r) === "PER");
  if (!perRow) return jsonResponse({ error: "재무이력 없음", code }, 502, origin);
  const cols = Object.keys(perRow.columns || {}).sort();
  const want = { PER: "per", PBR: "pbr", ROE: "roe", EPS: "eps", 매출액: "revenue", 영업이익률: "op_margin", 순이익률: "net_margin", 주당배당금: "dps" };
  const out = { code, years: cols.map((c) => c.slice(0, 4)) };
  for (const row of rows) {
    const key = want[titleOf(row)];
    if (!key) continue;
    out[key] = cols.map((c) => {
      const v = row.columns[c] && row.columns[c].value;
      if (v == null || v === "" || v === "-") return null;
      const n = parseFloat(String(v).replace(/,/g, ""));
      return Number.isFinite(n) ? n : null;
    });
  }
  return jsonResponse(out, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // GET /quote?code=XXXXXX — 라이브 시세/시총/컨센서스 (인증 불필요, 공개 포털 데이터)
    if (request.method === "GET" && path.endsWith("/quote")) {
      return handleQuote(url.searchParams.get("code"), origin);
    }
    // GET /ohlcv?code=XXXXXX — 일봉 차트 (전종목 on-demand 기술분석용)
    if (request.method === "GET" && path.endsWith("/ohlcv")) {
      return handleOhlcv(url.searchParams.get("code"), origin);
    }
    // GET /finance?code=XXXXXX — 연간 재무이력 (밸류에이션 밴드용)
    if (request.method === "GET" && path.endsWith("/finance")) {
      return handleFinance(url.searchParams.get("code"), origin);
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "POST만 지원합니다 (시세는 GET /quote?code=)" }, 405, origin);
    }
    if (!env.OPENAI_API_KEY) {
      return jsonResponse({ error: "서버에 OPENAI_API_KEY가 설정되지 않았습니다 (wrangler secret put OPENAI_API_KEY)" }, 500, origin);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: "잘못된 JSON 요청입니다" }, 400, origin);
    }

    const userMessages = Array.isArray(payload.messages) ? payload.messages : [];
    if (userMessages.length === 0) {
      return jsonResponse({ error: "messages가 비어있습니다" }, 400, origin);
    }
    if (userMessages.length > MAX_MESSAGES) {
      return jsonResponse({ error: `대화가 너무 깁니다 (최대 ${MAX_MESSAGES}턴). 새로고침 후 다시 시작해주세요.` }, 400, origin);
    }
    for (const m of userMessages) {
      if (typeof m.content !== "string" || m.content.length > MAX_MESSAGE_CHARS) {
        return jsonResponse({ error: "메시지 형식이 올바르지 않거나 너무 깁니다" }, 400, origin);
      }
    }

    const contextLine = payload.stockContext
      ? `\n\n[현재 보고 있는 종목 데이터]\n${JSON.stringify(payload.stockContext).slice(0, 1500)}`
      : "";

    const openaiRes = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0.4,
        messages: [
          { role: "system", content: SYSTEM_PROMPT + contextLine },
          ...userMessages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
        ],
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text();
      return jsonResponse({ error: `OpenAI 호출 실패 (${openaiRes.status})`, detail: errText.slice(0, 300) }, 502, origin);
    }

    const data = await openaiRes.json();
    const reply = data.choices?.[0]?.message?.content || "(응답을 받지 못했습니다)";
    return jsonResponse({ reply }, 200, origin);
  },
};
