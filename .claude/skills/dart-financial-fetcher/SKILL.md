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

## 중요: 분기 누적 금액 규칙

DART 손익계산서 항목(매출액/영업이익/순이익 등)의 `thstrm_amount`는 **연초 누계** 값이다
(예: 3분기보고서의 매출액 = 1~3분기 누적). `frmtrm_amount`는 전년 동기 누계이므로
`(thstrm-frmtrm)/frmtrm`로 계산하는 성장률은 그대로 유효하다(둘 다 같은 누적 기준). 단,
활동성 비율(회전율)처럼 특정 분기의 절대금액을 쓰는 지표는 **동일 분기(reprt_code)끼리만**
비교해야 하며, 서로 다른 reprt_code의 수치를 직접 비교하면 안 된다. financial-ratio-analyzer가
이 규칙을 따른다.
