import { paletteColor } from "./temperature-layer.js";

const weatherColors = {"晴れ":"weather-sun", "くもり":"weather-cloud", "雨":"weather-rain", "雨または雪":"weather-mix", "雪":"weather-snow"};
const rainColors = {"1未満":"weather-table-low", "1〜4":"amount-1", "5〜9":"amount-5", "10〜14":"amount-10", "15〜19":"amount-15", "20以上":"amount-20"};
const snowColors = {"1未満":"weather-table-low", "1〜2":"amount-1", "3〜5":"amount-5", "6以上":"amount-10"};
const categoryColors = {weather3h:weatherColors, precip3h:rainColors, snow3h:snowColors};

export function weatherTableAmount(weather, value) {
  return weather === "晴れ" || weather === "くもり" ? "—" : value;
}

export function colorWeatherCell(entry, kind, value) {
  if (value === "—") {
    entry.classList.add("weather-table-low");
  } else if (value === null) {
    entry.classList.add("weather-table-missing");
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
