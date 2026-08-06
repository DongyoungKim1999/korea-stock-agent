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

# sj_div: 회사마다 손익계산서를 "IS"(별도) + "OCI"/기타 로 나눠 내거나, "CIS"(포괄손익계산서)
# 하나로 통합해서 내는 경우가 섞여있다(실제 DART 응답으로 확인됨 — 예: 삼성전자는 IS로 분리해서
# 내지만 SK하이닉스/KB금융/NAVER 등은 CIS 하나에 매출액·영업이익·순이익을 전부 담아 낸다).
# 그래서 손익 계정은 sj_div를 "IS"만이 아니라 ("IS","CIS") 둘 다 허용해서 찾는다.
_IS_DIVS = ("IS", "CIS")

_ACCOUNT_MAP = {
    "assets": (("ifrs-full_Assets",), ("자산총계",), ("BS",)),
    "liabilities": (("ifrs-full_Liabilities",), ("부채총계",), ("BS",)),
    "equity": (("ifrs-full_Equity", "ifrs-full_EquityAttributableToOwnersOfParent"), ("자본총계",), ("BS",)),
    "current_assets": (("ifrs-full_CurrentAssets",), ("유동자산",), ("BS",)),
    "current_liabilities": (("ifrs-full_CurrentLiabilities",), ("유동부채",), ("BS",)),
    "revenue": (("ifrs-full_Revenue", "ifrs-full_RevenueFromContractsWithCustomers"), ("매출액", "영업수익"), _IS_DIVS),
    "cogs": (("ifrs-full_CostOfSales",), ("매출원가",), _IS_DIVS),
    "operating_income": (("dart_OperatingIncomeLoss",), ("영업이익",), _IS_DIVS),
    "net_income": (("ifrs-full_ProfitLoss",), ("당기순이익", "분기순이익", "반기순이익"), _IS_DIVS),
    "receivables": (("ifrs-full_TradeAndOtherCurrentReceivables", "ifrs-full_TradeAndOtherReceivables"), ("매출채권",), ("BS",)),
    "inventory": (("ifrs-full_Inventories",), ("재고자산",), ("BS",)),
    "finance_cost": (("ifrs-full_FinanceCosts",), ("금융원가", "이자비용"), _IS_DIVS),
    # 아래 3개는 퀄리티(F-Score/ROE) & 밸류에이션(PER/PBR) 계산용으로 추가.
    # 영업활동현금흐름은 현금흐름표(sj_div="CF")에 있다 — DART fnlttSinglAcntAll가 이미 함께 내려준다.
    "operating_cash_flow": (("ifrs-full_CashFlowsFromUsedInOperatingActivities",), ("영업활동현금흐름", "영업활동으로인한현금흐름"), ("CF",)),
    "issued_capital": (("ifrs-full_IssuedCapital",), ("자본금",), ("BS",)),  # 신주발행(희석) 판별용
    "eps": (("ifrs-full_BasicEarningsLossPerShare", "dart_BasicEarningsLossPerShareChanged"), ("기본주당이익", "기본주당순이익", "주당순이익"), _IS_DIVS),
    # DCF 계산기 자동채움용: CapEx(유형자산 취득)·현금성자산
    "capex": (("ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",), ("유형자산의취득", "유형자산의 취득"), ("CF",)),
    "cash": (("ifrs-full_CashAndCashEquivalents",), ("현금및현금성자산",), ("BS",)),
}

# 보고서코드별 연환산 계수 (분기 누계 → 연간). 1분기 ×4, 반기 ×2, 3분기 ×4/3, 사업보고서 ×1.
_ANNUALIZE_FACTOR = {"11013": 4.0, "11012": 2.0, "11014": 4.0 / 3.0, "11011": 1.0}

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


# 이자부부채(차입금·사채·리스부채) 항목 — 순부채 = 이자부부채 − 현금 계산용.
# '부채총계 − 현금'은 매입채무 등 비이자부채까지 포함해 과대계상되므로, 실제 금융부채만 합산한다.
_DEBT_NAME_PATTERNS = ("단기차입금", "장기차입금", "유동성장기부채", "유동성사채", "유동성장기차입금",
                       "사채", "전환사채", "신주인수권부사채", "리스부채", "금융리스부채", "유동차입금")
_DEBT_ID_HINTS = ("Borrowings", "BondsIssued", "LeaseLiabilities")


def _sum_interest_bearing_debt(accounts: list[dict]) -> float | None:
    """재무상태표(BS)에서 이자부부채 라인아이템 합. 못 찾으면 None(→ 순현금으로 간주)."""
    total, found = 0.0, False
    for acc in accounts:
        if acc.get("sj_div") != "BS":
            continue
        nm = (acc.get("account_nm") or "").replace(" ", "")
        aid = acc.get("account_id") or ""
        name_hit = any(p in nm for p in _DEBT_NAME_PATTERNS)
        id_hit = any(h in aid for h in _DEBT_ID_HINTS)
        if not (name_hit or id_hit):
            continue
        # 현금흐름·증감·주석성 문구가 섞인 항목은 제외(BS 라인만 대상이지만 방어적으로)
        if name_hit and any(x in nm for x in ("증가", "감소", "상환", "발행", "이자")):
            continue
        v = _to_float(acc.get("thstrm_amount"))
        if v is not None and v > 0:
            total += v
            found = True
    return total if found else None


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
    ids, names, sj_divs = _ACCOUNT_MAP[field]
    # id는 '우선순위' 순서다 — 계정 출현 순서가 아니라 이 순서를 존중해야 한다. 예: equity는
    # 총자본(ifrs-full_Equity)을 지배주주지분(EquityAttributableToOwnersOfParent)보다 먼저 잡아야
    # 총액 순이익(ProfitLoss)과 분모가 일치해 ROE가 어긋나지 않는다(지배지분이 먼저 나오면 오차).
    for wanted_id in ids:
        for acc in accounts:
            if acc.get("sj_div") in sj_divs and acc.get("account_id") == wanted_id:
                v = _amount_from(acc, amount_key)
                if v is not None:
                    return v
    # id로 못 찾으면(비표준 공시) 계정명 부분일치로 폴백
    for acc in accounts:
        if acc.get("sj_div") in sj_divs and any(n in (acc.get("account_nm") or "") for n in names):
            v = _amount_from(acc, amount_key)
            if v is not None:
                return v
    return None


def _safe_div(a: float | None, b: float | None) -> float | None:
    if a is None or b is None or b == 0:
        return None
    return a / b


def _relative_favorability(target_val: float | None, avg: float | None, higher_is_better: bool) -> float | None:
    """1보다 크면 target이 유리하도록 정규화. 두 값이 모두 양수면 기존처럼 비율로 계산한다.

    성장률처럼 음수가 나올 수 있는 지표는 비율로 계산하면 부호가 뒤집혀 오해를 부른다
    (예: target +474%, 평균 -30%일 때 474/-30을 그대로 쓰면 target이 훨씬 나은데도 '불리'로
    표시됨). 둘 중 하나라도 0 이하면 차이 기반으로 계산해 방향성을 올바르게 유지한다 — 두 값이
    모두 양수인 기존 케이스(안정성·활동성 비율 등)는 계산식이 그대로라 결과가 바뀌지 않는다.
    """
    if target_val is None or avg in (None, 0):
        return None
    if avg > 0 and target_val > 0:
        return (target_val / avg) if higher_is_better else (avg / target_val)
    diff = (target_val - avg) if higher_is_better else (avg - target_val)
    return 1 + diff / (abs(avg) + abs(target_val) + 1e-9)


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
        if t[key] is None or f[key] in (None, 0):
            return None
        g = (t[key] - f[key]) / abs(f[key]) * 100
        # 전년 기저가 극도로 작으면(스팩·신규상장·흑자전환 등) 성장률이 수백~수천%로 튀어 무의미하다
        # (예: 매출 +23,900%). ±400%p를 넘으면 '측정 불가'(None)로 둬 성장점수·표시를 오염시키지 않는다.
        return g if abs(g) <= 400 else None

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


def _piotroski_f_score(t: dict, f: dict) -> dict:
    """Piotroski F-Score (Joseph Piotroski, 2000, J. of Accounting Research).

    재무제표 9개 항목을 각각 통과(1)/미달(0)로 채점해 재무건전성을 0~9로 요약한다. 학술적으로
    저PBR 종목 중 F-Score 높은 그룹이 낮은 그룹을 유의하게 아웃퍼폼함이 검증된, 대표적인 퀄리티
    스크리닝 지표다. t=당기, f=전기(전년동기) raw 금액. 계산에 필요한 값이 없는 항목은 채점에서
    제외하고(분모를 실채점 항목 수로), 몇 개 항목으로 매겼는지 max_score로 함께 노출한다.

    한계 표기: 5번(레버리지)은 정통 정의(장기부채/평균자산)를 총부채/자산으로 근사했고, 7번(신주발행)은
    발행주식수 대신 자본금(액면) 증감으로 근사했다 — 무료 데이터 제약상 합리적 대체이며 방향성은 보존된다.
    """
    checks: dict[str, bool | None] = {}

    def roa(d):
        return _safe_div(d.get("net_income"), d.get("assets"))

    def leverage(d):
        return _safe_div(d.get("liabilities"), d.get("assets"))

    def current_ratio(d):
        return _safe_div(d.get("current_assets"), d.get("current_liabilities"))

    def gross_margin(d):
        rev = d.get("revenue")
        if rev in (None, 0) or d.get("cogs") is None:
            return None
        return (rev - d["cogs"]) / rev

    def asset_turnover(d):
        return _safe_div(d.get("revenue"), d.get("assets"))

    roa_t, roa_f = roa(t), roa(f)
    cfo_t = t.get("operating_cash_flow")
    ni_t = t.get("net_income")

    # 수익성 4
    checks["roa_positive"] = (roa_t > 0) if roa_t is not None else None
    checks["cfo_positive"] = (cfo_t > 0) if cfo_t is not None else None
    checks["roa_improving"] = (roa_t > roa_f) if (roa_t is not None and roa_f is not None) else None
    checks["accrual"] = (cfo_t > ni_t) if (cfo_t is not None and ni_t is not None) else None  # 이익의 질: 영업현금 > 순이익
    # 레버리지/유동성 3
    lev_t, lev_f = leverage(t), leverage(f)
    checks["leverage_down"] = (lev_t < lev_f) if (lev_t is not None and lev_f is not None) else None
    cr_t, cr_f = current_ratio(t), current_ratio(f)
    checks["current_ratio_up"] = (cr_t > cr_f) if (cr_t is not None and cr_f is not None) else None
    cap_t, cap_f = t.get("issued_capital"), f.get("issued_capital")
    checks["no_dilution"] = (cap_t <= cap_f) if (cap_t is not None and cap_f is not None) else None
    # 효율성 2
    gm_t, gm_f = gross_margin(t), gross_margin(f)
    checks["gross_margin_up"] = (gm_t > gm_f) if (gm_t is not None and gm_f is not None) else None
    at_t, at_f = asset_turnover(t), asset_turnover(f)
    checks["asset_turnover_up"] = (at_t > at_f) if (at_t is not None and at_f is not None) else None

    scored = [v for v in checks.values() if v is not None]
    score = sum(1 for v in scored if v)
    max_score = len(scored)
    return {
        "score": score,
        "max_score": max_score,
        "checks": checks,
        "interpretation": (
            "우량(재무개선 뚜렷)" if max_score and score / max_score >= 7 / 9
            else "보통" if max_score and score / max_score >= 4 / 9
            else "취약(재무악화 신호)" if max_score else "산출불가"
        ),
    }


_REPRT_ANNUAL = "11011"


def _ttm_net_income(periods: list[dict], ni_cum: float | None, ni_cum_prev: float | None, reprt_code: str | None):
    """최근 12개월(TTM) 순이익을 계산한다 — 단일 분기 ×N 연환산의 경기민감주 왜곡을 피하기 위함.

    반환: (ttm_net_income, basis). basis는 "ttm"(정석) / "annual"(최신이 사업보고서) /
    "annualized_quarter"(직전 연간보고서를 못 구해 부득이 분기 연환산) 중 하나.

    TTM = 최근분기누계 + 직전 연간 − 전년동기누계. 세 값 모두 이미 받아온 4개 분기 안에 있다
    (전년동기누계는 DART가 각 계정에 함께 주는 frmtrm값). 예) 지금이 1분기면
    TTM = 1Q(당해) + 전년 연간 − 1Q(전년).
    """
    if reprt_code == _REPRT_ANNUAL:
        return ni_cum, "annual"
    prior_annual_ni = None
    for p in periods[1:]:
        if p.get("reprt_code") == _REPRT_ANNUAL:
            prior_annual_ni = _find_amount(p.get("accounts", []), "net_income", "thstrm_amount")
            break
    if prior_annual_ni is not None and ni_cum is not None and ni_cum_prev is not None:
        return ni_cum + prior_annual_ni - ni_cum_prev, "ttm"
    factor = _ANNUALIZE_FACTOR.get(reprt_code or "", 1.0)
    return (ni_cum * factor if ni_cum is not None else None), "annualized_quarter"


def compute_quality_valuation(periods: list[dict], latest_close: float | None) -> dict:
    """퀄리티(ROE/ROA/F-Score)와 밸류에이션(PER/PBR)을 계산한다.

    ROE/ROA/PER의 이익 기준은 단일 분기 연환산이 아니라 TTM(최근 12개월)을 우선 사용한다 —
    경기민감주의 호황/불황 분기를 ×N 하면 크게 왜곡되기 때문(예: 반도체 호황 1분기 ×4 → ROE 98%).

    밸류에이션은 발행주식수를 DART가 내려주는 EPS로 역산한다(주식수 = 순이익 ÷ EPS, 같은 기간
    누계라 계수가 약분됨) — KRX 시가총액 엔드포인트가 클라우드 IP에서 차단돼도 종가+재무제표만으로
    PER/PBR을 낼 수 있게 한 우회다. EPS가 없거나 0이면 밸류에이션은 unavailable로 둔다.
    """
    latest = periods[0]
    reprt_code = latest.get("reprt_code")
    raw = extract_raw_amounts(latest["accounts"])
    t = {k: v["thstrm"] for k, v in raw.items()}
    f = {k: v["frmtrm"] for k, v in raw.items()}

    ni_cum = t.get("net_income")           # 당해 누계 순이익
    ni_cum_prev = f.get("net_income")       # 전년동기 누계 순이익
    equity = t.get("equity")
    assets = t.get("assets")

    ni_ttm, earnings_basis = _ttm_net_income(periods, ni_cum, ni_cum_prev, reprt_code)

    roe = _safe_div(ni_ttm, equity)
    roa = _safe_div(ni_ttm, assets)

    quality = {
        "roe_pct": round(roe * 100, 2) if roe is not None else None,
        "roa_pct": round(roa * 100, 2) if roa is not None else None,
        "f_score": _piotroski_f_score(t, f),
        "earnings_basis": earnings_basis,  # ttm / annual / annualized_quarter
    }

    # 밸류에이션: EPS로 주식수 역산 → PER(TTM)/PBR
    valuation = {"per": None, "pbr": None, "shares_estimated": None, "eps_ttm": None, "basis": "unavailable"}
    eps_cum = t.get("eps")
    if latest_close is not None and eps_cum not in (None, 0) and ni_cum not in (None, 0):
        shares = ni_cum / eps_cum  # 같은 기간 누계 순이익 ÷ 누계 EPS → 발행주식수
        if shares and shares > 0:
            eps_ttm = ni_ttm / shares if ni_ttm is not None else None
            per = _safe_div(latest_close, eps_ttm)
            bps = _safe_div(equity, shares)
            pbr = _safe_div(latest_close, bps)
            valuation = {
                "per": round(per, 2) if per is not None else None,
                "pbr": round(pbr, 2) if pbr is not None else None,
                "shares_estimated": int(shares),
                "eps_ttm": round(eps_ttm, 1) if eps_ttm is not None else None,
                "bps": round(bps, 1) if bps is not None else None,
                "latest_close": latest_close,
                "earnings_basis": earnings_basis,
                "basis": "eps_derived",  # 종가 + DART EPS 역산 기준. 시장 공표 PER과 소수 오차 가능
            }

    # DCF 계산기 자동채움용 입력값(억원 단위). FCFF ≈ 영업활동현금흐름 − CapEx(연환산). 순부채 = 부채총계 − 현금성자산.
    factor2 = _ANNUALIZE_FACTOR.get(reprt_code or "", 1.0)
    ocf = t.get("operating_cash_flow")
    capex = t.get("capex")
    fcff = None
    if ocf is not None:
        fcff = (ocf - abs(capex)) * factor2 if capex is not None else ocf * factor2
    # 순부채 = 이자부부채(차입금·사채·리스부채) − 현금. 이자부부채를 못 찾으면 현금만큼 순현금으로 본다.
    cash = t.get("cash")
    debt = _sum_interest_bearing_debt(latest["accounts"])
    if debt is not None:
        net_debt = debt - (cash or 0)
    elif cash is not None:
        net_debt = -cash  # 이자부부채 미검출 → 순현금
    else:
        net_debt = None
    to_eok = lambda v: round(v / 1e8, 1) if v is not None else None  # 원 → 억원
    valuation_inputs = {
        "fcff_eok": to_eok(fcff),          # 연환산 잉여현금흐름(근사, 억원)
        "net_debt_eok": to_eok(net_debt),  # 순부채(억원), 음수면 순현금
        "capex_included": capex is not None,
    }
    return {"quality": quality, "valuation": valuation, "valuation_inputs": valuation_inputs}


def _load(path: str) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def analyze(target_path: str, peer_paths: list[str], comparison_basis: str | None, latest_close: float | None = None) -> dict:
    target = _load(target_path)
    if target.get("status") != "ok" or not target.get("periods"):
        return {"status": "error", "reason": "target 재무데이터가 유효하지 않습니다: " + str(target.get("reason", "periods 없음"))}

    target_periods = target["periods"]
    latest = target_periods[0]
    latest_ratios = compute_period_ratios(latest["accounts"])
    quality_valuation = compute_quality_valuation(target_periods, latest_close)
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
            relative = _relative_favorability(target_val, avg, higher_is_better)
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
        "quality": quality_valuation["quality"],
        "valuation": quality_valuation["valuation"],
        "growth_trend_by_period": trend,
        "warnings": warnings,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True)
    parser.add_argument("--peer", action="append", default=[], dest="peers")
    parser.add_argument("--comparison-basis", choices=["industry_average", "market_average_fallback"])
    parser.add_argument("--latest-close", type=float, help="밸류에이션(PER/PBR) 계산용 최근 종가 (없으면 밸류에이션 생략)")
    parser.add_argument("--out")
    args = parser.parse_args()

    result = analyze(args.target, args.peers, args.comparison_basis, args.latest_close)
    text = json.dumps(result, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
