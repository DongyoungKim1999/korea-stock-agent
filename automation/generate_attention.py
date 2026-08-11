#!/usr/bin/env python3
"""'관심(검색·뉴스) 급증' 신호를 만든다 → web/data/attention.json.

아이디어(Da·Engelberg·Gao 2011): 개인의 관심이 급증하면 매수세가 유입돼 단기 주가가 움직인다.
관심의 순수 대용치로 ①네이버 검색량(데이터랩 검색어트렌드) ②뉴스 언급량(뉴스검색 API)을 쓴다.
거래대금 대비 '개인 관심' 자체를 직접 재는 게 강점(대형주 거래대금은 기관·지수 노이즈가 큼).

각 종목:
- 검색 급증 = 최근 RECENT_WINDOW일 평균 검색지수 / 그 직전 RECENT_WINDOW일 평균
- 뉴스 급증 = 최근 RECENT_WINDOW일 기사수 vs 그 직전 RECENT_WINDOW일 기사수
- (보너스) 공시 건수 = 최근 RECENT_WINDOW일 DART 정기·수시공시 수 — '공시→관심' 촉발 확인
→ 종합 관심도 레벨(🔥급등 / 관심↑ / 평온). 라이브 신호라 캐시 없이 매 실행 갱신.

우선 유니버스: 워치리스트 + 팩터 TOP. Naver 키(데이터랩·뉴스 API 활성화된 앱)는 CI 시크릿으로 주입.
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import _skill_imports  # noqa: F401
from common import naver_client
from common.config import has_naver_keys, has_dart_key
from watchlist import WATCHLIST

ROOT = Path(__file__).resolve().parents[1]
FACTOR_PATH = ROOT / "web" / "data" / "factor_ranking.json"
OUT_PATH = ROOT / "web" / "data" / "attention.json"

RECENT_WINDOW = 7        # 최근 N일 vs 직전 N일
SEARCH_TREND_DAYS = 40   # 검색 트렌드 조회 기간(≥ 2*RECENT_WINDOW 여유)
MAX_STOCKS = 220         # 실행당 상한(데이터랩 1,000/일 한도 안, 워치+팩터TOP 커버)


def _load(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def _priority_codes() -> list[dict]:
    """우선 대상: 워치리스트 + 팩터 종합 TOP(이름 포함). 중복 제거."""
    out, seen = [], set()
    for w in WATCHLIST:
        if w["code"] not in seen:
            seen.add(w["code"]); out.append({"code": w["code"], "name": w["name"]})
    fr = _load(FACTOR_PATH, {})
    if fr.get("status") == "ok":
        for t in fr.get("top", []):
            if t["code"] not in seen:
                seen.add(t["code"]); out.append({"code": t["code"], "name": t.get("name") or t["code"]})
    return out[:MAX_STOCKS]


def _search_surge(name: str) -> dict:
    end = dt.date.today()
    start = end - dt.timedelta(days=SEARCH_TREND_DAYS)
    series = naver_client.get_search_trend(name, start.isoformat(), end.isoformat())
    if not series:
        return {"available": False}
    vals = [pt.get("ratio", 0.0) for pt in series]
    recent = vals[-RECENT_WINDOW:]
    prior = vals[-2 * RECENT_WINDOW:-RECENT_WINDOW]
    r_avg = sum(recent) / len(recent) if recent else 0.0
    p_avg = sum(prior) / len(prior) if prior else 0.0
    ratio = None if p_avg == 0 else round(r_avg / p_avg, 2)
    return {"available": True, "recent_avg": round(r_avg, 1), "prior_avg": round(p_avg, 1),
            "surge_ratio": ratio, "new_spike": p_avg == 0 and r_avg > 0}


def _disclosure_count(code: str) -> dict:
    from common import dart_client
    corp = dart_client.find_corp_by_stock_code(code)
    if not corp:
        return {"available": False}
    end = dt.date.today()
    start = end - dt.timedelta(days=RECENT_WINDOW)
    try:
        items = dart_client.list_disclosures(corp["corp_code"], start.strftime("%Y%m%d"), end.strftime("%Y%m%d"))
    except Exception:
        return {"available": False}
    return {"available": True, "recent_count": len(items),
            "titles": [it.get("report_nm") for it in items[:4]]}


def _score(search: dict, news: dict) -> dict:
    """검색·뉴스 급증을 종합 관심도 레벨로. level: hot/up/calm, label + 배지 이모지.

    검색(데이터랩)이 주신호 — 정규화된 시계열이라 급증을 안정적으로 잰다. 뉴스검색 API는 최근 100건
    상한(capped)이 걸리면 대형주가 상시 100/0으로 나와 급증 판정이 불가하므로, capped가 아닐 때만
    (평소 조용하던 종목의 실제 기사 폭증) 보조 신호로 쓴다."""
    reasons = []
    hot = up = False

    sr = search.get("surge_ratio") if search.get("available") else None
    if search.get("new_spike"):
        hot = True; reasons.append("검색량 신규 급등")
    elif sr is not None:
        if sr >= 1.7:
            hot = True; reasons.append(f"검색량 {sr:.1f}배 급증")
        elif sr >= 1.3:
            up = True; reasons.append(f"검색량 {sr:.1f}배 증가")

    # 뉴스는 capped(100건 상한) 아닐 때만 — 조용하던 종목의 실제 폭증만 잡는다
    if news.get("recent_count") is not None and not news.get("capped"):
        rc, pc = news.get("recent_count", 0), news.get("prior_count", 0)
        if rc >= 8 and rc >= pc * 2:
            hot = True; reasons.append(f"뉴스 {rc}건 급증(직전 {pc})")
        elif rc >= 5 and rc > pc:
            up = True; reasons.append(f"뉴스 {rc}건↑")

    level = "hot" if hot else ("up" if up else "calm")
    emoji = {"hot": "🔥", "up": "📈", "calm": "🟢"}[level]
    label = {"hot": "관심 급등", "up": "관심 증가", "calm": "평온"}[level]
    return {"level": level, "emoji": emoji, "label": label, "reasons": reasons}


def main() -> None:
    if not has_naver_keys():
        print("[attention] NAVER 키 없음 — 스킵", file=sys.stderr)
        OUT_PATH.write_text(json.dumps({"status": "skipped", "reason": "no_naver_keys"}, ensure_ascii=False), encoding="utf-8")
        return

    targets = _priority_codes()
    signals, calls = {}, 0
    for t in targets:
        code, name = t["code"], t["name"]
        try:
            search = _search_surge(name)
        except Exception:
            search = {"available": False}
        try:
            news = naver_client.get_news_mention_signal(name, recent_days=RECENT_WINDOW)
        except Exception:
            news = {"available": False}
        disclosures = _disclosure_count(code) if has_dart_key() else {"available": False}
        calls += 1
        sc = _score(search, news)
        # 평온이고 데이터도 없으면 저장 생략(패널에서 '데이터 없음'으로 처리)
        signals[code] = {
            "name": name, **sc,
            "search": search,
            "news": {k: news.get(k) for k in ("recent_count", "prior_count", "capped", "sample_titles")} if news.get("available", True) else {"available": False},
            "disclosures": disclosures,
        }

    OUT_PATH.write_text(json.dumps({
        "status": "ok",
        "generated_at": dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).isoformat(timespec="seconds"),
        "count": len(signals),
        "recent_window_days": RECENT_WINDOW,
        "note": "네이버 검색량·뉴스 언급 급증 기반 관심도. 라이브 신호(매 실행 갱신). 매수권유 아님.",
        "signals": signals,
    }, ensure_ascii=False), encoding="utf-8")
    print(f"[attention] 완료: {len(signals)}종목 (호출 {calls}) → {OUT_PATH.name}", file=sys.stderr)


if __name__ == "__main__":
    main()
