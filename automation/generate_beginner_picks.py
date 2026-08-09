#!/usr/bin/env python3
"""초보자용 '안심 종목' 리스트를 만든다 → web/data/beginner_picks.json.

부모님처럼 뭘 골라야 할지 모르는 초보자에게 '큰 우량회사'만 추려 출발점을 준다. 유니버스는
워치리스트(대형·유명 종목 120)로 한정하고, 그중 ①흑자(ROE>0·최근 순이익>0) ②재무 탄탄
(안정성점수 높음) ③꾸준한 흑자 ④배당을 점수화해 상위 소수만 뽑는다. 한 업종에 쏠리지 않게
업종당 최대 2개로 다양화한다. 순수 로컬 계산(재무 JSON만 읽음)이라 DART 없이도 재생성된다.

'사라'는 리스트가 아니라 '초보자가 봐도 덜 위험한 큰 회사' 참고 목록이다 — 판단·책임은 사용자.
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

import math

MAX_PICKS = 15        # 초보자가 훑기 좋게 소수 정예
PER_SECTOR = 2        # 업종 쏠림 방지(다양한 산업을 보여준다)
MIN_STABILITY = 3.0   # 안심 리스트는 재무가 최소 '보통 이상'인 것만
MIN_REVENUE_EOK = 5000  # 매출 5천억 미만(소형주)은 변동성 커 초보자 안심 리스트에서 제외


def _num(x):
    return x if isinstance(x, (int, float)) and x == x else None


def _load(code: str) -> dict | None:
    p = FUND_DIR / f"{code}.json"
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    return d if d.get("status") == "ok" else None


def _evaluate(d: dict) -> dict | None:
    """안심 점수 + 쉬운 이유. 흑자·재무탄탄 필터를 통과 못 하면 None(리스트 제외)."""
    ss = _num(d.get("stability_score"))
    q = d.get("quality") or {}
    roe = _num(q.get("roe_pct"))
    fs = q.get("f_score") or {}
    fsr = (fs.get("score") / fs.get("max_score")) if fs.get("max_score") else None
    div = d.get("dividend") or {}
    dy = _num(div.get("dividend_yield_pct")) if div.get("status") == "ok" else None
    et = d.get("earnings_trend") or []
    nis = [_num(r.get("net_income")) for r in et]
    nis = [x for x in nis if x is not None]
    recent = nis[-3:]
    profit_ratio = (sum(1 for x in recent if x > 0) / len(recent)) if recent else 0.0
    latest_ni = nis[-1] if nis else None
    # 매출(원)→억 = 회사 규모 대용치(시총은 라이브 데이터라 없음). 최신 연도 매출 사용.
    rev_eok = None
    for r in reversed(et):
        rv = _num(r.get("revenue"))
        if rv:
            rev_eok = rv / 1e8
            break

    # 필터: 흑자(ROE>0·최근 순이익>0) + 재무 보통 이상 + 대형(매출 하한). 경고 있으면 제외.
    if roe is None or roe <= 0:
        return None
    if latest_ni is None or latest_ni <= 0:
        return None
    if ss is None or ss < MIN_STABILITY:
        return None
    if rev_eok is None or rev_eok < MIN_REVENUE_EOK:
        return None
    if d.get("warnings"):   # 관리·특이 경고가 있으면 초보자 안심 리스트에서 제외
        return None

    # 규모 점수: 매출 로그 스케일(5천억=0 ~ 300조≈1). 대형일수록 초보자에게 덜 위험.
    size = (math.log10(rev_eok) - math.log10(MIN_REVENUE_EOK)) / (math.log10(3_000_000) - math.log10(MIN_REVENUE_EOK))
    size = min(max(size, 0.0), 1.0)

    # 점수: 안정성 0.30 + 규모 0.20 + 꾸준한흑자 0.15 + F-Score 0.15 + 배당 0.10 + ROE 0.10
    score = (
        (ss / 5) * 0.30
        + size * 0.20
        + profit_ratio * 0.15
        + (fsr if fsr is not None else 0.5) * 0.15
        + (min(dy, 5.0) / 5 if dy else 0.0) * 0.10
        + (min(max(roe, 0.0), 25.0) / 25) * 0.10
    )

    # 쉬운 말 이유(강점 위주 2~3개) + 태그
    reasons, tags = [], []
    if rev_eok >= 50000:   # 매출 5조 이상 = 누구나 아는 대형사
        tags.append("대형")
    if ss >= 4.0:
        reasons.append("빚이 적고 재무가 탄탄해요")
        tags.append("재무탄탄")
    elif ss >= 3.5:
        reasons.append("재무가 비교적 안정적이에요")
    if profit_ratio >= 0.99 and len(recent) >= 2:
        reasons.append("최근 몇 년 꾸준히 흑자예요")
        tags.append("꾸준한흑자")
    if roe >= 12:
        reasons.append("돈을 잘 버는 회사예요")
        tags.append("수익성좋음")
    if dy and dy >= 1.5:
        reasons.append(f"배당을 약 {dy:.1f}% 줘요")
        tags.append("배당")
    if not reasons:
        reasons.append("큰 회사이고 흑자예요")
    reason = " · ".join(reasons[:3])

    return {
        "score": round(score, 4),
        "reason": reason,
        "tags": tags,
        "stability_score": ss,
        "roe_pct": round(roe, 1),
        "dividend_yield_pct": round(dy, 2) if dy else None,
    }


def build() -> dict:
    scored = []
    for w in WATCHLIST:
        d = _load(w["code"])
        if not d:
            continue
        ev = _evaluate(d)
        if not ev:
            continue
        scored.append({
            "code": w["code"],
            "name": d.get("name") or w.get("name"),
            "sector": d.get("sector") or w.get("sector"),
            **ev,
        })
    scored.sort(key=lambda x: x["score"], reverse=True)

    # 업종당 최대 PER_SECTOR개로 다양화하며 상위 MAX_PICKS개 선정
    picks, per_sector = [], {}
    for s in scored:
        sec = s.get("sector") or "기타"
        if per_sector.get(sec, 0) >= PER_SECTOR:
            continue
        picks.append(s)
        per_sector[sec] = per_sector.get(sec, 0) + 1
        if len(picks) >= MAX_PICKS:
            break

    return {
        "status": "ok",
        "generated_at": datetime.now(KST).isoformat(timespec="seconds"),
        "count": len(picks),
        "note": "워치리스트(대형주) 중 흑자·재무탄탄·배당을 점수화한 초보자 참고 목록. 매수 권유 아님.",
        "picks": picks,
    }


def main() -> None:
    result = build()
    OUT_PATH.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    print(f"[beginner] 완료: 안심 종목 {result['count']}개 → {OUT_PATH.name}")


if __name__ == "__main__":
    main()
