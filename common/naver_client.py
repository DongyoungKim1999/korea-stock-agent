"""네이버 오픈API 래퍼 (데이터랩 검색어트렌드, 뉴스검색).

주의: 뉴스검색 API는 날짜범위 필터를 지원하지 않는다(데이터랩과 다름). 최신순(sort=date)으로
최대 100건을 가져와 pubDate를 직접 파싱해 '최근 N일 vs 그 이전 N일' 건수를 근사 산출한다.
100건이 모두 최근 N일 이내라면 실제 건수는 더 많을 수 있으므로 capped=True로 표시한다.
"""
from __future__ import annotations

import datetime as dt
from email.utils import parsedate_to_datetime

import requests

from common.config import NAVER_CLIENT_ID, NAVER_CLIENT_SECRET, has_naver_keys
from common.retry import retry_with_backoff

DATALAB_URL = "https://openapi.naver.com/v1/datalab/search"
NEWS_URL = "https://openapi.naver.com/v1/search/news.json"


class NaverApiError(RuntimeError):
    pass


def _headers() -> dict:
    if not has_naver_keys():
        raise NaverApiError("NAVER_CLIENT_ID/SECRET이 설정되지 않았습니다 (.env 확인 필요)")
    return {
        "X-Naver-Client-Id": NAVER_CLIENT_ID,
        "X-Naver-Client-Secret": NAVER_CLIENT_SECRET,
    }


@retry_with_backoff(max_retries=2, exceptions=(requests.RequestException, NaverApiError))
def get_search_trend(keyword: str, start_date: str, end_date: str, time_unit: str = "date") -> list[dict]:
    """검색어트렌드 상대지수 시계열. start/end_date: 'YYYY-MM-DD'."""
    body = {
        "startDate": start_date,
        "endDate": end_date,
        "timeUnit": time_unit,
        "keywordGroups": [{"groupName": keyword, "keywords": [keyword]}],
    }
    resp = requests.post(DATALAB_URL, headers={**_headers(), "Content-Type": "application/json"}, json=body, timeout=15)
    if resp.status_code != 200:
        raise NaverApiError(f"datalab HTTP {resp.status_code}: {resp.text[:200]}")
    payload = resp.json()
    results = payload.get("results", [])
    return results[0]["data"] if results else []


@retry_with_backoff(max_retries=2, exceptions=(requests.RequestException, NaverApiError))
def _search_news_raw(keyword: str, display: int = 100) -> dict:
    params = {"query": keyword, "display": display, "sort": "date"}
    resp = requests.get(NEWS_URL, headers=_headers(), params=params, timeout=15)
    if resp.status_code != 200:
        raise NaverApiError(f"news HTTP {resp.status_code}: {resp.text[:200]}")
    return resp.json()


def get_news_mention_signal(keyword: str, recent_days: int = 7, now: dt.datetime | None = None) -> dict:
    now = now or dt.datetime.now(dt.timezone(dt.timedelta(hours=9)))
    payload = _search_news_raw(keyword, display=100)
    items = payload.get("items", [])

    recent_cutoff = now - dt.timedelta(days=recent_days)
    prior_cutoff = now - dt.timedelta(days=recent_days * 2)

    recent_count = 0
    prior_count = 0
    sample_titles = []
    oldest_seen = now
    for item in items:
        try:
            pub_dt = parsedate_to_datetime(item["pubDate"])
        except (KeyError, TypeError, ValueError):
            continue
        oldest_seen = min(oldest_seen, pub_dt)
        if pub_dt >= recent_cutoff:
            recent_count += 1
            if len(sample_titles) < 5:
                sample_titles.append(_strip_tags(item.get("title", "")))
        elif prior_cutoff <= pub_dt < recent_cutoff:
            prior_count += 1

    capped = len(items) > 0 and oldest_seen >= recent_cutoff  # 100건이 다 최근 구간 -> 실제 더 많을 가능성

    return {
        "keyword": keyword,
        "recent_days": recent_days,
        "recent_count": recent_count,
        "prior_count": prior_count,
        "capped": capped,
        "total_indexed": payload.get("total", 0),
        "sample_titles": sample_titles,
    }


def _strip_tags(text: str) -> str:
    return text.replace("<b>", "").replace("</b>", "").replace("&quot;", '"').replace("&amp;", "&")
