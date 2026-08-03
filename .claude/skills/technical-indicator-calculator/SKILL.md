---
name: technical-indicator-calculator
description: price-data-fetcher가 만든 개별종목 시세 JSON으로 이동평균·MACD·RSI·볼린저밴드·거래량비율·캔들패턴을 계산한다. technical-analyst가 A2(시세수집) 다음, A4(점수산출) 이전에 사용한다. 점수 자체는 산출하지 않는다.
---

# technical-indicator-calculator

## 목적 (설계서 §2.2 A3)

가격/거래량 원자료로부터 지표 **수치**만 계산한다. 1~5점 환산과 지표 간 가중치 판단은
technical-analyst가 이 스킬의 출력을 보고 직접 수행한다 (A4, LLM 판단 영역) — 이 스크립트가
점수를 매기지 않는다.

## 실행 방법

```bash
python3 .claude/skills/technical-indicator-calculator/scripts/compute_indicators.py \
  --in output/cache/raw/005930_price.json \
  --out output/cache/raw/005930_indicators.json
```

입력은 price-data-fetcher 개별종목 모드의 출력 JSON 그대로 사용한다.

## 출력 구조 요약

- `moving_averages`: ma5/20/60/120 각각 최신값 + 최근 10일 추이, `alignment`(정배열bullish/역배열bearish/mixed), `ma5_ma20_cross_recent`(최근 10일 내 골든/데드크로스 발생 여부)
- `macd`: MACD선/시그널선/히스토그램 최신값+추이, `signal_cross_recent`, 0선 상회 여부
- `rsi14`: 최신값 + zone(overbought≥70 / oversold≤30 / neutral) + 추이
- `stochastic`: 슬로우 스토캐스틱(14,3,3) %K/%D — 참고 표시용 보조지표이며 아래 가중치 프레임의 점수 공식에는 포함되지 않는다(대시보드 UI 표시 목적)
- `bollinger`: upper/mid/lower, `percent_b`(밴드 내 위치, 0~1 벗어나면 밴드 이탈), `bandwidth`(변동성 확장/축소)
- `volume`: 최신 거래량, 20일 평균, 평균 대비 비율, `abnormally_low`(30% 미만 여부)
- `candles.recent`: 최근 3봉의 양봉/음봉·패턴(도지/장대양봉·음봉/상승·하락장악형)
- `risk`: 리스크 관리 표준 지표 — `annualized_volatility_pct`(연율화 변동성), `max_drawdown_pct`(최대낙폭), `week52_high`/`week52_low`/`week52_position_pct`(52주 밴드 위치), `period_return_pct`(확보구간 누적수익률). **점수화하지 않는 참고 수치** — 근거는 `docs/reference/valuation-quality-risk-notes.md` 참조
- `levels`: `support`/`resistance` — 최근 스윙 고·저점 기준 현재가와 가장 가까운 지지/저항 가격대(진입·이탈 참고용, 점수화 안 함)

## technical-analyst가 반드시 지킬 것

- `docs/reference/technical-weighting-framework.md`의 가중치 프레임을 반드시 참조해서 점수화할 것 (임의 가중치 금지)
- `volume.abnormally_low`가 true면 가격 기반 지표(추세/모멘텀)의 신뢰도를 낮춰 재조정 — 거래량 부족 시 가격 움직임이 왜곡되기 쉽다는 설계서 §2.2 참고박스 규칙
- `status: "insufficient_data"`인 경우 계산 자체가 불가능한 것 — 리포트에 "데이터 부족으로 기술적분석 제한적" 명시하고 가능한 범위에서만 서술

## 실패 처리

이 단계는 순수 계산이라 네트워크 실패가 없다. `status: "insufficient_data"`만 발생 가능하며
(입력 시세가 20거래일 미만), 이 경우 자동재시도는 의미가 없다 — 더 긴 기간으로 price-data-fetcher를
다시 호출해도 상장 이력 자체가 짧으면 해결되지 않으므로 즉시 "데이터 부족" 처리로 넘어간다.
