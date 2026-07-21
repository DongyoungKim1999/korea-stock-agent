#!/usr/bin/env python3
"""전종목 거래량/등락률 이상탐지 (Z-score, 종목 자기 자신의 최근 이력 대비). 설계서 §2.3 B2.

각 종목의 '오늘' 거래량·등락률을, 그 종목의 최근 거래일 이력(baseline) 대비 몇 표준편차
벗어났는지로 평가한다 — 종목 간 단순 비교(오늘 등락률 상위 N개)가 아니라 "그 종목치고
평소와 다른가"를 본다는 점이 설계서 용어 '이상탐지'에 부합한다.

사용법:
    python3 screen_anomalies.py --history output/cache/raw/market_history.json --out output/cache/raw/anomaly_candidates.json
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from common import krx_client  # noqa: E402

TARGET_MIN, TARGET_MAX = 30, 50  # 설계서 §2.3 B2 확정값 (30~50개)
MIN_BASELINE_DAYS = 10
THRESHOLD_STEPS = [2.5, 2.0, 1.5, 1.0, 0.5, 0.0]


def _zscore(value: float, baseline: list[float]) -> float | None:
    if len(baseline) < MIN_BASELINE_DAYS:
        return None
    mean = statistics.fmean(baseline)
    stdev = statistics.pstdev(baseline)
    if stdev == 0:
        return None if value == mean else (10.0 if value > mean else -10.0)
    return (value - mean) / stdev


def screen(history: dict) -> dict:
    daily = history.get("daily", [])
    if len(daily) < MIN_BASELINE_DAYS + 1:
        return {"status": "error", "reason": f"이상탐지에 최소 {MIN_BASELINE_DAYS + 1}거래일 필요, {len(daily)}일 확보"}

    *baseline_days, today = daily
    today_rows = today["rows"]

    scored = []
    for code, today_val in today_rows.items():
        vol_baseline = [d["rows"][code]["volume"] for d in baseline_days if code in d["rows"]]
        chg_baseline = [d["rows"][code]["change_pct"] for d in baseline_days if code in d["rows"] and d["rows"][code]["change_pct"] is not None]

        vol_z = _zscore(today_val["volume"], vol_baseline)
        chg_z = _zscore(today_val["change_pct"], chg_baseline) if today_val.get("change_pct") is not None else None

        z_candidates = [abs(z) for z in (vol_z, chg_z) if z is not None]
        if not z_candidates:
            continue
        score = max(z_candidates)
        scored.append(
            {
                "code": code,
                "volume_zscore": round(vol_z, 3) if vol_z is not None else None,
                "change_zscore": round(chg_z, 3) if chg_z is not None else None,
                "today_volume": today_val["volume"],
                "today_close": today_val["close"],
                "today_change_pct": today_val.get("change_pct"),
                "baseline_days_used": len(vol_baseline),
                "score": round(score, 3),
            }
        )

    scored.sort(key=lambda r: r["score"], reverse=True)

    threshold_used = THRESHOLD_STEPS[0]
    candidates = [r for r in scored if r["score"] >= threshold_used]
    for threshold in THRESHOLD_STEPS[1:]:
        if len(candidates) >= TARGET_MIN:
            break
        threshold_used = threshold
        candidates = [r for r in scored if r["score"] >= threshold_used]

    candidates = candidates[:TARGET_MAX]

    warnings = []
    if len(candidates) < TARGET_MIN:
        warnings.append(f"임계치를 {THRESHOLD_STEPS[-1]}까지 완화해도 후보가 {len(candidates)}개뿐 — 시장 전반이 평온한 구간일 수 있음")

    for row in candidates:
        try:
            row["name"] = krx_client.get_market_ticker_name(row["code"])
        except Exception:
            row["name"] = None

    return {
        "status": "ok",
        "date": today["date"],
        "universe_scanned": len(today_rows),
        "threshold_used": threshold_used,
        "candidate_count": len(candidates),
        "candidates": candidates,
        "warnings": warnings,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--history", required=True, help="price-data-fetcher --market-history 출력 경로")
    parser.add_argument("--out")
    args = parser.parse_args()

    history = json.loads(Path(args.history).read_text(encoding="utf-8"))
    if history.get("status") not in ("ok", "partial"):
        result = {"status": "error", "reason": "입력 market-history 데이터가 유효하지 않음: " + str(history.get("reason"))}
    else:
        result = screen(history)

    text = json.dumps(result, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
