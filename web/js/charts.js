// 차트 렌더링 헬퍼: 게이지(SVG), 캔들+이동평균(lightweight-charts), 레이더/스파크라인(Chart.js)
// dataviz 스킬 원칙: 얇은 라인(2px), 카테고리 색은 고정 순서, 시퀀셜 상태색은 good/warning/critical 고정.

const PALETTE = {
  series1: "#3987e5",
  series2: "#199e70",
  series4: "#eda100",
  series7: "#9085e9",
  candleUp: "#e5484d",
  candleDown: "#3987e5",
  good: "#16c172",
  warning: "#fab219",
  critical: "#e5484d",
  textSecondary: "#a9b1c3",
  textMuted: "#6b7383",
  grid: "rgba(255,255,255,0.06)",
};

function scoreStatusColor(score, scale5 = true) {
  const v = scale5 ? score : score;
  if (v >= 4.0) return PALETTE.good;
  if (v >= 3.0) return PALETTE.warning;
  return PALETTE.critical;
}

function renderGauge(score) {
  const needle = document.getElementById("gauge-needle");
  if (!needle) return;
  const clamped = Math.max(1, Math.min(5, score ?? 3));
  const angle = -90 + ((clamped - 1) / 4) * 180;
  needle.style.transform = `rotate(${angle}deg)`;
}

function simpleMovingAverage(rows, period) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (i < period - 1) continue;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += rows[j].close;
    out.push({ time: rows[i].date, value: +(sum / period).toFixed(2) });
  }
  return out;
}

let _priceChart = null;
let _priceChartResizeObs = null;

function renderPriceChart(containerEl, rows) {
  if (_priceChartResizeObs) { _priceChartResizeObs.disconnect(); _priceChartResizeObs = null; }
  if (_priceChart) { _priceChart.remove(); _priceChart = null; }
  containerEl.innerHTML = "";
  if (!rows || rows.length === 0) {
    containerEl.innerHTML = '<div class="panel-empty">가격 데이터가 없습니다</div>';
    return;
  }
  const chart = LightweightCharts.createChart(containerEl, {
    width: containerEl.clientWidth,
    height: 220,
    layout: { background: { color: "transparent" }, textColor: PALETTE.textSecondary, fontSize: 11 },
    grid: { vertLines: { color: PALETTE.grid }, horzLines: { color: PALETTE.grid } },
    rightPriceScale: { borderColor: PALETTE.grid },
    timeScale: { borderColor: PALETTE.grid, timeVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    localization: {
      // 원화는 소수 단위가 없으므로 정수 + 천단위 구분자로 표시 (기존엔 "259000.00"처럼 나왔음)
      priceFormatter: (p) => Math.round(p).toLocaleString("ko-KR"),
    },
  });

  const krwPriceFormat = { type: "price", precision: 0, minMove: 1 };

  const candleSeries = chart.addCandlestickSeries({
    upColor: PALETTE.candleUp, downColor: PALETTE.candleDown,
    borderUpColor: PALETTE.candleUp, borderDownColor: PALETTE.candleDown,
    wickUpColor: PALETTE.candleUp, wickDownColor: PALETTE.candleDown,
    priceFormat: krwPriceFormat,
  });
  candleSeries.setData(rows.map(r => ({ time: r.date, open: r.open, high: r.high, low: r.low, close: r.close })));

  // MA선은 양봉/음봉 색(빨강·파랑)과 겹치지 않는 색만 사용 — 캔들과 추세선을 한눈에 구분하기 위함
  const ma5 = chart.addLineSeries({ color: PALETTE.series4, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, priceFormat: krwPriceFormat });
  ma5.setData(simpleMovingAverage(rows, 5));
  const ma20 = chart.addLineSeries({ color: PALETTE.series7, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, priceFormat: krwPriceFormat });
  ma20.setData(simpleMovingAverage(rows, 20));
  const ma60 = chart.addLineSeries({ color: PALETTE.series2, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, priceFormat: krwPriceFormat });
  ma60.setData(simpleMovingAverage(rows, 60));

  chart.timeScale().fitContent();
  _priceChart = chart;

  _priceChartResizeObs = new ResizeObserver(() => {
    if (_priceChart === chart) chart.applyOptions({ width: containerEl.clientWidth });
  });
  _priceChartResizeObs.observe(containerEl);
}

let _radarChart = null;

function clearRadar() {
  if (_radarChart) { _radarChart.destroy(); _radarChart = null; }
}

function renderRadar(canvasEl, entries) {
  // entries: [{label, value(0~5)}]
  if (_radarChart) { _radarChart.destroy(); _radarChart = null; }
  _radarChart = new Chart(canvasEl, {
    type: "radar",
    data: {
      labels: entries.map(e => e.label),
      datasets: [{
        data: entries.map(e => e.value ?? 0),
        backgroundColor: "rgba(57,135,229,0.18)",
        borderColor: PALETTE.series1,
        borderWidth: 2,
        pointBackgroundColor: PALETTE.series1,
        pointRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      animation: { duration: 300 },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: true, callbacks: { label: (ctx) => ` ${ctx.parsed.r.toFixed(1)} / 5.0` } },
      },
      scales: {
        r: {
          min: 0, max: 5, ticks: { display: false, stepSize: 1 },
          grid: { color: PALETTE.grid }, angleLines: { color: PALETTE.grid },
          pointLabels: { color: PALETTE.textSecondary, font: { size: 10 } },
        },
      },
    },
  });
}

