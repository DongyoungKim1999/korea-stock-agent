#!/usr/bin/env python3
"""워치리스트 전 종목의 기술적분석 데이터를 생성해 web/data/technical/{code}.json에 저장한다.
차트용 가격 시계열(최근 300거래일)과 지표, 결정론적 채점 결과를 함께 담는다.
"""
from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import _skill_imports  # noqa: F401  (sys.path 부트스트랩)
import deterministic_scoring as ds
import fetch_price
import compute_indicators
from watchlist import WATCHLIST

WEB_DATA_DIR = Path(__file__).resolve().parents[1] / "web" / "data" / "technical"
CHART_DAYS = 300
MAX_WORKERS = 6  # OHLCV 개별 조회는 I/O 대기라 동시 처리로 단축


def generate_one(entry: dict) -> dict:
    code, name = entry["code"], entry["name"]
    # include_market_cap=False: 시가총액 엔드포인트는 GHA에서 100% 차단 + UI 미사용이라 건너뛴다
    # (종목마다 doomed 호출로 낭비되던 시간 제거).
    price = fetch_price.fetch_individual(code, CHART_DAYS, include_market_cap=False)
    if price["status"] == "error":
        return {"status": "error", "code": code, "name": name, "reason": price.get("reason")}

    indicators = compute_indicators.compute(price)
    scored = ds.compute_technical_score(indicators)

    return {
        "status": "ok",
        "code": code,
        "name": name,
        "sector": entry.get("sector"),
        "as_of": price.get("as_of"),
        "score": scored.get("score"),
        "category_subscores": scored.get("category_subscores"),
        "price_series": price["rows"],
        "indicators": indicators,
        "warnings": price.get("warnings", []) + indicators.get("warnings", []),
    }


def _safe_generate(entry: dict) -> dict:
    try:
        return generate_one(entry)
    except Exception as exc:  # 종목 하나 실패가 전체를 막지 않도록
        return {"status": "error", "code": entry["code"], "name": entry["name"], "reason": str(exc)}


def main() -> None:
    WEB_DATA_DIR.mkdir(parents=True, exist_ok=True)
    summary = []
    print(f"[technical] 처리 중(동시 {MAX_WORKERS}개)...", file=sys.stderr)
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = {ex.submit(_safe_generate, entry): entry for entry in WATCHLIST}
        for fut in as_completed(futures):
            entry = futures[fut]
            result = fut.result()
            out_path = WEB_DATA_DIR / f"{entry['code']}.json"
            out_path.write_text(json.dumps(result, ensure_ascii=False, default=str), encoding="utf-8")
            summary.append({"code": entry["code"], "name": entry["name"], "status": result["status"], "score": result.get("score")})

    ok = sum(1 for s in summary if s["status"] == "ok")
    print(f"[technical] 완료: {ok}/{len(summary)} 성공", file=sys.stderr)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
