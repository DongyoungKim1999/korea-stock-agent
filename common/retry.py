"""재시도 백오프 유틸. 설계서 C6(API 호출한도) 및 각 단계 '자동재시도(최대 2회)' 규칙을 구현."""
from __future__ import annotations

import functools
import logging
import time
from typing import Callable, TypeVar

logger = logging.getLogger("korea_stock_agent")
if not logger.handlers:
    # root 레벨은 WARNING으로 둔다: pykrx가 내부적으로 찍는 logging.info() 잡음을 걸러내되
    # 이 모듈의 warning/error(재시도·소진 알림)는 그대로 보이게 하기 위함.
    logging.basicConfig(level=logging.WARNING, format="[%(levelname)s] %(message)s")

T = TypeVar("T")


class RetryExhausted(RuntimeError):
    """자동재시도를 모두 소진하고도 실패했을 때 발생. 호출부는 이를 잡아 스킵+로그 또는 에스컬레이션 처리."""


def retry_with_backoff(
    max_retries: int = 2,
    base_delay: float = 1.5,
    exceptions: tuple[type[BaseException], ...] = (Exception,),
):
    """최대 max_retries 회 재시도(총 시도 횟수 = max_retries + 1), 지수 백오프.

    설계서의 '자동재시도(최대 2회)' 문구와 맞추기 위해 기본값을 2로 둔다.
    """

    def decorator(fn: Callable[..., T]) -> Callable[..., T]:
        @functools.wraps(fn)
        def wrapper(*args, **kwargs) -> T:
            last_exc: BaseException | None = None
            for attempt in range(max_retries + 1):
                try:
                    return fn(*args, **kwargs)
                except exceptions as exc:  # noqa: BLE001 - 의도적으로 광범위 캐치 후 재시도
                    last_exc = exc
                    if attempt < max_retries:
                        delay = base_delay * (2**attempt)
                        logger.warning(
                            "%s 실패(%s/%s): %s — %.1f초 후 재시도",
                            fn.__name__,
                            attempt + 1,
                            max_retries + 1,
                            exc,
                            delay,
                        )
                        time.sleep(delay)
                    else:
                        logger.error("%s 재시도 소진: %s", fn.__name__, exc)
            raise RetryExhausted(f"{fn.__name__} 자동재시도({max_retries}회) 소진") from last_exc

        return wrapper

    return decorator
