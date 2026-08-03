#!/usr/bin/env python3
"""price-data-fetcher의 개별종목 JSON을 입력받아 기술지표 원자료(raw values)를 계산한다.

점수(1~5)는 계산하지 않는다 — 그것은 technical-analyst(LLM)의 몫이다(설계서 A3=스크립트/A4=LLM 분리).
이 스크립트는 수치와, 규칙으로 명확히 판별 가능한 보조 신호(골든크로스 발생 여부 등)까지만 산출한다.

사용법:
    python3 compute_indicators.py --in output/cache/raw/005930_price.json --out output/cache/raw/005930_indicators.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

MA_PERIODS = (5, 20, 60, 120)
RSI_PERIOD = 14
BB_PERIOD = 2  # placeholder, overwritten below (kept explicit for readability of constants)
BB_WINDOW = 20
BB_STD_MULT = 2
VOL_WINDOW = 20
LOW_VOLUME_RATIO = 0.3  # 거래량이 20일 평균의 30% 미만이면 '비정상적으로 낮음'으로 표시 (설계서 §2.2 참고박스)


def _none_if_nan(value) -> float | None:
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return None if (np.isnan(f) or np.isinf(f)) else round(f, 4)


def _tail_series(series: pd.Series, dates: pd.Series, n: int = 10) -> list[dict]:
    out = []
    for date, value in zip(dates.tail(n), series.tail(n)):
        out.append({"date": date, "value": _none_if_nan(value)})
    return out


def _compute_stochastic(high: pd.Series, low: pd.Series, close: pd.Series, k_period: int = 14, d_period: int = 3, slow_period: int = 3) -> tuple[pd.Series, pd.Series]:
    """스토캐스틱(14,3,3) — 참고 표시용 보조지표. 가중치 프레임의 점수 산출식에는 포함되지 않는다."""
    lowest_low = low.rolling(k_period).min()
    highest_high = high.rolling(k_period).max()
    fast_k = 100 * (close - lowest_low) / (highest_high - lowest_low).replace(0, np.nan)
    slow_k = fast_k.rolling(d_period).mean()
    slow_d = slow_k.rolling(slow_period).mean()
    return slow_k, slow_d


def _compute_rsi(close: pd.Series, period: int = RSI_PERIOD) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    rsi = rsi.where(avg_loss != 0, 100.0)  # 손실이 전혀 없으면 RSI=100
    return rsi


def _detect_recent_cross(fast: pd.Series, slow: pd.Series, lookback: int = 10) -> dict:
    diff = (fast - slow).dropna()
    if len(diff) < 2:
        return {"occurred": False, "days_ago": None, "direction": None}
    recent = diff.tail(lookback + 1)
    sign = np.sign(recent)
    for i in range(len(sign) - 1, 0, -1):
        if sign.iloc[i - 1] < 0 and sign.iloc[i] > 0:
            return {"occurred": True, "days_ago": len(sign) - 1 - i, "direction": "golden"}
        if sign.iloc[i - 1] > 0 and sign.iloc[i] < 0:
            return {"occurred": True, "days_ago": len(sign) - 1 - i, "direction": "dead"}
    return {"occurred": False, "days_ago": None, "direction": None}


def _ma_alignment(latest_ma: dict[int, float | None]) -> str:
    values = [latest_ma[p] for p in MA_PERIODS if latest_ma.get(p) is not None]
    if len(values) < 3:
        return "insufficient_data"
    if all(values[i] > values[i + 1] for i in range(len(values) - 1)):
        return "bullish"  # 정배열: 단기선이 장기선 위 (5>20>60>120)
    if all(values[i] < values[i + 1] for i in range(len(values) - 1)):
        return "bearish"  # 역배열
    return "mixed"


def _classify_candles(df: pd.DataFrame, n: int = 3) -> list[dict]:
    results = []
    tail = df.tail(n + 1)  # 장악형 판단을 위해 하루 더 확보
    rows = list(tail.itertuples())
    for i in range(1, len(rows)):
        cur, prev = rows[i], rows[i - 1]
        body = abs(cur.close - cur.open)
        rng = max(cur.high - cur.low, 1e-9)
        bullish = cur.close > cur.open
        patterns = []
        if body <= rng * 0.1:
            patterns.append("doji")
        elif body >= rng * 0.7:
            patterns.append("장대양봉" if bullish else "장대음봉")
        prev_body_low, prev_body_high = min(prev.open, prev.close), max(prev.open, prev.close)
        cur_body_low, cur_body_high = min(cur.open, cur.close), max(cur.open, cur.close)
        if cur_body_low <= prev_body_low and cur_body_high >= prev_body_high and body > abs(prev.close - prev.open):
            if bullish and prev.close < prev.open:
                patterns.append("상승장악형")
            elif not bullish and prev.close > prev.open:
                patterns.append("하락장악형")
        results.append(
            {
                "date": cur.date,
                "bullish": bool(bullish),
                "body_to_range_ratio": round(body / rng, 3),
                "patterns": patterns,
            }
        )
    return results[-n:]


TRADING_DAYS_YEAR = 252
WEEK52_WINDOW = 250  # 약 1년 거래일 (52주 고저 산출용)


def _compute_risk(df: pd.DataFrame) -> dict:
    """가격 시계열만으로 산출하는 리스크 지표 — 리스크 관리의 표준 척도들.

    - 연율화 변동성: 일간수익률 표준편차 × √252 (연간 기준으로 환산한 가격 출렁임 폭)
    - 최대낙폭(MDD): 확보 구간 내 고점 대비 최대 하락률 — '물렸을 때 최악'을 정량화
    - 52주 고저 위치: 현재가가 최근 1년 밴드 어디에 있는지(0=연저점, 100=연고점)
    이 값들은 raw 수치일 뿐 점수화하지 않는다(해석은 LLM/결정론적 채점의 몫).
    """
    close = df["close"]
    n = len(close)
    daily_ret = close.pct_change().dropna()

    annualized_vol = None
    if len(daily_ret) >= 20:
        annualized_vol = _none_if_nan(daily_ret.std(ddof=0) * np.sqrt(TRADING_DAYS_YEAR) * 100)

    # 최대낙폭: 확보한 전체 구간(최대 ~300일) 기준
    running_max = close.cummax()
    drawdown = close / running_max - 1.0
    max_drawdown = _none_if_nan(drawdown.min() * 100) if n >= 2 else None

    # 52주(최근 250거래일) 고저 및 현재가 위치
    window = close.tail(WEEK52_WINDOW)
    hi, lo, last = window.max(), window.min(), close.iloc[-1]
    week52_high = _none_if_nan(hi)
    week52_low = _none_if_nan(lo)
    position_pct = _none_if_nan((last - lo) / (hi - lo) * 100) if hi > lo else None

    # 확보 구간 기준 누적수익률(참고용, 정확한 1년 아님 — 확보일수 함께 표기)
    period_return = _none_if_nan((last / close.iloc[0] - 1) * 100) if n >= 2 and close.iloc[0] else None

    return {
        "annualized_volatility_pct": annualized_vol,
        "max_drawdown_pct": max_drawdown,
        "week52_high": week52_high,
        "week52_low": week52_low,
        "week52_position_pct": position_pct,
        "period_return_pct": period_return,
        "period_trading_days": int(n),
    }


def compute(payload: dict) -> dict:
    rows = payload.get("rows", [])
    if len(rows) < 20:
        return {
            "status": "insufficient_data",
            "code": payload.get("code"),
            "reason": f"지표 계산에 최소 20거래일 필요, {len(rows)}거래일 확보",
        }

    df = pd.DataFrame(rows)
    df["date"] = df["date"].astype(str)
    for col in ("open", "high", "low", "close", "volume"):
        df[col] = pd.to_numeric(df[col])

    close = df["close"]
    warnings = []

    ma_series = {p: close.rolling(p).mean() for p in MA_PERIODS}
    latest_ma = {p: _none_if_nan(ma_series[p].iloc[-1]) for p in MA_PERIODS}
    for p in MA_PERIODS:
        if latest_ma[p] is None:
            warnings.append(f"MA{p} 계산 불가 (데이터 {len(df)}일 < {p}일)")

    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    macd_line = ema12 - ema26
    signal_line = macd_line.ewm(span=9, adjust=False).mean()
    histogram = macd_line - signal_line
    macd_cross = _detect_recent_cross(macd_line, signal_line, lookback=10)

    stoch_k, stoch_d = _compute_stochastic(df["high"], df["low"], close)

    rsi = _compute_rsi(close)
    rsi_latest = _none_if_nan(rsi.iloc[-1])
    rsi_zone = None
    if rsi_latest is not None:
        rsi_zone = "overbought" if rsi_latest >= 70 else "oversold" if rsi_latest <= 30 else "neutral"

    mid = ma_series[20]
    std20 = close.rolling(BB_WINDOW).std(ddof=0)
    upper = mid + BB_STD_MULT * std20
    lower = mid - BB_STD_MULT * std20
    percent_b = (close - lower) / (upper - lower).replace(0, np.nan)
    bandwidth = (upper - lower) / mid.replace(0, np.nan)

    vol = df["volume"]
    vol_ma20 = vol.rolling(VOL_WINDOW).mean()
    vol_ratio = _none_if_nan(vol.iloc[-1] / vol_ma20.iloc[-1]) if vol_ma20.iloc[-1] and vol_ma20.iloc[-1] == vol_ma20.iloc[-1] else None
    abnormally_low_volume = bool(vol_ratio is not None and vol_ratio < LOW_VOLUME_RATIO)

    dates = df["date"]

    result = {
        "status": "ok",
        "code": payload.get("code"),
        "as_of": payload.get("as_of"),
        "latest_close": _none_if_nan(close.iloc[-1]),
        "moving_averages": {
            f"ma{p}": {"latest": latest_ma[p], "tail10": _tail_series(ma_series[p], dates)} for p in MA_PERIODS
        }
        | {
            "alignment": _ma_alignment(latest_ma),
            "ma5_ma20_cross_recent": _detect_recent_cross(ma_series[5], ma_series[20], lookback=10),
        },
        "macd": {
            "macd_latest": _none_if_nan(macd_line.iloc[-1]),
            "signal_latest": _none_if_nan(signal_line.iloc[-1]),
            "histogram_latest": _none_if_nan(histogram.iloc[-1]),
            "histogram_tail10": _tail_series(histogram, dates),
            "signal_cross_recent": macd_cross,
            "above_zero": bool(macd_line.iloc[-1] > 0) if macd_line.iloc[-1] == macd_line.iloc[-1] else None,
        },
        "rsi14": {"latest": rsi_latest, "zone": rsi_zone, "tail10": _tail_series(rsi, dates)},
        "stochastic": {
            "k_latest": _none_if_nan(stoch_k.iloc[-1]),
            "d_latest": _none_if_nan(stoch_d.iloc[-1]),
            "tail10": _tail_series(stoch_k, dates),
        },
        "bollinger": {
            "upper": _none_if_nan(upper.iloc[-1]),
            "mid": _none_if_nan(mid.iloc[-1]),
            "lower": _none_if_nan(lower.iloc[-1]),
            "percent_b": _none_if_nan(percent_b.iloc[-1]),
            "bandwidth": _none_if_nan(bandwidth.iloc[-1]),
            "bandwidth_tail10": _tail_series(bandwidth, dates),
        },
        "volume": {
            "latest": int(vol.iloc[-1]),
            "avg20": _none_if_nan(vol_ma20.iloc[-1]),
            "ratio_to_avg20": vol_ratio,
            "abnormally_low": abnormally_low_volume,
        },
        "candles": {"recent": _classify_candles(df, n=3)},
        "risk": _compute_risk(df),
        "warnings": warnings,
    }
    if abnormally_low_volume:
        warnings.append("거래량이 20일 평균의 30% 미만 — 가격지표 신뢰도를 낮춰 재조정 필요(설계서 §2.2 가중치 참고박스)")
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="in_path", required=True)
    parser.add_argument("--out")
    args = parser.parse_args()

    payload = json.loads(Path(args.in_path).read_text(encoding="utf-8"))
    if payload.get("status") == "error":
        result = {"status": "error", "code": payload.get("code"), "reason": "입력 시세 데이터가 error 상태입니다: " + str(payload.get("reason"))}
    else:
        result = compute(payload)

    text = json.dumps(result, ensure_ascii=False, indent=2)
    print(text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    main()
