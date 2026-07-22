#!/usr/bin/env python3
"""시장 전체 주목종목 스캔(B1~B4)을 실행하고 규칙기반으로 순위를 매겨 web/data/attention.json에 저장한다.
설계서의 B5(LLM 종합판단)는 자동화 파이프라인에 LLM이 없어 deterministic_scoring의 규칙기반으로 대체한다.
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import _skill_imports  # noqa: F401
import deterministic_scoring as ds
import fetch_price
import screen_anomalies
import collect_signals

WEB_DATA_PATH = Path(__file__).resolve().parents[1] / "web" / "data" / "attention.json"
HISTORY_DAYS = 20


def main() -> None:
    print("[attention] 전종목 시계열 수집 중...", file=sys.stderr)
    history = fetch_price.fetch_market_history("ALL", HISTORY_DAYS)
    if history["status"] == "error":
        result = {"status": "error", "reason": history.get("reason"), "generated_at": dt.datetime.now().isoformat()}
        WEB_DATA_PATH.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False))
        return

    print("[attention] 1차 스크리닝(Z-score) 중...", file=sys.stderr)
    screened = screen_anomalies.screen(history)
    if screened["status"] != "ok":
        result = {"status": "error", "reason": screened.get("reason"), "generated_at": dt.datetime.now().isoformat()}
        WEB_DATA_PATH.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False))
        return

    print(f"[attention] 2차 검증(검색량/뉴스/공시) 중... 후보 {len(screened['candidates'])}개", file=sys.stderr)
    signals = collect_signals.collect(screened["candidates"])
    signals_by_code = {r["code"]: r for r in signals["results"]}

    rankings = ds.build_attention_rankings(screened["candidates"], signals_by_code)

    def attach_sparkline(row: dict) -> None:
        row["sparkline"] = [day["rows"][row["code"]]["close"] for day in history["daily"] if row["code"] in day["rows"]]

    for row in rankings["overall"]:
        attach_sparkline(row)
    for row in rankings["by_search"]:
        attach_sparkline(row)

    result = {
        "status": "ok",
        "generated_at": dt.datetime.now().isoformat(),
        "scan_date": screened.get("date"),
        "scope": "ALL",
        "screened_candidate_count": screened.get("candidate_count"),
        "ranked_stocks": rankings["overall"],  # 하위호환: 기존 "실시간 급상승" 탭
        "rankings": rankings,  # {overall, by_search}
        "warnings": screened.get("warnings", []) + signals.get("warnings", []),
    }
    WEB_DATA_PATH.write_text(json.dumps(result, ensure_ascii=False, default=str), encoding="utf-8")
    print(f"[attention] 완료: overall {len(rankings['overall'])}개, 검색급증 {len(rankings['by_search'])}개", file=sys.stderr)
    print(json.dumps({"status": "ok", "ranked_count": len(rankings["overall"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
