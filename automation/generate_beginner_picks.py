#!/usr/bin/env python3
"""초보자용 추천 종목을 '투자 성향별'로 나눠 만든다 → web/data/beginner_picks.json.

부모님처럼 뭘 골라야 할지 모르는 초보자에게, 흑자·무경고 우량주(유니버스=워치리스트)를
네 가지 성향으로 갈라 출발점을 준다:
  · 대형주      — 규모(매출) 큰 대표 우량주
  · 고배당주    — 배당수익률 높은 회사
  · 고성장주    — 매출이 빠르게 크는 회사(변동성 안내 포함)
  · 꾸준한 흑자주 — 최근 몇 년 연속 흑자 + 재무 탄탄

공통 안전 필터: 흑자(ROE>0·최근 순이익>0) + 관리·특이 경고 없음 + 최소 규모. 순수 로컬 계산.
'사라'는 목록이 아니라 성향별 참고 출발점 — 판단·책임은 사용자.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone, timedelta
from pathlib import Path

import _skill_imports  # noqa: F401
from watchlist import WATCHLIST

ROOT = Path(__file__).resolve().parents[1]
FUND_DIR = ROOT / "web" / "data" / "fundamental"
OUT_PATH = ROOT / "web" / "data" / "beginner_picks.json"

KST = timezone(timedelta(hours=9))

PER_CAT = 8            # 카테고리당 최대 종목 수
MIN_REVENUE_EOK = 2000  # 매출 2천억 미만(소형주)은 변동성 커 제외
MIN_STABILITY = 3.0    # 재무 최소 '보통 이상'

# "경고 없음" 필터가 봐야 할 건 재무 위험 신호지, "피어 표본이 5개 미만이었다" 같은 비교기준
# 캐벗까지 전부 실격시키는 건 과하다(우량주도 업종이 특이하면 피어를 못 채워 늘 제외될 수 있음).
# 초보자 보호가 목적이라 기본은 여전히 "모르면 제외"지만, 알려진 무해한 캐벗 패턴만 예외로 둔다.
_BENIGN_WARNING_PATTERNS = ("요청", "피어 스킵", "피어 표본", "보고서 기간이 target과 달라")


def _has_risk_warning(warnings: list) -> bool:
    return any(not any(p in w for p in _BENIGN_WARNING_PATTERNS) for w in warnings)


def _num(x):
    return x if isinstance(x, (int, float)) and x == x else None


def _load(code: str) -> dict | None:
    try:
        d = json.loads((FUND_DIR / f"{code}.json").read_text(encoding="utf-8"))
    except Exception:
        return None
    return d if d.get("status") == "ok" else None


def _extract(d: dict) -> dict | None:
    """판정용 지표 추출. 공통 안전 필터(흑자·무경고·최소규모) 실패 시 None."""
    ss = _num(d.get("stability_score"))
    q = d.get("quality") or {}
    roe = _num(q.get("roe_pct"))
    fs = q.get("f_score") or {}
    fsr = (fs.get("score") / fs.get("max_score")) if fs.get("max_score") else None
    div = d.get("dividend") or {}
    dy = _num(div.get("dividend_yield_pct")) if div.get("status") == "ok" else None
    g = d.get("growth") or {}
    rev_g = _num((g.get("revenue_growth_yoy") or {}).get("target"))
    et = d.get("earnings_trend") or []
    nis = [_num(r.get("net_income")) for r in et]
    nis = [x for x in nis if x is not None]
    recent = nis[-3:]
    profit_ratio = (sum(1 for x in recent if x > 0) / len(recent)) if recent else 0.0
    latest_ni = nis[-1] if nis else None
    rev_eok = None
    for r in reversed(et):
        rv = _num(r.get("revenue"))
        if rv:
            rev_eok = rv / 1e8
            break

    if roe is None or roe <= 0:
        return None
    if latest_ni is None or latest_ni <= 0:
        return None
    if _has_risk_warning(d.get("warnings") or []):
        return None
    if rev_eok is None or rev_eok < MIN_REVENUE_EOK:
        return None

    return {
        "ss": ss, "roe": roe, "fsr": fsr, "dy": dy, "rev_g": rev_g,
        "profit_ratio": profit_ratio, "rev_eok": rev_eok, "n_years": len(recent),
    }


def _pick(items, key, reason_fn, tag_fn):
    out = []
    for s in sorted(items, key=key, reverse=True)[:PER_CAT]:
        out.append({
            "code": s["code"], "name": s["name"], "sector": s.get("sector"),
            "reason": reason_fn(s), "tags": tag_fn(s),
        })
    return out


def build() -> dict:
    rows = []
    for w in WATCHLIST:
        d = _load(w["code"])
        if not d:
            continue
        m = _extract(d)
        if not m:
            continue
        rows.append({"code": w["code"], "name": d.get("name") or w.get("name"),
                     "sector": d.get("sector") or w.get("sector"), **m})

    # 대형주 — 매출(규모) 큰 순
    large = _pick(
        [s for s in rows if s["ss"] and s["ss"] >= MIN_STABILITY],
        key=lambda s: s["rev_eok"],
        reason_fn=lambda s: f"국내 대표급 규모 · {'빚 적고 재무 탄탄' if s['ss'] >= 4 else '흑자 안정'}",
        tag_fn=lambda s: ["대형"] + (["재무탄탄"] if s["ss"] >= 4 else []),
    )
    # 고배당주 — 배당수익률 높은 순(2% 이상)
    dividend = _pick(
        [s for s in rows if s["dy"] and s["dy"] >= 2.0],
        key=lambda s: s["dy"],
        reason_fn=lambda s: f"배당을 약 {s['dy']:.1f}% 줘요 · 흑자",
        tag_fn=lambda s: [f"배당 {s['dy']:.1f}%"] + (["대형"] if s["rev_eok"] >= 50000 else []),
    )
    # 고성장주 — 매출성장률 높은 순(10% 이상)
    growth = _pick(
        [s for s in rows if s["rev_g"] is not None and s["rev_g"] >= 10],
        key=lambda s: s["rev_g"],
        reason_fn=lambda s: f"매출이 {s['rev_g']:.0f}% 성장 · 흑자",
        tag_fn=lambda s: [f"매출+{s['rev_g']:.0f}%"] + (["수익성좋음"] if s["roe"] >= 12 else []),
    )
    # 꾸준한 흑자주 — 최근 연속 흑자 + 재무 탄탄, 안정성·F-Score 순
    steady = _pick(
        [s for s in rows if s["profit_ratio"] >= 0.99 and s["n_years"] >= 2 and s["ss"] and s["ss"] >= 3.5],
        key=lambda s: (s["ss"] or 0) * 0.6 + (s["fsr"] if s["fsr"] is not None else 0.5) * 0.4,
        reason_fn=lambda s: f"최근 {s['n_years']}년 연속 흑자 · 빚 적고 재무 탄탄",
        tag_fn=lambda s: ["꾸준한흑자", "재무탄탄"],
    )

    categories = [
        {"key": "large", "title": "대형주", "desc": "규모가 큰 대표 우량회사예요. 대체로 가장 안정적이에요.", "picks": large},
        {"key": "dividend", "title": "고배당주", "desc": "배당(가진 것만으로 받는 현금)을 많이 주는 회사예요.", "picks": dividend},
        {"key": "growth", "title": "고성장주", "desc": "매출이 빠르게 크는 회사예요. 기대가 큰 만큼 주가 변동도 클 수 있어요.", "picks": growth},
        {"key": "steady", "title": "꾸준한 흑자주", "desc": "매년 안정적으로 이익을 내는 회사예요.", "picks": steady},
    ]

    return {
        "status": "ok",
        "generated_at": datetime.now(KST).isoformat(timespec="seconds"),
        "note": "워치리스트(대형주) 중 흑자·무경고 종목을 성향별로 나눈 초보자 참고 목록. 매수 권유 아님.",
        "categories": categories,
    }


def main() -> None:
    result = build()
    OUT_PATH.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    counts = " / ".join(f"{c['title']} {len(c['picks'])}" for c in result["categories"])
    print(f"[beginner] 완료: {counts} → {OUT_PATH.name}")


if __name__ == "__main__":
    main()
