---
name: dart-financial-fetcher
description: DART Open API로 종목의 최근 3~4개 분기 재무제표와 업종코드를 조회한다. fundamental-analyst의 A5(재무제표 수집) 단계에서 사용하며, 동일업종 피어(peer) 재무데이터 수집에도 재사용한다.
---

# dart-financial-fetcher

## 목적 (설계서 §2.2 A5)

DART Open API로 재무제표 원자료(자산/부채/자본/매출/이익 등 계정과목별 금액)와 업종코드
(induty_code)를 가져온다. 비율 계산은 하지 않는다 — financial-ratio-analyzer의 역할이다.

## 사전조건

`.env`에 `DART_API_KEY`가 설정되어 있어야 한다 (C2). 없으면 즉시 `status: "error"`로 종료된다 —
이 경우 재시도로 해결되지 않으므로 사용자에게 키 발급/설정을 안내할 것 (opendart.fss.or.kr).

## 실행 방법

**분석 대상 종목** (최근 4개 분기, 추세 파악용):
```bash
python3 .claude/skills/dart-financial-fetcher/scripts/fetch_financials.py --code 005930 --periods 4 --out output/cache/raw/005930_financials.json
```

**동일업종 피어 종목** (최신 1개 분기만, API 호출 절약 — C6):
```bash
python3 .claude/skills/dart-financial-fetcher/scripts/fetch_financials.py --code <피어코드> --periods 1 --out output/cache/raw/<피어코드>_financials_peer.json
```

## 출력 해석

- `status: "ok"` — `periods`에 최신순으로 분기별 `{bsns_year, reprt_code, fs_div, accounts:[...]}` 배열. `accounts`의 각 항목은 DART 표준 계정과목(account_id/account_nm/sj_div/thstrm_amount/frmtrm_amount) 그대로.
- `induty_code`가 없거나 조회 실패해도(`warnings`에만 기록) 재무제표 자체는 진행됨 — 이 경우 financial-ratio-analyzer는 업종 비교 없이 진행해야 함
- `status: "error"` — **A5는 지속실패 시 에스컬레이션 대상** (A2처럼 조용히 스킵하지 않음). 사유가 "신규상장 등 공시 이력 부족"이면 사용자에게 해당 종목은 기본적분석이 제한적임을 알리고 기술적분석만으로 진행할지 확인할 것

## 중요: 분기보고서의 금액 필드 이름 (실제 API 응답으로 확인됨)

**분기보고서(11013/11012/11014)의 손익계산서(sj_div="IS") 항목은 재무상태표와 필드 구성이 다르다.**
재무상태표(BS)는 단순히 `thstrm_amount`/`frmtrm_amount`(시점 값)만 있지만, 손익계산서 항목은
아래 네 필드를 함께 내려준다:

| 필드 | 의미 |
|---|---|
| `thstrm_amount` | 당기 **해당 분기만**의 금액 (예: 3분기보고서면 7~9월만) |
| `thstrm_add_amount` | 당기 **연초 누계** (예: 3분기보고서면 1~9월 누적) |
| `frmtrm_q_amount` | 전년 **동분기만**의 금액 |
| `frmtrm_add_amount` | 전년 **동기 누계** |

**`frmtrm_amount` 필드 자체가 분기보고서 손익계산서 항목에는 존재하지 않는다** — 이걸 곧바로
읽으려 하면 항상 실패한다(실제로 이 버그로 성장성 지표가 전종목에서 빈 값이 나온 적 있음).
financial-ratio-analyzer의 `_find_amount()`는 `_add_amount`(누계) 필드를 우선 사용하고, 없으면
(재무상태표·사업보고서처럼 애초에 이 구분이 없는 경우) 일반 필드로 자동 폴백한다 — 스킬 사용자가
직접 이 필드명을 다룰 일은 없지만, 원본 JSON을 눈으로 확인할 때 참고할 것.

활동성 비율(회전율)처럼 특정 시점 잔액과 짝지어 계산하는 지표는 **동일 분기(reprt_code)끼리만**
비교해야 하며, 서로 다른 reprt_code의 수치를 직접 비교하면 안 된다.
