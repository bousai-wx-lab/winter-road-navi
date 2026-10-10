import test from "node:test";
import assert from "node:assert/strict";
import {setImmediate as nextTurn} from "node:timers/promises";
import {initForecastTimeline,forecastTickLabel} from "../forecast-timeline.js";
import {initWeather} from "../weather-control.js";

class Element {
  constructor(){this.value="";this.textContent="";this.hidden=false;this.disabled=false;this.dataset={};this.handlers={};this.children=[];this.style={};}
  addEventListener(name,fn){this.handlers[name]=fn;}
  replaceChildren(...children){this.children=children;}
  append(child){this.children.push(child);}
  setAttribute(name,value){this[name]=value;}
  emit(name){this.handlers[name]?.();}
}
async function until(fn){for(let i=0;i<1000;i++){if(fn())return;await nextTurn();}throw new Error("timeline did not settle");}

test("forecast ticks use JST and preserve the midnight day boundary",()=>{
  assert.equal(forecastTickLabel("2026-10-05T12:00:00Z"),"5日21時");
  assert.equal(forecastTickLabel("2026-10-05T15:00:00Z"),"6日00時");
});

test("map forecast timeline and existing weather controls share native slots through navigation, refresh, failures and late responses",async()=>{
  const saved=Object.fromEntries(["document","fetch","Option","setInterval","clearInterval","requestAnimationFrame"].map(k=>[k,globalThis[k]]));
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  get("weatherOpacity").value="75";
  globalThis.document={getElementById:get,createElement:()=>new Element(),hidden:false,addEventListener(){}};
  globalThis.Option=class{constructor(label,value){this.label=label;this.value=value;}};
  globalThis.setInterval=()=>1;globalThis.clearInterval=()=>{};globalThis.requestAnimationFrame=fn=>fn();
  const map={sources:new Map(),layers:new Map(),handlers:{},resizes:0,resize(){this.resizes++;},on(name,fn){this.handlers[name]=fn;},
    addSource(id,source){this.sources.set(id,source);},getSource(id){return this.sources.get(id);},removeSource(id){this.sources.delete(id);},isSourceLoaded(){return true;},
    addLayer(layer){this.layers.set(layer.id,layer);},getLayer(id){return this.layers.get(id);},removeLayer(id){this.layers.delete(id);}};
  let records=["20990101030000","20990101060000","20990101090000"].map(validtime=>({validtime,basetime:"20990101000000",elements:["wm","r3","s3"]}));
  let fail=false,holdNext=null;
  globalThis.fetch=async()=>{const held=holdNext;holdNext=null;if(held)await held;return {ok:!fail,text:async()=>JSON.stringify(records)};};
  let timeline=null,controller=null;
  controller=initWeather(map,{onChange:()=>timeline?.render()});
  timeline=initForecastTimeline(map,()=>controller);
  try {
    timeline.setVisible(true);controller.setActive(true,"forecast");await until(()=>get("map").dataset.weatherReady==="true");
    assert.equal(get("forecastTimeRange").max,"2");assert.equal(get("forecastTimeRange").value,"0");
    assert.equal(get("forecastTimePrevious").disabled,true);assert.equal(get("forecastTimeNext").disabled,false);
    assert.equal(get("forecastTimeTicks").children.length,3);assert.match(get("forecastTimeLabel").textContent,/9:00.*12:00/);
    get("forecastTimeRange").value="1";get("forecastTimeRange").emit("input");
    assert.equal(get("weatherSlot").value,records[1].validtime);
    await until(()=>get("map").dataset.weatherTarget==="2099-01-01T06:00:00Z");
    assert.equal(get("forecastTimeTicks").children[1]["aria-current"],"true");
    get("forecastTimeNext").emit("click");await until(()=>get("forecastTimeNext").disabled);
    assert.equal(get("weatherSlot").value,records[2].validtime);
    get("weatherSlot").value=records[0].validtime;get("weatherSlot").emit("change");
    assert.equal(get("forecastTimeRange").value,"0");
    await until(()=>get("map").dataset.weatherReady==="true");
    get("forecastTimeTicks").children[2].emit("click");await until(()=>get("map").dataset.weatherTarget==="2099-01-01T09:00:00Z");
    get("forecastTimePrevious").emit("click");await until(()=>get("map").dataset.weatherTarget==="2099-01-01T06:00:00Z");
    let release;holdNext=new Promise(r=>release=r);
    get("forecastTimeRange").value="0";get("forecastTimeRange").emit("input");
    get("forecastTimeRange").value="2";get("forecastTimeRange").emit("input");
    await until(()=>get("map").dataset.weatherTarget==="2099-01-01T09:00:00Z");release();await nextTurn();
    assert.equal(get("forecastTimeRange").value,"2");assert.equal(get("weatherSlot").value,records[2].validtime);
    let releaseWeather;holdNext=new Promise(r=>releaseWeather=r);
    get("weatherRefresh").emit("click");controller.setActive(true,"forecast","precipitation");
    await until(()=>get("map").dataset.weatherElement==="r3" && get("map").dataset.weatherReady==="true");
    releaseWeather();await nextTurn();
    assert.equal(get("map").dataset.weatherElement,"r3");assert.equal(get("weatherSlot").value,records[2].validtime);
    assert.equal(get("forecastTimeRange").value,"2");assert.match(get("weatherUpdated").textContent,/mm\/3h/);
    assert.equal(get("precipitationLegend").hidden,false);assert.equal(get("weatherLegend").hidden,true);
    assert.equal([...map.sources.values()].every(s=>s.tiles[0].includes("/surf/r3/")),true);
    controller.setActive(true,"forecast","snowfall");await until(()=>get("map").dataset.weatherElement==="s3");
    assert.equal(get("forecastTimeRange").value,"2");assert.match(get("weatherUpdated").textContent,/cm\/3h/);
    assert.equal(get("snowfallLegend").hidden,false);assert.equal(get("precipitationLegend").hidden,true);
    assert.match(get("weatherDescription").textContent,/積雪深ではありません/);
    get("forecastTimePrevious").emit("click");await until(()=>get("map").dataset.weatherTarget==="2099-01-01T06:00:00Z");
    const sourceId=[...map.sources.keys()][0];map.handlers.error({sourceId});
    assert.equal(map.sources.size,0);assert.equal(get("map").dataset.weatherElement,undefined);
    assert.equal(get("weatherStatus").dataset.state,"error");assert.match(get("weatherStatus").textContent,/降雪量/);
    // A missing snowfall family is unavailable, rather than a zero forecast or an old rain image.
    records=records.map(row=>({...row,elements:["wm","r3"]}));get("weatherRefresh").emit("click");
    await until(()=>get("weatherStatus").dataset.state==="error");await nextTurn();
    assert.equal(map.sources.size,0);assert.equal(get("map").dataset.weatherTarget,undefined);
    records=records.map(row=>({...row,elements:["wm","r3","s3"]}));controller.setActive(true,"forecast","weather");
    await until(()=>get("map").dataset.weatherElement==="wm");
    get("forecastTimeTicks").children[2].emit("click");await until(()=>get("map").dataset.weatherTarget==="2099-01-01T09:00:00Z");
    records=records.slice(1);get("weatherRefresh").emit("click");await until(()=>get("forecastTimeRange").max==="1");
    assert.equal(get("forecastTimeRange").value,"1");
    fail=true;get("weatherRefresh").emit("click");await until(()=>get("weatherStatus").dataset.state==="error");
    assert.equal(get("map").dataset.weatherTarget,undefined);
    fail=false;get("forecastTimePrevious").emit("click");await until(()=>get("map").dataset.weatherReady==="true");
    assert.equal(get("forecastTimeRange").value,"0");
    timeline.setVisible(false);controller.setActive(false);assert.equal(get("forecastTimeline").hidden,true);assert.equal(map.resizes,2);
    controller.choose(records[1].validtime);await nextTurn();assert.equal(get("map").dataset.weatherTarget,undefined);
  }finally{controller.setActive(false);Object.assign(globalThis,saved);}
});

test("empty and single-slot forecasts are readable with disabled navigation",()=>{
  const saved={document:globalThis.document,requestAnimationFrame:globalThis.requestAnimationFrame};
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  globalThis.document={getElementById:get,createElement:()=>new Element()};globalThis.requestAnimationFrame=fn=>fn();
  let state={selected:null,slots:[]};const timeline=initForecastTimeline({resize(){}},()=>({timeline:()=>state}));
  try {
    timeline.setVisible(true);assert.equal(get("forecastTimeRange").disabled,true);assert.match(get("forecastTimeLabel").textContent,/準備中/);
    state={selected:"one",slots:[{id:"one",label:"2026-10-06 · 予想最高気温（データなし）",shortLabel:"6日最高"}]};timeline.render();
    assert.equal(get("forecastTimeRange").disabled,true);assert.equal(get("forecastTimePrevious").disabled,true);assert.equal(get("forecastTimeNext").disabled,true);
    assert.match(get("forecastTimeLabel").textContent,/データなし/);assert.equal(get("forecastTimeTicks").children[0].style.left,"50%");
  }finally{Object.assign(globalThis,saved);}
});
