import test from "node:test";
import assert from "node:assert/strict";
import {setImmediate as nextTurn} from "node:timers/promises";
import {initLiveTemperature} from "../live-temperature-control.js";
import {LIVE_POLL_MS} from "../live-temperature-data.js";

class Element {
  constructor(){this.value="";this.textContent="";this.checked=true;this.hidden=false;this.disabled=false;this.dataset={};this.handlers={};}
  addEventListener(name,fn){this.handlers[name]=fn;}
  replaceChildren(...options){this.options=options;}
  emit(name){this.handlers[name]?.();}
}
async function until(fn){for(let i=0;i<1000;i++){if(fn())return;await nextTurn();}throw new Error("controller did not settle");}

test("live controller refreshes the actual feed, rejects failure, and drops late responses on mode exit",async()=>{
  const saved=Object.fromEntries(["document","fetch","Option","setInterval","clearInterval"].map(k=>[k,globalThis[k]]));
  const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  get("liveKind").value="current";get("temperatureOpacity").value="65";
  const document={getElementById:get,hidden:false,handlers:{},addEventListener(name,fn){this.handlers[name]=fn;}};
  const map={layers:new Map(),handlers:{},addLayer(layer){this.layers.set(layer.id,layer);},getLayer(id){return this.layers.get(id);},removeLayer(id){this.layers.delete(id);},on(name,fn){this.handlers[name]=fn;}};
  let generation=0,fail=false,hold=null,poll,pollMs,calls=0;
  const manifest=()=>({generated_at:`2026-09-26T17:${generation?"21":"11"}:00+09:00`,latest_time:`2026-09-26T17:${generation?"20":"10"}:00+09:00`,station_count:915,grid_count:31296});
  const csv=()=>"longitude,latitude,observed_c,source_date,target_date\n"+Array.from({length:31296},(_,i)=>`${((2080+i%300+.5)/16).toFixed(5)},${((600+Math.floor(i/300)+.5)/20).toFixed(5)},${generation?"2.01":"0"},2026-09-26,${manifest().latest_time}`).join("\n");
  globalThis.document=document;globalThis.Option=class{constructor(label,value){this.label=label;this.value=value;}};
  globalThis.setInterval=(fn,ms)=>{poll=fn;pollMs=ms;return 1;};globalThis.clearInterval=()=>{};
  globalThis.fetch=async url=>{
    calls++;if(hold)await hold;
    if(fail)return {ok:false};
    return {ok:true,text:async()=>url.includes("manifest")?JSON.stringify(manifest()):csv()};
  };
  const shown=[],unavailable=[];const control=initLiveTemperature(map,{onData:data=>shown.push(data),onUnavailable:state=>unavailable.push(state)});
  try {
    assert.equal(calls,0);control.setActive(true);await until(()=>shown.length===1);
    assert.equal(shown[0].data.classes[0],4);assert.equal(pollMs,LIVE_POLL_MS);
    generation=1;poll();await until(()=>shown.length===2);
    assert.equal(shown[1].data.values[0],2.01);assert.equal(shown[1].data.classes[0],2);
    assert.equal(get("map").dataset.liveTarget,manifest().latest_time);
    fail=true;get("liveRefresh").emit("click");await until(()=>get("liveStatus").dataset.state==="error");
    assert.equal(get("map").dataset.liveTarget,undefined);assert.equal(unavailable.at(-1),"error");
    fail=false;let release;hold=new Promise(r=>release=r);get("liveRefresh").emit("click");control.setActive(false);release();
    await nextTurn();await nextTurn();assert.equal(shown.length,2);assert.equal(get("map").dataset.liveTarget,undefined);
  } finally {control.setActive(false);Object.assign(globalThis,saved);}
});
