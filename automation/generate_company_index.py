#!/usr/bin/env python3
"""코스피+코스닥 전체 상장사 검색 인덱스를 생성해 web/data/company_index.json에 저장한다.

DART corpCode.xml(이미 dart_client.py가 30일 캐시로 관리)을 재활용한다 — KRX 전종목 조회처럼
클라우드 IP에서 막히는 엔드포인트를 새로 쓰지 않고, 이미 검증된 DART 매핑만으로 구성한다.
검색은 이 전체 인덱스를 대상으로 하고, 상세분석은 watchlist.py의 종목만 지원한다(프론트엔드가
watchlist에 없는 종목은 "상세분석 미지원"으로 안내).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import _skill_imports  # noqa: F401
from common import dart_client
from watchlist import WATCHLIST_BY_CODE

OUT_PATH = Path(__file__).resolve().parents[1] / "web" / "data" / "company_index.json"


def main() -> None:
    try:
        corp_map = dart_client.get_corp_code_map()
    except Exception as exc:
        print(f"[company_index] 실패: {exc}", file=sys.stderr)
        OUT_PATH.write_text(json.dumps({"status": "error", "reason": str(exc)}, ensure_ascii=False), encoding="utf-8")
        return

    seen = set()
    companies = []
    for row in corp_map:
        code = row["stock_code"]
        if code in seen:
            continue
        seen.add(code)
        companies.append(
            {
                "code": code,
                "name": row["corp_name"],
                "has_detail": code in WATCHLIST_BY_CODE,
            }
        )
    companies.sort(key=lambda r: r["name"])

    OUT_PATH.write_text(
        json.dumps({"status": "ok", "count": len(companies), "companies": companies}, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"[company_index] 완료: {len(companies)}개 종목 (상세분석 지원 {sum(1 for c in companies if c['has_detail'])}개)")


if __name__ == "__main__":
    main()
