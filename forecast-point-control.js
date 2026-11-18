import { LIVE_POLL_MS, timeLabel } from "./live-temperature-data.js";
import { forecastTickLabel } from "./forecast-timeline.js?v=20261110-drive4";
import { POINT_FORECAST_FIELDS, pointForecastCell, readPointForecast } from "./forecast-point-data.js?v=20261118-point1";

export function initForecastPoint(map, Marker) {
  const panel = document.getElementById("forecastPoint");
  const body = document.getElementById("forecastPointBody");
  const heading = document.getElementById("forecastPointHeading");
  const toggle = document.getElementById("forecastPointToggle");
  const close = document.getElementById("forecastPointClose");
  const status = document.getElementById("forecastPointStatus");
  const scroller = document.getElementById("forecastPointScroll");
  const table = document.getElementById("forecastPointTable");
  const retry = document.getElementById("forecastPointRetry");
  const pin = document.createElement("span");
  pin.className = "forecast-point-marker";
  pin.setAttribute("aria-hidden", "true");
  const marker = new Marker({element:pin});
  let cell = null;
  let forecast = null;
  let pending = null;
  let refreshTimer = null;

  function resize() {
    requestAnimationFrame(() => map.resize());
  }

  function setExpanded(expanded) {
    body.hidden = !expanded;
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.textContent = expanded ? "折りたたむ" : "展開する";
    resize();
  }

  function dismiss() {
    pending?.abort();
    pending = null;
    clearTimeout(refreshTimer);
    cell = null;
    forecast = null;
    marker.remove();
    if (!panel.hidden) {
      panel.hidden = true;
      resize();
    }
  }

  function render({issued, series, incomplete}) {
    status.textContent = `発表 ${timeLabel(issued)}${incomplete ? " · 一部の資料を取得できませんでした" : ""}`;
    const rows = [
      ["対象時刻", ...series.map(period => forecastTickLabel(period.end))],
      ...POINT_FORECAST_FIELDS.map(([, name], index) => [name, ...series.map(period => period.values[index] ?? "資料なし")]),
    ];
    const sections = [document.createElement("thead"), document.createElement("tbody")];
    for (const [index, values] of rows.entries()) {
      const row = sections[index === 0 ? 0 : 1].insertRow();
      for (const [column, value] of values.entries()) {
        const entry = document.createElement(index === 0 || column === 0 ? "th" : "td");
        if (entry.tagName === "TH") entry.scope = index === 0 ? "col" : "row";
        if (index === 0 && column > 0) entry.title = timeLabel(series[column - 1].end);
        entry.textContent = value;
        row.append(entry);
      }
    }
    table.replaceChildren(...sections);
    scroller.hidden = false;
    retry.hidden = !incomplete;
  }

  async function load() {
    if (!cell) return;
    clearTimeout(refreshTimer);
    pending?.abort();
    const request = new AbortController();
    pending = request;
    retry.hidden = true;
    if (!forecast) {
      status.textContent = "選択地点の予測を読み込み中";
      scroller.hidden = true;
    }
    resize();
    try {
      const result = await readPointForecast(cell, {signal:request.signal, previous:forecast});
      if (!request.signal.aborted) {
        forecast = result;
        render(forecast);
      }
    } catch {
      if (!request.signal.aborted) {
        status.textContent = forecast
          ? `発表 ${timeLabel(forecast.issued)} · 最新の予測を取得できませんでした`
          : "選択地点の予測を取得できませんでした。";
        retry.hidden = false;
      }
    } finally {
      if (!request.signal.aborted) {
        pending = null;
        refreshTimer = setTimeout(load, LIVE_POLL_MS);
        resize();
      }
    }
  }

  toggle.addEventListener("click", () => setExpanded(body.hidden));
  close.addEventListener("click", () => {
    dismiss();
    map.getCanvas().focus({preventScroll:true});
  });
  retry.addEventListener("click", load);

  return {dismiss, select(lngLat) {
    const {lng, lat} = lngLat.wrap();
    const next = pointForecastCell(lng, lat);
    if (next && next.col === cell?.col && next.row === cell.row) {
      setExpanded(true);
      return;
    }
    dismiss();
    cell = next;
    const [x, y] = cell?.center ?? [lng, lat];
    heading.textContent = `地点の予測 · ${y.toFixed(3)}°, ${x.toFixed(3)}°`;
    marker.setLngLat(cell?.center ?? [lng, lat]).addTo(map);
    panel.hidden = false;
    scroller.scrollLeft = 0;
    setExpanded(true);
    if (cell) {
      void load();
    } else {
      scroller.hidden = true;
      retry.hidden = true;
      status.textContent = "この地点は予測データの対象範囲外です。";
    }
  }};
}
