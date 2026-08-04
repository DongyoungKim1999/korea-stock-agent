"""프로젝트 공통 경로/환경변수 설정."""
from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]

OUTPUT_DIR = PROJECT_ROOT / "output"
REPORTS_DIR = OUTPUT_DIR / "reports"
CACHE_DIR = OUTPUT_DIR / "cache"
RAW_CACHE_DIR = CACHE_DIR / "raw"
REFERENCE_DIR = PROJECT_ROOT / "docs" / "reference"

for _dir in (REPORTS_DIR, CACHE_DIR, RAW_CACHE_DIR):
    _dir.mkdir(parents=True, exist_ok=True)


def _load_dotenv() -> None:
    env_path = PROJECT_ROOT / ".env"
    if not env_path.exists():
        return
    try:
        from dotenv import load_dotenv

        load_dotenv(env_path)
    except ImportError:
        # python-dotenv 미설치 시 수동 파싱으로 폴백
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


_load_dotenv()

DART_API_KEY = os.environ.get("DART_API_KEY", "")
NAVER_CLIENT_ID = os.environ.get("NAVER_CLIENT_ID", "")
NAVER_CLIENT_SECRET = os.environ.get("NAVER_CLIENT_SECRET", "")

# 캐시 TTL (초 단위)
TTL_PRICE_DATA = 6 * 3600           # 시세: 하루 중 여러 번 요청해도 6시간은 재사용
# OHLCV 시계열: 과거 구간은 사실상 불변이라 길게 캐시하고, 매 실행 최근 구간만 델타 조회해 병합한다
# (증분 조회). 실행 간 캐시 영구보존(actions/cache)과 결합해 300일 전체 재조회를 없앤다.
TTL_OHLCV_SERIES = 45 * 24 * 3600
TTL_CORP_CODE_MAP = 30 * 24 * 3600  # DART corpCode 매핑: 한 달
TTL_FINANCIAL_STATEMENT = 24 * 3600 # 기업개황 등: 하루
# 확정 공시된 재무제표(fnlttSinglAcntAll)는 사실상 불변이라 길게 캐시한다 — 새 분기는 다른 캐시키라
# 자동으로 새로 받고, 같은 분기 데이터는 재수집하지 않는다(실행 간 캐시 영구보존과 결합해 재조회 최소화).
TTL_FILED_STATEMENT = 45 * 24 * 3600  # 확정 재무제표: 45일
# '최근 재무제표 없음'(상폐·스팩·비표준 결산 등) 음성캐시. 매 실행 헛조회(종목당 최대 8콜)를 막는다.
# 새로 상장·공시하는 종목은 이 TTL이 지나면 재확인되므로 며칠 내 자동 반영된다.
TTL_NO_STATEMENT = 5 * 24 * 3600  # 재무제표 없음 확인: 5일
TTL_SEARCH_TREND = 24 * 3600        # 네이버 검색트렌드: 하루
TTL_NEWS_COUNT = 6 * 3600           # 뉴스 언급건수: 6시간
TTL_STOCK_LIST = 24 * 3600          # 종목리스트(pykrx): 하루


def has_dart_key() -> bool:
    return bool(DART_API_KEY)


def has_naver_keys() -> bool:
    return bool(NAVER_CLIENT_ID and NAVER_CLIENT_SECRET)
