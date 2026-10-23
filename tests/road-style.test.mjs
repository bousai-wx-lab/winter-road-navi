import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_TILE_URL,
  JAPAN_VIEW,
  GENERAL_ROAD_FILTER,
  HIGHWAY_FILTER,
  ROAD_TILE_URL,
  classifyRoad,
  createMapStyle,
} from "../road-style.js";

test("the style uses only the approved GSI tile host", () => {
  for (const url of [BASE_TILE_URL, ROAD_TILE_URL]) {
    assert.equal(new URL(url.replace("{z}", "5").replace("{x}", "28").replace("{y}", "12")).hostname, "cyberjapandata.gsi.go.jp");
    assert.equal(url.startsWith("https://"), true);
  }
});

test("the default extent contains Hokkaido and Kyushu, with a basemap available on wider zooms", () => {
  const [[west, south], [east, north]] = JAPAN_VIEW.bounds;
  for (const [lng, lat] of [[141.65, 45.5], [145.82, 43.38], [130.67, 30.99], [129.48, 31.62]]) {
    assert.ok(lng > west && lng < east && lat > south && lat < north);
  }
  const style = createMapStyle();
  assert.ok(style.sources.background.minzoom <= 2.5);
  assert.ok(style.layers.find(l => l.id === "background-map").minzoom <= 2.5);
});

test("highways and general roads are distinct source-layer road groups", () => {
  const style = createMapStyle();
  const layers = Object.fromEntries(style.layers.map((layer) => [layer.id, layer]));
  assert.deepEqual(layers.highway.filter, HIGHWAY_FILTER);
  assert.deepEqual(layers["general-road"].filter, GENERAL_ROAD_FILTER);
  assert.equal(layers.highway["source-layer"], "road");
  assert.equal(layers["general-road"]["source-layer"], "road");
  assert.equal(layers.highway.source, "roads");
  assert.equal(layers["general-road"].source, "roads");
  assert.notEqual(layers.highway.paint["line-color"], layers["general-road"].paint["line-color"]);
  assert.equal(layers.highway.minzoom, 4);
  assert.equal(layers["highway-casing"].minzoom, 4);
  assert.equal(layers["general-road"].minzoom, 5);
});

test("road classification covers low and high zoom GSI attributes", () => {
  for (const properties of [
    { motorway: 1, ftCode: 2701 },
    { rdCtg: 3, ftCode: 2704 },
    { ftCode: 52703 },
    { ftCode: "52704" },
  ]) {
    assert.equal(classifyRoad(properties), "highway");
  }
  for (const properties of [
    { motorway: 0, rdCtg: 0, ftCode: 2701 },
    { motorway: 0, rdCtg: 1, ftCode: 2704 },
    { ftCode: 52701 },
    { ftCode: "52702" },
    {},
  ]) {
    assert.equal(classifyRoad(properties), "general");
  }
});

test("style has no third-party glyph, sprite, terrain, or analytics source", () => {
  const style = createMapStyle();
  assert.equal(style.glyphs, undefined);
  assert.equal(style.sprite, undefined);
  assert.equal(style.terrain, undefined);
  assert.deepEqual(Object.keys(style.sources).sort(), ["background", "roads"].sort());
});
