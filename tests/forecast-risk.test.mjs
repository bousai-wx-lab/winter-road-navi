import test from "node:test";
import assert from "node:assert/strict";
import {riskClass,riskSlots,projectRiskField,buildRiskData,RISK_RULES,RISK_LEVELS} from "../forecast-risk-data.js";

const full=t=>[8,7,6,5,t];
test("the requested road colours use inclusive 0/2°C and 1/3/6cm boundaries",()=>{
  const cases=[
    [3,1,0,full(2),2],[3,1,0,full(2.01),1],[3,1,0,full(0),3],
    [3,1,0,full(-1),3],[3,1,0,full(.01),2],
    [5,0,0,full(10),4],[5,0,1,full(10),5],[5,1,2,full(0),5],
    [5,0,3,full(0),6],[5,0,5,full(0),6],[5,0,6,full(0),7],
    [1,0,0,full(-5),1],[3,0,0,full(2),2],[4,0,0,full(0),3],
  ];
  for(const [w,p,s,t,expected] of cases)assert.equal(riskClass(w,p,s,t),expected,JSON.stringify([w,p,s,t]));
  assert.deepEqual(RISK_RULES.slice(2).map(r=>r.color),["#ffe032","#ff8c24","#ffb5b5","#e53232","#f35ea7","#8d38c9"]);
});

test("snow has priority, incomplete cold coverage stays unknown unless 0°C is established",()=>{
  for(const temperatures of [full(-2),[NaN,NaN,NaN,NaN,NaN],full(12)]) {
    for(const [snow,expected] of [[1,5],[3,6],[6,7]])assert.equal(riskClass(5,1,snow,temperatures),expected);
    assert.equal(riskClass(5,1,0,temperatures),4);
  }
  assert.equal(riskClass(3,1,0,[1,2,3,4,NaN]),0);
  assert.equal(riskClass(3,1,0,[10,10,10,10,NaN]),0);
  assert.equal(riskClass(3,1,0,[0,10,NaN,NaN,NaN]),3);
  assert.equal(riskClass(5,1,-1,full(1)),0,"no-data snowfall must not become the pale-red low-snow class");
  assert.equal(riskClass(-1,0,0,full(1)),0);
  assert.equal(riskClass(1,-1,0,full(1)),0);
  assert.equal(riskClass(1,0,0,[NaN,NaN,NaN,NaN,NaN]),1,"dry weather needs no future cold test");
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

const target={basetime:"20261023080000",validtime:"20261023120000"};
function manifest() {
  const layers={};
  for(const kind of ["weather3h","precip3h","snow3h"])layers[kind]={slots:[{...target,id:`${kind}_${target.validtime}`,status:"available"}]};
  layers.temp3h={slots:Array.from({length:5},(_,i)=>{
    const validtime=new Date(Date.UTC(2026,9,23,12+i*3)).toISOString().replace(/[-:TZ.]/g,"").slice(0,14);
    return {id:`temp3h_${validtime}`,validtime,basetime:target.basetime,status:"available",target_date:new Date(Date.UTC(2026,9,23,21+i*3)).toISOString().slice(0,10)};
  })};
  return {generated_at:"2026-10-23T08:05:00Z",layers};
}
test("the same issue and UTC target are joined, with exactly end/+3/+6/+9/+12 hours",()=>{
  const m=manifest(),joined=riskSlots(m,target);
  assert.deepEqual(joined.temperatures.map(s=>s.validtime),["20261023120000","20261023150000","20261023180000","20261023210000","20261024000000"]);
  m.layers.temp3h.slots.pop();assert.equal(riskSlots(m,target).temperatures[4],null);
  m.layers.snow3h.slots[0].basetime="20261023020000";
  assert.throws(()=>riskSlots(m,target),/一致/);
  const duplicate=manifest();duplicate.layers.weather3h.slots.push({...duplicate.layers.weather3h.slots[0]});
  assert.throws(()=>riskSlots(duplicate,target),/一致/);
});

test("joined cells retain their own conditions, coverage and minimum temperature",()=>{
  const data=buildRiskData(grid,new Int16Array([3,5,5,1]),new Int16Array([1,0,1,0]),new Int16Array([0,0,6,0]),Array.from({length:5},()=>new Float32Array([2,8,-4,NaN])));
  assert.deepEqual([...data.classes],[2,4,7,1]);
  assert.deepEqual([...data.minimum].slice(0,3),[2,8,-4]);
  assert.deepEqual([...data.complete],[1,1,1,0]);
  assert.equal(data.counts.reduce((a,b)=>a+b),4);
});
