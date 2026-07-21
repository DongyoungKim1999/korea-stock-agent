"""공개 대시보드용 워치리스트. DART 호출량(피어 비교 포함)을 감당할 수 있는 범위로 20종목을 고정한다.

전체 시장이 아니라 이 목록만 기술적/기본적분석을 상시 갱신한다 — 종목 추천(주목종목) 패널은
이 목록과 무관하게 시장 전체를 스캔한다(automation/generate_attention.py).
확장하려면 이 리스트에 항목만 추가하면 된다(다른 코드 변경 불필요).
"""

WATCHLIST = [
    {"code": "005930", "name": "삼성전자", "sector": "반도체"},
    {"code": "000660", "name": "SK하이닉스", "sector": "반도체"},
    {"code": "042700", "name": "한미반도체", "sector": "반도체"},
    {"code": "009150", "name": "삼성전기", "sector": "전자부품"},
    {"code": "066570", "name": "LG전자", "sector": "전자제품"},
    {"code": "373220", "name": "LG에너지솔루션", "sector": "2차전지"},
    {"code": "006400", "name": "삼성SDI", "sector": "2차전지"},
    {"code": "003670", "name": "포스코퓨처엠", "sector": "2차전지소재"},
    {"code": "005380", "name": "현대차", "sector": "자동차"},
    {"code": "000270", "name": "기아", "sector": "자동차"},
    {"code": "012330", "name": "현대모비스", "sector": "자동차부품"},
    {"code": "005490", "name": "POSCO홀딩스", "sector": "철강"},
    {"code": "051910", "name": "LG화학", "sector": "화학"},
    {"code": "035420", "name": "NAVER", "sector": "인터넷"},
    {"code": "035720", "name": "카카오", "sector": "인터넷"},
    {"code": "207940", "name": "삼성바이오로직스", "sector": "바이오"},
    {"code": "068270", "name": "셀트리온", "sector": "바이오"},
    {"code": "105560", "name": "KB금융", "sector": "금융"},
    {"code": "055550", "name": "신한지주", "sector": "금융"},
    {"code": "028260", "name": "삼성물산", "sector": "지주/상사"},
]

WATCHLIST_BY_CODE = {row["code"]: row for row in WATCHLIST}
