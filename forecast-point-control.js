import { LIVE_POLL_MS, timeLabel } from "./live-temperature-data.js";
import { forecastTickLabel } from "./forecast-timeline.js?v=20261118-point-time1";
import { POINT_FORECAST_FIELDS, forecastMunicipality, pointForecastCell, readPointForecast } from "./forecast-point-data.js?v=20261118-point-time1";
import { paletteColor } from "./temperature-layer.js";

const weatherColors = {"晴れ":"weather-sun", "くもり":"weather-cloud", "雨":"weather-rain", "雨または雪":"weather-mix", "雪":"weather-snow"};
const rainColors = {"1未満":"forecast-point-low", "1〜4":"amount-1", "5〜9":"amount-5", "10〜14":"amount-10", "15〜19":"amount-15", "20以上":"amount-20"};
const snowColors = {"1未満":"forecast-point-low", "1〜2":"amount-1", "3〜5":"amount-5", "6以上":"amount-10"};
const categoryColors = {weather3h:weatherColors, precip3h:rainColors, snow3h:snowColors};

function colorValue(entry, kind, value) {
  if (value === null) {
    entry.classList.add("forecast-point-missing");
  } else if (kind === "temp3h") {
    const color = paletteColor(Math.min(81, Math.max(1, Math.floor(Number(value)) + 41)));
    const [r, g, b] = color.slice(1).match(/../g).map(pair => {
      const channel = parseInt(pair, 16) / 255;
      return channel < .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    });
    entry.style.backgroundColor = color;
    entry.style.color = .2126 * r + .7152 * g + .0722 * b > .179 ? "#000" : "#fff";
  } else {
    const color = categoryColors[kind][value];
    if (color) entry.classList.add(color);
  }
}

export function initForecastPoint(map, Marker, onChooseTime) {
  const panel = document.getElementById("forecastPoint");
  const body = document.getElementById("forecastPointBody");
  const place = document.getElementById("forecastPointPlace");
  const coordinates = document.getElementById("forecastPointCoordinates");
  const issued = document.getElementById("forecastPointIssued");
  const notice = document.getElementById("forecastPointNotice");
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
  let municipalityIndex = null;
  let mapTime = {selectedEnd:null, availableEnds:new Set()};
  const columns = new Map();

  function resize() {
    requestAnimationFrame(() => map.resize());
  }

  function setExpanded(expanded) {
    body.hidden = !expanded;
    toggle.setAttribute("aria-expanded", String(expanded));
    const label = expanded ? "折りたたむ" : "展開する";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    toggle.textContent = expanded ? "▼" : "▶";
    resize();
    if (expanded) revealSelectedTime();
  }

  function dismiss() {
    pending?.abort();
    pending = null;
    clearTimeout(refreshTimer);
    cell = null;
    forecast = null;
    columns.clear();
    marker.remove();
    if (!panel.hidden) {
      panel.hidden = true;
      resize();
    }
  }

  function report(message, retryAvailable = false) {
    status.textContent = message;
    retry.hidden = !retryAvailable;
    notice.hidden = !message && !retryAvailable;
  }

  function showMunicipality(selection) {
    municipalityIndex ??= fetch("./data/forecast-municipalities.json?v=20260101", {credentials:"omit", referrerPolicy:"no-referrer"})
      .then(response => {
        if (!response.ok) throw new Error("市区町村資料を取得できません");
        return response.json();
      })
      .catch(() => {
        municipalityIndex = null;
        return null;
      });
    void municipalityIndex.then(index => {
      if (cell === selection) place.textContent = forecastMunicipality(index, selection);
    });
  }

  function revealSelectedTime() {
    const button = columns.get(mapTime.selectedEnd)?.button;
    if (!button || body.hidden || panel.hidden || scroller.hidden) return;
    const bounds = button.getBoundingClientRect();
    const left = table.tHead.rows[0].cells[0].getBoundingClientRect().right;
    const right = scroller.getBoundingClientRect().right;
    if (bounds.left < left) scroller.scrollLeft -= left - bounds.left;
    else if (bounds.right > right) scroller.scrollLeft += bounds.right - right;
  }

  function syncTime(selection, reveal = mapTime.selectedEnd !== selection.selectedEnd) {
    mapTime = selection;
    for (const [end, {button, cells}] of columns) {
      const selected = end === selection.selectedEnd;
      button.disabled = !selection.availableEnds.has(end);
      button.title = button.disabled ? "地図にこの時刻の予測資料がありません" : button.getAttribute("aria-label");
      button.setAttribute("aria-pressed", String(selected));
      for (const entry of cells) entry.classList.toggle("forecast-point-selected", selected);
    }
    if (reveal) revealSelectedTime();
  }

  function render({issued:issueTime, series, incomplete}) {
    issued.textContent = `発表 ${timeLabel(issueTime)}`;
    report(incomplete ? "一部の資料を取得できませんでした。" : "", incomplete);
    columns.clear();
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
        if (column === 0) {
          entry.textContent = value;
        } else {
          const period = series[column - 1];
          if (index === 0) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = value;
            button.setAttribute("aria-label", `${timeLabel(period.end)}の予測を地図に表示`);
            button.addEventListener("click", () => onChooseTime(period.end));
            columns.set(period.end, {button, cells:[]});
            entry.append(button);
          } else {
            entry.textContent = value;
            colorValue(entry, POINT_FORECAST_FIELDS[index - 1][0], period.values[index - 1]);
          }
          columns.get(period.end).cells.push(entry);
        }
        row.append(entry);
      }
    }
    table.replaceChildren(...sections);
    scroller.hidden = false;
    syncTime(mapTime, true);
  }

  async function load() {
    if (!cell) return;
    clearTimeout(refreshTimer);
    pending?.abort();
    const request = new AbortController();
    pending = request;
    if (!forecast) {
      report("選択地点の予測を読み込み中");
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
        report(forecast ? "最新の予測を取得できませんでした。" : "選択地点の予測を取得できませんでした。", true);
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

  return {dismiss, syncTime, select(lngLat) {
    const {lng, lat} = lngLat.wrap();
    const next = pointForecastCell(lng, lat);
    if (next && next.col === cell?.col && next.row === cell.row) {
      setExpanded(true);
      return;
    }
    dismiss();
    cell = next;
    const [x, y] = cell?.center ?? [lng, lat];
    place.textContent = "";
    issued.textContent = "";
    coordinates.textContent = `${y.toFixed(3)}°, ${x.toFixed(3)}°`;
    marker.setLngLat(cell?.center ?? [lng, lat]).addTo(map);
    panel.hidden = false;
    scroller.scrollLeft = 0;
    setExpanded(true);
    if (cell) {
      showMunicipality(cell);
      void load();
    } else {
      scroller.hidden = true;
      report("この地点は予測データの対象範囲外です。");
    }
  }};
}
