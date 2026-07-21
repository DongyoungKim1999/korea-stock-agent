"""DART Open API 래퍼 (재무제표, 기업개황, 공시목록, corpCode 매핑)."""
from __future__ import annotations

import datetime as dt
import io
import xml.etree.ElementTree as ET
import zipfile

import requests

from common.cache import cached_call
from common.config import DART_API_KEY, TTL_CORP_CODE_MAP, TTL_FINANCIAL_STATEMENT, has_dart_key
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
    payload = resp.json()
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


def get_recent_financial_statements(corp_code: str, periods_needed: int = 4) -> list[dict]:
    """최근 N개 분기의 전체 재무제표 원자료. 연결(CFS) 우선, 없으면 별도(OFS)로 재시도."""
    results = []
    for bsns_year, reprt_code in _recent_report_periods(count=periods_needed + 3):
        period_data = None
        for fs_div in ("CFS", "OFS"):
            payload = _get_json(
                "fnlttSinglAcntAll.json",
                {"corp_code": corp_code, "bsns_year": bsns_year, "reprt_code": reprt_code, "fs_div": fs_div},
            )
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


def list_disclosures(corp_code: str, bgn_de: str, end_de: str) -> list[dict]:
    """공시목록 (bgn_de/end_de: YYYYMMDD)."""
    payload = _get_json(
        "list.json",
        {"corp_code": corp_code, "bgn_de": bgn_de, "end_de": end_de, "page_count": 100},
    )
    return payload.get("list", [])
