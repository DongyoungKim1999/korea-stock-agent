#!/usr/bin/env python3
"""전종목 횡단면(cross-sectional) 멀티팩터 랭킹을 생성한다 → web/data/factor_ranking.json.

퀀트의 뼈대: 종목을 하나씩 절대평가하지 않고, '전체 유니버스에서 팩터별로 줄 세운다'. 각 팩터를
윈저라이즈(5/95 절사)한 뒤 z-점수로 표준화하고, 퀄리티·성장·밸류 필라별로 묶어 가중합해 종합
팩터점수를 낸다. 이걸로 백분위·데실(10분위)을 매겨 '상위 데실 스크리너'를 만든다.

- 퀄리티(가중 0.5): ROE·ROA·F-Score비율·안정성점수 (높을수록 우수)
- 성장(가중 0.3): 매출·영업이익·순이익 YoY 성장률 (초소형 기저 허수는 이미 None 처리됨)
- 밸류(가중 0.2): 이익수익률(1/PER)·순자산수익률(1/PBR) — DART 역산 PER/PBR 있는 종목만(대부분 워치)

모멘텀(12-1개월)은 전종목 가격 수집이 필요해 Phase 2에서 추가한다. 필라가 없는 종목은 가진 필라만으로
가중치를 재정규화해 종합점수를 낸다. 순수 계산이라 DART 없이 로컬에서도 재생성된다.
"""
from __future__ import annotations

import json
import statistics
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FUND_DIR = ROOT / "web" / "data" / "fundamental"
MOM_PATH = ROOT / "web" / "data" / "momentum.json"
OUT_PATH = ROOT / "web" / "data" / "factor_ranking.json"

KST = timezone(timedelta(hours=9))

# 필라별 팩터 정의: (팩터키, 필라). 전부 '높을수록 우수'가 되도록 값을 미리 변환해 담는다.
# 가중치는 학술 강건성 순: 모멘텀·퀄리티 최상, 밸류 다음, 성장은 보조(성장은 단독 팩터로 약함).
PILLARS = {
    "momentum": ["mom"],
    "quality": ["roe", "roa", "fscore", "stability"],
    "value": ["earnings_yield", "book_yield"],
    "growth": ["rev_g", "oi_g", "ni_g"],
}
PILLAR_WEIGHT = {"momentum": 0.35, "quality": 0.30, "value": 0.20, "growth": 0.15}


def _num(x):
    return x if isinstance(x, (int, float)) and x == x else None  # NaN 제외


def _load_momentum() -> dict:
    """web/data/momentum.json의 {code: 12-1M 모멘텀%}. 아직 없으면 빈 dict(모멘텀 필라 없이 랭킹)."""
    try:
        d = json.loads(MOM_PATH.read_text(encoding="utf-8"))
        return d.get("moms", {}) if d.get("status") == "ok" else {}
    except Exception:
        return {}


def load_universe() -> list[dict]:
    """정상 종목별 팩터 원값(높을수록 우수로 변환)을 모은다."""
    moms = _load_momentum()
    out = []
    for p in FUND_DIR.glob("*.json"):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if d.get("status") != "ok":
            continue
        q = d.get("quality") or {}
        v = d.get("valuation") or {}
        g = d.get("growth") or {}
        fs = q.get("f_score") or {}
        fsr = (fs.get("score") / fs.get("max_score")) if fs.get("max_score") else None
        # 밸류: DART 역산 PER/PBR이 양수인 경우만 이익수익률/순자산수익률로 변환(낮은 PER=높은 수익률=우수)
        per = v.get("per") if v.get("basis") == "eps_derived" else None
        pbr = v.get("pbr") if v.get("basis") == "eps_derived" else None
        ey = (1.0 / per) if (per and per > 0) else None
        by = (1.0 / pbr) if (pbr and pbr > 0) else None
        factors = {
            "mom": _num(moms.get(d["code"])),  # 12-1개월 모멘텀(%) — 전종목 가격 수집(momentum.json)
            "roe": _num(q.get("roe_pct")),
            "roa": _num(q.get("roa_pct")),
            "fscore": _num(fsr),
            "stability": _num(d.get("stability_score")),
            "rev_g": _num((g.get("revenue_growth_yoy") or {}).get("target")),
            "oi_g": _num((g.get("operating_income_growth_yoy") or {}).get("target")),
            "ni_g": _num((g.get("net_income_growth_yoy") or {}).get("target")),
            "earnings_yield": _num(ey),
            "book_yield": _num(by),
        }
        out.append({
            "code": d["code"], "name": d.get("name"),
            "sector": d.get("sector"), "induty": d.get("industry_code"),
            "factors": factors,
        })
    return out


def _percentile(sorted_vals: list[float], pct: float) -> float:
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * pct / 100.0
    lo = int(k)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def zscore_factor(stocks: list[dict], key: str) -> dict[int, float]:
    """한 팩터를 윈저라이즈(5/95 절사) 후 z-표준화. 값이 있는 종목만 참여. {인덱스: z} 반환."""
    idx_vals = [(i, s["factors"][key]) for i, s in enumerate(stocks) if s["factors"].get(key) is not None]
    if len(idx_vals) < 20:
        return {}
    vals = sorted(v for _, v in idx_vals)
    lo, hi = _percentile(vals, 5), _percentile(vals, 95)
    clipped = [min(max(v, lo), hi) for _, v in idx_vals]
    mean = statistics.mean(clipped)
    sd = statistics.pstdev(clipped) or 1.0
    return {i: (min(max(v, lo), hi) - mean) / sd for (i, v) in idx_vals}


def build_ranking() -> dict:
    stocks = load_universe()
    n = len(stocks)
    if n < 50:
        return {"status": "error", "reason": f"유니버스 부족({n})"}

    # 팩터별 z-점수
    zf = {key: zscore_factor(stocks, key) for pillar in PILLARS.values() for key in pillar}

    # 종목별 필라 z(가진 팩터 평균) → 종합 z(가진 필라만 가중 재정규화)
    for i, s in enumerate(stocks):
        pillar_z = {}
        for pillar, keys in PILLARS.items():
            zs = [zf[k][i] for k in keys if i in zf.get(k, {})]
            if zs:
                pillar_z[pillar] = sum(zs) / len(zs)
        s["_pillar"] = pillar_z
        if pillar_z:
            wsum = sum(PILLAR_WEIGHT[p] for p in pillar_z)
            s["_composite"] = sum(pillar_z[p] * PILLAR_WEIGHT[p] for p in pillar_z) / wsum
        else:
            s["_composite"] = None

    ranked = [s for s in stocks if s["_composite"] is not None]
    ranked.sort(key=lambda s: s["_composite"], reverse=True)
    m = len(ranked)

    ranks = {}
    for rank, s in enumerate(ranked, start=1):
        pct = round((1 - (rank - 1) / m) * 100)  # 1위=100, 꼴찌≈0 (상위 백분위)
        decile = min(10, max(1, int((rank - 1) / m * 10) + 1))  # 1=상위10%
        pz = s["_pillar"]
        rnd = lambda k: round(pz[k], 2) if k in pz else None
        ranks[s["code"]] = {
            "rank": rank, "pct": pct, "decile": decile,
            "composite": round(s["_composite"], 3),
            "momentum": rnd("momentum"), "quality": rnd("quality"),
            "value": rnd("value"), "growth": rnd("growth"),
        }

    # 스크리너용 상위 60 (이름 포함)
    top = [{
        "code": s["code"], "name": s["name"], "sector": s.get("sector"),
        "pct": ranks[s["code"]]["pct"], "decile": ranks[s["code"]]["decile"],
        "momentum": ranks[s["code"]]["momentum"], "quality": ranks[s["code"]]["quality"],
        "value": ranks[s["code"]]["value"], "growth": ranks[s["code"]]["growth"],
    } for s in ranked[:60]]

    return {
        "status": "ok",
        "generated_at": datetime.now(KST).isoformat(timespec="seconds"),
        "universe": m,
        "factors": {"quality": PILLARS["quality"], "growth": PILLARS["growth"], "value": PILLARS["value"]},
        "weights": PILLAR_WEIGHT,
        "note": "횡단면 멀티팩터(퀄리티·성장·밸류) z-점수 랭킹. 모멘텀은 Phase 2 추가 예정.",
        "ranks": ranks,
        "top": top,
    }


def main() -> None:
    result = build_ranking()
    OUT_PATH.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    if result.get("status") == "ok":
        print(f"[factor-rank] 완료: {result['universe']}종목 랭킹 → {OUT_PATH.name}")
    else:
        print(f"[factor-rank] 실패: {result.get('reason')}")


if __name__ == "__main__":
    main()
