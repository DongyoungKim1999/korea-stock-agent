#!/usr/bin/env python3
"""dart-financial-fetcher 출력(target 1개 + peer N개)으로 안정성/성장성/활동성 비율과
산업평균 대비 상대위치를 계산한다. 1~5점 환산은 하지 않는다 (그건 fundamental-analyst/A8, LLM 판단).

사용법:
    python3 compute_ratios.py --target output/cache/raw/005930_financials.json \
        --peer output/cache/raw/000660_financials_peer.json \
        --peer output/cache/raw/012450_financials_peer.json \
        --comparison-basis industry_average \
        --out output/cache/raw/005930_ratios.json

--comparison-basis: 호출자(fundamental-analyst)가 A6 규칙에 따라 무엇을 모았는지 명시한다.
    industry_average        동일업종(예: KRX 업종분류 동일) 종목들
    market_average_fallback 동일업종 표본이 5개사 미만이라 시장 전반에서 폭넓게 뽑은 대체 표본
--peer를 하나도 주지 않으면 비교 없이 target 절대수치만 출력한다(comparison_basis=unavailable로 강제).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

MIN_PEER_SAMPLE = 5  # 설계서 A6

_ACCOUNT_MAP = {
    "assets": (("ifrs-full_Assets",), ("자산총계",), "BS"),
    "liabilities": (("ifrs-full_Liabilities",), ("부채총계",), "BS"),
    "equity": (("ifrs-full_Equity", "ifrs-full_EquityAttributableToOwnersOfParent"), ("자본총계",), "BS"),
    "current_assets": (("ifrs-full_CurrentAssets",), ("유동자산",), "BS"),
    "current_liabilities": (("ifrs-full_CurrentLiabilities",), ("유동부채",), "BS"),
    "revenue": (("ifrs-full_Revenue", "ifrs-full_RevenueFromContractsWithCustomers"), ("매출액", "영업수익"), "IS"),
    "cogs": (("ifrs-full_CostOfSales",), ("매출원가",), "IS"),
    "operating_income": (("dart_OperatingIncomeLoss",), ("영업이익",), "IS"),
    "net_income": (("ifrs-full_ProfitLoss",), ("당기순이익", "분기순이익", "반기순이익"), "IS"),
    "receivables": (("ifrs-full_TradeAndOtherCurrentReceivables", "ifrs-full_TradeAndOtherReceivables"), ("매출채권",), "BS"),
    "inventory": (("ifrs-full_Inventories",), ("재고자산",), "BS"),
    "finance_cost": (("ifrs-full_FinanceCosts",), ("금융원가", "이자비용"), "IS"),
}

# (지표, 높을수록 유리한지, 설명)
RATIO_META = {
    "debt_ratio": (False, "부채비율(%) = 부채총계/자본총계*100"),
    "current_ratio": (True, "유동비율(%) = 유동자산/유동부채*100"),
    "interest_coverage": (True, "이자보상배율(배) = 영업이익/금융원가"),
    "revenue_growth_yoy": (True, "매출액증가율(%, YoY 누적기준)"),
    "operating_income_growth_yoy": (True, "영업이익증가율(%, YoY 누적기준)"),
    "net_income_growth_yoy": (True, "순이익증가율(%, YoY 누적기준)"),
    "asset_turnover": (True, "총자산회전율(회) = 매출액/자산총계 (분기 누적치 기준, 연환산 아님)"),
    "receivables_turnover": (True, "매출채권회전율(회) = 매출액/매출채권"),
    "inventory_turnover": (True, "재고자산회전율(회) = 매출원가/재고자산"),
}

STABILITY_KEYS = ["debt_ratio", "current_ratio", "interest_coverage"]
GROWTH_KEYS = ["revenue_growth_yoy", "operating_income_growth_yoy", "net_income_growth_yoy"]
ACTIVITY_KEYS = ["asset_turnover", "receivables_turnover", "inventory_turnover"]


def _to_float(value) -> float | None:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f else None  # NaN 제거


def _amount_from(acc: dict, amount_key: str) -> float | None:
    """DART는 분기보고서(11013/11012/11014)의 손익계산서 항목에 한해 thstrm_amount/frmtrm_amount
    대신(또는 그와 별개로) thstrm_add_amount/frmtrm_add_amount(연초 누계)를 함께 내려준다 —
    분기 단독 금액이 아니라 누계를 써야 YoY 성장률·회전율이 일관되므로 add_amount를 우선한다.
    재무상태표 항목·사업보고서는 add_amount 필드 자체가 없어 자동으로 일반 필드로 폴백된다.
    """
    add_key = amount_key.replace("_amount", "_add_amount")
    v = _to_float(acc.get(add_key))
    if v is not None:
        return v
    return _to_float(acc.get(amount_key))


def _find_amount(accounts: list[dict], field: str, amount_key: str) -> float | None:
    ids, names, sj_div = _ACCOUNT_MAP[field]
    for acc in accounts:
        if acc.get("sj_div") == sj_div and acc.get("account_id") in ids:
            v = _amount_from(acc, amount_key)
            if v is not None:
                return v
    for acc in accounts:
        if acc.get("sj_div") == sj_div and any(n in (acc.get("account_nm") or "") for n in names):
            v = _amount_from(acc, amount_key)
            if v is not None:
                return v
    return None


def _safe_div(a: float | None, b: float | None) -> float | None:
    if a is None or b is None or b == 0:
        return None
    return a / b


def extract_raw_amounts(accounts: list[dict]) -> dict:
    return {
        field: {"thstrm": _find_amount(accounts, field, "thstrm_amount"), "frmtrm": _find_amount(accounts, field, "frmtrm_amount")}
        for field in _ACCOUNT_MAP
    }


def compute_period_ratios(accounts: list[dict]) -> dict:
    a = extract_raw_amounts(accounts)
    t = {k: v["thstrm"] for k, v in a.items()}
    f = {k: v["frmtrm"] for k, v in a.items()}

    def growth(key):
        return _safe_div(t[key] - f[key], abs(f[key])) * 100 if t[key] is not None and f[key] not in (None, 0) else None

    return {
        "debt_ratio": _safe_div(t["liabilities"], t["equity"]) * 100 if _safe_div(t["liabilities"], t["equity"]) is not None else None,
        "current_ratio": _safe_div(t["current_assets"], t["current_liabilities"]) * 100 if _safe_div(t["current_assets"], t["current_liabilities"]) is not None else None,
        "interest_coverage": _safe_div(t["operating_income"], t["finance_cost"]),
        "revenue_growth_yoy": growth("revenue"),
        "operating_income_growth_yoy": growth("operating_income"),
        "net_income_growth_yoy": growth("net_income"),
        "asset_turnover": _safe_div(t["revenue"], t["assets"]),
        "receivables_turnover": _safe_div(t["revenue"], t["receivables"]),
        "inventory_turnover": _safe_div(t["cogs"], t["inventory"]),
        "_raw": t,
    }


def _load(path: str) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def analyze(target_path: str, peer_paths: list[str], comparison_basis: str | None) -> dict:
    target = _load(target_path)
    if target.get("status") != "ok" or not target.get("periods"):
        return {"status": "error", "reason": "target 재무데이터가 유효하지 않습니다: " + str(target.get("reason", "periods 없음"))}

    target_periods = target["periods"]
    latest = target_periods[0]
    latest_ratios = compute_period_ratios(latest["accounts"])
    trend = [
        {"bsns_year": p["bsns_year"], "reprt_code": p["reprt_code"], **{k: compute_period_ratios(p["accounts"])[k] for k in GROWTH_KEYS}}
        for p in target_periods
    ]

    peers = []
    warnings = list(target.get("warnings") or [])
    for path in peer_paths:
        peer = _load(path)
        if peer.get("status") != "ok" or not peer.get("periods"):
            warnings.append(f"피어 스킵({peer.get('stock_code', path)}): {peer.get('reason', 'periods 없음')}")
            continue
        peer_period = peer["periods"][0]
        if peer_period.get("reprt_code") != latest.get("reprt_code") or peer_period.get("bsns_year") != latest.get("bsns_year"):
            warnings.append(
                f"피어 {peer.get('corp_name', peer.get('stock_code'))}의 보고서 기간이 target과 달라 비교 정확도가 낮을 수 있음 "
                f"(target={latest.get('bsns_year')}/{latest.get('reprt_code')}, peer={peer_period.get('bsns_year')}/{peer_period.get('reprt_code')})"
            )
        peers.append(
            {
                "stock_code": peer.get("stock_code"),
                "corp_name": peer.get("corp_name"),
                "ratios": compute_period_ratios(peer_period["accounts"]),
            }
        )

    basis = comparison_basis
    if not peers:
        basis = "unavailable"
    elif basis is None:
        basis = "industry_average" if len(peers) >= MIN_PEER_SAMPLE else "market_average_fallback"
    if peers and len(peers) < MIN_PEER_SAMPLE:
        warnings.append(f"피어 표본 {len(peers)}개 (<{MIN_PEER_SAMPLE}) — comparison_basis={basis}로 처리")

    def category(keys: list[str]) -> dict:
        out = {}
        for key in keys:
            higher_is_better, desc = RATIO_META[key]
            target_val = latest_ratios[key]
            peer_vals = [p["ratios"][key] for p in peers if p["ratios"][key] is not None]
            avg = sum(peer_vals) / len(peer_vals) if peer_vals else None
            relative = None
            if target_val is not None and avg not in (None, 0):
                relative = (target_val / avg) if higher_is_better else (avg / target_val)
            out[key] = {
                "description": desc,
                "target": round(target_val, 4) if target_val is not None else None,
                "peer_average": round(avg, 4) if avg is not None else None,
                "peer_sample_size": len(peer_vals),
                "relative_favorability": round(relative, 4) if relative is not None else None,
                "higher_is_better": higher_is_better,
            }
        return out

    return {
        "status": "ok",
        "stock_code": target.get("stock_code"),
        "corp_name": target.get("corp_name"),
        "induty_code": target.get("induty_code"),
        "latest_period": {"bsns_year": latest.get("bsns_year"), "reprt_code": latest.get("reprt_code")},
        "comparison_basis": basis,
        "peer_list": [{"stock_code": p["stock_code"], "corp_name": p["corp_name"]} for p in peers],
        "stability": category(STABILITY_KEYS),
        "growth": category(GROWTH_KEYS),
        "activity": category(ACTIVITY_KEYS),
        "growth_trend_by_period": trend,
        "warnings": warnings,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True)
    parser.add_argument("--peer", action="append", default=[], dest="peers")
    parser.add_argument("--comparison-basis", choices=["industry_average", "market_average_fallback"])
    parser.add_argument("--out")
    args = parser.parse_args()

    result = analyze(args.target, args.peers, args.comparison_basis)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
