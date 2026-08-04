"""DART Open API 래퍼 (재무제표, 기업개황, 공시목록, corpCode 매핑)."""
from __future__ import annotations

import datetime as dt
import io
import xml.etree.ElementTree as ET
import zipfile

import requests

from common import cache
from common.cache import cached_call
from common.config import (
    DART_API_KEY,
    TTL_CORP_CODE_MAP,
    TTL_FILED_STATEMENT,
    TTL_FINANCIAL_STATEMENT,
    has_dart_key,
)
from common.retry import retry_with_backoff

BASE_URL = "https://opendart.fss.or.kr/api"

# 보고서 코드: 1분기/반기/3분기/사업(연간)보고서
REPRT_Q1, REPRT_HALF, REPRT_Q3, REPRT_ANNUAL = "11013", "11012", "11014", "11011"

# 보고서별 대략적 법정 제출기한(월,일). 사업보고서는 익년 제출이라 연도 보정이 필요.
_DEADLINE = {REPRT_Q1: (5, 15), REPRT_HALF: (8, 14), REPRT_Q3: (11, 14), REPRT_ANNUAL: (3, 31)}


class DartApiError(RuntimeError):
    """DART가 status != '000'/'013' 을 반환했을 때. status/message는 공식 오류코드 체계를 따른다."""


def _require_key() -> str:
    if not has_dart_key():
        raise DartApiError("DART_API_KEY가 설정되지 않았습니다 (.env 확인 필요)")
    return DART_API_KEY


@retry_with_backoff(max_retries=2, exceptions=(requests.RequestException, DartApiError))
def _get_json(endpoint: str, params: dict) -> dict:
    params = {**params, "crtfc_key": _require_key()}
    resp = requests.get(f"{BASE_URL}/{endpoint}", params=params, timeout=15)
    resp.raise_for_status()
    try:
        payload = resp.json()
    except ValueError as exc:
        # DART가 동시요청 과다 등으로 JSON이 아닌 응답(빈 본문/HTML 오류페이지)을 줄 때가 있다.
        # JSONDecodeError는 ValueError라 재시도 대상(DartApiError)으로 바꿔 백오프 재시도되게 한다
        # (예전엔 재시도 없이 바로 실패해 일부 종목 재무가 빈 상태로 남았음).
        raise DartApiError(f"{endpoint} 비정상 응답(JSON 파싱 실패): {resp.text[:80]!r}") from exc
    status = payload.get("status")
    if status == "013":  # 조회된 데이터가 없습니다 — 오류가 아니라 '해당 없음'
        return payload
    if status != "000":
        raise DartApiError(f"{endpoint} status={status} message={payload.get('message')}")
    return payload


def _fetch_corp_code_map() -> list[dict]:
    _require_key()
    resp = requests.get(f"{BASE_URL}/corpCode.xml", params={"crtfc_key": DART_API_KEY}, timeout=30)
    resp.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        xml_bytes = zf.read("CORPCODE.xml")
    root = ET.fromstring(xml_bytes)
    result = []
    for node in root.findall("list"):
        stock_code = (node.findtext("stock_code") or "").strip()
        if not stock_code:
            continue  # 비상장/펀드 등 종목코드 없는 항목은 이 프로젝트 범위에서 제외
        result.append(
            {
                "corp_code": (node.findtext("corp_code") or "").strip(),
                "corp_name": (node.findtext("corp_name") or "").strip(),
                "stock_code": stock_code,
            }
        )
    if not result:
        raise DartApiError("corpCode.xml 파싱 결과가 비어있습니다")
    return result


def get_corp_code_map(force_refresh: bool = False) -> list[dict]:
    """상장기업 corp_code/corp_name/stock_code 매핑 전체 (약 30일 캐시)."""
    return cached_call("dart_corp_code_map", TTL_CORP_CODE_MAP, _fetch_corp_code_map, force_refresh)


def find_corp_by_stock_code(stock_code: str) -> dict | None:
    for row in get_corp_code_map():
        if row["stock_code"] == stock_code:
            return row
    return None


def get_company_profile(corp_code: str) -> dict:
    """기업개황 (업종코드 induty_code 포함)."""
    def _fetch():
        return _get_json("company.json", {"corp_code": corp_code})

    return cached_call(f"dart_company_{corp_code}", TTL_FINANCIAL_STATEMENT, _fetch)


def _recent_report_periods(today: dt.date | None = None, count: int = 6) -> list[tuple[str, str]]:
    """최근 분기부터 내림차순 (bsns_year, reprt_code) 후보 목록.

    법정 제출기한을 지난 분기만 후보로 삼아 불필요한 '013(데이터없음)' 호출을 줄인다.
    실제 제출은 회사마다 조금씩 빠르거나 늦을 수 있어 이후 호출 결과(013 여부)로 최종 확정한다.
    """
    today = today or dt.date.today()
    candidates: list[tuple[int, str]] = []
    year = today.year
    while len(candidates) < count + 4:
        candidates += [(year, REPRT_Q3), (year, REPRT_HALF), (year, REPRT_Q1), (year - 1, REPRT_ANNUAL)]
        year -= 1

    filtered = []
    for yy, code in candidates:
        mm, dd = _DEADLINE[code]
        deadline_year = yy + 1 if code == REPRT_ANNUAL else yy
        if dt.date(deadline_year, mm, dd) <= today:
            filtered.append((str(yy), code))
    return filtered[:count]


def _fetch_statement(corp_code: str, bsns_year: str, reprt_code: str, fs_div: str) -> dict:
    """단일 (기업/연도/보고서/연결구분) 재무제표 조회. 확정 공시분(status 000 + list)만 길게 캐시한다.

    확정 재무제표는 불변이라 한 번 받으면 재조회할 필요가 없다 — 실행 간 캐시 영구보존(actions/cache)과
    결합하면 계산 로직만 바꾸는 수정 시 DART를 거의 호출하지 않는다. 반면 '아직 미제출(013)'이나 빈
    응답은 캐시하지 않아, 이후 실제로 공시되면 곧바로 반영된다."""
    key = f"dart_fs_{corp_code}_{bsns_year}_{reprt_code}_{fs_div}"
    cached = cache.read(key, TTL_FILED_STATEMENT)
    if cached is not None:
        return cached
    payload = _get_json(
        "fnlttSinglAcntAll.json",
        {"corp_code": corp_code, "bsns_year": bsns_year, "reprt_code": reprt_code, "fs_div": fs_div},
    )
    if payload.get("status") == "000" and payload.get("list"):
        cache.write(key, payload)  # 확정 공시분만 영구 캐시
    return payload


def get_recent_financial_statements(corp_code: str, periods_needed: int = 4) -> list[dict]:
    """최근 N개 분기의 전체 재무제표 원자료. 연결(CFS) 우선, 없으면 별도(OFS)로 재시도."""
    results = []
    for bsns_year, reprt_code in _recent_report_periods(count=periods_needed + 3):
        period_data = None
        for fs_div in ("CFS", "OFS"):
            payload = _fetch_statement(corp_code, bsns_year, reprt_code, fs_div)
            if payload.get("status") == "000" and payload.get("list"):
                period_data = {
                    "bsns_year": bsns_year,
                    "reprt_code": reprt_code,
                    "fs_div": fs_div,
                    "accounts": payload["list"],
                }
                break
        if period_data:
            results.append(period_data)
        if len(results) >= periods_needed:
            break
    return results


def _to_num(text) -> float | None:
    """DART 텍스트 금액(콤마·'-' 포함)을 float으로. 배당 미실시('-')는 None."""
    if text is None:
        return None
    s = str(text).replace(",", "").strip()
    if s in ("", "-"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def get_dividend_info(corp_code: str, bsns_year: str) -> dict | None:
    """해당 사업연도 배당 정보(주당현금배당금·현금배당성향·시가배당률). 배당 미실시/미제출이면 None.

    확정 공시분(불변)만 길게 캐시한다 — 계산 로직 수정 시 재호출을 없앤다.
    DART alotMatter.json(배당에 관한 사항)은 사업보고서(11011)에 담긴다."""
    key = f"dart_dividend_{corp_code}_{bsns_year}"
    cached = cache.read(key, TTL_FILED_STATEMENT)
    if cached is not None:
        return cached or None  # 빈 dict({})는 '배당없음 확정'으로 캐시된 것
    try:
        payload = _get_json(
            "alotMatter.json",
            {"corp_code": corp_code, "bsns_year": bsns_year, "reprt_code": REPRT_ANNUAL},
        )
    except DartApiError:
        return None
    if payload.get("status") != "000" or not payload.get("list"):
        return None

    dps = payout = div_yield = None
    for row in payload["list"]:
        se = (row.get("se") or "").replace(" ", "")
        stock_knd = (row.get("stock_knd") or "")
        val = _to_num(row.get("thstrm"))
        # 보통주 기준 우선(우선주 행이 섞여 나오면 보통주만)
        if "주당현금배당금" in se and (not stock_knd or "보통" in stock_knd) and dps is None:
            dps = val
        elif "현금배당성향" in se and payout is None:
            payout = val
        elif ("현금배당수익률" in se or "시가배당" in se) and (not stock_knd or "보통" in stock_knd) and div_yield is None:
            div_yield = val

    result = {"dps": dps, "payout_pct": payout, "reported_yield_pct": div_yield}
    # 배당 관련 값이 하나도 없으면 실질 무배당 → 빈 dict로 캐시(다음엔 재호출 안 함)
    cache.write(key, result if any(v is not None for v in result.values()) else {})
    return result if any(v is not None for v in result.values()) else None


def get_annual_statements(corp_code: str, years: int = 4) -> list[dict]:
    """최근 N개 '사업연도(연간)' 재무제표를 최신연도부터 반환 — 매출/이익/마진 추이용.

    확정 공시분만 캐시하는 _fetch_statement를 재사용하므로 실행 간 재호출이 최소화된다."""
    results: list[dict] = []
    year = dt.date.today().year - 1  # 최근 확정 사업연도 후보(사업보고서는 익년 3월말 제출)
    attempts = 0
    while len(results) < years and attempts < years + 3:
        for fs_div in ("CFS", "OFS"):
            payload = _fetch_statement(corp_code, str(year), REPRT_ANNUAL, fs_div)
            if payload.get("status") == "000" and payload.get("list"):
                results.append({"bsns_year": str(year), "accounts": payload["list"]})
                break
        year -= 1
        attempts += 1
    return results


def list_disclosures(corp_code: str, bgn_de: str, end_de: str) -> list[dict]:
    """공시목록 (bgn_de/end_de: YYYYMMDD)."""
    payload = _get_json(
        "list.json",
        {"corp_code": corp_code, "bgn_de": bgn_de, "end_de": end_de, "page_count": 100},
    )
    return payload.get("list", [])
