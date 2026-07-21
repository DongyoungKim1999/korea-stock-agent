#!/usr/bin/env python3
"""임시 진단: 여러 종목의 '매출액'류 IS 계정이 어떤 account_id/account_nm으로 오는지 확인.
문제 해결 후 삭제할 것.
"""
import json
from pathlib import Path

import _skill_imports  # noqa: F401
import fetch_financials

CODES = ["005930", "000660", "373220", "105560", "035420"]
out = {}

for code in CODES:
    result = fetch_financials.fetch(code, periods=1)
    if result["status"] != "ok":
        out[code] = {"error": result.get("reason")}
        continue
    accounts = result["periods"][0]["accounts"]
    is_accounts = [a for a in accounts if a.get("sj_div") == "IS"]
    # '매출' 이 이름에 들어가거나 ord가 낮은(상단) 항목들만 추려서 확인
    revenue_like = [a for a in is_accounts if "매출" in (a.get("account_nm") or "") or "수익" in (a.get("account_nm") or "")]
    out[code] = {
        "bsns_year": result["periods"][0]["bsns_year"],
        "reprt_code": result["periods"][0]["reprt_code"],
        "fs_div": result["periods"][0]["fs_div"],
        "is_account_count": len(is_accounts),
        "revenue_like_accounts": [
            {"account_id": a.get("account_id"), "account_nm": a.get("account_nm"),
             "thstrm_amount": a.get("thstrm_amount"), "thstrm_add_amount": a.get("thstrm_add_amount")}
            for a in revenue_like
        ],
    }

out_path = Path(__file__).resolve().parents[1] / "web" / "data" / "_debug.json"
out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
print("dumped", list(out.keys()))
