"""스킬 스크립트를 모듈로 재사용하기 위한 sys.path 부트스트랩.

automation/의 생성 스크립트들은 이미 만들어져 테스트된 skill 스크립트의 계산 로직
(fetch_individual, compute, analyze, screen, collect)을 그대로 import해서 재사용한다 —
같은 로직을 두 번 구현하지 않기 위함.
"""
from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

_SKILL_SCRIPT_DIRS = [
    "price-data-fetcher",
    "technical-indicator-calculator",
    "dart-financial-fetcher",
    "financial-ratio-analyzer",
    "market-anomaly-screener",
    "attention-signal-collector",
]
for _name in _SKILL_SCRIPT_DIRS:
    sys.path.insert(0, str(PROJECT_ROOT / ".claude" / "skills" / _name / "scripts"))
