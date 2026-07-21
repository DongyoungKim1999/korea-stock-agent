---
name: attention-signal-collector
description: market-anomaly-screener가 압축한 30~50개 후보의 네이버 검색어트렌드 급증 여부와 뉴스/공시 언급빈도를 수집한다. market-scanner의 B3~B4(2차 검증) 단계. 최종 주목종목 판단(B5)은 하지 않는다.
---

# attention-signal-collector

## 목적 (설계서 §2.3 B3~B4, C4)

1차 스크리닝(market-anomaly-screener)을 통과한 후보에 한해서만 네이버 API를 호출한다 —
전종목에 호출하면 비효율적이라는 C4 원칙 그대로. 후보 하나가 실패해도 나머지는 계속
진행한다(스킵+로그).

## 사전조건

`.env`에 `NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET`가 있어야 검색량/뉴스 신호를 얻는다.
`DART_API_KEY`가 있어야 공시 언급빈도를 얻는다. 둘 다 없어도 스크립트는 죽지 않고
`available: false`로 표시하며 진행한다 — 단, 이 경우 market-scanner의 최종 판단(B5)은
거래량/등락률 통계만으로 이루어지므로 리포트에 "검색량·뉴스 근거 없이 시세 이상탐지만으로 판단"을
명시해야 한다.

## 실행 방법

```bash
python3 .claude/skills/attention-signal-collector/scripts/collect_signals.py \
  --candidates output/cache/raw/anomaly_candidates_{date}.json \
  --out output/cache/raw/attention_signals_{date}.json
```

후보 전체를 한 번의 스크립트 실행으로 순회한다 (후보마다 별도 호출 금지 — 오케스트레이션 낭비).
후보 30~50개 기준 Naver 호출이 60~100건, DART 호출이 최대 50건 발생하므로 실행에 다소
시간이 걸릴 수 있음을 사용자에게 미리 안내할 것.

## 출력 해석 (후보별)

- `search_trend.surge_ratio`: 최근 7일 검색지수 평균 / 그 이전 7일 평균. 2~3배 이상이면 뚜렷한 급증. `"new_spike"`는 이전 기간에 검색량이 거의 0이었다가 갑자기 생긴 경우
- `news.recent_count` vs `news.prior_count`: 최근 7일 vs 그 이전 7일 뉴스 언급 건수(네이버 뉴스는 날짜필터를 지원하지 않아 최신순 상위 100건을 직접 파싱한 근사치 — `news.capped=true`면 100건이 전부 최근 7일 이내라는 뜻이라 실제로는 더 많을 수 있음)
- `disclosures.recent_count`: 최근 7일 공시 건수, `recent_titles`로 어떤 공시인지 확인 가능(유상증자/공급계약 등은 그 자체로 강한 근거)
- 세 신호 모두 `available: false`인 후보는 market-scanner가 시세 이상탐지 근거만으로 판단하되 신뢰도를 낮춰 서술할 것

## 실패 처리

개별 후보 실패는 해당 후보의 `warnings`에만 기록되고 전체는 계속 진행된다. 전체 후보의 30%
초과가 완전 실패하면 최상위 `warnings`에 경고가 남는다 — 이 경우 API 키 상태나 일일 호출한도
초과 여부를 사용자에게 확인 요청할 것 (자동 재시도로는 한도초과가 해결되지 않음).
