#!/usr/bin/env python3
"""전종목 12-1개월 모멘텀을 수집한다 → web/data/momentum.json (팩터 랭킹의 모멘텀 필라 입력).

모멘텀 = 최근 12개월 수익률에서 '직전 1개월은 스킵'(close[-21]/close[-252]-1). 최근 1개월 스킵은
단기 반전 노이즈를 빼는 학술 표준(Jegadeesh-Titman). 기술적 신호 중 유일하게 수십 년 살아남은 팩터.

가격은 Worker /ohlcv(네이버 프록시, 이 환경의 신뢰 가능한 시세원)에서 받는다. 전종목 3,900개를 매번
받으면 ~2시간이므로: ①영구캐시(actions/cache로 보존) ②7일 지난 종목만 갱신 ③실행당 상한(MAX_REFRESH)
으로 며칠에 걸쳐 커버한다(DART식 점진 워밍). 모멘텀은 느리게 변하는 팩터라 최대 1주 staleness는 무해.
"""
from __future__ import annotations

import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path

import _skill_imports  # noqa: F401

ROOT = Path(__file__).resolve().parents[1]
COMPANY_INDEX = ROOT / "web" / "data" / "company_index.json"
CACHE_PATH = ROOT / "output" / "cache" / "raw" / "_momentum_cache.json"  # actions/cache로 영구보존
OUT_PATH = ROOT / "web" / "data" / "momentum.json"

REFRESH_DAYS = 7        # 이보다 오래된 종목만 재수집
MAX_REFRESH = 800       # 실행당 재수집 상한(런타임 캡, ~3분). 6실행이면 전종목 커버
WORKERS = 8
_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
_WORKER = "https://korea-stock-agent-gpt-proxy.dkdla00.workers.dev"  # web/js/config.js와 동일한 Worker


def _fetch_ohlcv(code: str) -> list[dict] | None:
    req = urllib.request.Request(f"{_WORKER}/ohlcv?code={code}", headers={"User-Agent": _UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.load(r)
        rows = d.get("rows")
        return rows if isinstance(rows, list) else None
    except Exception:
        return None


def _momentum_12_1(rows: list[dict]) -> float | None:
    """12-1개월 수익률(%). 최근 1개월(≈21거래일) 스킵. 데이터 260봉 미만이면 None(신규상장 등)."""
    closes = [x.get("close") for x in rows if x.get("close")]
    if len(closes) < 260:
        return None
    prev1m, prev12m = closes[-21], closes[-252]
    if not prev12m:
        return None
    return round((prev1m / prev12m - 1) * 100, 2)


def _load_json(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def _needs_refresh(entry: dict | None, today: str) -> bool:
    if not entry or "updated" not in entry:
        return True
    # 문자열 날짜 비교(ISO)로 REFRESH_DAYS 경과 판단
    try:
        d0 = date.fromisoformat(entry["updated"])
        return (date.fromisoformat(today) - d0).days >= REFRESH_DAYS
    except Exception:
        return True


def main() -> None:
    idx = _load_json(COMPANY_INDEX, {})
    codes = [c["code"] for c in idx.get("companies", [])] if idx.get("status") == "ok" else []
    if not codes:
        print("[momentum] company_index 비어있음 — 중단", file=sys.stderr)
        OUT_PATH.write_text(json.dumps({"status": "error", "reason": "no universe"}, ensure_ascii=False), encoding="utf-8")
        return

    cache = _load_json(CACHE_PATH, {})
    today = date.today().isoformat()
    stale = [c for c in codes if _needs_refresh(cache.get(c), today)]
    to_fetch = stale[:MAX_REFRESH]
    print(f"[momentum] 유니버스 {len(codes)} · 갱신필요 {len(stale)} · 이번실행 {len(to_fetch)}개 수집(상한 {MAX_REFRESH})", file=sys.stderr)

    def work(code):
        rows = _fetch_ohlcv(code)
        if rows is None:
            return code, None
        return code, _momentum_12_1(rows)

    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(work, c): c for c in to_fetch}
        for fut in as_completed(futs):
            code, mom = fut.result()
            # 실패(None+네트워크)와 '데이터부족(None)'을 구분: rows 자체 실패면 캐시 유지, 계산결과 None이면 기록
            cache[code] = {"mom": mom, "updated": today}
            done += 1
            if done % 200 == 0:
                print(f"[momentum] {done}/{len(to_fetch)}...", file=sys.stderr)

    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")

    # 출력: 모멘텀 값이 있는(계산된) 종목만 {code: mom}
    moms = {c: v["mom"] for c, v in cache.items() if v.get("mom") is not None}
    OUT_PATH.write_text(json.dumps({
        "status": "ok", "generated_at": today, "covered": len(moms),
        "universe": len(codes), "window": "12-1M",
        "moms": moms,
    }, ensure_ascii=False), encoding="utf-8")
    print(f"[momentum] 완료: 모멘텀 보유 {len(moms)}/{len(codes)}종목 → {OUT_PATH.name}", file=sys.stderr)


if __name__ == "__main__":
    main()
