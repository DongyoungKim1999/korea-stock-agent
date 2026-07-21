---
name: market-anomaly-screener
description: 전종목 거래량·등락률 시계열에서 종목 자신의 최근 평균 대비 통계적으로 이상(급증/급변)한 종목을 Z-score로 골라 30~50개 후보로 압축한다. market-scanner의 B2(1차 스크리닝) 단계, 완전 규칙기반(LLM 판단 없음).
---

# market-anomaly-screener

## 목적 (설계서 §2.3 B2, C4)

전종목(2,500개+)에 검색량/뉴스 API를 다 호출하는 것은 비효율적이므로, 무료 시세데이터만으로
"평소 그 종목치고 오늘이 이상한가"를 Z-score로 계산해 30~50개 후보로 압축한다. 다른 종목과
비교하는 것이 아니라 **그 종목 자신의 최근 20거래일 대비** 편차를 본다.

## 실행 순서 (market-scanner B1→B2)

1. 먼저 price-data-fetcher로 시계열 확보:
   ```bash
   python3 .claude/skills/price-data-fetcher/scripts/fetch_price.py --market-history --scope ALL --days 20 --out output/cache/raw/market_history_{date}.json
   ```
   (일자당 1회씩 최근 20거래일분 전종목 스냅샷을 반복 조회 — 종목당 호출이 아니므로 저비용)
2. 이 스킬로 이상탐지:
   ```bash
   python3 .claude/skills/market-anomaly-screener/scripts/screen_anomalies.py --history output/cache/raw/market_history_{date}.json --out output/cache/raw/anomaly_candidates_{date}.json
   ```

## 로직 요약

- 각 종목의 최근 20거래일(오늘 제외) 거래량/등락률 평균·표준편차를 baseline으로, 오늘 값의 Z-score를 계산
- `score = max(|거래량 Z-score|, |등락률 Z-score|)` 로 종목 정렬
- 임계치 2.5부터 시작해 후보가 30개 미만이면 2.0→1.5→1.0→0.5→0.0 순으로 자동 완화 (설계서 B2 "후보 미달 시 임계치 완화 후 재시도"를 별도 호출 없이 스크립트 내부에서 1회 실행으로 처리)
- 최종 후보는 상위 50개로 자름 (30~50개 범위 확정값)
- 이력이 10거래일 미만인 종목(신규상장 등)은 Z-score 계산에서 자연스럽게 제외됨

## 출력 해석

- `candidates`: 종목코드/이름/오늘거래량·등락률/Z-score/score. **이 목록 자체는 아직 '주목종목'이 아니라 "정밀검증 대상"** — attention-signal-collector(B3~B4)로 넘겨 검색량/뉴스 근거까지 확인한 뒤에야 market-scanner가 최종 판단(B5)한다
- `threshold_used`가 0.0인데도 후보가 30개 미만이면 시장이 전반적으로 평온하다는 뜻 — 이 경우 그대로 진행하고 최종 리포트에 "오늘은 통계적으로 뚜렷한 이상 종목이 적었음"을 명시
- `status: "error"` — market-history 자체가 실패한 것. B1이 스킵 불가 단계이므로 1회 재시도 후에도 실패하면 스캔 중단하고 사용자에게 원인(네트워크/KRX 접근) 안내

## 실패 처리

이 스킬은 순수 통계 계산이라 네트워크 실패가 없다. 입력 market-history의 `status`가
`error`면 즉시 중단 — 이 스킬을 다시 불러도 해결되지 않으므로 price-data-fetcher부터 재시도할 것.
