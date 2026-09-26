import {createTemperatureLayer, lookupCell} from "./temperature-layer.js";
import {roadClassLabel} from "./temperature-display-data.js";
import {LIVE_ROOT,LIVE_KINDS,LIVE_POLL_MS,liveSlots,liveFile,liveSlotKey,chooseLiveSlot,decodeLiveCSV,timeLabel,utcTime,liveFreshness} from "./live-temperature-data.js";

const $=id=>document.getElementById(id);
const FACE_COLORS=["#00000000","#b8dfd0","#e8bd20","#f08020","#da3434"];
const MODE_KINDS={observed:["current","observed"],forecast:["temp3h","daily"]};
export function initLiveTemperature(map,hooks={}) {
  let active=false,request=0,abort=null,timer=null,loading=false;
  let manifest=null,slots=[],selectedId=null,selectedTarget=null,followingLatest=true,shown=null,layer=null,grid=null,pinned=null;
  const select=$("liveSlot"),kindSelect=$("liveKind"),status=$("liveStatus"),point=$("livePoint");
  let mode="observed",kind=kindSelect.value;
  const selections={observed:null,forecast:{kind:"temp3h",selectedId:null,selectedTarget:null,followingLatest:false}};
  function setMode(next) {
    if(!Object.hasOwn(MODE_KINDS,next)) throw new Error("気温モードが不正です");
    if(next!==mode) {
      selections[mode]={kind,selectedId,selectedTarget,followingLatest};
      ({kind,selectedId,selectedTarget,followingLatest}=selections[next]);
      mode=next;slots=[];
    }
    kindSelect.replaceChildren(...MODE_KINDS[mode].map(key=>new Option(LIVE_KINDS[key].label,key)));
    kindSelect.value=kind;
    const label=mode==="observed"?"実況":"予測";
    $("liveControls").setAttribute("aria-label",`${label}気温の設定`);
    $("liveKindLabel").textContent=`表示する${label}気温`;
    $("liveLegend").setAttribute("aria-label",`${label}気温面の色分け`);
    $("liveUpdateNote").textContent="天気分布予報プラスと同じ数値を使用。10分ごと・タブ復帰時に更新を確認します。"+(mode==="observed"?"実況の最新枠を選択中は最新時刻へ進み、過去の対象を選んだ場合はその対象を保ちます。":"選択した予想の対象日時を保ちます。実況値は実況値モードで確認できます。");
    controls();
  }
  function setStatus(text,state) {status.textContent=text;status.dataset.state=state;}
  function controls() {
    const index=slots.findIndex(s=>s.id===selectedId);
    $("livePrevious").disabled=index<=0;
    $("liveNext").disabled=index<0 || index>=slots.length-1;
    select.disabled=!slots.length;
  }
  function valueAt(lng,lat) {
    if(!shown) return {label:loading?"気温を準備中":"気温を表示できません"};
    const index=lookupCell(grid,lng,lat),value=index<0?NaN:shown.data.values[index];
    return {label:Number.isFinite(value)?`${value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}℃ · ${roadClassLabel(shown.data.classes[index])}`:"気温なし",value,roadClass:index<0?0:shown.data.classes[index]};
  }
  function refreshPoint() {
    if(!pinned) return;
    const value=valueAt(pinned.lng,pinned.lat);
    point.textContent=`選択地点：${value.label}`;
    point.dataset.longitude=String(pinned.lng);point.dataset.latitude=String(pinned.lat);
    point.dataset.temperature=Number.isFinite(value.value)?String(value.value):"";
    point.dataset.roadClass=String(value.roadClass ?? 0);
  }
  function paint() {
    if(!active || !shown) return;
    layer.setVisible($("temperatureToggle").checked);
    layer.setOpacity(Number($("temperatureOpacity").value)/100);
    $("mapTemperatureLabel").textContent=`${shown.label} · ${shown.title}${$("temperatureToggle").checked?"":" · 気温面は非表示"}`;
    $("liveNotice").textContent=liveFreshness(manifest,kind,shown.slot);
    $("liveNotice").hidden=!$("liveNotice").textContent;
    refreshPoint();
  }
  async function get(file,json,signal) {
    if(!/^[a-z0-9_]+\.(json|csv)$/.test(file)) throw new Error("データ参照が不正です");
    const response=await fetch(LIVE_ROOT+file+`?_=${Date.now()}`,{cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer",signal});
    if(!response.ok) throw new Error("配信データを取得できません");
    const text=await response.text();
    if(text.length>5_000_000) throw new Error("配信データが大きすぎます");
    return json?JSON.parse(text):text;
  }
  async function load(refresh=false) {
    if(!active) return;
    const token=++request; abort?.abort();abort=new AbortController();const signal=abort.signal;
    loading=true;shown=null;layer?.setVisible(false);hooks.onUnavailable?.("loading");
    delete $("map").dataset.liveTarget;delete $("map").dataset.liveUpdated;delete $("map").dataset.liveCells;
    $("mapTemperatureLabel").textContent=`${mode==="observed"?"実況":"予測"}気温を準備中`;
    setStatus("対象時刻と気温を読み込んでいます","loading");refreshPoint();
    try {
      // A manifest and selected CSV are accepted together. Re-check generation
      // after fetching so an upstream update cannot mix two different slots.
      let data,nextManifest,slot,nextSlots;
      for(let attempt=0;attempt<3;attempt++) {
        nextManifest=await get(LIVE_KINDS[kind].manifest,true,signal);
        nextSlots=liveSlots(nextManifest,kind);
        slot=chooseLiveSlot(nextSlots,{kind,id:selectedId,target:selectedTarget,followLatest:refresh && followingLatest && selectedTarget!==null});
        if(slot.status==="unavailable") break;
        try {data=decodeLiveCSV(await get(liveFile(kind,slot),false,signal),kind,slot);}
        catch(error) {if(attempt===2) throw error;continue;}
        const after=await get(LIVE_KINDS[kind].manifest,true,signal);
        if(after.generated_at===nextManifest.generated_at) break;
        data=null;
      }
      if(!active || token!==request) return;
      manifest=nextManifest;slots=nextSlots;selectedId=slot.id;selectedTarget=liveSlotKey(slot,kind);followingLatest=(kind==="current" || kind==="observed") && slot.id===slots.at(-1).id;
      select.replaceChildren(...slots.map(s=>new Option(`${s.target_date} · ${s.label}${s.status==="unavailable"?"（データなし）":""}`,s.id)));
      select.value=slot.id;controls();
      const observed=kind==="current" || kind==="observed";
      const target=observed?slot.target_time:kind==="daily"?slot.target_date:utcTime(slot.validtime);
      const label=kind==="daily" || (kind==="observed" && slot.source!=="realtime")?`${slot.target_date} · ${slot.label}`:timeLabel(target);
      $("liveUpdated").textContent=`配信更新：${timeLabel(manifest.generated_at)}${!observed && slot.basetime?` · 予報発表：${timeLabel(utcTime(slot.basetime))}`:""}`;
      $("liveSource").textContent=observed?"気象庁アメダス・日別観測値からの内挿 · 約5km数値メッシュ":"気象庁 天気分布予報 · 約5kmメッシュ";
      $("liveNotice").textContent=liveFreshness(manifest,kind,slot);$("liveNotice").hidden=!$("liveNotice").textContent;
      if(slot.status==="unavailable") {
        loading=false;hooks.onUnavailable?.("error");setStatus(slot.message || "この対象の予想気温はデータなしです","error");
        $("mapTemperatureLabel").textContent=`${label} · データなし`;refreshPoint();return;
      }
      if(!data) throw new Error("更新途中です");
      const same=grid?.count===data.grid.count && data.grid.rows.every((row,i)=>row===grid.rows[i] && data.grid.cols[i]===grid.cols[i]);
      if(!same) {
        if(layer && map.getLayer(layer.id)) map.removeLayer(layer.id);
        grid=data.grid;
        layer=createTemperatureLayer(grid,{id:"live-temperature",colorForBin:bin=>FACE_COLORS[bin] || FACE_COLORS[1]});
        map.addLayer(layer,"general-road-casing");
      }
      data.grid=grid;layer.setBins(data.bins);
      const title=kind==="daily" || kind==="observed"?`${observed?"実況":"予想"}${slot.element==="min"?"最低":"最高"}気温`:LIVE_KINDS[kind].label;
      shown={data,slot,label,title};loading=false;
      const day=slot.target_date.slice(5,10);
      hooks.onData?.({...shown,day});paint();
      $("map").dataset.liveKind=kind;$("map").dataset.liveTarget=target;$("map").dataset.liveCells=String(grid.count);
      $("map").dataset.liveUpdated=manifest.generated_at;
      setStatus(`${label} · ${title}を表示中（${grid.count.toLocaleString()}格子）`,"ready");
    } catch(error) {
      if(!active || token!==request || error.name==="AbortError") return;
      loading=false;layer?.setVisible(false);hooks.onUnavailable?.("error");
      setStatus("気温を取得・確認できません。再読込できます。","error");
      $("mapTemperatureLabel").textContent=`${mode==="observed"?"実況":"予測"}気温を表示できません`;refreshPoint();
    }
  }
  function choose(id) {selectedId=id;const slot=slots.find(s=>s.id===id);selectedTarget=slot?liveSlotKey(slot,kind):null;followingLatest=(kind==="current" || kind==="observed") && id===slots.at(-1)?.id;void load();}
  kindSelect.addEventListener("change",()=>{if(!MODE_KINDS[mode].includes(kindSelect.value))return;kind=kindSelect.value;selectedId=null;selectedTarget=null;slots=[];followingLatest=true;controls();void load();});
  select.addEventListener("change",()=>choose(select.value));
  $("livePrevious").addEventListener("click",()=>choose(slots[Math.max(0,slots.findIndex(s=>s.id===selectedId)-1)]?.id));
  $("liveNext").addEventListener("click",()=>choose(slots[Math.min(slots.length-1,slots.findIndex(s=>s.id===selectedId)+1)]?.id));
  $("liveRefresh").addEventListener("click",()=>void load(true));
  $("temperatureToggle").addEventListener("change",paint);$("temperatureOpacity").addEventListener("input",paint);
  $("clearLivePoint").addEventListener("click",()=>{pinned=null;point.textContent="地図をクリックすると、その格子の気温と道路の色区分を確認できます。";$("clearLivePoint").hidden=true;});
  map.on("click",event=>{if(!active)return;pinned=event.lngLat;$("clearLivePoint").hidden=false;refreshPoint();});
  document.addEventListener("visibilitychange",()=>{if(active && !document.hidden && !loading) void load(true);});
  setMode(mode);
  return {
    setMode,
    setActive(value) {
      active=value;++request;abort?.abort();clearInterval(timer);loading=false;shown=null;
      layer?.setVisible(false);controls();
      if(value) {void load(true);timer=setInterval(()=>{if(!document.hidden && !loading)void load(true);},LIVE_POLL_MS);}
      else {delete $("map").dataset.liveTarget;delete $("map").dataset.liveUpdated;}
    },
    tooltipAt:valueAt,
    title:()=>shown?.title || LIVE_KINDS[kind].label,
    label:()=>shown?.label || "対象時刻を準備中",
  };
}
