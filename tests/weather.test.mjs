import test from "node:test";
import assert from "node:assert/strict";
import {weatherSlots,weatherTile,weatherNotice,weatherProduct} from "../weather-data.js";
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
test("three-hour amounts select their own official elements and preserve intervals, units and native grids",()=>{
  const rows=[
    {basetime:"20261010080000",validtime:"20261010120000",elements:["r3","s3","wm"]},
    {basetime:"20261010080000",validtime:"20261010150000",elements:["r3","wm"]},
    {basetime:"20261010080000",validtime:"20261010180000",elements:["temp"]},
  ];
  const rain=weatherSlots(rows,"forecast","precipitation"),snow=weatherSlots(rows,"forecast","snowfall");
  assert.equal(rain.length,2);assert.equal(snow.length,1);
  assert.equal(rain[0].start,"2026-10-10T09:00:00.000Z");assert.equal(rain[0].end,"2026-10-10T12:00:00Z");
  assert.match(rain[0].label,/18:00.*21:00/);
  for(const [view,element,unit] of [["precipitation","r3","mm/3h"],["snowfall","s3","cm/3h"]]) {
    assert.equal(weatherProduct("forecast",view).unit,unit);
    for(const zoom of [4,6,8,10]) {
      const tile=weatherTile("forecast",rain[0],zoom,view);
      assert.equal(tile.nativeZoom,zoom);assert.equal(tile.tileSize,256);
      assert.equal(tile.url,`https://www.jma.go.jp/bosai/jmatile/data/wdist/20261010080000/none/20261010120000/surf/${element}/${zoom}/{x}/{y}.png`);
    }
    assert.throws(()=>weatherSlots(rows,"observed",view));
    assert.throws(()=>weatherSlots([{...rows[0],elements:["temp"]}],"forecast",view));
    assert.throws(()=>weatherSlots([rows[0],rows[0]],"forecast",view));
  }
});
