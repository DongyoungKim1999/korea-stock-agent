"""pykrx 래퍼. 실거래일/전종목 스냅샷 조회는 KRX 서버 사정에 따라 간헐적으로 빈 응답을 줄 수 있어
모든 호출에 재시도를 걸고, 최종 실패 시 예외를 그대로 올려 skill 스크립트가 '스킵+로그'로 처리하게 한다.
"""
from __future__ import annotations

import datetime as dt

import pandas as pd
from pykrx import stock

from common.retry import retry_with_backoff

REFERENCE_TICKER = "005930"  # 삼성전자: 상장폐지/거래정지 위험이 사실상 없어 '최근 영업일' 판별 기준으로 사용


def _yyyymmdd(d: dt.date) -> str:
    return d.strftime("%Y%m%d")


@retry_with_backoff(max_retries=2)
def _fetch_ohlcv_by_date(fromdate: str, todate: str, ticker: str) -> pd.DataFrame:
    df = stock.get_market_ohlcv_by_date(fromdate, todate, ticker)
    if df is None or df.empty:
        raise ValueError(f"빈 응답: {ticker} {fromdate}~{todate}")
    return df


def get_latest_trading_date(today: dt.date | None = None) -> str:
    """가장 최근 영업일(YYYYMMDD)을 반환.

    pykrx.get_nearest_business_day_in_a_week()는 내부적으로 지수(KOSPI) 조회 엔드포인트를 쓰는데
    해당 엔드포인트가 환경에 따라 빈 응답을 주는 사례가 있어, 개별종목 시세 조회(더 안정적으로 확인됨)로
    최근 10 영업일 이내 데이터를 직접 확인하는 방식을 1차로 사용하고 pykrx 내장 함수를 폴백으로 둔다.
    """
    today = today or dt.date.today()
    fromdate = _yyyymmdd(today - dt.timedelta(days=14))
    todate = _yyyymmdd(today)
    try:
        df = _fetch_ohlcv_by_date(fromdate, todate, REFERENCE_TICKER)
        last_date = df.index[-1]
        return pd.Timestamp(last_date).strftime("%Y%m%d")
    except Exception:
        pass

    try:
        return stock.get_nearest_business_day_in_a_week(_yyyymmdd(today), prev=True)
    except Exception as exc:
        raise RuntimeError("최근 영업일 조회 실패 (개별종목/지수 조회 모두 실패)") from exc


def get_ohlcv(code: str, trading_days: int = 120, end_date: str | None = None) -> pd.DataFrame:
    """종목의 최근 N 거래일 OHLCV(+거래량, 등락률)를 날짜 오름차순으로 반환."""
    todate = end_date or get_latest_trading_date()
    calendar_buffer = int(trading_days * 1.6) + 15  # 주말/공휴일 감안 여유분
    fromdate = _yyyymmdd(dt.datetime.strptime(todate, "%Y%m%d").date() - dt.timedelta(days=calendar_buffer))
    df = _fetch_ohlcv_by_date(fromdate, todate, code)
    df = df.sort_index()
    return df.tail(trading_days)


@retry_with_backoff(max_retries=0)
def _fetch_market_cap_by_date(fromdate: str, todate: str, ticker: str) -> pd.DataFrame:
    # GitHub Actions 환경에서 이 엔드포인트는 실제 배포 로그로 100% 실패가 확인됐다(개별종목
    # OHLCV는 정상인데 이것만 막힘 — 다른 "전종목류" 엔드포인트와 같은 차단 패턴). 재시도해도
    # 성공한 적이 없어 max_retries=0으로 두어 워치리스트 전체 기준 약 10분+ 낭비를 없앤다.
    # 시가총액은 UI에도 크게 노출되지 않는 부가정보라 실패해도 영향이 적다(비치명적 warning 처리됨).
    df = stock.get_market_cap(fromdate, todate, ticker)
    if df is None or df.empty:
        raise ValueError(f"빈 응답: 시가총액 {ticker} {fromdate}~{todate}")
    return df


def get_market_cap_series(code: str, trading_days: int = 120, end_date: str | None = None) -> pd.DataFrame:
    """종목의 최근 N 거래일 시가총액/상장주식수 시계열."""
    todate = end_date or get_latest_trading_date()
    calendar_buffer = int(trading_days * 1.6) + 15
    fromdate = _yyyymmdd(dt.datetime.strptime(todate, "%Y%m%d").date() - dt.timedelta(days=calendar_buffer))
    df = _fetch_market_cap_by_date(fromdate, todate, code)
    return df.sort_index().tail(trading_days)


def get_recent_trading_dates(count: int, end_date: str | None = None) -> list[str]:
    """최근 거래일 목록(오름차순, YYYYMMDD).

    전종목 스냅샷 엔드포인트(get_market_snapshot)와 달리 개별종목 시계열 엔드포인트는
    안정적으로 동작함이 확인되어, 기준종목의 실제 거래일 인덱스를 그대로 거래일 캘린더로 사용한다.
    """
    df = get_ohlcv(REFERENCE_TICKER, trading_days=count, end_date=end_date)
    return [pd.Timestamp(d).strftime("%Y%m%d") for d in df.index]


@retry_with_backoff(max_retries=2)
def get_market_snapshot(date: str, market: str = "ALL") -> pd.DataFrame:
    """지정일 전종목 OHLCV+거래대금+등락률 스냅샷 (시장 전체 스캔 B1용)."""
    df = stock.get_market_ohlcv_by_ticker(date, market=market, alternative=True)
    if df is None or df.empty:
        raise ValueError(f"빈 응답: market snapshot {market} {date}")
    return df


@retry_with_backoff(max_retries=2)
def get_market_cap_snapshot(date: str, market: str = "ALL") -> pd.DataFrame:
    df = stock.get_market_cap_by_ticker(date, market=market, alternative=True)
    if df is None or df.empty:
        raise ValueError(f"빈 응답: market cap snapshot {market} {date}")
    return df


@retry_with_backoff(max_retries=2)
def get_ticker_universe(date: str) -> list[dict]:
    """종목코드/종목명/시장구분 전체 목록. stock-code-resolver의 매칭 대상."""
    universe: list[dict] = []
    for market in ("KOSPI", "KOSDAQ", "KONEX"):
        tickers = stock.get_market_ticker_list(date=date, market=market)
        for code in tickers:
            try:
                name = stock.get_market_ticker_name(code)
            except Exception:
                continue
            universe.append({"code": code, "name": name, "market": market})
    if not universe:
        raise ValueError("빈 응답: 종목 유니버스")
    return universe
