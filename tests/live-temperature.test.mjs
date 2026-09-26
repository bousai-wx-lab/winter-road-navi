import assert from "node:assert/strict";
import test from "node:test";
import {classForTemperature,decodeLiveCSV,liveSlots,liveFile,liveFreshness,utcTime,liveSlotKey,chooseLiveSlot} from "../live-temperature-data.js";
import {lookupCell} from "../temperature-layer.js";
import {mercatorPoint,splitSegment} from "../road-geometry.js";

const slot={id:"temp3h_20260926120000",target_date:"2026-09-26",validtime:"20260926120000",basetime:"20260926080000",status:"available"};
const header="longitude,latitude,display_c,forecast_c,observed_c,source_date,target_date";
function csv(values) {return header+"\n"+values.map((v,i)=>`${((2230+i+.5)/16).toFixed(5)},35.67500,999,${v},,,2026-09-26`).join("\n");}

test("live thresholds use raw numerical values, including all exact boundaries and missing",()=>{
  assert.deepEqual([-2,0,.01,2,2.01,5,5.01,NaN].map(classForTemperature),[4,4,3,3,2,2,1,0]);
  const decoded=decodeLiveCSV(csv([0,.01,2,2.01,5,5.01,""]),"temp3h",slot,7);
  assert.deepEqual([...decoded.classes],[4,3,3,2,2,1,0]);
  assert.equal(decoded.values[0],0);assert.ok(Number.isNaN(decoded.values[6]));
  assert.equal(decoded.grid.rowScale,20);assert.equal(decoded.grid.colScale,16);
  assert.equal(lookupCell(decoded.grid,2230/16+.03,35.675),0);
  assert.equal(lookupCell(decoded.grid,2231/16,35.675),1);
  assert.equal(lookupCell(decoded.grid,2230/16-.01,35.675),-1);
});
test("roads split at original approximately 5km edges, without 1km subdivisions",()=>{
  const data=decodeLiveCSV(csv([0,6]),"temp3h",slot,2);
  const a=mercatorPoint((2230+.25)/16,35.675),b=mercatorPoint((2231+.75)/16,35.675);
  const parts=splitSegment(a,b,data.grid);
  assert.deepEqual(parts.map(p=>p.cell),[0,1]);
  assert.ok(Math.abs(parts[0].b[0]-mercatorPoint(2231/16,35.675)[0])<1e-12);
});
test("CSV rejects wrong date, duplicate cells, empty coordinates, malformed values, count and off-grid values",()=>{
  for(const text of [csv([0,1]).replaceAll("2026-09-26","2026-09-27"),csv([0,1]).replace("139.46875","139.40625"),csv(["bad",1]),csv([0]),csv([0,1]).replace("139.40625","139.41000"),csv([0,1]).replace("139.40625","")]) {
    assert.throws(()=>decodeLiveCSV(text,"temp3h",slot,2));
  }
});
test("current and daily observed values preserve the observation time and ignore display/anomaly columns",()=>{
  const current={target_date:"2026-09-26",target_time:"2026-09-26T12:10:00+09:00"};
  const text=header+"\n139.40625,35.67500,999,,1.23,2026-09-26,2026-09-26T12:10:00+09:00";
  const result=decodeLiveCSV(text,"current",current,1);
  assert.equal(result.classes[0],3);assert.ok(Math.abs(result.values[0]-1.23)<1e-6);
  assert.throws(()=>decodeLiveCSV(text.replaceAll("12:10","12:00"),"current",current,1));
});
test("forecast slots retain unavailable today and reject traversal or misaligned UTC/JST dates",()=>{
  const unavailable={id:"today_min",target_date:"2026-09-26",status:"unavailable"};
  const manifest={generated_at:"2026-09-26T17:00:00+09:00",layers:{temp3h:{slots:[slot]},daily:{slots:[unavailable]}}};
  assert.equal(liveSlots(manifest,"temp3h")[0],slot);assert.equal(liveSlots(manifest,"daily")[0],unavailable);
  assert.throws(()=>liveFile("daily",unavailable));assert.throws(()=>liveFile("temp3h",{...slot,id:"../anything"}));
  assert.throws(()=>liveSlots({...manifest,layers:{temp3h:{slots:[{...slot,target_date:"2026-09-27"}]}}},"temp3h"));
  assert.throws(()=>utcTime("20260230000000"));
  assert.equal(liveFile("temp3h",slot),"forecast_temp3h_20260926120000_value.csv");
});
test("freshness, elapsed forecast and provisional observations are explicit",()=>{
  const manifest={generated_at:"2026-09-26T17:00:00+09:00",latest_time:"2026-09-26T17:20:00+09:00"};
  const now=Date.parse("2026-09-26T17:30:00+09:00");
  assert.equal(liveFreshness(manifest,"current",{},now),"");
  assert.match(liveFreshness(manifest,"current",{},now+3600000),/更新が遅れ/);
  assert.match(liveFreshness(manifest,"observed",{source:"realtime"},now),/暫定/);
  assert.match(liveFreshness(manifest,"temp3h",slot,now+4*3600000),/対象時刻を過ぎ/);
});

test("daily forecasts keep their date across the morning today/tomorrow rollover",()=>{
  const old={id:"tomorrow_min",target_date:"2026-09-27",element:"min",status:"available"};
  const rolled=[{...old,id:"today_min"},{...old,id:"tomorrow_min",target_date:"2026-09-28"}];
  assert.equal(chooseLiveSlot(rolled,{kind:"daily",id:old.id,target:liveSlotKey(old,"daily")}),rolled[0]);
  assert.equal(chooseLiveSlot(rolled,{kind:"daily",id:old.id,target:liveSlotKey(old,"daily"),followLatest:true}),rolled[1]);
  assert.equal(liveSlotKey({...old,target_time:"2026-09-27T09:00:00+09:00"},"observed"),liveSlotKey({...old,target_time:"2026-09-27T09:10:00+09:00"},"observed"));
});
