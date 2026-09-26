import test from "node:test";
import assert from "node:assert/strict";
import {weatherSlots,weatherTile,weatherNotice} from "../weather-data.js";
test("official weather slots keep observation instants and forecast three-hour intervals distinct",()=>{
  const observed=weatherSlots([{basetime:"20260926110000",validtime:"20260926110000",elements:["wthr"]}],"observed")[0];
  assert.equal(observed.end,"2026-09-26T11:00:00Z");assert.equal(observed.start,observed.end);
  const forecast=weatherSlots([{basetime:"20260926080000",validtime:"20260927000000",elements:["wm"]},{basetime:"20260926080000",validtime:"20260926090000",elements:["temp"]}],"forecast")[0];
  assert.equal(forecast.start,"2026-09-26T21:00:00.000Z");assert.equal(forecast.end,"2026-09-27T00:00:00Z");assert.match(forecast.label,/6:00.*9:00/);
  assert.throws(()=>weatherSlots([{basetime:"20260926100000",validtime:"20260926110000",elements:["wthr"]}],"observed"));
  assert.throws(()=>weatherSlots([{basetime:"20260230000000",validtime:"20260230000000",elements:["wthr"]}],"observed"));
});
test("tile grids preserve the distinct 512-pixel observed and 256-pixel forecast coordinates",()=>{
  const slot={basetime:"20260926110000",validtime:"20260926110000"};
  const obs=weatherTile("observed",slot,6),fcst=weatherTile("forecast",slot,6);
  assert.equal(obs.nativeZoom,5);assert.equal(obs.tileSize,512);assert.match(obs.url,/suikeikishou.*surf\/wthr\/6\/\{x\}\/\{y\}/);
  assert.equal(fcst.nativeZoom,6);assert.equal(fcst.tileSize,256);assert.match(fcst.url,/wdist.*surf\/wm\/6\/\{x\}\/\{y\}/);
  assert.throws(()=>weatherTile("observed",slot,5));assert.throws(()=>weatherTile("observed",{...slot,basetime:"../../bad"},4));
});
test("old observation, expired forecast interval and old forecast issue have visible notices",()=>{
  const slot={base:"2026-09-26T08:00:00Z",end:"2026-09-26T11:00:00Z"};
  assert.equal(weatherNotice("observed",slot,Date.parse("2026-09-26T12:00:00Z")),"");
  assert.match(weatherNotice("observed",slot,Date.parse("2026-09-26T14:00:00Z")),/遅れ/);
  assert.match(weatherNotice("forecast",slot,Date.parse(slot.end)),/過ぎ/);
});
