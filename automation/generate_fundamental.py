#!/usr/bin/env python3
"""워치리스트 전 종목의 기본적분석 데이터를 생성해 web/data/fundamental/{code}.json에 저장한다.

동일업종 피어는 pykrx 업종분류(KRX 대분류)로 찾는다 — docs/reference/industry-classification-notes.md
의 A6 정책(표본 5개사 미만이면 시장평균 대체)을 그대로 구현한다.
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from pykrx import stock

import _skill_imports  # noqa: F401
import deterministic_scoring as ds
import fetch_financials
import compute_ratios
from watchlist import WATCHLIST

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import krx_client  # noqa: E402

WEB_DATA_DIR = Path(__file__).resolve().parents[1] / "web" / "data" / "fundamental"
MAX_PEERS = 15
MIN_PEERS = 5


def find_peers(code: str, latest_date: str) -> tuple[list[str], str]:
    """(피어 종목코드 목록, comparison_basis) 반환."""
    for market in ("KOSPI", "KOSDAQ"):
        try:
            df = stock.get_market_sector_classifications(latest_date, market)
        except Exception:
            continue
        if df is None or df.empty or code not in df.index:
            continue

        target_sector = df.loc[code, "업종명"]
        same_sector = [c for c in df.index if c != code and df.loc[c, "업종명"] == target_sector]

        if len(same_sector) >= MIN_PEERS:
            return same_sector[:MAX_PEERS], "industry_average"

        others = [c for c in df.index if c != code and c not in same_sector]
        fallback = (same_sector + others)[:MAX_PEERS]
        if len(fallback) >= MIN_PEERS:
            return fallback, "market_average_fallback"
        return fallback, "market_average_fallback"

    return [], "unavailable"


def generate_one(entry: dict, latest_date: str, tmp_dir: Path) -> dict:
    code, name = entry["code"], entry["name"]

    target = fetch_financials.fetch(code, periods=4)
    if target["status"] != "ok":
        return {"status": "error", "code": code, "name": name, "reason": target.get("reason")}

    target_path = tmp_dir / f"{code}_target.json"
    target_path.write_text(json.dumps(target, ensure_ascii=False, default=str), encoding="utf-8")

    peer_codes, basis = find_peers(code, latest_date)
    peer_paths = []
    for peer_code in peer_codes:
        try:
            peer = fetch_financials.fetch(peer_code, periods=1)
        except Exception:
            continue
        if peer["status"] != "ok":
            continue
        p = tmp_dir / f"{code}_peer_{peer_code}.json"
        p.write_text(json.dumps(peer, ensure_ascii=False, default=str), encoding="utf-8")
        peer_paths.append(str(p))

    ratios = compute_ratios.analyze(str(target_path), peer_paths, basis if peer_paths else None)
    if ratios.get("status") != "ok":
        return {"status": "error", "code": code, "name": name, "reason": ratios.get("reason")}

    scores = ds.compute_fundamental_scores(ratios, entry.get("sector", ""))

    return {
        "status": "ok",
        "code": code,
        "name": name,
        "sector": entry.get("sector"),
        "stability_score": scores.get("stability"),
        "growth_score": scores.get("growth"),
        "activity_score": scores.get("activity"),
        "sensitivity_applied": scores.get("sensitivity_applied"),
        "comparison_basis": ratios.get("comparison_basis"),
        "peer_list": ratios.get("peer_list"),
        "latest_period": ratios.get("latest_period"),
        "stability": ratios.get("stability"),
        "growth": ratios.get("growth"),
        "activity": ratios.get("activity"),
        "warnings": target.get("warnings", []) + ratios.get("warnings", []),
    }


def main() -> None:
    WEB_DATA_DIR.mkdir(parents=True, exist_ok=True)
    latest_date = krx_client.get_latest_trading_date()
    summary = []

    with tempfile.TemporaryDirectory(prefix="fundamental_gen_") as tmp:
        tmp_dir = Path(tmp)
        for entry in WATCHLIST:
            print(f"[fundamental] {entry['code']} {entry['name']} 처리 중...", file=sys.stderr)
            try:
                result = generate_one(entry, latest_date, tmp_dir)
            except Exception as exc:
                result = {"status": "error", "code": entry["code"], "name": entry["name"], "reason": str(exc)}

            out_path = WEB_DATA_DIR / f"{entry['code']}.json"
            out_path.write_text(json.dumps(result, ensure_ascii=False, default=str), encoding="utf-8")
            summary.append({"code": entry["code"], "name": entry["name"], "status": result["status"]})

    ok = sum(1 for s in summary if s["status"] == "ok")
    print(f"[fundamental] 완료: {ok}/{len(summary)} 성공", file=sys.stderr)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
