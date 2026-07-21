#!/usr/bin/env python3
"""서브에이전트가 만든 구조화 JSON을 최종 Markdown 리포트로 렌더링한다.

disclaimer는 이 스크립트가 docs/reference/disclaimer-template.md에서 읽어 '항상' 덧붙인다 —
LLM이 빠뜨릴 수 없도록 렌더링 단계에서 강제한다 (설계서 C5). review_flag(A9, 5점/1점 등
극단값 재검토 권장)도 입력값과 무관하게 점수를 다시 확인해 스크립트가 최종 결정한다.

사용법:
    python3 format_report.py --type stock --data output/cache/005930_report_input.json \
        --out output/reports/005930_report_20260721.md
    python3 format_report.py --type attention --data output/cache/attention_report_input.json \
        --out output/reports/attention_report_20260721.md
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from common.config import REFERENCE_DIR  # noqa: E402

TECH_EXTREME = {1, 5}
FUND_EXTREME_LOW, FUND_EXTREME_HIGH = 1.5, 4.5


def _load_disclaimer() -> str:
    path = REFERENCE_DIR / "disclaimer-template.md"
    text = path.read_text(encoding="utf-8")
    marker = "\n---\n"
    idx = text.find(marker)
    return text[idx + len(marker) :].strip() if idx != -1 else text.strip()


def _table(headers: list[str], rows: list[list[str]]) -> str:
    if not rows:
        return "_해당 데이터 없음_\n"
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for row in rows:
        lines.append("| " + " | ".join(str(c) if c is not None else "-" for c in row) + " |")
    return "\n".join(lines) + "\n"


def _tech_label(score) -> str:
    if score is None:
        return "산출불가"
    if score >= 4:
        return "매수"
    if score <= 2:
        return "매도"
    return "중립"


def _compute_review_flag(data: dict) -> tuple[bool, list[str]]:
    reasons = list(data.get("review_flag_reasons") or ([data["review_flag_reason"]] if data.get("review_flag_reason") else []))
    technical_score = (data.get("technical") or {}).get("score")
    if technical_score in TECH_EXTREME:
        reasons.append(f"기술적분석 점수가 극단값({technical_score}점)")
    fundamental = data.get("fundamental") or {}
    for label, key in (("안정성", "stability_score"), ("성장성", "growth_score"), ("활동성", "activity_score")):
        v = fundamental.get(key)
        if v is not None and (v <= FUND_EXTREME_LOW or v >= FUND_EXTREME_HIGH):
            reasons.append(f"기본적분석 {label} 점수가 극단값({v}점)")
    return (len(reasons) > 0, reasons)


def render_stock_report(data: dict) -> str:
    code, name = data.get("code", "?"), data.get("name", "?")
    technical = data.get("technical") or {}
    fundamental = data.get("fundamental") or {}
    review_flag, review_reasons = _compute_review_flag(data)

    lines = [
        f"# {name}({code}) 투자분석 리포트",
        "",
        f"**기준일**: {data.get('as_of', '알수없음')}  ·  **생성일시**: {dt.datetime.now().strftime('%Y-%m-%d %H:%M')}",
        "",
        "## 종합의견",
        "",
        f"- **기술적분석**: {technical.get('score', '산출불가')}점 / 5점 ({_tech_label(technical.get('score'))})",
        f"- **기본적분석** (비교기준: {fundamental.get('comparison_basis', '알수없음')}): "
        f"안정성 {fundamental.get('stability_score', '산출불가')}점 · "
        f"성장성 {fundamental.get('growth_score', '산출불가')}점 · "
        f"활동성 {fundamental.get('activity_score', '산출불가')}점",
        "",
        data.get("overall_opinion", "_종합의견 없음_"),
        "",
    ]

    if review_flag:
        lines += ["> ⚠️ **재검토 권장**: " + "; ".join(review_reasons), ""]

    lines += ["## 기술적분석 상세", "", technical.get("summary", "_상세 서술 없음_"), ""]
    signals = technical.get("signals") or []
    lines.append(_table(["지표", "판단", "기여도"], [[s.get("indicator"), s.get("finding"), s.get("contribution")] for s in signals]))
    if technical.get("data_warnings"):
        lines += ["", "**데이터 주의사항**: " + "; ".join(technical["data_warnings"])]

    lines += ["", "## 기본적분석 상세", "", fundamental.get("summary", "_상세 서술 없음_"), ""]
    if fundamental.get("peer_list"):
        peers = ", ".join(p.get("corp_name", p.get("stock_code", "?")) for p in fundamental["peer_list"])
        lines += [f"**비교 대상**: {peers}", ""]
    fsignals = fundamental.get("signals") or []
    lines.append(_table(["카테고리", "지표", "종목값", "산업평균", "상대위치"], [
        [s.get("category"), s.get("indicator"), s.get("target_value"), s.get("peer_average"), s.get("relative_note")] for s in fsignals
    ]))
    if fundamental.get("data_warnings"):
        lines += ["", "**데이터 주의사항**: " + "; ".join(fundamental["data_warnings"])]

    lines += ["", "## Disclaimer", "", _load_disclaimer(), ""]
    return "\n".join(lines)


def render_attention_report(data: dict) -> str:
    scan_date = data.get("scan_date", "알수없음")
    ranked = data.get("ranked_stocks") or []

    lines = [
        f"# 주목종목 스캔 리포트 ({scan_date})",
        "",
        f"**스캔범위**: {data.get('scope', 'ALL')}  ·  "
        f"**1차 스크리닝 통과**: {data.get('screened_candidate_count', '?')}개  ·  "
        f"**최종 선정**: {len(ranked)}개",
        "",
        f"**생성일시**: {dt.datetime.now().strftime('%Y-%m-%d %H:%M')}",
        "",
    ]
    if data.get("market_note"):
        lines += [data["market_note"], ""]

    if not ranked:
        lines += ["오늘은 통계적으로 뚜렷하게 주목할 만한 종목이 확인되지 않았습니다.", ""]
    else:
        lines.append("## 순위")
        for item in ranked:
            lines += [
                "",
                f"### {item.get('rank', '?')}. {item.get('name', '?')}({item.get('code', '?')})",
                "",
                item.get("reason", "_사유 없음_"),
                "",
                "**근거 데이터**:",
            ]
            for ev in item.get("evidence") or []:
                lines.append(f"- {ev}")

    lines += ["", "## Disclaimer", "", _load_disclaimer(), ""]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--type", required=True, choices=["stock", "attention"])
    parser.add_argument("--data", required=True, help="서브에이전트가 만든 구조화 JSON 경로")
    parser.add_argument("--out", required=True, help="최종 Markdown 저장 경로")
    args = parser.parse_args()

    data = json.loads(Path(args.data).read_text(encoding="utf-8"))
    markdown = render_stock_report(data) if args.type == "stock" else render_attention_report(data)

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(markdown, encoding="utf-8")
    print(json.dumps({"status": "ok", "out": args.out, "chars": len(markdown)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
