import test from "node:test";
import assert from "node:assert/strict";
import {riskClass,riskSlots,projectRiskField,buildRiskData,RISK_RULES,RISK_LEVELS} from "../forecast-risk-data.js";
import {initForecastRisk} from "../forecast-risk-control.js";
import {setImmediate as nextTurn} from "node:timers/promises";

const dry=()=>Array.from({length:4},()=>({weather:1,precipitation:0}));
const wet=(index=0)=>dry().map((s,i)=>i===index?{weather:3,precipitation:1}:s);
test("current temperature uses inclusive 0/2°C, including precipitation six hours earlier",()=>{
  for(const [temperature,expected] of [[2,2],[2.01,1],[0,3],[-1,3],[.01,2]]) {
    assert.equal(riskClass(3,1,0,temperature,wet()),expected);
    assert.equal(riskClass(1,0,0,temperature,wet(2)),expected);
  }
  assert.equal(riskClass(1,0,0,-5,dry()),1);
  assert.equal(riskClass(1,0,0,5,[null,null,null,null]),1);
  assert.deepEqual(RISK_RULES.slice(2).map(r=>r.color),["#ffe032","#ff8c24","#ffb5b5","#e53232","#f35ea7","#8d38c9"]);
});

test("snow retains priority; unknown history is not dry, but confirmed rain is sufficient",()=>{
  for(const temperature of [-2,NaN,12]) {
    for(const [snow,expected] of [[0,4],[1,5],[2,5],[3,6],[5,6],[6,7]])assert.equal(riskClass(5,1,snow,temperature,[null,null,null,null]),expected);
  }
  assert.equal(riskClass(1,0,0,1,[null,...dry().slice(1)]),0);
  assert.equal(riskClass(3,1,0,1,[wet()[0],null,null,null]),2);
  assert.equal(riskClass(1,0,0,0,[null,null,wet()[0],null]),3);
  assert.equal(riskClass(1,0,0,1,[{weather:3,precipitation:-1},...dry().slice(1)]),2,"rain below 1 mm also establishes wet conditions");
  assert.equal(riskClass(1,0,0,1,[{weather:-1,precipitation:0},...dry().slice(1)]),0);
  assert.equal(riskClass(1,0,0,NaN,dry()),0);
  assert.equal(riskClass(5,1,-1,1,wet()),0);
  assert.equal(riskClass(-1,0,0,1,wet()),0);
  assert.equal(riskClass(1,-1,0,1,wet()),0);
});

const square=(x0,y0,x1,y1)=>[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]];
function collection(kind,shapes={}) {
  return {type:"FeatureCollection",features:Object.keys(RISK_LEVELS[kind]).map(level=>({type:"Feature",properties:{level},geometry:{type:"Polygon",coordinates:shapes[level] ?? []}}))};
}
const grid={count:4,rowScale:20,colScale:16,rows:new Uint16Array([700,700,701,701]),cols:new Uint16Array([2200,2201,2200,2201])};
const outer=square(137.5,35,137.625,35.1),hole=square(137.5,35,137.5625,35.05);
test("native-grid polygon projection preserves holes, disjoint parts and NoData masks",()=>{
  const rain=collection("precip3h",{"1<=mm<5":[outer,hole],NoData:[square(137.5625,35.05,137.625,35.1)]});
  assert.deepEqual([...projectRiskField(rain,grid,"precip3h")],[0,1,1,-1]);
  const weather=collection("weather3h",{Snow:[hole],Rain:[square(137.5625,35,137.625,35.05)]});
  assert.deepEqual([...projectRiskField(weather,grid,"weather3h")],[5,3,-1,-1]);
  const multi=collection("snow3h");multi.features.find(f=>f.properties.level==="6<=cm").geometry={type:"MultiPolygon",coordinates:[[hole],[square(137.5625,35.05,137.625,35.1)]]};
  assert.deepEqual([...projectRiskField(multi,grid,"snow3h")],[6,0,0,6]);
  assert.deepEqual([...projectRiskField(collection("snow3h"),grid,"snow3h")],[0,0,0,0]);
  const world=collection("snow3h",{NoData:[square(-45,-85,315,85).slice(0,-1),outer]});
  assert.deepEqual([...projectRiskField(world,grid,"snow3h")],[0,0,0,0],"JMA's unwrapped global NoData ring must preserve the Japan hole");
});

test("unknown categories, duplicate levels, broken rings and mismatched grids reject",()=>{
  const input=collection("snow3h");input.features[0].properties.level="new-code";
  assert.throws(()=>projectRiskField(input,grid,"snow3h"),/未知/);
  const duplicate=collection("snow3h");duplicate.features[0].properties.level="NoData";
  assert.throws(()=>projectRiskField(duplicate,grid,"snow3h"),/重複/);
  const open=collection("snow3h",{"6<=cm":[outer.slice(0,-1)]});
  assert.throws(()=>projectRiskField(open,grid,"snow3h"),/閉じて/);
  assert.throws(()=>projectRiskField(collection("snow3h"),{...grid,rowScale:120},"snow3h"),/格子/);
});

const target={basetime:"20261022080000",validtime:"20261023120000"};
function manifest() {
  const layers={};
  for(const kind of ["weather3h","precip3h","snow3h","temp3h"])layers[kind]={slots:Array.from({length:6},(_,i)=>{
    const date=new Date(Date.UTC(2026,9,23,12-i*3)),validtime=date.toISOString().replace(/[-:TZ.]/g,"").slice(0,14);
    return {id:`${kind}_${validtime}`,validtime,basetime:target.basetime,status:"available",target_date:new Date(date.valueOf()+9*3600000).toISOString().slice(0,10)};
  })};
  return {generated_at:"2026-10-22T08:05:00Z",layers};
}
test("the last forecast needs only its current temperature and exactly four preceding 3h periods",()=>{
  const m=manifest(),joined=riskSlots(m,target);
  assert.equal(joined.temperature.validtime,target.validtime);
  assert.deepEqual(joined.history.map(s=>s.validtime),["20261023120000","20261023090000","20261023060000","20261023030000"]);
  assert.equal(joined.history.some(s=>s.validtime==="20261023000000"),false,"a period ending exactly 12h earlier is outside the accumulated 12h window");
  m.layers.temp3h.slots=m.layers.temp3h.slots.slice(0,1);
  assert.equal(riskSlots(m,target).temperature.validtime,target.validtime,"no later temperature is requested at the forecast tail");
  m.layers.precip3h.slots.splice(2,1);assert.equal(riskSlots(m,target).history[2].precip3h,null);
  m.layers.snow3h.slots[0].basetime="20261022020000";
  assert.throws(()=>riskSlots(m,target),/一致/);
  const duplicate=manifest();duplicate.layers.weather3h.slots.push({...duplicate.layers.weather3h.slots[0]});
  assert.throws(()=>riskSlots(duplicate,target),/一致/);
  const wrong=manifest();wrong.layers.precip3h.slots[2].basetime="20261022020000";
  assert.equal(riskSlots(wrong,target).history[2].precip3h,null,"past periods from another issue must not fill the gap");
});

test("joined cells retain current temperature, history coverage, and their own snow priority",()=>{
  const weather=new Int16Array([3,5,5,1]),precipitation=new Int16Array([1,0,1,0]);
  const history=Array.from({length:4},()=>({weather,precipitation}));history[3]={weather:null,precipitation:null};
  const data=buildRiskData(grid,weather,precipitation,new Int16Array([0,0,6,0]),new Float32Array([1,8,-4,NaN]),history);
  assert.deepEqual([...data.classes],[2,4,7,0]);
  assert.deepEqual([...data.temperature].slice(0,3),[1,8,-4]);
  assert.deepEqual([...data.complete],[0,0,0,0]);
  assert.equal(data.counts.reduce((a,b)=>a+b),4);
  assert.throws(()=>buildRiskData(grid,weather,precipitation,new Int16Array(4),new Float32Array(3),history),/格子/);
});

test("changing targets while a shared history request is pending cannot strand loading or restore the old target",async()=>{
  class Element {
    constructor(){this.textContent="";this.dataset={};this.style={};this.handlers={};}
    addEventListener(name,fn){this.handlers[name]=fn;}
    replaceChildren(){} append(){} setAttribute(){}
  }
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const oldDocument=globalThis.document,oldFetch=globalThis.fetch;
  globalThis.document={getElementById:get,createElement:()=>new Element(),createTextNode:s=>s};
  const m=manifest();m.generated_at=new Date().toISOString();
  const rows=["longitude,latitude,forecast_c,source_date,target_date"];
  for(let row=600;row<763;row++)for(let col=2080;col<2272;col++)rows.push(`${(col+.5)/16},${(row+.5)/20},5,2026-10-22,2026-10-23`);
  const csv=rows.join("\n"),requests=[];
  let held=false,release,fail=false;
  const waiting=new Promise(resolve=>{release=resolve;});
  globalThis.fetch=async url=>{
    const file=new URL(url).pathname.split("/").at(-1);requests.push(file);
    if(!held && file==="forecast_weather3h_20261023030000_value.geojson"){held=true;await waiting;}
    if(fail)return {ok:false};
    if(file==="forecast_manifest.json")return {ok:true,text:async()=>JSON.stringify(m)};
    if(file.endsWith(".csv"))return {ok:true,text:async()=>csv};
    const kind=file.match(/^forecast_(weather3h|precip3h|snow3h)_/)[1];
    return {ok:true,text:async()=>JSON.stringify(collection(kind,kind==="weather3h"?{Clear:[square(129,29,143,39)]}:{}))};
  };
  async function until(predicate){for(let i=0;i<1000;i++){if(predicate())return;await nextTurn();}throw new Error("risk controller did not settle");}
  try {
    const controller=initForecastRisk();controller.setActive(true);
    controller.setTarget({...target,base:"2026-10-22T08:00:00Z",end:"2026-10-23T12:00:00Z"});
    await until(()=>held);
    controller.setTarget({...target,validtime:"20261023090000",base:"2026-10-22T08:00:00Z",end:"2026-10-23T09:00:00Z"});
    await until(()=>get("map").dataset.riskReady==="true");
    assert.equal(get("map").dataset.riskTarget,"2026-10-23T09:00:00Z");
    release();await nextTurn();await nextTurn();
    assert.equal(get("map").dataset.riskTarget,"2026-10-23T09:00:00Z");
    assert.equal(requests.some(file=>file.includes("temp3h_20261023150000")),false);
    fail=true;get("riskRefresh").handlers.click();await until(()=>get("riskStatus").dataset.state==="error");
    fail=false;get("riskRefresh").handlers.click();await until(()=>get("riskStatus").dataset.state==="ready");
    assert.equal(get("map").dataset.riskTarget,"2026-10-23T09:00:00Z");
    controller.setActive(false);
  } finally {release();globalThis.document=oldDocument;globalThis.fetch=oldFetch;}
});
