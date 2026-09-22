import {
  TEMPERATURE_DAY_COUNT,
  TEMPERATURE_STATIONS,
  TEMPERATURE_VALUE_SCALE,
  TEMPERATURE_VALUES_BASE64,
} from "./temperature-data.js";

export const TEMPERATURE_LAYER_IDS = Object.freeze(["temperature-normal-halo", "temperature-normal-core"]);
export const MONTH_LENGTHS = Object.freeze([31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
export const TEMPERATURE_COLOR_STOPS = Object.freeze([
  [-30, "#281052"],
  [-20, "#3a3f9e"],
  [-10, "#397fd0"],
  [0, "#80d9eb"],
  [10, "#e8f4cf"],
  [20, "#ffc36d"],
  [30, "#ef6b5b"],
]);

export function normalizeDayIndex(value) {
  const number = Number(value);
  const integer = Number.isFinite(number) ? Math.trunc(number) : 0;
  return ((integer % TEMPERATURE_DAY_COUNT) + TEMPERATURE_DAY_COUNT) % TEMPERATURE_DAY_COUNT;
}

export function getCalendarDate(dayIndex) {
  let remaining = normalizeDayIndex(dayIndex);
  for (let month = 0; month < MONTH_LENGTHS.length; month += 1) {
    if (remaining < MONTH_LENGTHS[month]) {
      return { month: month + 1, day: remaining + 1 };
    }
    remaining -= MONTH_LENGTHS[month];
  }
  return { month: 1, day: 1 };
}

export function formatCalendarDate(dayIndex) {
  const { month, day } = getCalendarDate(dayIndex);
  return `${month}月${day}日`;
}

export function decodeTemperatureValues(encoded = TEMPERATURE_VALUES_BASE64) {
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const expectedBytes = TEMPERATURE_STATIONS.length * TEMPERATURE_DAY_COUNT * 2;
  if (bytes.length !== expectedBytes) {
    throw new Error(`temperature payload length mismatch: ${bytes.length} != ${expectedBytes}`);
  }
  const values = new Int16Array(bytes.length / 2);
  for (let index = 0; index < values.length; index += 1) {
    const unsigned = bytes[index * 2] | (bytes[index * 2 + 1] << 8);
    values[index] = unsigned > 32767 ? unsigned - 65536 : unsigned;
  }
  return values;
}

export function buildTemperatureFeatures(values, dayIndex) {
  const normalizedDay = normalizeDayIndex(dayIndex);
  return {
    type: "FeatureCollection",
    features: TEMPERATURE_STATIONS.map((station, stationIndex) => ({
      type: "Feature",
      id: station.id,
      geometry: { type: "Point", coordinates: [station.lon, station.lat] },
      properties: {
        station: station.name,
        altitude: station.alt,
        temperature: values[stationIndex * TEMPERATURE_DAY_COUNT + normalizedDay] * TEMPERATURE_VALUE_SCALE,
      },
    })),
  };
}

export function temperatureColorExpression() {
  return [
    "interpolate",
    ["linear"],
    ["get", "temperature"],
    ...TEMPERATURE_COLOR_STOPS.flat(),
  ];
}
