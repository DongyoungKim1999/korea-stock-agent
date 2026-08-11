"""파일 기반 JSON 캐시. API 일일 호출한도(C6)를 아끼기 위해 모든 외부 호출은 이 캐시를 거친다."""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any, Callable

from common.config import RAW_CACHE_DIR


def _cache_path(key: str) -> Path:
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]
    safe_prefix = "".join(c if c.isalnum() or c in "-_" else "_" for c in key)[:60]
    return RAW_CACHE_DIR / f"{safe_prefix}_{digest}.json"


_MISSING = object()  # read()가 "캐시 없음"과 "캐시된 값이 None"을 구분하기 위한 내부 센티널


def _read_sentinel(key: str, ttl_seconds: float) -> Any:
    path = _cache_path(key)
    if not path.exists():
        return _MISSING
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return _MISSING
    if time.time() - payload.get("_cached_at", 0) > ttl_seconds:
        return _MISSING
    return payload.get("data")


def read(key: str, ttl_seconds: float) -> Any | None:
    """캐시 히트 시 저장된 값(그 값이 None이어도), 미스/만료/손상 시 None을 반환한다.

    주의: fetch_fn()이 정말로 None을 캐싱한 경우 이 함수로는 히트와 미스를 구분할 수 없다
    (호출부가 이미 `is not None`으로 음성캐시를 직접 판별하는 경우가 있어 하위호환을 위해 유지).
    그 구분이 필요하면 cached_call()처럼 _read_sentinel()을 직접 쓴다.
    """
    value = _read_sentinel(key, ttl_seconds)
    return None if value is _MISSING else value


def write(key: str, data: Any) -> None:
    path = _cache_path(key)
    payload = {"_cached_at": time.time(), "_key": key, "data": data}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")


def cached_call(key: str, ttl_seconds: float, fetch_fn: Callable[[], Any], force_refresh: bool = False) -> Any:
    """캐시에 있으면 반환(값이 None이어도 캐시 히트로 인정), 없거나 만료됐으면 fetch_fn() 실행 후 저장."""
    if not force_refresh:
        cached = _read_sentinel(key, ttl_seconds)
        if cached is not _MISSING:
            return cached
    data = fetch_fn()
    write(key, data)
    return data
