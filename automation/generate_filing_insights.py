#!/usr/bin/env python3
"""DART 사업보고서를 LLM(gpt-4o-mini)이 읽어 '가이던스·경영진 톤·회계 레드플래그'를 추출한다
→ web/data/filing_insights.json. "남들보다 빨리·넓게 공시를 읽는" 정성 엣지.

비용 통제: ①우선 유니버스(워치리스트+팩터TOP)만 ②rcept_no로 캐시(같은 보고서 재호출 안 함 →
새 공시 나올 때만 LLM) ③실행당 LLM 상한(MAX_LLM). OpenAI 호출은 Worker(/, gpt-4o-mini)를 경유해
Cloudflare AI Gateway+$5 지출한도 안에서 처리한다. 로컬엔 DART키가 없어 CI에서 동작(방어적 코드).
"""
from __future__ import annotations

import io
import json
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

import requests

import _skill_imports  # noqa: F401
from common import dart_client
from common.config import DART_API_KEY, has_dart_key
from watchlist import WATCHLIST

ROOT = Path(__file__).resolve().parents[1]
FACTOR_PATH = ROOT / "web" / "data" / "factor_ranking.json"
CACHE_PATH = ROOT / "output" / "cache" / "raw" / "_filing_insights_cache.json"  # actions/cache 보존
OUT_PATH = ROOT / "web" / "data" / "filing_insights.json"

MAX_LLM = 40          # 실행당 LLM 호출 상한(비용 캡). 캐시 덕에 초기 워밍 뒤 거의 0
MAX_CHARS = 28000     # LLM에 보낼 공시 텍스트 상한(≈14k토큰)
_WORKER = "https://korea-stock-agent-gpt-proxy.dkdla00.workers.dev"
_ORIGIN = "https://dongyoungkim1999.github.io"
_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

_PROMPT = (
    "아래 텍스트는 한국 상장사 사업보고서(정기공시) 본문 발췌다. 투자자 관점에서 아래 3가지를 각각 "
    "1~2문장으로, 반드시 JSON으로만 답하라(코드펜스·설명 금지). "
    '{"guidance":"실적·향후계획 가이던스 핵심","tone":"경영진 톤을 자신감/중립/신중/우려 중 하나로 시작+근거",'
    '"redflags":"회계·소송·특수관계자·계속기업 등 주의신호(없으면 \'특이사항 없음\')"}'
)


def _load(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return default


def _priority_codes() -> list[str]:
    """우선 대상: 워치리스트 + 팩터 종합 TOP. 중복 제거."""
    codes = [w["code"] for w in WATCHLIST]
    fr = _load(FACTOR_PATH, {})
    if fr.get("status") == "ok":
        codes += [t["code"] for t in fr.get("top", [])]
    seen, out = set(), []
    for c in codes:
        if c not in seen:
            seen.add(c); out.append(c)
    return out


def _latest_report(corp_code: str) -> dict | None:
    """최근 정기공시(사업/반기/분기보고서) 1건의 rcept_no·보고서명·접수일. 없으면 None."""
    import datetime as dt
    end = dt.date.today()
    bgn = end - dt.timedelta(days=200)
    try:
        rows = dart_client.list_disclosures(corp_code, bgn.strftime("%Y%m%d"), end.strftime("%Y%m%d"))
    except Exception:
        return None
    for r in rows:  # 최신순
        nm = r.get("report_nm") or ""
        if any(k in nm for k in ("사업보고서", "분기보고서", "반기보고서")):
            return {"rcept_no": r.get("rcept_no"), "report_nm": nm.strip(), "rcept_dt": r.get("rcept_dt")}
    return None


def _fetch_document_text(rcept_no: str) -> str | None:
    """DART document.xml(ZIP) → 가장 큰 XML의 태그 제거 텍스트. 경영진단/사업의 내용 근처 우선."""
    try:
        resp = requests.get(
            "https://opendart.fss.or.kr/api/document.xml",
            params={"crtfc_key": DART_API_KEY, "rcept_no": rcept_no}, timeout=30,
        )
        resp.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            names = [n for n in zf.namelist() if n.lower().endswith(".xml")]
            if not names:
                return None
            raw = max((zf.read(n) for n in names), key=len)  # 가장 큰 XML(본문)
    except Exception:
        return None
    try:
        text = raw.decode("utf-8", errors="ignore")
    except Exception:
        return None
    text = re.sub(r"<[^>]+>", " ", text)          # 태그 제거
    text = re.sub(r"&[a-zA-Z#0-9]+;", " ", text)   # 엔티티 제거
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) < 500:
        return None
    # 경영진단/사업의 내용 섹션 근처를 우선 발췌(없으면 앞부분)
    m = re.search(r"(이사의 경영진단|경영진단 및 분석|사업의 내용|사업의개요)", text)
    start = max(0, m.start() - 500) if m else 0
    return text[start:start + MAX_CHARS]


def _llm_insight(text: str) -> dict | None:
    """Worker(gpt-4o-mini)로 공시 인사이트 추출. JSON 파싱 실패 시 None."""
    try:
        req = urllib.request.Request(
            _WORKER + "/analyze", method="POST",
            headers={"Content-Type": "application/json", "Origin": _ORIGIN, "User-Agent": _UA},
            data=json.dumps({"instruction": _PROMPT, "text": text}).encode("utf-8"),
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            reply = (json.load(r) or {}).get("reply") or ""
    except Exception:
        return None
    mjson = re.search(r"\{.*\}", reply, re.S)
    if not mjson:
        return None
    try:
        d = json.loads(mjson.group(0))
    except Exception:
        return None
    return {k: (str(d.get(k) or "")).strip()[:400] for k in ("guidance", "tone", "redflags")}


def main() -> None:
    if not has_dart_key():
        print("[filing] DART 키 없음 — 스킵", file=sys.stderr)
        return
    cache = _load(CACHE_PATH, {})
    codes = _priority_codes()
    out = {}
    llm_calls = 0
    for code in codes:
        corp = dart_client.find_corp_by_stock_code(code)
        if not corp:
            continue
        rep = _latest_report(corp["corp_code"])
        if not rep or not rep.get("rcept_no"):
            continue
        cached = cache.get(code)
        if cached and cached.get("rcept_no") == rep["rcept_no"] and cached.get("insight"):
            out[code] = {**cached["insight"], "report_nm": rep["report_nm"], "rcept_dt": rep.get("rcept_dt")}
            continue  # 같은 보고서 → 캐시 재사용(LLM 호출 없음)
        if llm_calls >= MAX_LLM:
            continue  # 실행당 상한 도달 — 다음 실행에서 이어서 워밍
        text = _fetch_document_text(rep["rcept_no"])
        if not text:
            continue
        insight = _llm_insight(text)
        llm_calls += 1
        if not insight:
            continue
        cache[code] = {"rcept_no": rep["rcept_no"], "insight": insight}
        out[code] = {**insight, "report_nm": rep["report_nm"], "rcept_dt": rep.get("rcept_dt")}

    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    OUT_PATH.write_text(json.dumps({
        "status": "ok", "count": len(out), "llm_calls_this_run": llm_calls, "insights": out,
    }, ensure_ascii=False), encoding="utf-8")
    print(f"[filing] 완료: 인사이트 {len(out)}종목 (이번 LLM {llm_calls}회) → {OUT_PATH.name}", file=sys.stderr)


if __name__ == "__main__":
    main()
