#!/usr/bin/env python3
"""DART Open API로 재무제표(+업종코드)를 조회한다.

사용법:
    python3 fetch_financials.py --code 005930 --out output/cache/raw/005930_financials.json
    python3 fetch_financials.py --code 005930 --periods 1 --out ...   # 동일업종 피어용 (1개 분기만)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from common import dart_client  # noqa: E402
from common.config import has_dart_key  # noqa: E402


def fetch(stock_code: str, periods: int, annual_only: bool = False) -> dict:
    """재무제표 조회. annual_only=True면 최근 사업연도(연간) 보고서만 받는다 — 분기 보고서를 ×N
    연환산하면 경기민감주의 ROE/FCFF가 왜곡되므로(정규화 실패), 전종목 기본적분석은 연간 기준을 쓴다.
    """
    if not has_dart_key():
        return {"status": "error", "stock_code": stock_code, "reason": "DART_API_KEY 미설정 (.env 확인)"}

    corp = dart_client.find_corp_by_stock_code(stock_code)
    if corp is None:
        return {
            "status": "error",
            "stock_code": stock_code,
            "reason": "DART corpCode 매핑에서 해당 종목코드를 찾을 수 없음 (상장폐지/코드오류 가능)",
        }

    try:
        profile = dart_client.get_company_profile(corp["corp_code"])
    except Exception as exc:
        profile = {}
        profile_warning = f"기업개황 조회 실패(비치명적, 업종분류 없이 진행): {exc}"
    else:
        profile_warning = None

    try:
        if annual_only:
            periods_data = dart_client.get_annual_statements(corp["corp_code"], years=periods)
        else:
            periods_data = dart_client.get_recent_financial_statements(corp["corp_code"], periods_needed=periods)
    except Exception as exc:
        return {
            "status": "error",
            "stock_code": stock_code,
            "corp_code": corp["corp_code"],
            "corp_name": corp["corp_name"],
            "reason": f"재무제표 조회 실패: {exc}",
        }

    if not periods_data:
        return {
            "status": "error",
            "stock_code": stock_code,
            "corp_code": corp["corp_code"],
            "corp_name": corp["corp_name"],
            "reason": "제출된 재무제표를 찾지 못함 (신규상장 직후 등 공시 이력 부족 가능)",
        }

    warnings = [profile_warning] if profile_warning else []
    if len(periods_data) < periods:
        warnings.append(f"요청 {periods}개 분기 중 {len(periods_data)}개만 확보")

    return {
        "status": "ok",
        "stock_code": stock_code,
        "corp_code": corp["corp_code"],
        "corp_name": corp["corp_name"],
        "induty_code": profile.get("induty_code"),
        "corp_cls": profile.get("corp_cls"),
        "periods": periods_data,
        "warnings": warnings,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--code", required=True, help="6자리 종목코드")
    parser.add_argument("--periods", type=int, default=4, help="조회할 최근 분기 수 (피어 비교용은 1)")
    parser.add_argument("--out")
    args = parser.parse_args()

    result = fetch(args.code, args.periods)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
