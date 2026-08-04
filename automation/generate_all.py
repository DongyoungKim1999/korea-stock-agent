#!/usr/bin/env python3
"""GitHub Actions에서 실행되는 진입점. web/data/의 모든 정적 데이터를 갱신한다."""
from __future__ import annotations

import datetime as dt
import json
import sys
import traceback
from pathlib import Path

import _skill_imports  # noqa: F401
from watchlist import WATCHLIST

WEB_DATA_DIR = Path(__file__).resolve().parents[1] / "web" / "data"


def run_step(name: str, fn) -> bool:
    print(f"===== {name} 시작 =====", file=sys.stderr)
    try:
        fn()
        print(f"===== {name} 성공 =====", file=sys.stderr)
        return True
    except Exception:
        print(f"===== {name} 실패 =====", file=sys.stderr)
        traceback.print_exc()
        return False


def main() -> None:
    WEB_DATA_DIR.mkdir(parents=True, exist_ok=True)
    (WEB_DATA_DIR / "watchlist.json").write_text(json.dumps(WATCHLIST, ensure_ascii=False, indent=2), encoding="utf-8")

    import generate_technical
    import generate_fundamental_all
    import generate_company_index

    # generate_attention(주목종목 스캔)은 웹 대시보드 UI에서 뺐으므로(2026-07 개편) 더 이상
    # 호출하지 않는다 — 전종목 스캔은 시간이 오래 걸리고 KRX 차단으로 자주 실패했었다.
    # 스크립트 자체는 그대로 남아있어 필요하면 아래 줄만 다시 추가하면 된다:
    #   import generate_attention
    #   "attention": run_step("주목종목 스캔 생성", generate_attention.main),

    # company_index(유니버스) → technical(워치리스트, 밸류에이션용 종가) → fundamental_all(전종목) 순서.
    # generate_fundamental_all이 전 상장종목을 업종평균 방식으로 채운다(워치리스트 120은 배당·추이까지).
    # 예전 generate_fundamental.py(120 피어방식)는 남겨두되 파이프라인에서는 _all로 대체.
    results = {
        "company_index": run_step("전체 상장사 검색 인덱스 생성", generate_company_index.main),
        "technical": run_step("기술적분석 생성(워치리스트)", generate_technical.main),
        "fundamental": run_step("기본적분석 생성(전종목 업종평균)", generate_fundamental_all.main),
    }

    meta = {
        "generated_at": dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).isoformat(),
        "steps_ok": results,
        "watchlist_count": len(WATCHLIST),
    }
    (WEB_DATA_DIR / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(meta, ensure_ascii=False))

    if not any(results.values()):
        sys.exit(1)  # 전부 실패면 Actions에 실패로 표시 (일부만 실패는 성공 취급 — 부분 데이터라도 배포)


if __name__ == "__main__":
    main()
