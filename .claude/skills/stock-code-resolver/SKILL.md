---
name: stock-code-resolver
description: 사용자가 자연어로 언급한 종목명 또는 종목코드를 유효한 6자리 KRX 종목코드로 변환한다. Entry A(종목 지정 분석) 시작 시, 다른 모든 분석에 앞서 항상 가장 먼저 실행해야 한다.
---

# stock-code-resolver

## 목적 (설계서 §2.2 A1)

사용자가 입력한 종목명/코드 문자열을 pykrx 종목 유니버스(코스피+코스닥+코넥스)와 대조하여
유효한 6자리 종목코드로 변환한다. pykrx 전종목 조회가 일시적으로 막힌 환경에서는 DART
corpCode 매핑으로 자동 폴백한다(단, DART 매핑에는 시장구분이 없어 `market: "UNKNOWN"`으로 표시됨).

## 실행 방법

```bash
python3 .claude/skills/stock-code-resolver/scripts/resolve.py --query "<사용자가 언급한 종목명 또는 코드>"
```

프로젝트 루트의 `.venv`가 준비되어 있다면 `.venv/bin/python3`로 실행할 것 (pykrx/pandas 의존).

## 출력 해석

stdout에 JSON 한 덩어리가 출력된다:

| status | 의미 | 다음 행동 |
|---|---|---|
| `resolved` | 단일 종목으로 확정 | `code` 값을 후속 단계(price-data-fetcher, dart-financial-fetcher)에 전달하고 진행 |
| `ambiguous` | 후보 다수 (동명이인 기업, 부분일치 등) | `candidates` 목록을 사용자에게 보여주고 **반드시 사용자 확인을 받은 뒤** 진행 (자동 선택 금지) |
| `not_found` | 일치하는 종목 없음 | 사용자에게 정확한 종목명/코드를 다시 요청 |
| `error` | 유니버스 조회 자체가 실패 (네트워크/키 문제) | 원인을 사용자에게 알리고, DART 키 미설정이 원인이면 `.env` 설정을 안내 |

## 실패 처리 (설계서 표 A1)

자동재시도는 스크립트 내부(공용 retry 유틸)에서 이미 수행되므로 재호출은 불필요하다.
`error` 또는 `not_found`가 지속되면 자동재시도로 해결되지 않는 상황이므로 즉시
사용자에게 에스컬레이션한다 (유사 종목 후보를 스스로 지어내지 말 것).
