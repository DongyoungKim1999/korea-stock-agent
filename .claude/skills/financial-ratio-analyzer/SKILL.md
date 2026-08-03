---
name: financial-ratio-analyzer
description: dart-financial-fetcher가 수집한 재무제표로 안정성·성장성·활동성 비율을 계산하고 동일업종(또는 대체 표본) 평균 대비 상대위치를 산출한다. fundamental-analyst의 A7 단계. 1~5점 환산은 하지 않는다.
---

# financial-ratio-analyzer

## 목적 (설계서 §2.2 A7)

재무제표 원자료로 안정성/성장성/활동성 비율을 계산하고 산업평균(또는 대체표본) 대비
**상대값(relative_favorability)** 까지 산출한다. 최종 1~5점 환산과 업종 특성에 따른 가중치
조정은 fundamental-analyst가 이 출력을 보고 직접 수행한다 (A8, LLM 판단 — `docs/reference/fundamental-weighting-framework.md` 참조 필수).

## 실행 전 준비: 동일업종 피어 찾기

이 스킬 자체는 피어를 찾지 않는다 — fundamental-analyst가 아래 순서로 준비해야 한다:

1. dart-financial-fetcher로 대상 종목의 `induty_code` 확보
2. pykrx `get_market_sector_classifications(date, market)` 로 같은 업종분류 종목 목록 조회
   (해당 종목의 시장(KOSPI/KOSDAQ)과 동일한 시장에서 조회)
3. 목록에서 대상 종목을 제외하고 최대 15개사(시가총액 상위 우선 권장)를 골라 각각
   dart-financial-fetcher를 `--periods 1`로 호출 → `--peer` 인자로 이 스킬에 전달
4. **3번 결과가 5개사 미만이면** (A6 규칙): 업종 조회 자체가 실패했다면 비교 없이 진행
   (`--peer`를 아예 주지 않음 → `comparison_basis: "unavailable"`), 업종 조회는 됐지만 동일업종
   종목 수 자체가 5개 미만이면 시가총액 등 임의 기준으로 다른 업종 종목을 추가해 5개 이상을 채운
   뒤 `--comparison-basis market_average_fallback`으로 명시

## 실행 방법

```bash
python3 .claude/skills/financial-ratio-analyzer/scripts/compute_ratios.py \
  --target output/cache/raw/005930_financials.json \
  --peer output/cache/raw/000660_financials_peer.json \
  --peer output/cache/raw/012450_financials_peer.json \
  --comparison-basis industry_average \
  --latest-close 70000 \
  --out output/cache/raw/005930_ratios.json
```

`--latest-close`(선택): 최근 종가를 주면 밸류에이션(PER/PBR)까지 계산한다. 종가는
price-data-fetcher 결과(`latest_close`)를 그대로 넘기면 된다 — 없으면 밸류에이션만 생략되고
나머지는 정상 산출된다.

## 출력 구조

- `stability` / `growth` / `activity`: 각 카테고리 내 지표별 `{target, peer_average, relative_favorability, higher_is_better}`. `relative_favorability`는 **항상 1보다 크면 target이 유리**하도록 정규화되어 있다(부채비율처럼 낮을수록 좋은 지표는 스크립트가 이미 역수 처리함 — fundamental-analyst가 다시 뒤집을 필요 없음)
- `quality`: `roe_pct`, `roa_pct`(연환산), `f_score`(Piotroski F-Score 0~9 — `score`/`max_score`/항목별 `checks`/`interpretation`). 근거·한계는 `docs/reference/valuation-quality-risk-notes.md` 참조
- `valuation`: `per`(연환산)·`pbr`·`eps_annualized`·`bps`·`shares_estimated`·`basis`. `basis="eps_derived"`면 종가+EPS 역산으로 산출됨, `"unavailable"`이면 EPS 미공시 등으로 계산 불가. **PBR<1은 순자산가치 이하**라는 의미 있는 저평가 신호
- `growth_trend_by_period`: target의 최근 여러 분기 YoY 성장률 추이 (가속/둔화 판단용, 피어 비교와 무관)
- `comparison_basis`: `industry_average` / `market_average_fallback` / `unavailable` — 리포트에 반드시 그대로 노출할 것 (근거 투명성)
- 개별 지표값이 `null`이면 원자료에서 해당 계정과목을 못 찾은 것 (금융업 등 특수 업종은 계정구조가 달라 발생 가능) — 그 지표만 "산출불가"로 표시하고 나머지로 진행

## 실패 처리

target 자체가 `status:"error"`면 이 스킬도 즉시 `status:"error"`를 반환한다 — dart-financial-fetcher
단계의 에스컬레이션 정책(A5)을 그대로 따른다. 피어 개별 실패는 `warnings`에 스킵 기록만 남기고
계속 진행한다(설계서의 일반적 "스킵+로그" 원칙).
