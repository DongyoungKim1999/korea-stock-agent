// 캔들스틱 패턴 인식 — 일봉 OHLCV에서 대표적 반전 패턴을 탐지해 매수(상승반전)/매도(하락반전)로 분류한다.
// 순수 규칙기반(라이브러리 없음). 추세 맥락(직전 상승/하락)을 함께 봐 반전 패턴의 유효성을 판단한다.
// 반환: [{ index, date, type:'buy'|'sell', name, confidence:'고'|'중', desc }]

function detectCandlePatterns(rows) {
  const n = rows ? rows.length : 0;
  if (n < 6) return [];

  const O = (i) => rows[i].open, H = (i) => rows[i].high, L = (i) => rows[i].low, C = (i) => rows[i].close;
  const body = (i) => Math.abs(C(i) - O(i));
  const upSh = (i) => H(i) - Math.max(O(i), C(i));
  const loSh = (i) => Math.min(O(i), C(i)) - L(i);
  const bull = (i) => C(i) > O(i);
  const bear = (i) => C(i) < O(i);
  const mid = (i) => (O(i) + C(i)) / 2;
  const avgBody = (i) => { let s = 0, c = 0; for (let j = Math.max(0, i - 20); j < i; j++) { s += body(j); c++; } return c ? s / c : (body(i) || 1); };
  // 추세 맥락: 직전 봉이 6봉·3봉 전보다 낮으면 하락추세(반등 패턴 유효), 높으면 상승추세(반전 패턴 유효)
  const downTrend = (i) => i >= 6 && C(i - 1) < C(i - 6) && C(i - 1) <= C(i - 3);
  const upTrend = (i) => i >= 6 && C(i - 1) > C(i - 6) && C(i - 1) >= C(i - 3);

  const out = [];
  const push = (i, type, name, conf, desc) => out.push({ index: i, date: rows[i].date, type, name, confidence: conf, desc });

  for (let i = 2; i < n; i++) {
    const ab = avgBody(i) || 1;
    const b = body(i);

    // ── 3봉 패턴 (우선순위 높음) ──
    const b0 = body(i - 2), b1 = body(i - 1);
    // 샛별형 / 상승 버려진 아기
    if (bear(i - 2) && b0 > ab && b1 < ab * 0.5 && bull(i) && b > ab * 0.8 && C(i) > mid(i - 2) && downTrend(i - 2)) {
      if (H(i - 1) < L(i - 2) && H(i - 1) < L(i) && b1 < ab * 0.25) push(i, "buy", "상승 버려진 아기", "고", "바닥권 갭+도지 후 강한 반등");
      else push(i, "buy", "샛별형(모닝스타)", "고", "바닥권 3봉 상승 반전");
      continue;
    }
    // 석별형 / 하락 버려진 아기
    if (bull(i - 2) && b0 > ab && b1 < ab * 0.5 && bear(i) && b > ab * 0.8 && C(i) < mid(i - 2) && upTrend(i - 2)) {
      if (L(i - 1) > H(i - 2) && L(i - 1) > H(i) && b1 < ab * 0.25) push(i, "sell", "하락 버려진 아기", "고", "고점권 갭+도지 후 급락 반전");
      else push(i, "sell", "석별형(이브닝스타)", "고", "고점권 3봉 하락 반전");
      continue;
    }
    // 적삼병 (연속 3양봉)
    if (bull(i) && bull(i - 1) && bull(i - 2) && C(i) > C(i - 1) && C(i - 1) > C(i - 2) &&
        body(i) > ab * 0.6 && body(i - 1) > ab * 0.6 && body(i - 2) > ab * 0.6 &&
        O(i) < C(i - 1) && O(i) > O(i - 1) && O(i - 1) < C(i - 2) && O(i - 1) > O(i - 2)) {
      push(i, "buy", "적삼병", "고", "연속 3양봉 상승 지속"); continue;
    }
    // 흑삼병 (연속 3음봉)
    if (bear(i) && bear(i - 1) && bear(i - 2) && C(i) < C(i - 1) && C(i - 1) < C(i - 2) &&
        body(i) > ab * 0.6 && body(i - 1) > ab * 0.6 && body(i - 2) > ab * 0.6 &&
        O(i) > C(i - 1) && O(i) < O(i - 1) && O(i - 1) > C(i - 2) && O(i - 1) < O(i - 2)) {
      push(i, "sell", "흑삼병", "고", "연속 3음봉 하락 지속"); continue;
    }

    // ── 2봉 패턴 ──
    // 상승 장악형
    if (bear(i - 1) && bull(i) && C(i) >= O(i - 1) && O(i) <= C(i - 1) && b > body(i - 1) && downTrend(i)) {
      push(i, "buy", "상승 장악형", "고", "전일 음봉을 감싸는 큰 양봉"); continue;
    }
    // 하락 장악형
    if (bull(i - 1) && bear(i) && O(i) >= C(i - 1) && C(i) <= O(i - 1) && b > body(i - 1) && upTrend(i)) {
      push(i, "sell", "하락 장악형", "고", "전일 양봉을 감싸는 큰 음봉"); continue;
    }
    // 관통형
    if (bear(i - 1) && body(i - 1) > ab * 0.7 && bull(i) && O(i) < L(i - 1) && C(i) > mid(i - 1) && C(i) < O(i - 1) && downTrend(i)) {
      push(i, "buy", "관통형", "중", "갭하락 후 전일 몸통 절반 이상 회복"); continue;
    }
    // 먹구름형
    if (bull(i - 1) && body(i - 1) > ab * 0.7 && bear(i) && O(i) > H(i - 1) && C(i) < mid(i - 1) && C(i) > O(i - 1) && upTrend(i)) {
      push(i, "sell", "먹구름형", "중", "갭상승 후 전일 몸통 절반 이상 하락"); continue;
    }

    // ── 1봉 패턴 (망치/유성 계열) ──
    if (b < ab * 0.6 && loSh(i) > b * 2 && upSh(i) < b * 0.7) {
      if (downTrend(i)) { push(i, "buy", "망치형", "중", "바닥권 긴 아래꼬리 — 반등 신호"); continue; }
      if (upTrend(i)) { push(i, "sell", "교수형", "중", "고점권 긴 아래꼬리 — 반락 경계"); continue; }
    }
    if (b < ab * 0.6 && upSh(i) > b * 2 && loSh(i) < b * 0.7) {
      if (upTrend(i)) { push(i, "sell", "유성형", "중", "고점권 긴 위꼬리 — 반전 신호"); continue; }
      if (downTrend(i)) { push(i, "buy", "역망치형", "중", "바닥권 긴 위꼬리 — 반등 시도"); continue; }
    }
  }

  // 클러터 감소: 4봉 이내 인접 신호는 고신뢰 우선으로 1개만 남긴다.
  const thinned = [];
  for (const p of out) {
    const last = thinned[thinned.length - 1];
    if (last && p.index - last.index < 4) {
      if (p.confidence === "고" && last.confidence !== "고") thinned[thinned.length - 1] = p;
    } else thinned.push(p);
  }
  return thinned;
}
