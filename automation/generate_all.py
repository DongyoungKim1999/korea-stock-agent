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
    import generate_momentum
    import generate_estimate_revisions
    import generate_factor_ranking
    import generate_filing_insights
    import generate_beginner_picks
    import generate_attention

    # company_index(유니버스) → technical(워치리스트, 밸류에이션용 종가) → fundamental_all(전종목) 순서.
    # generate_fundamental_all이 전 상장종목을 업종평균 방식으로 채운다(워치리스트 120은 배당·추이까지).
    # 예전 generate_fundamental.py(120 피어방식)는 남겨두되 파이프라인에서는 _all로 대체.
    results = {
        "company_index": run_step("전체 상장사 검색 인덱스 생성", generate_company_index.main),
        "technical": run_step("기술적분석 생성(워치리스트)", generate_technical.main),
        "fundamental": run_step("기본적분석 생성(전종목 업종평균)", generate_fundamental_all.main),
        # 모멘텀(12-1M, 전종목 가격) → 팩터 랭킹(fundamental+모멘텀 읽어 횡단면 z). 순서 중요.
        "momentum": run_step("전종목 모멘텀 수집(점진 워밍)", generate_momentum.main),
        # 추정치 리비전: 컨센서스 스냅샷 누적(시간 지나며 신호 발현). 팩터랭킹과 독립이라 순서 무관.
        "estimate_revisions": run_step("애널리스트 추정치 리비전 스냅샷", generate_estimate_revisions.main),
        "factor_ranking": run_step("전종목 횡단면 팩터 랭킹 생성", generate_factor_ranking.main),
        # LLM 공시 리더: 우선 유니버스(워치+팩터TOP) 사업보고서를 gpt-4o-mini로 요약. factor_ranking 다음.
        "filing_insights": run_step("LLM 공시 인사이트(가이던스·톤·레드플래그)", generate_filing_insights.main),
        # 초보자용 안심 종목 리스트(워치리스트 재무 필터, 순수 로컬 계산). fundamental 다음이면 무관.
        "beginner_picks": run_step("초보자용 안심 종목 리스트", generate_beginner_picks.main),
        # 관심도(검색·뉴스 급증): 네이버 데이터랩·뉴스 API. 우선유니버스=워치+팩터TOP. factor_ranking 다음.
        "attention": run_step("관심도(검색·뉴스 급증) 신호", generate_attention.main),
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
