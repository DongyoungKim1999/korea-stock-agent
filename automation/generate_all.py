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
    import generate_fundamental
    import generate_attention

    results = {
        "technical": run_step("기술적분석 생성", generate_technical.main),
        "fundamental": run_step("기본적분석 생성", generate_fundamental.main),
        "attention": run_step("주목종목 스캔 생성", generate_attention.main),
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
