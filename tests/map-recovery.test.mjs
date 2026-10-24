import test from "node:test";
import assert from "node:assert/strict";
import {setTimeout as sleep} from "node:timers/promises";
import {startMap, watchMapRecovery, showMapState} from "../map-recovery.js";

class MapFixture {
  constructor(loaded = true) { this.ready = loaded; this.listeners = new Map(); this.layers = [{id:"base"},{id:"labels"}]; this.removed = false; }
  on(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  off(name, fn) { this.listeners.get(name)?.delete(fn); }
  emit(name, event = {}) { for (const fn of [...(this.listeners.get(name) ?? [])]) fn(event); }
  loaded() { return this.ready; }
  isStyleLoaded() { return this.ready; }
  getStyle() { return {layers:this.layers.filter(layer=>layer.type!=="custom")}; }
  getLayersOrder() { return this.layers.map(layer=>layer.id); }
  getLayer(id) { return this.layers.find(layer=>layer.id===id); }
  addLayer(layer, before) { const index=this.layers.findIndex(item=>item.id===before); this.layers.splice(index<0?this.layers.length:index,0,layer); layer.onAdd?.(); return this; }
  removeLayer(id) { this.layers=this.layers.filter(layer=>layer.id!==id); return this; }
  triggerRepaint() { queueMicrotask(()=>this.emit("render")); }
  remove() { this.removed=true; this.emit("remove"); }
}

test("startup succeeds on the first try or retries a transient constructor failure",async()=>{
  for(const failures of [0,1,2]) {
    let calls=0;const states=[],delays=[];
    const result=await startMap(()=>{if(calls++<failures)throw new Error("GPU unavailable");return new MapFixture();}, {onState:s=>states.push(s),sleep:async ms=>delays.push(ms)});
    assert.equal(calls,failures+1);assert.equal(states.at(-1),"ready");assert.equal(delays.length,failures);
    result.map.remove();
  }
});

test("persistent failure and a map that never loads finish with an error, without infinite retries",async()=>{
  let calls=0;const states=[];
  assert.equal(await startMap(()=>{calls++;throw new Error("GPU unavailable");},{onState:s=>states.push(s),sleep:async()=>{}}),null);
  assert.equal(calls,3);assert.equal(states.at(-1),"error");
  const maps=[];
  assert.equal(await startMap(()=>{const map=new MapFixture(false);maps.push(map);return map;},{timeoutMs:5,sleep:async()=>{}}),null);
  assert.equal(maps.length,3);assert.ok(maps.every(map=>map.removed));
});

test("a delayed load is awaited before handing the map to the application",async()=>{
  const map=new MapFixture(false);
  const pending=startMap(()=>map,{timeoutMs:100});
  map.ready=true;map.emit("load");
  assert.equal((await pending).map,map);map.remove();
});

test("restoration reinstates custom layers in their original order and reloads selected data",async()=>{
  const map=new MapFixture(),states=[];let reloads=0,adds=0;
  const recovery=watchMapRecovery(map,{onState:s=>states.push(s),timeoutMs:100});
  recovery.onRestored(()=>{reloads++;});
  const temperature={id:"temperature",type:"custom",onAdd(){adds++;}},roads={id:"roads",type:"custom",onAdd(){adds++;}};
  map.addLayer(temperature,"labels");map.addLayer(roads,"labels");
  map.addLayer({id:"discarded",type:"custom"});map.removeLayer("discarded");
  for(let cycle=0;cycle<2;cycle++) {
    map.layers=map.layers.filter(layer=>layer.type!=="custom");map.ready=false;map.emit("webglcontextlost");
    map.emit("webglcontextrestored");map.ready=true;map.emit("style.load");
    await sleep(0);
    assert.deepEqual(map.layers.map(layer=>layer.id),["base","temperature","roads","labels"]);
    assert.equal(states.at(-1),"ready");
  }
  assert.equal(reloads,2);assert.equal(adds,6);map.remove();
});

test("an unreturned context, failed restoration, or repeated losses ends the recovery message",async()=>{
  const map=new MapFixture(),states=[];
  const recovery=watchMapRecovery(map,{onState:s=>states.push(s),timeoutMs:5,maxRecoveries:1});
  map.emit("webglcontextlost");await sleep(15);assert.equal(states.at(-1),"error");
  map.emit("webglcontextrestored");await sleep(0);assert.equal(states.at(-1),"ready");
  map.emit("webglcontextlost");assert.equal(states.at(-1),"error");
  map.emit("webglcontextrestored");await sleep(0);assert.equal(states.at(-1),"error");recovery.dispose();
  const another=new MapFixture(),other=[];const next=watchMapRecovery(another,{onState:s=>other.push(s),timeoutMs:100});
  next.onRestored(()=>{throw new Error("layer restore failed");});
  another.emit("webglcontextlost");another.emit("webglcontextrestored");await sleep(0);assert.equal(other.at(-1),"error");another.remove();
});

test("failure UI ends loading, exposes retry, and prevents interaction with an unavailable map",()=>{
  const elements=new Map();
  const element=id=>{if(!elements.has(id))elements.set(id,{dataset:{},setAttribute(name,value){this[name]=value;}});return elements.get(id);};
  const old=globalThis.document;
  globalThis.document={getElementById:element,querySelector:element};
  try {
    showMapState("error","地図を起動できませんでした");
    assert.equal(element("map").dataset.recoveryState,"error");assert.equal(element("map")["aria-busy"],"false");
    assert.equal(element("mapTemperatureLabel").hidden,true);assert.equal(element("mapRetry").hidden,false);
    assert.equal(element(".control-panel").inert,true);assert.doesNotMatch(element("temperatureStatus").textContent,/準備中/);
    showMapState("ready","地図を表示しました");
    assert.equal(element("mapRecovery").hidden,true);assert.equal(element(".control-panel").inert,false);
  } finally {globalThis.document=old;}
});
