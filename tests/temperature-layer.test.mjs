import assert from "node:assert/strict";
import test from "node:test";

import {
  TEMPERATURE_DAY_COUNT,
  TEMPERATURE_PROVENANCE,
  TEMPERATURE_STATIONS,
} from "../temperature-data.js";
import {
  buildTemperatureFeatures,
  decodeTemperatureValues,
  formatCalendarDate,
  getCalendarDate,
  normalizeDayIndex,
  temperatureColorExpression,
} from "../temperature-layer.js";
import { createMapStyle } from "../road-style.js";

test("temperature payload is complete for 180 stations and 366 calendar days", () => {
  const values = decodeTemperatureValues();
  assert.equal(TEMPERATURE_STATIONS.length, 180);
  assert.equal(TEMPERATURE_DAY_COUNT, 366);
  assert.equal(values.length, 180 * 366);
  assert.equal(TEMPERATURE_PROVENANCE.statistics_period, "1991-2020");
  assert.equal(TEMPERATURE_PROVENANCE.element, "daily minimum temperature normal");
});

test("calendar navigation includes leap day and wraps exactly", () => {
  assert.deepEqual(getCalendarDate(0), { month: 1, day: 1 });
  assert.equal(formatCalendarDate(59), "2月29日");
  assert.equal(formatCalendarDate(365), "12月31日");
  assert.equal(normalizeDayIndex(-1), 365);
  assert.equal(normalizeDayIndex(366), 0);
});

test("feature builder keeps station geometry fixed and changes only daily values", () => {
  const values = decodeTemperatureValues();
  const january = buildTemperatureFeatures(values, 0);
  const august = buildTemperatureFeatures(values, 213);
  assert.equal(january.features.length, 180);
  assert.deepEqual(january.features[0].geometry, august.features[0].geometry);
  assert.notEqual(january.features[0].properties.temperature, august.features[0].properties.temperature);
  for (const feature of january.features) {
    assert.equal(Number.isFinite(feature.properties.temperature), true);
    assert.equal(feature.geometry.coordinates.length, 2);
  }
});

test("map keeps a fixed temperature scale below both road groups", () => {
  const expression = temperatureColorExpression();
  assert.deepEqual(expression.slice(0, 3), ["interpolate", ["linear"], ["get", "temperature"]]);
  const style = createMapStyle({ type: "FeatureCollection", features: [] });
  const layerIds = style.layers.map((layer) => layer.id);
  assert.ok(layerIds.indexOf("temperature-normal-core") < layerIds.indexOf("general-road"));
  assert.ok(layerIds.indexOf("temperature-normal-core") < layerIds.indexOf("highway"));
  assert.equal(style.sources.temperatureNormals.type, "geojson");
});
