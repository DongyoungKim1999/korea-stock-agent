#!/usr/bin/env python3
"""애널리스트 컨센서스(목표주가·추정EPS·투자의견)를 주기적으로 스냅샷해 '추정치 리비전'을 추적한다.
→ web/data/estimate_revisions.json.

리비전(추정치 변화)은 단기 주가에 가장 강건하게 작동하는 신호 중 하나다 — 애널리스트가 목표가를
올리는(상향) 종목은 그 뒤로도 초과수익을 내는 경향(estimate revision momentum). 단, 이 신호는
'시간에 걸친 변화'라 스냅샷을 며칠~몇 주 쌓아야 발현된다. 그래서 지금은 '인프라를 깔아 누적을 시작'
하는 게 목적이다.

컨센서스는 Worker /quote(네이버 프록시)에서 받는다. 모멘텀과 같은 점진 워밍(영구캐시+주기 스냅샷+
실행당 상한)으로 파이프라인 런타임을 통제한다. 종목별 최근 스냅샷 여러 개를 보관하고, 최신 vs 가장
오래된(기간 내) 값으로 리비전을 산출한다.
"""
from __future__ import annotations

import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime
from pathlib import Path

import _skill_imports  # noqa: F401

ROOT = Path(__file__).resolve().parents[1]
COMPANY_INDEX = ROOT / "web" / "data" / "company_index.json"
HIST_PATH = ROOT / "output" / "cache" / "raw" / "_estimate_history.json"  # actions/cache로 영구보존
OUT_PATH = ROOT / "web" / "data" / "estimate_revisions.json"

SNAPSHOT_DAYS = 3     # 종목별 이 간격으로만 스냅샷(컨센서스는 느리게 변함)
MAX_SNAPSHOT = 800    # 실행당 상한(런타임 캡)
KEEP = 12             # 종목당 보관 스냅샷 수
WORKERS = 8
_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
_WORKER = "https://korea-stock-agent-gpt-proxy.dkdla00.workers.dev"


def _fetch_consensus(code: str) -> dict | None:
    """Worker /quote에서 컨센서스 필드만. 목표가/투자의견 없으면 None(컨센서스 미보유 종목)."""
    req = urllib.request.Request(f"{_WORKER}/quote?code={code}", headers={"User-Agent": _UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            q = json.load(r)
    except Exception:
        return None
    tgt = q.get("target_price")
    rec = q.get("recomm_mean")
    if tgt is None and rec is None:
        return {"_no_consensus": True}  # 컨센서스 없음(스킵 표시)
    eps = q.get("cns_eps")
    try:
        eps = float(str(eps).replace(",", "")) if eps not in (None, "") else None
    except Exception:
        eps = None
    return {"tgt": tgt, "rec": rec, "eps": eps}


def _load_json(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def _days_since(iso: str, today: str) -> int:
    try:
        return (date.fromisoformat(today) - date.fromisoformat(iso)).days
    except Exception:
        return 999


def _pct(new, old):
    if new is None or old in (None, 0):
        return None
    return round((new / old - 1) * 100, 1)


def _revision(snaps: list[dict], today: str) -> dict | None:
    """종목 스냅샷들로 리비전 산출. 최신 vs (기간 내) 가장 오래된 스냅샷 비교. 스냅샷 2개 미만이면 None."""
    valid = [s for s in snaps if s.get("d")]
    if len(valid) < 2:
        return None
    valid.sort(key=lambda s: s["d"])
    latest, oldest = valid[-1], valid[0]
    span = _days_since(oldest["d"], latest["d"])
    if span < 1:
        return None
    return {
        "target_rev_pct": _pct(latest.get("tgt"), oldest.get("tgt")),
        "eps_rev_pct": _pct(latest.get("eps"), oldest.get("eps")),
        "recomm_change": round(latest["rec"] - oldest["rec"], 2) if (latest.get("rec") is not None and oldest.get("rec") is not None) else None,
        "latest_target": latest.get("tgt"),
        "latest_recomm": latest.get("rec"),
        "n": len(valid), "span_days": span,
        "first_date": oldest["d"], "last_date": latest["d"],
    }


def main() -> None:
    idx = _load_json(COMPANY_INDEX, {})
    codes = [c["code"] for c in idx.get("companies", [])] if idx.get("status") == "ok" else []
    if not codes:
        OUT_PATH.write_text(json.dumps({"status": "error", "reason": "no universe"}, ensure_ascii=False), encoding="utf-8")
        return

    hist = _load_json(HIST_PATH, {})   # {code: {"snaps":[...], "no_consensus": bool, "last": date}}
    today = date.today().isoformat()

    # 스냅샷 대상: 기록 없거나 SNAPSHOT_DAYS 경과. 컨센서스 없는 종목은 30일간 스킵(헛조회 방지).
    def stale(c):
        e = hist.get(c)
        if not e:
            return True
        if e.get("no_consensus") and _days_since(e.get("last", "2000-01-01"), today) < 30:
            return False
        return _days_since(e.get("last", "2000-01-01"), today) >= SNAPSHOT_DAYS

    todo = [c for c in codes if stale(c)][:MAX_SNAPSHOT]
    print(f"[revisions] 유니버스 {len(codes)} · 이번 스냅샷 {len(todo)}", file=sys.stderr)

    def work(c):
        return c, _fetch_consensus(c)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        for fut in as_completed({ex.submit(work, c): c for c in todo}):
            c, cons = fut.result()
            e = hist.setdefault(c, {"snaps": []})
            e["last"] = today
            if cons is None:
                continue  # 네트워크 실패 — 기록 안 함(다음 실행 재시도)
            if cons.get("_no_consensus"):
                e["no_consensus"] = True
                continue
            e["no_consensus"] = False
            snaps = e.setdefault("snaps", [])
            # 같은 날 중복 스냅샷은 갱신
            snaps = [s for s in snaps if s.get("d") != today]
            snaps.append({"d": today, "tgt": cons["tgt"], "rec": cons["rec"], "eps": cons["eps"]})
            e["snaps"] = snaps[-KEEP:]

    HIST_PATH.parent.mkdir(parents=True, exist_ok=True)
    HIST_PATH.write_text(json.dumps(hist, ensure_ascii=False), encoding="utf-8")

    # 리비전 산출(스냅샷 2개 이상인 종목만)
    revs = {}
    for c, e in hist.items():
        r = _revision(e.get("snaps", []), today)
        if r:
            revs[c] = r
    OUT_PATH.write_text(json.dumps({
        "status": "ok", "generated_at": today,
        "tracked": sum(1 for e in hist.values() if e.get("snaps")),
        "with_revision": len(revs),
        "revisions": revs,
    }, ensure_ascii=False), encoding="utf-8")
    print(f"[revisions] 완료: 추적 {sum(1 for e in hist.values() if e.get('snaps'))}종목 · 리비전 산출 {len(revs)} → {OUT_PATH.name}", file=sys.stderr)


if __name__ == "__main__":
    main()
