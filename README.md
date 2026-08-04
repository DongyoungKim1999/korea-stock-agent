# 한국주식 투자분석 에이전트

[korea-stock-agent-design.md](../korea-stock-agent-design.md) 설계서를 구현한 Claude Code
프로젝트입니다. 이 폴더를 Claude Code로 열고 자연어로 요청하면 됩니다 — 별도 실행 명령이 없습니다.

> **중요**: `CLAUDE.md`와 `.claude/skills`, `.claude/agents`는 Claude Code가 **작업 디렉터리 자신의**
> 설정만 자동으로 인식합니다. 상위 폴더(`주식/`, `클로드 코드/`)를 워크스페이스로 연 상태에서는
> 자동 인식되지 않으니, 이 `korea-stock-agent` 폴더 자체를 Claude Code의 작업 폴더로 새로 열어야
> (VS Code라면 `파일 > 폴더 열기`로 이 폴더를 선택, 터미널이라면 이 폴더로 `cd` 후 실행) 아래
> 기능들이 동작합니다.

- "삼성전자 분석해줘", "005930 어때?" → 기술적분석(1~5점) + 기본적분석(안정성/성장성/활동성
  각 1~5점) 통합 리포트
- "요즘 주목받는 종목 알려줘" → 시장 전체 스캔 후 주목종목 순위 리포트

라우팅/오케스트레이션 규칙은 [CLAUDE.md](CLAUDE.md)에 정의되어 있습니다.

## 처음 설정하기

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
cp .env.example .env   # 아래 안내대로 키를 채워 넣기
```

### API 키 발급

| 키 | 없으면 | 발급처 |
|---|---|---|
| `DART_API_KEY` | 기본적분석(재무제표) 전체 사용 불가 — 에스컬레이션 대상 | opendart.fss.or.kr 회원가입 → 인증키 신청 |
| `NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET` | 주목종목 스캔이 시세 이상탐지만으로 판단(검색량/뉴스 근거 없이) | developers.naver.com/apps → 애플리케이션 등록 시 "검색"과 "데이터랩(검색어트렌드)" 두 API를 함께 추가 |

키가 없어도 기술적분석(Entry A 일부)과 시세 기반 스캔(Entry B 일부)은 동작합니다 — 각 스킬이
키 유무에 따라 알아서 범위를 조정합니다.

## 폴더 구조

```
.claude/skills/    스킬 8종 (각 SKILL.md + scripts/*.py)
.claude/agents/    서브에이전트 3종 (technical-analyst, fundamental-analyst, market-scanner)
common/            pykrx·DART·네이버 API 공용 클라이언트, 캐시/재시도 유틸
docs/reference/    가중치 프레임, 업종분류 노트, disclaimer 원본
output/reports/    최종 사용자용 리포트(md)
output/cache/      서브에이전트 결과(json) + API 원본 캐시(raw/, TTL 기반)
tests/fixtures/    DART/네이버 API 실키 없이도 로직을 검증할 수 있는 합성 데이터
automation/        GitHub Actions용 무인 데이터 생성 파이프라인 (아래 "웹 대시보드" 참고)
web/               GitHub Pages로 배포되는 정적 대시보드 (HTML/CSS/JS + automation이 만든 데이터)
cloudflare-worker/ AI 어시스턴트용 GPT 프록시 서버(선택 기능, 별도 배포 필요)
```

## 웹 대시보드 (GitHub Pages)

`web/`은 이 프로젝트와는 별개로, **누구나 링크로 볼 수 있는 읽기 전용 요약 대시보드**다. 대화형
Claude Code 에이전트(위 기능들)는 LLM이 매번 직접 판단하지만, 무인으로 상시 갱신되는 이
웹페이지에는 LLM이 없으므로 `docs/reference/*-weighting-framework.md`의 채점 공식을
`automation/deterministic_scoring.py`에 코드로 그대로 구현해 대신 사용한다. 두 결과는 방향은
비슷해도 서술적 뉘앙스까지 같지는 않다 — 대시보드에도 이 사실을 명시해 두었다.

- **검색**: 코스피+코스닥 전체 상장사(약 2,500개+) 대상. `automation/generate_company_index.py`가
  DART corpCode 매핑을 재활용해 만든다(전종목 조회 차단과 무관한 경로)
- **전종목 상세분석**: 코스피·코스닥 전 상장종목(~3,900개)에 아래 관점을 제공한다. 재무 기본적분석은
  `automation/generate_fundamental_all.py`가 **업종평균 방식**(종목별 피어 대신 업종코드로 묶어 평균을
  한 번만 산출)으로 전종목을 채운다 — 종목당 최신 보고서 1개만 받아 DART 일일한도 안에서 며칠에 걸쳐
  캐시가 차며 채워진다. 워치리스트 120종목(`automation/watchlist.py`)은 여기에 배당·실적추이(다기간)까지
  더한 full coverage. 아래 관점:
  - **기술적분석**: 이동평균·MACD·RSI·볼린저·거래량·캔들 종합 1~5점
  - **기본적분석**: 안정성/성장성/활동성 업종평균 대비 상대점수
  - **밸류에이션**: PER(TTM)·PBR — "지금 이 가격이 싼가/비싼가"
  - **재무건전성**: Piotroski F-Score(0~9)·ROE·ROA — "재무가 튼튼하고 개선 중인가"
  - **리스크**: 연변동성·최대낙폭(MDD)·52주 위치 — "얼마나 출렁이고 물리면 얼마나 깨지나"
  - **배당**: 배당수익률·배당성향·주당배당금 — 배당주/현금흐름 판단
  - **실적·마진 추이**: 최근 4년 매출·영업이익률·순이익률 흐름 — 개선/악화 추세
  - **지지·저항선**: 차트에 진입/이탈 참고 가격대 표시
  - **종합 투자 요약**: 위 축들을 통합한 한 줄 특성 진단(매수·매도 권유 아님)
- **라이브 시세**(전종목): 종목을 열면 상단에 실시간 현재가·등락률·시가총액·외국인소진율·**목표주가
  컨센서스**가 뜨고 장중 자동 갱신된다. 검색 결과 목록에도 각 종목 현재가·등락·시총이 붙는다.
  네이버 포털 데이터를 Cloudflare Worker(`/quote`)로 중계 — KRX가 클라우드에서 막는 시총·수급·
  컨센서스를 우회로 확보.
- **전종목 기술적분석**(on-demand): 워치리스트 밖 종목을 선택하면 네이버 일봉을 Worker(`/ohlcv`)로
  받아 **브라우저에서 즉석 계산**해 차트·지표·리스크·지지저항·손익비·1~5점을 보여준다(재무 상세분석만
  120종목 한정). 사전생성이 아니라 클릭 시 계산이라 저장소 부담 0 — `web/js/indicators.js`가
  `compute_indicators.py`를 JS로 이식한 것(파이썬 결과와 소수점까지 일치 검증). Worker 미배포 시
  라이브 시세·전종목 기술분석만 빠지고 나머지는 정상. 설정은
  [cloudflare-worker/README.md](cloudflare-worker/README.md) 참고

  밸류에이션/재무건전성/리스크의 방법론 근거·한계는
  [docs/reference/valuation-quality-risk-notes.md](docs/reference/valuation-quality-risk-notes.md)
  참조(Piotroski 2000 등 공신력 있는 지표를 무료 데이터로 재현). 종목 추가/제거는 watchlist.py만 수정하면 됨
- **AI 어시스턴트**(우측 컬럼): 기본은 안내 메시지만 표시(정적 사이트라 LLM 연결 없음). `cloudflare-worker/`를
  배포하면 실제 GPT와 대화 가능 — 아래 "GPT 연동" 절 참고
- (이전 버전에 있던 "종목 추천"/주목종목 패널은 UI에서 제거했다. 생성 스크립트
  `automation/generate_attention.py`는 남아있어 `automation/generate_all.py`에 다시 한 줄만
  추가하면 되살릴 수 있다 — 코드 참고)
- `.github/workflows/update-and-deploy.yml`이 평일 하루 2회(KST 09:00/15:00) `automation/generate_all.py`를
  실행해 `web/data/*.json`을 갱신하고 Pages로 배포한다. 실제 배포 방법은 이 문서 하단 참고.
  `web/*.html`·`css`·`js` 같은 순수 UI 변경 커밋은 데이터 재생성 없이 기존 `web/data`로 바로
  재배포한다(전종목 재조회는 커밋당 15~30분이 걸려서 UI만 고칠 때는 건너뜀) — `automation/`,
  `common/`, `.claude/skills/` 변경이나 정기 스케줄/수동 실행은 항상 재생성한다.

## GPT 연동 (선택 기능)

AI 어시스턴트가 실제 GPT와 대화하게 하려면 별도 서버리스 프록시가 필요하다(OpenAI 키를
공개 웹페이지에 직접 넣을 수 없기 때문 — DART/네이버 키와 같은 이유). 상세 배포 절차는
[cloudflare-worker/README.md](cloudflare-worker/README.md) 참고. 요약:

1. `cloudflare-worker/`에서 Cloudflare Worker 배포 (`wrangler deploy`), `OPENAI_API_KEY`는 Secret으로 등록
2. 배포된 Worker 주소를 `web/js/config.js`의 `GPT_WORKER_URL`에 입력 후 커밋/푸시
3. **OpenAI 계정에 월 지출 한도(Hard limit)를 반드시 설정** — Worker URL이 공개되므로 남용 시 비용
   폭탄을 막는 최종 방어선

설정 전까지는 어시스턴트가 "GPT가 아직 연결되지 않았습니다" 안내만 표시하며, 사이트의 다른
기능에는 전혀 영향이 없다.

**로컬 미리보기**:
```bash
./.venv/bin/python automation/generate_all.py   # .env에 키가 있으면 실데이터, 없으면 종목별 error 상태로 채워짐
cd web && python3 -m http.server 8834           # http://localhost:8834 접속
```

## 알려진 제약

- **전종목(코스피+코스닥 전체) 조회는 네트워크 환경에 민감합니다.** 개별종목 시세 조회는
  안정적으로 동작하지만, KRX의 전종목 스냅샷 엔드포인트는 클라우드/서버성 IP를 간헐적으로
  차단하는 것으로 관찰되었습니다. 실제 사용 환경(가정용/사무용 네트워크)에서는 정상 동작할
  가능성이 높지만, 만약 Entry B(주목종목 스캔)가 계속 실패한다면 코드 버그보다 네트워크 차단을
  먼저 의심하세요 — `.claude/skills/price-data-fetcher/SKILL.md`의 "알려진 제약" 참고.
- DART 뉴스 API는 날짜범위 필터를 지원하지 않아 최신순 최대 100건을 직접 파싱해 "최근 N일
  언급건수"를 근사합니다(정확한 전수 카운트가 아님). 자세한 내용은
  `.claude/skills/attention-signal-collector/SKILL.md` 참고.

## 로직 검증 (실 API 키 없이)

`tests/fixtures/`에 합성 DART 재무데이터·피어 6개사·전종목 시계열(이상 신호 포함)이 있습니다.
예:
```bash
./.venv/bin/python .claude/skills/financial-ratio-analyzer/scripts/compute_ratios.py \
  --target tests/fixtures/dart_target_fetch_result_sample.json \
  --peer tests/fixtures/peers/800001.json --peer tests/fixtures/peers/800002.json \
  --peer tests/fixtures/peers/800003.json --peer tests/fixtures/peers/800004.json \
  --peer tests/fixtures/peers/800005.json --peer tests/fixtures/peers/800006.json

./.venv/bin/python .claude/skills/market-anomaly-screener/scripts/screen_anomalies.py \
  --history tests/fixtures/market_history_synthetic.json
```

## GitHub Pages 배포 방법

이 저장소에는 `gh` CLI가 설치되어 있지 않아 아래 단계는 직접 진행해야 한다 (API 키를 다루는
단계라 대화로 전달하지 않고 직접 하는 편이 더 안전하기도 하다).

1. **GitHub에 새 저장소 생성** — github.com에서 New repository, **Public**으로 생성(무료 Pages는
   Public 저장소만 지원). 이름 예: `korea-stock-agent`. README 등 자동 생성 옵션은 모두 체크 해제.
2. **로컬 저장소를 푸시**:
   ```bash
   git remote add origin https://github.com/<사용자명>/<저장소명>.git
   git push -u origin main
   ```
3. **API 키를 GitHub Secrets로 등록** — 저장소 Settings → Secrets and variables → Actions →
   New repository secret 에서 3개 등록: `DART_API_KEY`, `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`
   (`.env`에 넣은 값과 동일). 이 값은 Actions 실행 중에만 쓰이고 코드/로그에는 남지 않는다.
4. **Pages 소스를 "GitHub Actions"로 설정** — 저장소 Settings → Pages → Build and deployment →
   Source에서 "GitHub Actions" 선택 (기본값인 "Deploy from a branch"가 아님).
5. **워크플로우 실행** — 저장소 Actions 탭 → "데이터 갱신 및 GitHub Pages 배포" → Run workflow로
   1회 수동 실행(이후에는 평일 하루 2회 자동 실행). 완료되면 Settings → Pages 상단에 뜨는 URL
   (`https://<사용자명>.github.io/<저장소명>/`)이 공개 링크다.

3번을 건너뛰고 실행하면 기술적분석(pykrx)만 채워지고 기본적분석(DART 키 필요)은 빈 상태로
표시된다 — 에러는 아니며, 대시보드 상단 안내문에 그대로 표시된다. 네이버 키는 현재 대시보드
UI에서는 쓰이지 않는다("종목 추천" 패널 제거로 인해).
