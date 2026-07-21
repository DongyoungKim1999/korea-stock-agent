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
```

## 웹 대시보드 (GitHub Pages)

`web/`은 이 프로젝트와는 별개로, **누구나 링크로 볼 수 있는 읽기 전용 요약 대시보드**다. 대화형
Claude Code 에이전트(위 기능들)는 LLM이 매번 직접 판단하지만, 무인으로 상시 갱신되는 이
웹페이지에는 LLM이 없으므로 `docs/reference/*-weighting-framework.md`의 채점 공식을
`automation/deterministic_scoring.py`에 코드로 그대로 구현해 대신 사용한다. 두 결과는 방향은
비슷해도 서술적 뉘앙스까지 같지는 않다 — 대시보드에도 이 사실을 명시해 두었다.

- **기술적/기본적분석**: API 호출량 관리를 위해 `automation/watchlist.py`의 20종목만 상시 갱신
  (종목 추가는 이 파일만 수정하면 됨)
- **종목 추천(주목종목)**: 원래 설계대로 시장 전체(코스피+코스닥)를 스캔하되, 최종 순위(B5)는
  LLM 대신 규칙 기반 합산 점수로 대체
- `.github/workflows/update-and-deploy.yml`이 평일 하루 2회(KST 09:00/15:00) `automation/generate_all.py`를
  실행해 `web/data/*.json`을 갱신하고 Pages로 배포한다. 실제 배포 방법은 이 문서 하단 참고.

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

3번을 건너뛰고 실행하면 기술적분석(pykrx)만 채워지고 기본적분석·주목종목 검색량/뉴스 신호는
빈 상태로 표시된다 — 에러는 아니며, 대시보드 상단 안내문에 그대로 표시된다.
