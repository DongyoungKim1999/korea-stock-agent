#!/usr/bin/env python3
"""pykrx 기반 시세 조회. 개별종목 시계열 모드와 전종목 스냅샷 모드를 지원한다.

개별종목 (technical-analyst용):
    python3 fetch_price.py --code 005930 --days 120 --out out.json

전종목 스냅샷 (market-scanner B1용):
    python3 fetch_price.py --market-snapshot --scope ALL --out out.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from common import krx_client  # noqa: E402

MIN_ROW_RATIO = 0.9        # 요청 거래일 대비 이 비율 미만이면 'partial'
MARKET_SOFT_FLOOR = 2000   # 전종목 수집 결과가 이보다 적으면 경고(코스피+코스닥 상장사 수 감안)


def fetch_individual(code: str, days: int, include_market_cap: bool = True) -> dict:
    warnings: list[str] = []

    try:
        ohlcv = krx_client.get_ohlcv(code, trading_days=days)
    except Exception as exc:
        return {"status": "error", "code": code, "reason": str(exc)}

    rows = []
    for date, row in ohlcv.iterrows():
        rows.append(
            {
                "date": date.strftime("%Y-%m-%d"),
                "open": float(row["시가"]),
                "high": float(row["고가"]),
                "low": float(row["저가"]),
                "close": float(row["종가"]),
                "volume": int(row["거래량"]),
                "change_pct": float(row["등락률"]) if "등락률" in row and row["등락률"] == row["등락률"] else None,
            }
        )

    # 시가총액은 KRX 전종목류 엔드포인트라 클라우드/서버 IP에서 100% 차단된다(GitHub Actions에서
    # 종목마다 실패하며 시간만 낭비). 대시보드 UI에서도 시가총액 표시를 뺐으므로 자동 파이프라인은
    # include_market_cap=False로 아예 건너뛴다. 가정용 IP에서 돌리는 대화형 경로는 기본 True라 그대로 시도.
    market_cap_rows: list[dict] = []
    if include_market_cap:
        try:
            cap_df = krx_client.get_market_cap_series(code, trading_days=days)
            for date, row in cap_df.iterrows():
                market_cap_rows.append(
                    {
                        "date": date.strftime("%Y-%m-%d"),
                        "market_cap": int(row["시가총액"]) if "시가총액" in row else None,
                        "shares_outstanding": int(row["상장주식수"]) if "상장주식수" in row else None,
                    }
                )
        except Exception as exc:
            warnings.append(f"시가총액 조회 실패(비치명적): {exc}")

    status = "ok"
    if len(rows) < days * MIN_ROW_RATIO:
        status = "partial"
        warnings.append(f"요청 {days}거래일 중 {len(rows)}거래일만 확보 (신규상장 등으로 이력 부족 가능)")

    return {
        "status": status,
        "code": code,
        "as_of": rows[-1]["date"] if rows else None,
        "requested_trading_days": days,
        "collected_trading_days": len(rows),
        "rows": rows,
        "market_cap": market_cap_rows,
        "warnings": warnings,
    }


def fetch_market_snapshot(scope: str) -> dict:
    try:
        date = krx_client.get_latest_trading_date()
    except Exception as exc:
        return {"status": "error", "reason": f"최근 영업일 조회 실패: {exc}"}

    try:
        ohlcv = krx_client.get_market_snapshot(date, market=scope)
    except Exception as exc:
        return {"status": "error", "date": date, "market": scope, "reason": str(exc)}

    cap_map: dict[str, int] = {}
    try:
        cap_df = krx_client.get_market_cap_snapshot(date, market=scope)
        cap_map = {code: int(row["시가총액"]) for code, row in cap_df.iterrows() if "시가총액" in row}
    except Exception:
        pass  # 시가총액은 부가정보 — 실패해도 스냅샷 자체는 계속 진행

    rows = []
    for code, row in ohlcv.iterrows():
        rows.append(
            {
                "code": code,
                "open": float(row["시가"]),
                "high": float(row["고가"]),
                "low": float(row["저가"]),
                "close": float(row["종가"]),
                "volume": int(row["거래량"]),
                "trading_value": int(row["거래대금"]) if "거래대금" in row else None,
                "change_pct": float(row["등락률"]) if "등락률" in row and row["등락률"] == row["등락률"] else None,
                "market_cap": cap_map.get(code),
            }
        )

    warnings = []
    if len(rows) < MARKET_SOFT_FLOOR:
        warnings.append(f"수집 종목 수({len(rows)})가 예상보다 적습니다 — 일부 종목 누락 가능성")

    return {
        "status": "ok",
        "date": date,
        "market": scope,
        "collected_count": len(rows),
        "rows": rows,
        "warnings": warnings,
    }


def fetch_market_history(scope: str, days: int) -> dict:
    """최근 N거래일 전종목 거래량/종가/등락률 시계열 (market-anomaly-screener의 Z-score 베이스라인용).

    거래일 수만큼 전종목 스냅샷을 반복 호출한다 — 종목당 호출이 아니라 '일자당' 호출이므로
    전종목 개별 조회(C4가 경고하는 비효율) 대비 훨씬 저렴하다 (기본 20회 호출).
    """
    try:
        dates = krx_client.get_recent_trading_dates(days)
    except Exception as exc:
        return {"status": "error", "reason": f"최근 거래일 목록 조회 실패: {exc}"}

    daily = []
    failed_dates = []
    for date in dates:
        try:
            snap = krx_client.get_market_snapshot(date, market=scope)
        except Exception:
            failed_dates.append(date)
            continue
        rows = {
            code: {
                "volume": int(row["거래량"]),
                "close": float(row["종가"]),
                "change_pct": float(row["등락률"]) if "등락률" in row and row["등락률"] == row["등락률"] else None,
            }
            for code, row in snap.iterrows()
        }
        daily.append({"date": date, "rows": rows})

    if not daily:
        return {"status": "error", "reason": "요청 기간 전체에서 스냅샷 수집 실패 (네트워크/KRX 접근 문제 가능성)"}

    return {
        "status": "ok" if not failed_dates else "partial",
        "scope": scope,
        "requested_days": days,
        "collected_days": len(daily),
        "failed_dates": failed_dates,
        "daily": daily,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--code", help="개별 종목코드 (6자리)")
    parser.add_argument("--days", type=int, default=None, help="조회 기간(거래일 수). 개별모드 기본 150, --market-history 모드 기본 20")
    parser.add_argument("--market-snapshot", action="store_true", help="전종목 스냅샷 모드 (당일 1개)")
    parser.add_argument("--market-history", action="store_true", help="전종목 시계열 모드 (최근 N일, Z-score 베이스라인용)")
    parser.add_argument("--scope", default="ALL", choices=["ALL", "KOSPI", "KOSDAQ", "KONEX"])
    parser.add_argument("--out", help="결과 JSON을 저장할 경로 (선택)")
    args = parser.parse_args()

    if args.market_history:
        result = fetch_market_history(args.scope, args.days or 20)
    elif args.market_snapshot:
        result = fetch_market_snapshot(args.scope)
    elif args.code:
        result = fetch_individual(args.code, args.days or 150)
    else:
        parser.error("--code, --market-snapshot, --market-history 중 하나는 필요합니다")
        return

    text = json.dumps(result, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
