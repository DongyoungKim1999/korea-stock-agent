#!/usr/bin/env python3
"""market-anomaly-screener 후보군의 검색량 트렌드 + 뉴스/공시 언급빈도를 수집한다. 설계서 §2.3 B3~B4.

사용법:
    python3 collect_signals.py --candidates output/cache/raw/anomaly_candidates_20260721.json \
        --out output/cache/raw/attention_signals_20260721.json

후보 1개 실패가 전체를 막지 않도록 개별 try/except로 스킵+로그한다 (설계서 B3/B4 실패처리).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from common import dart_client, naver_client  # noqa: E402
from common.config import has_dart_key, has_naver_keys  # noqa: E402

SEARCH_TREND_DAYS = 30
RECENT_WINDOW = 7


def _search_surge(name: str) -> dict:
    end = dt.date.today()
    start = end - dt.timedelta(days=SEARCH_TREND_DAYS)
    series = naver_client.get_search_trend(name, start.isoformat(), end.isoformat())
    if not series:
        return {"available": False}

    values = [pt.get("ratio", 0.0) for pt in series]
    recent = values[-RECENT_WINDOW:]
    prior = values[-2 * RECENT_WINDOW : -RECENT_WINDOW]
    recent_avg = sum(recent) / len(recent) if recent else 0.0
    prior_avg = sum(prior) / len(prior) if prior else 0.0

    if prior_avg == 0:
        surge_ratio = None if recent_avg == 0 else float("inf")
    else:
        surge_ratio = recent_avg / prior_avg

    return {
        "available": True,
        "recent_avg_ratio": round(recent_avg, 2),
        "prior_avg_ratio": round(prior_avg, 2),
        "surge_ratio": None if surge_ratio in (None,) else (surge_ratio if surge_ratio != float("inf") else "new_spike"),
    }


def _disclosure_count(code: str) -> dict:
    corp = dart_client.find_corp_by_stock_code(code)
    if corp is None:
        return {"available": False, "reason": "DART corpCode 매핑에 없음"}
    end = dt.date.today()
    start = end - dt.timedelta(days=RECENT_WINDOW)
    items = dart_client.list_disclosures(corp["corp_code"], start.strftime("%Y%m%d"), end.strftime("%Y%m%d"))
    return {
        "available": True,
        "recent_count": len(items),
        "recent_titles": [it.get("report_nm") for it in items[:5]],
    }


def collect_one(code: str, name: str) -> dict:
    result: dict = {"code": code, "name": name}
    warnings = []

    if has_naver_keys():
        try:
            result["search_trend"] = _search_surge(name)
        except Exception as exc:
            result["search_trend"] = {"available": False}
            warnings.append(f"검색트렌드 조회 실패: {exc}")

        try:
            result["news"] = naver_client.get_news_mention_signal(name, recent_days=RECENT_WINDOW)
        except Exception as exc:
            result["news"] = {"available": False}
            warnings.append(f"뉴스 조회 실패: {exc}")
    else:
        result["search_trend"] = {"available": False}
        result["news"] = {"available": False}
        warnings.append("NAVER_CLIENT_ID/SECRET 미설정 — 검색량/뉴스 신호 없이 진행")

    if has_dart_key():
        try:
            result["disclosures"] = _disclosure_count(code)
        except Exception as exc:
            result["disclosures"] = {"available": False}
            warnings.append(f"공시목록 조회 실패: {exc}")
    else:
        result["disclosures"] = {"available": False}
        warnings.append("DART_API_KEY 미설정 — 공시 언급빈도 없이 진행")

    result["warnings"] = warnings
    return result


def collect(candidates: list[dict]) -> dict:
    results = []
    failed = 0
    for cand in candidates:
        code, name = cand.get("code"), cand.get("name") or cand.get("code")
        try:
            results.append(collect_one(code, name))
        except Exception as exc:
            failed += 1
            results.append({"code": code, "name": name, "error": str(exc)})

    warnings = []
    if candidates and failed / len(candidates) > 0.3:
        warnings.append(f"후보 {len(candidates)}개 중 {failed}개 완전 실패 (30% 초과) — API 키/한도 상태를 점검할 것")

    return {"status": "ok", "collected_count": len(results), "results": results, "warnings": warnings}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidates", required=True, help="market-anomaly-screener 출력 경로")
    parser.add_argument("--out")
    args = parser.parse_args()

    payload = json.loads(Path(args.candidates).read_text(encoding="utf-8"))
    candidates = payload.get("candidates", [])
    result = collect(candidates)

    text = json.dumps(result, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
