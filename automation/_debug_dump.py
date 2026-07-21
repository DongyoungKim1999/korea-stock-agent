#!/usr/bin/env python3
"""임시 진단 스크립트: 삼성전자 최신 분기 재무제표 원본(IS 계정)을 web/data/_debug.json에 덤프.
성장성 지표가 전종목 공통으로 비어있는 원인(frmtrm_amount 누락 추정)을 확인하기 위함.
문제 해결 후 삭제할 것.
"""
import json
import sys
from pathlib import Path

import _skill_imports  # noqa: F401
import fetch_financials

result = fetch_financials.fetch("005930", periods=1)
out_path = Path(__file__).resolve().parents[1] / "web" / "data" / "_debug.json"

if result["status"] != "ok":
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    sys.exit(0)

accounts = result["periods"][0]["accounts"]
is_accounts = [a for a in accounts if a.get("sj_div") == "IS"]
dump = {
    "bsns_year": result["periods"][0]["bsns_year"],
    "reprt_code": result["periods"][0]["reprt_code"],
    "fs_div": result["periods"][0]["fs_div"],
    "is_account_count": len(is_accounts),
    "is_accounts_sample": is_accounts[:15],
}
out_path.write_text(json.dumps(dump, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
print(json.dumps({"status": "dumped", "is_account_count": len(is_accounts)}, ensure_ascii=False))
