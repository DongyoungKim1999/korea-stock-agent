---
name: report-formatter
description: technical-analyst/fundamental-analyst/market-scanner의 분석 결과(JSON)를 최종 사용자용 Markdown 리포트로 렌더링한다. disclaimer 삽입과 극단값 재검토 플래그를 스크립트가 강제한다. 각 Entry의 마지막 단계, 메인 에이전트(오케스트레이터)가 직접 사용한다.
---

# report-formatter

## 목적 (설계서 A9 / B6, C5)

리포트 "포맷"은 스크립트가 담당하고 "서술 내용"은 LLM이 담당하는 분리 구조다. 이 스킬은
**disclaimer를 절대 빠뜨리지 않도록** `docs/reference/disclaimer-template.md`를 항상 읽어
리포트 끝에 붙이며, 기술점수가 1점/5점이거나 기본점수 카테고리가 1.5점 이하/4.5점 이상이면
입력값과 무관하게 스스로 "재검토 권장" 배너를 붙인다(A9 에스컬레이션 기준 — 점수만으로
결정하므로 LLM이 플래그를 빠뜨려도 새어나가지 않음).

## 호출 시점

메인 에이전트가 technical-analyst + fundamental-analyst(Entry A) 또는 market-scanner(Entry B)의
결과를 취합한 뒤, **직접** 이 스킬을 호출해 최종 리포트를 만든다 (서브에이전트가 이 스킬을
호출하지 않음 — 각 서브에이전트는 자기 결과를 캐시 JSON으로만 남긴다).

## 실행 전 준비: 입력 JSON 구성

이 스크립트는 서브에이전트의 원본 캐시 JSON(`{code}_technical.json` 등)을 직접 읽지 않는다.
메인 에이전트가 아래 스키마로 **취합**해 하나의 JSON으로 만든 뒤 전달해야 한다.

**`--type stock`** (Entry A):
```json
{
  "code": "005930", "name": "삼성전자", "as_of": "2026-07-21",
  "technical": {"score": 4, "summary": "...", "signals": [{"indicator":"MACD","finding":"...","contribution":"긍정적"}], "data_warnings": []},
  "fundamental": {"stability_score": 3.5, "growth_score": 4.0, "activity_score": 3.0, "comparison_basis": "industry_average",
                  "summary": "...", "peer_list": [{"corp_name":"..."}], "signals": [{"category":"안정성","indicator":"부채비율","target_value":"...","peer_average":"...","relative_note":"유리"}], "data_warnings": []},
  "overall_opinion": "..."
}
```

**`--type attention`** (Entry B):
```json
{
  "scan_date": "2026-07-21", "scope": "ALL", "screened_candidate_count": 37,
  "market_note": "...(선택)",
  "ranked_stocks": [{"rank": 1, "code": "...", "name": "...", "reason": "...", "evidence": ["...", "..."]}]
}
```

## 실행 방법

```bash
python3 .claude/skills/report-formatter/scripts/format_report.py --type stock \
  --data output/cache/005930_report_input.json \
  --out output/reports/005930_report_20260721.md

python3 .claude/skills/report-formatter/scripts/format_report.py --type attention \
  --data output/cache/attention_report_input.json \
  --out output/reports/attention_report_20260721.md
```

## 실패 처리

이 단계는 필수(스킵 불가) — B6/A9 모두 "실패 시 재시도"로 명시되어 있다. 입력 JSON의 필드가
일부 빠져 있어도 렌더링 자체는 실패하지 않도록 설계되어 있으므로(누락 필드는 "산출불가"/빈 표로
표시), 실패한다면 입력 JSON 자체가 파싱 불가능한 경우뿐이다 — 이 경우 취합 JSON을 다시 만들 것.
