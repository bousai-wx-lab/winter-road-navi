import test from "node:test";
import assert from "node:assert/strict";
import { pointForecastCell, readPointForecast } from "../forecast-point-data.js";
import { RISK_LEVELS } from "../forecast-risk-data.js";

const now = () => Date.parse("2026-11-18T04:45:00Z");
const issued = "20261118020000";
const first = "20261118060000";
const last = "20261118090000";
const point = pointForecastCell(137.51, 35.01);

const slot = (kind, validtime, basetime = issued) => ({
  id:`${kind}_${validtime}`, validtime, basetime, status:"available", target_date:"2026-11-18",
});
const manifest = {
  generated_at:"2026-11-18T02:21:00Z",
  layers:{
    weather3h:{slots:[slot("weather3h", last), slot("weather3h", first)]},
    temp3h:{slots:[slot("temp3h", first, "20261117200000")]},
    precip3h:{slots:[slot("precip3h", first), slot("precip3h", last)]},
    snow3h:{slots:[slot("snow3h", first)]},
  },
};

const ring = [[137.5,35],[137.6,35],[137.6,35.1],[137.5,35.1],[137.5,35]];
function collection(kind, level) {
  return {type:"FeatureCollection", features:Object.keys(RISK_LEVELS[kind]).map(name => ({
    type:"Feature", properties:{level:name},
    geometry:{type:"Polygon", coordinates:name === level ? [ring] : []},
  }))};
}

function feed({changeAfterRead = false} = {}) {
  const files = {
    [`forecast_weather3h_${first}_value.geojson`]:collection("weather3h", "Snow"),
    [`forecast_weather3h_${last}_value.geojson`]:collection("weather3h", "Clear"),
    [`forecast_precip3h_${first}_value.geojson`]:collection("precip3h", "NoData"),
    [`forecast_snow3h_${first}_value.geojson`]:collection("snow3h"),
  };
  const requests = [];
  let manifestReads = 0;
  return {requests, async fetchImpl(url) {
    const name = new URL(url).pathname.split("/").at(-1);
    requests.push(name);
    if (name === "forecast_manifest.json") {
      manifestReads++;
      return Response.json(changeAfterRead && manifestReads > 1
        ? {...manifest, generated_at:"2026-11-18T03:00:00Z"} : manifest);
    }
    return files[name] ? Response.json(files[name]) : new Response(null, {status:404});
  }};
}

test("point lookup uses the native forecast cell and bounds", () => {
  assert.deepEqual(point, {col:2200, row:700, center:[137.53125,35.025]});
  assert.equal(pointForecastCell(150, 35), null);
  assert.equal(pointForecastCell(137.5, NaN), null);
});

test("point forecast keeps chronological periods, known ranges and missing fields separate", async () => {
  const {requests, fetchImpl} = feed();
  const result = await readPointForecast(point, {fetchImpl, now});
  assert.equal(result.issued, Date.parse("2026-11-18T02:00:00Z"));
  assert.deepEqual(result.series.map(period => period.values), [
    ["雪", null, null, "1未満"], ["晴れ", null, null, null],
  ]);
  assert.equal(result.incomplete, true);
  assert.ok(requests.every(path => !path.startsWith("forecast_temp3h_")), "another issue must not fill a missing field");
});

test("point forecast drops mixed updates and respects a cancelled selection", async () => {
  await assert.rejects(readPointForecast(point, {...feed({changeAfterRead:true}), now}), /予報が更新/);
  const controller = new AbortController();
  const fixture = feed();
  controller.abort();
  await assert.rejects(readPointForecast(point, {...fixture, now, signal:controller.signal}), {name:"AbortError"});
  assert.deepEqual(fixture.requests, []);
});
