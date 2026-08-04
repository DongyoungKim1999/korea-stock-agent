#!/usr/bin/env python3
"""코스피+코스닥 전체 상장사 검색 인덱스를 생성해 web/data/company_index.json에 저장한다.

DART corpCode.xml(이미 dart_client.py가 30일 캐시로 관리)을 재활용한다 — KRX 전종목 조회처럼
클라우드 IP에서 막히는 엔드포인트를 새로 쓰지 않고, 이미 검증된 DART 매핑만으로 구성한다.
검색은 이 전체 인덱스를 대상으로 하고, 재무 기본적분석은 generate_fundamental_all이 이 인덱스 전체를
업종평균 방식으로 채운다(전종목 대상). 기술적분석은 전종목 on-demand(네이버 차트)로 제공되므로,
여기 실린 종목은 모두 상세분석 대상이다(has_detail=True). 워치리스트 120은 배당·실적추이까지 추가.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import _skill_imports  # noqa: F401
from common import dart_client
from watchlist import WATCHLIST_BY_CODE  # noqa: F401 (full/core 구분은 fundamental JSON의 coverage로 표기)

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
                "has_detail": True,  # 전종목 재무(업종평균)+기술(on-demand) 대상
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
