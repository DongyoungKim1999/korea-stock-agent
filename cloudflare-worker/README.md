# GPT 프록시 + 라이브 시세 (Cloudflare Worker)

대시보드용 서버리스 중계 서버다. 두 가지를 한다:

1. **GPT 프록시** (`POST /`) — "AI 투자 어시스턴트"가 OpenAI GPT와 대화. OpenAI API 키를 여기
   (Cloudflare 서버쪽)에만 두고, 대시보드(브라우저)는 이 Worker의 URL만 알게 된다 — 키는 절대
   브라우저에 노출되지 않는다.
2. **라이브 시세** (`GET /quote?code=005930`) — 네이버 포털의 실시간 현재가·등락률·시가총액·
   외국인소진율·PER·목표주가 컨센서스를 중계한다. KRX 전종목/시총/수급 엔드포인트는 클라우드
   IP에서 막히지만, 네이버 포털은 열려 있어 이 우회로로 **모든 상장종목**의 시세를 확보한다.
   브라우저가 CORS 때문에 네이버를 직접 못 부르므로 Worker가 중계한다. 인증·키 불필요(공개 데이터).
3. **일봉 차트** (`GET /ohlcv?code=005930`) — 네이버 일봉(시/고/저/종/거래량)을 중계한다. 브라우저가
   이걸로 이동평균·MACD·RSI·볼린저·리스크·지지저항·1~5점을 즉석 계산해, **워치리스트 120종목뿐
   아니라 전종목**의 기술적분석을 제공한다(사전생성 없이, 저장소 부담 0).

> **`/quote`·`/ohlcv`는 새 라우트라, 이 기능들을 켜려면 Worker를 반드시 다시 배포해야 한다: `wrangler deploy`.**
> 재배포 전에는 라이브 시세·전종목 기술분석이 안 뜨고 나머지(워치리스트 심층분석·GPT)만 동작한다(무해한 저하).

## 준비물

- Cloudflare 계정 (무료) — cloudflare.com
- OpenAI API 키 — platform.openai.com/api-keys 에서 발급 (결제수단 등록 필요)
- Node.js (npx 명령을 쓰기 위함 — 이미 있다면 생략)

## 배포 순서

```bash
cd cloudflare-worker
npx wrangler login          # 브라우저가 열리며 Cloudflare 계정 로그인
npx wrangler secret put OPENAI_API_KEY   # 프롬프트가 뜨면 OpenAI 키 붙여넣기 (터미널에 저장되지 않음)
npx wrangler deploy
```

배포가 끝나면 터미널에 `https://korea-stock-agent-gpt-proxy.<your-subdomain>.workers.dev` 같은
URL이 출력된다 — 이 주소를 복사해둔다.

## 대시보드와 연결

1. `worker.js` 맨 위 `ALLOWED_ORIGIN` 값을 실제 배포된 GitHub Pages 주소로 맞춰져 있는지 확인
   (기본값이 이미 `https://dongyoungkim1999.github.io`로 되어 있음 — 저장소/사용자명을 바꿨다면 수정 후 재배포)
2. `web/js/config.js`의 `GPT_WORKER_URL`에 위에서 복사한 Worker 주소를 붙여넣기
3. 커밋 + 푸시 → GitHub Actions가 자동 재배포

## 반드시 할 것: OpenAI 지출 한도 설정

이 Worker의 URL이 공개되면(브라우저 네트워크 탭 등으로 알아낼 수 있음) 이론적으로 누군가
직접 호출해서 당신의 OpenAI 크레딧을 소모시킬 수 있다. 코드 쪽에서 메시지 길이·대화 턴 수를
제한해두었지만, **최종 방어선은 OpenAI 계정 자체의 지출 한도**다:

1. platform.openai.com → Settings → **Billing** → **Limits**
2. **Hard limit**(월 최대 지출)을 감당 가능한 금액(예: $5~10)으로 설정

이렇게 해두면 최악의 경우에도 그 금액 이상 청구되지 않는다.

## 비용 감각

기본 모델은 `gpt-4o-mini`(저렴한 모델)이고 응답을 500 토큰으로 제한해뒀다. 일반적인 대화
한 턴에 몇 원~몇십 원 수준이다. 더 아끼고 싶으면 `worker.js`의 `MAX_TOKENS`를 줄이면 된다.
