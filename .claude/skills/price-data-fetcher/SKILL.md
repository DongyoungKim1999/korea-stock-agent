---
name: price-data-fetcher
description: pykrx로 개별종목 또는 전종목의 OHLCV·거래량·시가총액을 조회한다. technical-analyst의 시세 수집 단계(A2)와 market-scanner의 전종목 1차 수집 단계(B1)에서 사용한다.
---

# price-data-fetcher

## 목적 (설계서 §2.2 A2 / §2.3 B1)

무료 공개 라이브러리 pykrx로 시세를 조회한다. 유료 실시간 시세가 아니므로 **최소 당일 종가
기준**이며 장중 실시간 반영이 아님을 항상 전제한다 (C1).

## 실행 방법

**개별종목 시계열** (technical-analyst):
```bash
python3 .claude/skills/price-data-fetcher/scripts/fetch_price.py --code 005930 --days 150 --out output/cache/raw/005930_price.json
```
`--days` 기본값은 150. 120일 이동평균선의 "추세"(최근 며칠간 상승/하락 중인지)까지 보려면 120일치
단일 스냅샷으로는 부족하고 그 이전 기간이 더 필요하므로, technical-indicator-calculator는 120일선보다
30일 이상 여유를 둔 기간을 요구한다. 특별한 사유가 없다면 150 미만으로 줄이지 말 것.

**전종목 스냅샷** (market-scanner B1, 기본 스캔범위 = 코스피+코스닥 전체):
```bash
python3 .claude/skills/price-data-fetcher/scripts/fetch_price.py --market-snapshot --scope ALL --out output/cache/raw/market_snapshot_{date}.json
```

## 출력 해석

개별종목 모드:
- `status: "ok"` — 정상, `rows`에 날짜 오름차순 OHLCV+등락률 배열
- `status: "partial"` — 요청 기간의 90% 미만 확보 (신규상장 등). `warnings`에 사유 명시. 후속 단계(기술지표 계산)는 진행하되 리포트에 "데이터 기간 제한" 명시 필요
- `status: "error"` — 자동재시도 소진. **이 단계는 스킵 가능** — technical-analyst는 리포트에 "데이터 부족" 명시 후 가능한 지표만으로 진행 (설계서 A2 실패처리)
- `market_cap` 배열은 부가정보이며 실패해도 `warnings`에만 기록되고 `status`는 영향받지 않음

전종목 스냅샷 모드:
- `status: "ok"` — `rows`에 종목코드별 OHLCV+거래대금+등락률+시가총액(가능시). `collected_count`가 2000 미만이면 `warnings`에 경고 표시됨 (코스피+코스닥 상장사 수 대비)
- `status: "error"` — 자동재시도 소진. market-scanner는 이 실행을 1회 더 재시도하고, 그래도 실패하면 스캔을 중단하고 사용자에게 "현재 시세 데이터를 가져올 수 없어 스캔을 완료할 수 없다"고 알려야 함 (B1은 스킵 불가 — 이후 모든 단계의 입력이기 때문)

## 알려진 제약

KRX 데이터 서버는 환경(특히 클라우드/서버 IP)에 따라 전종목 스냅샷 계열 호출을 간헐적으로
거부할 수 있다. 개별종목 시계열 조회는 상대적으로 안정적으로 확인됨. 전종목 스냅샷이 반복
실패하면 네트워크 환경(방화벽, IP 차단 여부)을 우선 의심할 것 — 코드 로직 문제가 아닐 가능성이 높다.
