#!/usr/bin/env python3
"""전 상장종목 기본적분석을 생성한다 — 종목별 피어 조회 대신 '업종평균' 방식.

규모의 경제: 전체를 한 번 받아 업종코드로 묶어 평균을 한 번만 산출하고, 각 종목을 자기 업종평균과
비교한다(피어를 종목마다 따로 받지 않음). 종목당 최신 보고서 1개만 받는다 — 안정성/성장성/활동성·
Piotroski F-Score·ROE/ROA·PER/PBR은 최신 보고서 하나로 계산되기 때문(전년 대비 값이 그 안 frmtrm에 있음).
확정 공시분은 영구 캐시(actions/cache)라 첫 실행만 DART를 많이 부르고 이후엔 재호출이 거의 없다 —
DART 일일한도(2만) 안에서 며칠에 걸쳐 캐시가 차며 전종목이 채워진다(캐시+재시도로 자연스럽게 이어짐).

워치리스트 120종목은 여기에 더해 배당·실적추이(다기간)까지 채운다(generate_fundamental.py 재사용).
"""
from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import _skill_imports  # noqa: F401
import deterministic_scoring as ds
import fetch_financials
import compute_ratios
from watchlist import WATCHLIST_BY_CODE
import generate_fundamental as gf  # compute_dividend / compute_earnings_trend / read_latest_close 재사용

ROOT = Path(__file__).resolve().parents[1]
WEB_DATA_DIR = ROOT / "web" / "data" / "fundamental"
COMPANY_INDEX = ROOT / "web" / "data" / "company_index.json"

MAX_WORKERS = 6
MIN_INDUSTRY_SAMPLE = 5   # 업종 표본이 이보다 적으면 시장 전체 평균으로 대체
ALL_RATIO_KEYS = ds.STABILITY_KEYS + ds.GROWTH_KEYS + ds.ACTIVITY_KEYS


def load_universe() -> list[dict]:
    """검색 인덱스(전 상장 보통주)를 재무분석 유니버스로 사용."""
    try:
        data = json.loads(COMPANY_INDEX.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"[fund-all] company_index 로드 실패: {exc}", file=sys.stderr)
        return []
    if data.get("status") != "ok":
        return []
    return [{"code": c["code"], "name": c["name"]} for c in data.get("companies", [])]


def fetch_raw(entry: dict) -> dict:
    """한 종목의 최신 보고서를 받아 원시 비율/퀄리티/밸류에이션 + 업종코드를 산출(피어 비교 없음)."""
    code, name = entry["code"], entry["name"]
    try:
        fetched = fetch_financials.fetch(code, periods=1)
    except Exception as exc:
        return {"code": code, "name": name, "status": "error", "reason": str(exc)[:120]}
    if fetched.get("status") != "ok" or not fetched.get("periods"):
        return {"code": code, "name": name, "status": "error", "reason": fetched.get("reason", "재무데이터 없음")}

    latest = fetched["periods"][0]
    raw_ratios = compute_ratios.compute_period_ratios(latest["accounts"])
    latest_close = gf.read_latest_close(code)  # 워치리스트만 technical JSON 존재 → 대부분 None(밸류에이션은 라이브 시세로 대체)
    qv = compute_ratios.compute_quality_valuation(fetched["periods"], latest_close)
    return {
        "code": code, "name": name, "status": "ok",
        "corp_code": fetched.get("corp_code"),
        "induty": (fetched.get("induty_code") or "UNKNOWN"),
        "ratios": {k: raw_ratios.get(k) for k in ALL_RATIO_KEYS},
        "quality": qv["quality"], "valuation": qv["valuation"],
        "latest_period": {"bsns_year": latest.get("bsns_year"), "reprt_code": latest.get("reprt_code")},
        "periods": fetched["periods"],  # 워치리스트 배당/추이용
        "warnings": fetched.get("warnings", []),
    }


def industry_averages(records: list[dict]) -> tuple[dict, dict]:
    """업종별·시장전체 각 비율의 평균. (industry_avg[induty][key], market_avg[key]) 반환."""
    by_ind: dict[str, dict[str, list[float]]] = {}
    market: dict[str, list[float]] = {k: [] for k in ALL_RATIO_KEYS}
    for r in records:
        if r.get("status") != "ok":
            continue
        ind = r["induty"]
        bucket = by_ind.setdefault(ind, {k: [] for k in ALL_RATIO_KEYS})
        for k in ALL_RATIO_KEYS:
            v = r["ratios"].get(k)
            if v is not None:
                bucket[k].append(v)
                market[k].append(v)

    def _avg(lst):
        return sum(lst) / len(lst) if lst else None

    industry_avg = {ind: {k: _avg(vs[k]) for k in ALL_RATIO_KEYS} for ind, vs in by_ind.items()}
    industry_count = {ind: max((len(vs[k]) for k in ALL_RATIO_KEYS), default=0) for ind, vs in by_ind.items()}
    market_avg = {k: _avg(market[k]) for k in ALL_RATIO_KEYS}
    return industry_avg, industry_count, market_avg


def build_output(r: dict, industry_avg: dict, industry_count: dict, market_avg: dict) -> dict:
    ind = r["induty"]
    use_industry = industry_count.get(ind, 0) >= MIN_INDUSTRY_SAMPLE
    avg = industry_avg[ind] if use_industry else market_avg
    basis = "industry_average" if use_industry else "market_average_fallback"

    def category(keys: list[str]) -> dict:
        out = {}
        for key in keys:
            higher_is_better, desc = compute_ratios.RATIO_META[key]
            target_val = r["ratios"].get(key)
            peer_avg = avg.get(key)
            rel = compute_ratios._relative_favorability(target_val, peer_avg, higher_is_better)
            out[key] = {
                "description": desc,
                "target": round(target_val, 4) if target_val is not None else None,
                "peer_average": round(peer_avg, 4) if peer_avg is not None else None,
                "relative_favorability": round(rel, 4) if rel is not None else None,
                "higher_is_better": higher_is_better,
            }
        return out

    ratios_dict = {
        "status": "ok",
        "comparison_basis": basis,
        "stability": category(ds.STABILITY_KEYS),
        "growth": category(ds.GROWTH_KEYS),
        "activity": category(ds.ACTIVITY_KEYS),
    }
    curated = WATCHLIST_BY_CODE.get(r["code"])
    sector = curated.get("sector", "") if curated else ""
    scores = ds.compute_fundamental_scores(ratios_dict, sector)

    out = {
        "status": "ok",
        "code": r["code"], "name": r["name"], "sector": sector or None,
        "coverage": "full" if curated else "core",  # full=워치리스트(배당/추이 포함), core=전종목 기본
        "stability_score": scores.get("stability"),
        "growth_score": scores.get("growth"),
        "activity_score": scores.get("activity"),
        "sensitivity_applied": scores.get("sensitivity_applied"),
        "comparison_basis": basis,
        "industry_code": ind,
        "latest_period": r["latest_period"],
        "stability": ratios_dict["stability"],
        "growth": ratios_dict["growth"],
        "activity": ratios_dict["activity"],
        "quality": r["quality"],
        "valuation": r["valuation"],
        "warnings": r.get("warnings", []),
    }
    # 워치리스트(우량주)는 배당·실적추이까지 추가
    if curated:
        target = {"status": "ok", "corp_code": r.get("corp_code"), "periods": r["periods"]}
        out["dividend"] = gf.compute_dividend(target, gf.read_latest_close(r["code"]))
        out["earnings_trend"] = gf.compute_earnings_trend(r.get("corp_code"))
    return out


def main() -> None:
    WEB_DATA_DIR.mkdir(parents=True, exist_ok=True)
    universe = load_universe()
    if not universe:
        print("[fund-all] 유니버스가 비어있어 중단", file=sys.stderr)
        print(json.dumps({"ok": 0, "total": 0}, ensure_ascii=False))
        return

    print(f"[fund-all] 유니버스 {len(universe)}종목 재무 수집 시작(동시 {MAX_WORKERS}개)...", file=sys.stderr)
    records: list[dict] = []
    done = 0
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futures = {ex.submit(fetch_raw, e): e for e in universe}
        for fut in as_completed(futures):
            records.append(fut.result())
            done += 1
            if done % 200 == 0:
                print(f"[fund-all] 수집 {done}/{len(universe)}...", file=sys.stderr)

    ok_records = [r for r in records if r.get("status") == "ok"]
    print(f"[fund-all] 재무 확보 {len(ok_records)}/{len(universe)} — 업종평균 산출 중...", file=sys.stderr)
    industry_avg, industry_count, market_avg = industry_averages(ok_records)
    print(f"[fund-all] 업종 수: {len(industry_avg)} (표본≥{MIN_INDUSTRY_SAMPLE} 업종은 업종평균, 그 외 시장평균)", file=sys.stderr)

    ok_count = 0
    kept = 0
    for r in records:
        code = r["code"]
        out_path = WEB_DATA_DIR / f"{code}.json"
        if r.get("status") == "ok":
            try:
                result = build_output(r, industry_avg, industry_count, market_avg)
                ok_count += 1
            except Exception as exc:
                result = {"status": "error", "code": code, "name": r["name"], "reason": f"산출 실패: {exc}"}
        else:
            result = {"status": "error", "code": code, "name": r["name"], "reason": r.get("reason", "재무데이터 없음")}

        # 일시적 DART 실패로 기존 정상 데이터를 에러로 덮어쓰지 않는다 — 다음 실행에서 캐시로 복구되게 둔다
        # (점진 캐시 워밍 중 안전장치). 신규(파일 없음)면 에러라도 기록해 상태를 남긴다.
        if result.get("status") != "ok" and out_path.exists():
            try:
                if json.loads(out_path.read_text(encoding="utf-8")).get("status") == "ok":
                    kept += 1
                    continue
            except Exception:
                pass
        out_path.write_text(json.dumps(result, ensure_ascii=False, default=str), encoding="utf-8")

    if kept:
        print(f"[fund-all] 일시실패 {kept}종목은 기존 정상데이터 유지(다음 실행 재시도)", file=sys.stderr)

    print(f"[fund-all] 완료: {ok_count}/{len(universe)} 성공", file=sys.stderr)
    print(json.dumps({"ok": ok_count, "total": len(universe), "industries": len(industry_avg)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
