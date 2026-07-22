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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "POST만 지원합니다" }, 405, origin);
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

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
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
