"""GitHub Actions 자동 파이프라인용 결정론적 채점기.

docs/reference/technical-weighting-framework.md, fundamental-weighting-framework.md의
공식을 코드로 그대로 구현한다. 대화형 Claude Code 에이전트(technical-analyst/fundamental-analyst)는
이 공식을 참고자료 삼아 LLM이 직접 판단하지만, 무인 자동화 파이프라인에는 LLM 호출이 없으므로
동일 공식을 스크립트로 고정 구현해 일관된 점수를 낸다. 두 값은 대체로 비슷한 방향을 가리키지만
LLM 쪽은 서술적 뉘앙스까지 반영하므로 완전히 같지는 않다 — 웹 대시보드에는 이 사실을 명시한다.
"""
from __future__ import annotations

import math

# ---------- 기술적분석 (technical-weighting-framework.md) ----------

TREND_WEIGHT, MOMENTUM_WEIGHT, VOLUME_WEIGHT, CANDLE_WEIGHT = 0.4, 0.3, 0.2, 0.1


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _trend_subscore(indicators: dict) -> float:
    ma = indicators["moving_averages"]
    score = {"bullish": 1.4, "bearish": -1.4, "mixed": 0.0, "insufficient_data": 0.0}[ma["alignment"]]

    cross = ma["ma5_ma20_cross_recent"]
    if cross.get("occurred") and cross.get("days_ago") is not None:
        w = 0.6 if cross["days_ago"] <= 5 else (0.3 if cross["days_ago"] <= 10 else 0.0)
        score += w if cross["direction"] == "golden" else -w

    macd = indicators["macd"]
    mcross = macd["signal_cross_recent"]
    if mcross.get("occurred") and mcross.get("days_ago") is not None:
        w = 0.4 if mcross["days_ago"] <= 5 else 0.2
        score += w if mcross["direction"] == "golden" else -w
    if macd.get("above_zero") is True:
        score += 0.2
    elif macd.get("above_zero") is False:
        score -= 0.2

    return _clamp(score, -2, 2)


def _momentum_subscore(indicators: dict) -> float:
    rsi = indicators["rsi14"]
    base = 0.0
    if rsi.get("latest") is not None:
        base = _clamp((rsi["latest"] - 50) / 25, -2, 2)
        if rsi.get("zone") == "overbought":
            base = min(base, 1.0)
        elif rsi.get("zone") == "oversold":
            base = max(base, -1.0)

    bb = indicators["bollinger"]
    bb_component = 0.0
    if bb.get("percent_b") is not None:
        bb_component = _clamp((bb["percent_b"] - 0.5) * 2, -1.5, 1.5)

    return _clamp(0.6 * base + 0.4 * bb_component, -2, 2)


def _volume_subscore(indicators: dict) -> float:
    vol = indicators["volume"]
    ratio = vol.get("ratio_to_avg20")
    if ratio is None:
        return 0.0
    candles = indicators["candles"]["recent"]
    direction = 1.0 if (candles and candles[-1]["bullish"]) else -1.0
    magnitude = _clamp(ratio - 1.0, -1.0, 3.0)
    score = _clamp(magnitude * direction, -2, 2)
    if ratio < 0.5:
        score *= 0.5
    return score


def _candle_subscore(indicators: dict) -> float:
    candles = indicators["candles"]["recent"]
    if not candles:
        return 0.0
    last = candles[-1]
    strong = {"장대양봉", "상승장악형"}
    weak = {"장대음봉", "하락장악형"}
    if any(p in strong for p in last["patterns"]):
        return 1.5
    if any(p in weak for p in last["patterns"]):
        return -1.5
    if "doji" in last["patterns"]:
        return 0.0
    return 0.3 if last["bullish"] else -0.3


def compute_technical_score(indicators: dict) -> dict:
    """technical-indicator-calculator의 compute() 출력을 그대로 입력받는다."""
    if indicators.get("status") != "ok":
        return {"score": None, "reason": indicators.get("reason", "지표 산출 불가")}

    trend = _trend_subscore(indicators)
    momentum = _momentum_subscore(indicators)
    volume_s = _volume_subscore(indicators)
    candle = _candle_subscore(indicators)

    if indicators["volume"].get("abnormally_low"):
        trend *= 0.7
        momentum *= 0.7

    weighted = TREND_WEIGHT * trend + MOMENTUM_WEIGHT * momentum + VOLUME_WEIGHT * volume_s + CANDLE_WEIGHT * candle
    raw = 3 + weighted
    score = round(_clamp(raw, 1, 5), 1)  # 소수점 첫째자리까지(정수 반올림 아님)

    return {
        "score": score,
        "category_subscores": {
            "trend": round(trend, 3),
            "momentum_volatility": round(momentum, 3),
            "volume": round(volume_s, 3),
            "candle": round(candle, 3),
        },
    }


# ---------- 기본적분석 (fundamental-weighting-framework.md) ----------

LOG_SCALE_K = 2.16
GROWTH_SECTORS = {"2차전지", "2차전지소재", "바이오", "인터넷"}
CAPITAL_INTENSIVE_SECTORS = {"반도체", "전자부품", "전자제품", "자동차", "자동차부품", "철강", "화학", "지주/상사"}

STABILITY_KEYS = ["debt_ratio", "current_ratio", "interest_coverage"]
GROWTH_KEYS = ["revenue_growth_yoy", "operating_income_growth_yoy", "net_income_growth_yoy"]
ACTIVITY_KEYS = ["asset_turnover", "receivables_turnover", "inventory_turnover"]


def _geometric_mean(values: list[float]) -> float | None:
    vals = [v for v in values if v is not None and v > 0]
    if not vals:
        return None
    return math.exp(sum(math.log(v) for v in vals) / len(vals))


def _category_score(ratios: dict, keys: list[str], sensitivity: float) -> float | None:
    # 개별 favorability를 [0.2,5] 밴드로 제한한 뒤 기하평균한다. 전년 매출이 0에 가까운 초소형주는
    # 매출성장률이 +23,900% 같은 허수로 튀고, favorability(target/peer)가 무계라 수백~수천 배가 되어
    # 지표 하나가 카테고리 점수를 5.0으로 독점해버린다(41종목이 이렇게 허위 5.0). 5배로 상한을 두면
    # 한 지표가 최대 log(5)만 기여해 이상값이 점수를 지배하지 못한다. 부호혼합 케이스는 이미 [0,2]라
    # 영향이 없고, 정상 비교(대개 5배 이내)도 그대로 유지된다. 밴드는 log 공간에서 1을 중심으로 대칭.
    raw = [ratios[k]["relative_favorability"] for k in keys if ratios.get(k)]
    values = [_clamp(v, 0.2, 5.0) for v in raw if v is not None]
    gm = _geometric_mean(values)
    if gm is None:
        return None
    ratio_for_log = max(gm, 0.05)
    score = 3 + sensitivity * LOG_SCALE_K * math.log(ratio_for_log)
    return round(_clamp(score, 1.0, 5.0), 1)


def sector_sensitivity(sector: str) -> dict:
    """업종 민감도. 예전엔 자본집약 섹터의 안정성·성장섹터의 성장성을 1.3배 가중했다. 그러나 이 sector
    라벨은 큐레이션된 워치리스트 120종목에만 있고(전종목은 DART 업종코드만 있는데, 지주회사 코드 64992
    하나가 7개 섹터로 갈리는 등 코드→섹터 매핑이 모호), 결과적으로 같은 업종이라도 워치리스트 종목만
    가중돼 '워치 vs 비워치'가 다르게 채점되는 불일치를 낳았다(44/3,900종목에만 적용).

    전종목 동일 채점(파리티)을 위해 1.0으로 통일한다 — 업종 정규화는 이미 '업종중앙값 대비' 비교가
    수행하므로 핵심(동종기업 기준 상대평가)은 그대로 보존된다. CAPITAL_INTENSIVE_SECTORS/GROWTH_SECTORS
    상수는 향후 업종코드 매핑이 정비되면 되살릴 수 있도록 정의만 남겨둔다."""
    return {"stability": 1.0, "growth": 1.0, "activity": 1.0}


def compute_fundamental_scores(ratios: dict, sector: str) -> dict:
    """financial-ratio-analyzer의 analyze() 출력을 그대로 입력받는다."""
    if ratios.get("status") != "ok":
        return {"stability": None, "growth": None, "activity": None, "reason": ratios.get("reason")}

    sens = sector_sensitivity(sector)
    basis = ratios.get("comparison_basis")
    if basis == "unavailable":
        return {"stability": None, "growth": None, "activity": None, "reason": "비교 표본 없음(unavailable)"}

    return {
        "stability": _category_score(ratios["stability"], STABILITY_KEYS, sens["stability"]),
        "growth": _category_score(ratios["growth"], GROWTH_KEYS, sens["growth"]),
        "activity": _category_score(ratios["activity"], ACTIVITY_KEYS, sens["activity"]),
        "sensitivity_applied": sens,
        "comparison_basis": basis,
    }


# ---------- 주목종목 순위 (자동화 파이프라인용 B5 대체 — 규칙기반) ----------
# 대화형 에이전트(market-scanner)는 이 데이터를 LLM이 직접 종합판단하지만, 자동화 파이프라인에는
# LLM이 없으므로 신호별 기여도를 고정 공식으로 합산한다. reason은 서술이 아니라 템플릿 조합이다 —
# 프론트엔드에 "자동 생성된 요약"임을 명시해야 한다.

TOP_N_ATTENTION = 15


def _news_component(news: dict) -> float:
    if not news or news.get("recent_count") is None:
        return 0.0
    recent, prior = news["recent_count"], news.get("prior_count", 0)
    if prior == 0:
        return 2.5 if recent >= 3 else (1.0 if recent > 0 else 0.0)
    ratio = recent / prior
    return _clamp(ratio, 0, 5) / 5 * 2.5


def _search_component(search: dict) -> float:
    if not search or not search.get("available"):
        return 0.0
    sr = search.get("surge_ratio")
    if sr == "new_spike":
        return 3.0
    if isinstance(sr, (int, float)):
        return _clamp(sr, 0, 8) / 8 * 3.0
    return 0.0


def _disclosure_component(disclosures: dict) -> float:
    if not disclosures or not disclosures.get("available"):
        return 0.0
    return _clamp(disclosures.get("recent_count", 0), 0, 3) / 3 * 1.5


def _build_evidence_and_reason(candidate: dict, signals: dict) -> tuple[list[str], str]:
    evidence = []
    has_stat = abs(candidate.get("volume_zscore") or 0) >= 1.5 or abs(candidate.get("change_zscore") or 0) >= 1.5
    if candidate.get("volume_zscore") is not None:
        evidence.append(f"거래량 Z-score {candidate['volume_zscore']}")
    if candidate.get("change_zscore") is not None:
        evidence.append(f"등락률 Z-score {candidate['change_zscore']} (오늘 {candidate.get('today_change_pct')}%)")

    search = signals.get("search_trend", {})
    has_search = False
    if search.get("available"):
        sr = search.get("surge_ratio")
        if sr == "new_spike":
            evidence.append("검색량 신규 급등(직전 기간 거의 없다가 발생)")
            has_search = True
        elif isinstance(sr, (int, float)) and sr >= 1.5:
            evidence.append(f"검색량 최근7일/이전7일 비율 {round(sr, 1)}배")
            has_search = True

    news = signals.get("news", {})
    has_news = False
    if news.get("recent_count") is not None and news["recent_count"] > 0:
        evidence.append(f"뉴스 언급 최근7일 {news['recent_count']}건 (이전 {news.get('prior_count', 0)}건)")
        has_news = news["recent_count"] >= 3

    disc = signals.get("disclosures", {})
    has_disc = False
    if disc.get("available") and disc.get("recent_count", 0) > 0:
        titles = ", ".join(disc.get("recent_titles", [])[:2])
        evidence.append(f"최근 7일 공시 {disc['recent_count']}건 ({titles})")
        has_disc = True

    corroborated = has_search or has_news or has_disc
    if has_stat and corroborated:
        reason = "시세 이상탐지 신호와 검색량/뉴스/공시 근거가 함께 확인되어 주목도가 높습니다."
    elif has_stat and not corroborated:
        reason = "거래량/등락률이 평소 대비 이상 수준이지만, 검색량·뉴스·공시로는 뚜렷한 사유가 확인되지 않았습니다."
    else:
        reason = "시세 이상탐지 신호는 약하지만 검색량 또는 뉴스 언급이 뚜렷하게 증가했습니다."
    return evidence, reason


def _score_all_candidates(candidates: list[dict], signals_by_code: dict[str, dict]) -> list[dict]:
    """후보 전체(30~50개)를 채점한다 — 상위 N 컷은 호출부에서 기준별로 따로 한다."""
    scored = []
    for cand in candidates:
        code = cand["code"]
        signals = signals_by_code.get(code, {})
        stat = _clamp(cand.get("score", 0), 0, 10) / 10 * 4
        search = _search_component(signals.get("search_trend", {}))
        news = _news_component(signals.get("news", {}))
        disclosure = _disclosure_component(signals.get("disclosures", {}))
        evidence, reason = _build_evidence_and_reason(cand, signals)
        scored.append(
            {
                "code": code,
                "name": cand.get("name") or signals.get("name"),
                "composite_score": round(stat + search + news + disclosure, 2),
                "stat_component": round(stat, 2),
                "search_component": round(search, 2),
                "news_component": round(news, 2),
                "disclosure_component": round(disclosure, 2),
                "reason": reason,
                "evidence": evidence,
                "today_change_pct": cand.get("today_change_pct"),
                "today_close": cand.get("today_close"),
            }
        )
    return scored


def _rank(scored: list[dict], key: str) -> list[dict]:
    ranked = sorted((r for r in scored if r[key] > 0), key=lambda r: r[key], reverse=True)[:TOP_N_ATTENTION]
    for i, row in enumerate(ranked, start=1):
        row = dict(row)
        row["rank"] = i
        ranked[i - 1] = row
    return ranked


def build_attention_rankings(candidates: list[dict], signals_by_code: dict[str, dict]) -> dict:
    """설계서 B5의 규칙기반 대체 — 여러 기준별 순위를 한 번에 만든다(추가 API 호출 없음, 이미
    수집된 30~50개 후보 신호를 기준만 바꿔 재정렬).
    """
    scored = _score_all_candidates(candidates, signals_by_code)
    return {
        "overall": _rank(scored, "composite_score"),
        "by_search": _rank(scored, "search_component"),
    }
