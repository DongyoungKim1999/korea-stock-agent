// GPT 연동 설정. cloudflare-worker/README.md 안내대로 Worker를 배포한 뒤,
// 그 주소를 아래에 채워 넣으면 우측 AI 어시스턴트 패널이 실제 GPT와 대화한다.
// 비워두면(기본값) 어시스턴트는 안내 메시지만 표시하는 기존 동작을 유지한다.
//
// 같은 Worker가 라이브 시세도 중계한다(GET /quote?code=). 아래 주소만 넣으면 실시간 현재가·등락률·
// 시가총액·목표주가 컨센서스가 모든 종목에 표시된다(네이버 포털 데이터, KRX가 클라우드에서 막는
// 정보를 우회로 확보). 새 라우트라 Worker를 재배포(wrangler deploy)해야 시세 기능이 켜진다.
const GPT_WORKER_URL = "https://korea-stock-agent-gpt-proxy.dkdla00.workers.dev";

// Worker 기반 라이브 시세 URL (GPT_WORKER_URL과 같은 Worker의 /quote 라우트).
function quoteUrl(code) {
  if (!GPT_WORKER_URL || !GPT_WORKER_URL.trim()) return null;
  const base = GPT_WORKER_URL.replace(/\/+$/, "");
  return `${base}/quote?code=${encodeURIComponent(code)}`;
}
