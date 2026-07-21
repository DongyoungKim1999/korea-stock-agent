#!/usr/bin/env python3
"""종목명/종목코드 자연어 입력 -> 6자리 종목코드 변환.

사용법:
    python3 resolve.py --query "삼성전자"
    python3 resolve.py --query "005930"

출력 (stdout, JSON):
    {"status": "resolved", "code": "005930", "name": "삼성전자", "market": "KOSPI"}
    {"status": "ambiguous", "candidates": [{"code":..,"name":..,"market":..}, ...]}
    {"status": "not_found", "query": "..."}
    {"status": "error", "reason": "..."}
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from common import dart_client, krx_client  # noqa: E402
from common.cache import cached_call  # noqa: E402
from common.config import TTL_STOCK_LIST, has_dart_key  # noqa: E402

_SUFFIX_PATTERN = re.compile(r"(주식회사|㈜|\(주\)|보통주|우선주)")


def _normalize(name: str) -> str:
    return _SUFFIX_PATTERN.sub("", name).replace(" ", "").strip().upper()


def _load_universe() -> list[dict]:
    def _via_pykrx():
        latest = krx_client.get_latest_trading_date()
        return krx_client.get_ticker_universe(latest)

    try:
        return cached_call("stock_universe_pykrx", TTL_STOCK_LIST, _via_pykrx)
    except Exception:
        pass  # 전종목 스냅샷이 막힌 환경 대비 DART corpCode 매핑으로 폴백

    if has_dart_key():
        def _via_dart():
            return [
                {"code": row["stock_code"], "name": row["corp_name"], "market": "UNKNOWN"}
                for row in dart_client.get_corp_code_map()
            ]

        return cached_call("stock_universe_dart", TTL_STOCK_LIST, _via_dart)

    raise RuntimeError("pykrx 전종목 조회 실패 + DART 키 없음: 종목 유니버스를 구할 수 없습니다")


def resolve(query: str) -> dict:
    query = query.strip()
    if not query:
        return {"status": "not_found", "query": query}

    try:
        universe = _load_universe()
    except Exception as exc:
        return {"status": "error", "reason": str(exc)}

    if re.fullmatch(r"\d{6}", query):
        for row in universe:
            if row["code"] == query:
                return {"status": "resolved", **row}
        return {"status": "not_found", "query": query}

    norm_query = _normalize(query)

    exact = [row for row in universe if _normalize(row["name"]) == norm_query]
    if len(exact) == 1:
        return {"status": "resolved", **exact[0]}
    if len(exact) > 1:
        return {"status": "ambiguous", "candidates": exact[:10]}

    substring = [row for row in universe if norm_query in _normalize(row["name"])]
    if len(substring) == 1:
        return {"status": "resolved", **substring[0]}
    if 1 < len(substring) <= 10:
        substring.sort(key=lambda r: len(r["name"]))
        return {"status": "ambiguous", "candidates": substring}

    name_map = {row["name"]: row for row in universe}
    close = difflib.get_close_matches(query, name_map.keys(), n=5, cutoff=0.6)
    if close:
        candidates = [name_map[n] for n in close]
        if len(candidates) == 1:
            return {"status": "resolved", **candidates[0]}
        return {"status": "ambiguous", "candidates": candidates}

    return {"status": "not_found", "query": query}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--query", required=True)
    parser.add_argument("--out", help="결과 JSON을 저장할 경로 (선택)")
    args = parser.parse_args()

    result = resolve(args.query)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
