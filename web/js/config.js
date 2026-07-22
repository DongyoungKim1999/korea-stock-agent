// GPT 연동 설정. cloudflare-worker/README.md 안내대로 Worker를 배포한 뒤,
// 그 주소를 아래에 채워 넣으면 하단 AI 어시스턴트가 실제 GPT와 대화한다.
// 비워두면(기본값) 어시스턴트는 안내 메시지만 표시하는 기존 동작을 유지한다.
const GPT_WORKER_URL = "";
