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


def read(key: str, ttl_seconds: float) -> Any | None:
    path = _cache_path(key)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if time.time() - payload.get("_cached_at", 0) > ttl_seconds:
        return None
    return payload.get("data")


def write(key: str, data: Any) -> None:
    path = _cache_path(key)
    payload = {"_cached_at": time.time(), "_key": key, "data": data}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")


def cached_call(key: str, ttl_seconds: float, fetch_fn: Callable[[], Any], force_refresh: bool = False) -> Any:
    """캐시에 있으면 반환, 없거나 만료됐으면 fetch_fn() 실행 후 캐시에 저장."""
    if not force_refresh:
        cached = read(key, ttl_seconds)
        if cached is not None:
            return cached
    data = fetch_fn()
    write(key, data)
    return data
