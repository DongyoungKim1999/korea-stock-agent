#!/usr/bin/env python3
"""워치리스트 전 종목의 기본적분석 데이터를 생성해 web/data/fundamental/{code}.json에 저장한다.

동일업종 피어는 1차로 pykrx 업종분류(KRX 대분류)로 찾는다 — 실패하면(예: KRX가 클라우드 IP의
전종목 조회 자체를 차단하는 환경) 워치리스트 내 다른 종목들을 피어로 재활용한다. 이 종목들은
이미 자기 자신의 분석을 위해 재무제표를 받아둔 상태라 추가 DART 호출이 필요 없다. 두 경우 모두
docs/reference/industry-classification-notes.md의 A6 정책(표본 5개사 미만이면 시장평균 대체)을 따른다.
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from pykrx import stock

import _skill_imports  # noqa: F401
import deterministic_scoring as ds
import fetch_financials
import compute_ratios
from watchlist import WATCHLIST, WATCHLIST_BY_CODE

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import krx_client  # noqa: E402
from common import dart_client  # noqa: E402

WEB_DATA_DIR = Path(__file__).resolve().parents[1] / "web" / "data" / "fundamental"
TECHNICAL_DIR = Path(__file__).resolve().parents[1] / "web" / "data" / "technical"
MAX_PEERS = 15
MIN_PEERS = 5


def read_latest_close(code: str) -> float | None:
    """직전 단계(generate_technical)가 만든 기술적분석 JSON에서 최근 종가를 읽는다 —
    밸류에이션(PER/PBR) 계산에 필요한 종가를 추가 API 호출 없이 재사용하기 위함."""
    path = TECHNICAL_DIR / f"{code}.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if data.get("status") != "ok":
        return None
    ind = data.get("indicators") or {}
    close = ind.get("latest_close")
    if close is None and data.get("price_series"):
        close = data["price_series"][-1].get("close")
    try:
        return float(close) if close is not None else None
    except (TypeError, ValueError):
        return None


def fetch_sector_classifications(latest_date: str) -> dict:
    """KOSPI/KOSDAQ 업종분류를 딱 한 번씩만 받아온다(종목별로 재호출하지 않음 — 이 한 번의
    호출로 전종목 분류가 다 들어있다). 클라우드 IP에서 막히는 환경이면 빈 dict를 반환하고,
    이후 모든 종목은 재호출 없이 바로 워치리스트 재활용 경로로 넘어간다."""
    result = {}
    for market in ("KOSPI", "KOSDAQ"):
        try:
            df = stock.get_market_sector_classifications(latest_date, market)
            if df is not None and not df.empty:
                result[market] = df
        except Exception:
            pass
    return result


def find_peers_via_pykrx(code: str, sector_dfs: dict) -> tuple[list[str], str]:
    """(피어 종목코드 목록, comparison_basis) 반환. sector_dfs는 main()에서 한 번만 받아온 캐시."""
    for df in sector_dfs.values():
        if code not in df.index:
            continue

        target_sector = df.loc[code, "업종명"]
        same_sector = [c for c in df.index if c != code and df.loc[c, "업종명"] == target_sector]

        if len(same_sector) >= MIN_PEERS:
            return same_sector[:MAX_PEERS], "industry_average"

        others = [c for c in df.index if c != code and c not in same_sector]
        return (same_sector + others)[:MAX_PEERS], "market_average_fallback"

    return [], "unavailable"


def find_peers_via_watchlist(code: str, sector: str, fetched: dict[str, dict]) -> tuple[list[str], str]:
    """pykrx 업종분류를 못 쓸 때의 대체 경로: 이미 가져온 워치리스트 종목들을 피어로 재활용."""
    ok_codes = [c for c, r in fetched.items() if c != code and r.get("status") == "ok"]
    same_sector = [c for c in ok_codes if WATCHLIST_BY_CODE.get(c, {}).get("sector") == sector]

    if len(same_sector) >= MIN_PEERS:
        return same_sector[:MAX_PEERS], "industry_average"
    return ok_codes[:MAX_PEERS], "market_average_fallback"


def compute_dividend(target: dict, latest_close: float | None) -> dict | None:
    """최근 확정 사업연도 배당 → 현재 종가 기준 배당수익률까지 계산. 배당 없으면 status='none'."""
    corp_code = target.get("corp_code")
    if not corp_code:
        return None
    annual_years = [p["bsns_year"] for p in target.get("periods", []) if p.get("reprt_code") == "11011"]
    year = annual_years[0] if annual_years else None
    if year is None:
        return None
    try:
        div = dart_client.get_dividend_info(corp_code, year)
    except Exception:
        return None
    if not div:
        return {"status": "none", "year": year}
    dps = div.get("dps")
    yld = (dps / latest_close * 100) if (dps and latest_close) else div.get("reported_yield_pct")
    return {
        "status": "ok",
        "year": year,
        "dps": dps,
        "payout_pct": div.get("payout_pct"),
        "dividend_yield_pct": round(yld, 2) if yld is not None else None,
    }


def compute_earnings_trend(corp_code: str | None) -> list[dict]:
    """최근 4개 사업연도 매출·영업이익·순이익 + 영업/순이익률 추이(오름차순)."""
    if not corp_code:
        return []
    try:
        annuals = dart_client.get_annual_statements(corp_code, years=4)
    except Exception:
        return []
    trend = []
    for period in reversed(annuals):  # 최신→과거를 과거→최신으로
        raw = compute_ratios.extract_raw_amounts(period["accounts"])
        rev = raw["revenue"]["thstrm"]
        oi = raw["operating_income"]["thstrm"]
        ni = raw["net_income"]["thstrm"]
        trend.append({
            "year": period["bsns_year"],
            "revenue": rev,
            "operating_income": oi,
            "net_income": ni,
            "op_margin_pct": round(oi / rev * 100, 1) if rev and oi is not None else None,
            "net_margin_pct": round(ni / rev * 100, 1) if rev and ni is not None else None,
        })
    return trend


def generate_one(entry: dict, sector_dfs: dict, fetched: dict[str, dict], tmp_dir: Path) -> dict:
    code, name = entry["code"], entry["name"]

    target = fetched[code]
    if target["status"] != "ok":
        return {"status": "error", "code": code, "name": name, "reason": target.get("reason")}

    target_path = tmp_dir / f"{code}_target.json"
    target_path.write_text(json.dumps(target, ensure_ascii=False, default=str), encoding="utf-8")

    peer_codes, basis = find_peers_via_pykrx(code, sector_dfs) if sector_dfs else ([], "unavailable")
    peer_paths = []

    if peer_codes:
        # pykrx 업종분류가 성공한 경우 — 정식 경로. 이 피어들은 아직 재무데이터가 없으므로 새로 조회.
        for peer_code in peer_codes:
            try:
                peer = fetch_financials.fetch(peer_code, periods=1)
            except Exception:
                continue
            if peer["status"] != "ok":
                continue
            p = tmp_dir / f"{code}_peer_{peer_code}.json"
            p.write_text(json.dumps(peer, ensure_ascii=False, default=str), encoding="utf-8")
            peer_paths.append(str(p))

    if not peer_paths:
        # pykrx 경로가 아예 막혔거나 피어를 못 찾은 경우 — 워치리스트 재활용 경로(추가 호출 없음)
        wl_peer_codes, basis = find_peers_via_watchlist(code, entry.get("sector", ""), fetched)
        for peer_code in wl_peer_codes:
            peer_paths.append(str(tmp_dir / f"{peer_code}_target.json"))  # 이미 저장돼있는 파일 재사용

    latest_close = read_latest_close(code)
    ratios = compute_ratios.analyze(str(target_path), peer_paths, basis if peer_paths else None, latest_close)
    if ratios.get("status") != "ok":
        return {"status": "error", "code": code, "name": name, "reason": ratios.get("reason")}

    scores = ds.compute_fundamental_scores(ratios, entry.get("sector", ""))

    return {
        "status": "ok",
        "code": code,
        "name": name,
        "sector": entry.get("sector"),
        "stability_score": scores.get("stability"),
        "growth_score": scores.get("growth"),
        "activity_score": scores.get("activity"),
        "sensitivity_applied": scores.get("sensitivity_applied"),
        "comparison_basis": ratios.get("comparison_basis"),
        "peer_list": ratios.get("peer_list"),
        "latest_period": ratios.get("latest_period"),
        "stability": ratios.get("stability"),
        "growth": ratios.get("growth"),
        "activity": ratios.get("activity"),
        "quality": ratios.get("quality"),
        "valuation": ratios.get("valuation"),
        "dividend": compute_dividend(target, latest_close),
        "earnings_trend": compute_earnings_trend(target.get("corp_code")),
        "warnings": target.get("warnings", []) + ratios.get("warnings", []),
    }


def main() -> None:
    WEB_DATA_DIR.mkdir(parents=True, exist_ok=True)
    latest_date = krx_client.get_latest_trading_date()
    summary = []

    with tempfile.TemporaryDirectory(prefix="fundamental_gen_") as tmp:
        tmp_dir = Path(tmp)

        # 1단계: 워치리스트 전체를 먼저 받아둔다 — 이 결과를 서로의 피어로 재활용하기 위함.
        fetched: dict[str, dict] = {}
        for entry in WATCHLIST:
            print(f"[fundamental] {entry['code']} {entry['name']} 재무데이터 수집 중...", file=sys.stderr)
            try:
                fetched[entry["code"]] = fetch_financials.fetch(entry["code"], periods=4)
            except Exception as exc:
                fetched[entry["code"]] = {"status": "error", "reason": str(exc)}
            p = tmp_dir / f"{entry['code']}_target.json"
            p.write_text(json.dumps(fetched[entry["code"]], ensure_ascii=False, default=str), encoding="utf-8")

        # 2단계: 업종분류를 한 번만 받아오고(종목별 재호출 없음), 종목별 비율 계산
        print("[fundamental] 업종분류 조회 중(KOSPI/KOSDAQ 각 1회)...", file=sys.stderr)
        sector_dfs = fetch_sector_classifications(latest_date)
        print(f"[fundamental] 업종분류 확보: {list(sector_dfs.keys()) or '없음(워치리스트 재활용으로 진행)'}", file=sys.stderr)

        for entry in WATCHLIST:
            print(f"[fundamental] {entry['code']} {entry['name']} 비율 계산 중...", file=sys.stderr)
            try:
                result = generate_one(entry, sector_dfs, fetched, tmp_dir)
            except Exception as exc:
                result = {"status": "error", "code": entry["code"], "name": entry["name"], "reason": str(exc)}

            out_path = WEB_DATA_DIR / f"{entry['code']}.json"
            out_path.write_text(json.dumps(result, ensure_ascii=False, default=str), encoding="utf-8")
            summary.append({"code": entry["code"], "name": entry["name"], "status": result["status"]})

    ok = sum(1 for s in summary if s["status"] == "ok")
    print(f"[fundamental] 완료: {ok}/{len(summary)} 성공", file=sys.stderr)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
