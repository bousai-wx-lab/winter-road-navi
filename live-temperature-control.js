import {createTemperatureLayer, lookupCell, paletteColor} from "./temperature-layer.js";
import {LIVE_ROOT,LIVE_KINDS,LIVE_POLL_MS,liveSlots,liveFile,liveSlotKey,chooseLiveSlot,decodeLiveCSV,timeLabel,utcTime,liveFreshness,isDailyTemperature,previousComparison} from "./live-temperature-data.js?v=20261110-daily-diff1";
import {forecastTickLabel,forecastSlotAtTime} from "./forecast-timeline.js?v=20261110-drive4";
import {MAP_OUTLINE_LAYER} from "./road-style.js?v=20261110-outline1";

const $=id=>document.getElementById(id);
const MODE_KINDS={observed:["current","observed"],forecast:["temp3h","daily"]};
const COMPARISON_LABELS={value:"気温",previous:"前日差",normal:"平年差"};
const COMPARISON_BUTTONS={value:"liveValue",previous:"livePreviousDifference",normal:"liveNormalDifference"};
const degrees = value => value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");

function differenceColor(bin) {
  const difference = bin - 11;
  const center = [249, 249, 246], end = difference < 0 ? [24, 83, 164] : [179, 36, 55];
  const weight = Math.sqrt(Math.min(10, Math.abs(difference)) / 10);
  return "#" + center.map((value, i) => Math.round(value + weight * (end[i] - value)).toString(16).padStart(2, "0")).join("");
}

export function initLiveTemperature(map,hooks={}) {
  let active=false,request=0,abort=null,timer=null,loading=false;
  let manifest=null,slots=[],selectedId=null,selectedTarget=null,followingLatest=true,shown=null,layer=null,grid=null,pinned=null,layerMode=null;
  let comparison="value",layerGrid=null,layerDifference=false;
  let followTime=null;
  const legend=$("liveTemperatureGradient").getContext("2d");
  for(let bin=1;bin<=81;bin++){legend.fillStyle=paletteColor(bin);legend.fillRect((bin-1)*4,0,4,18);}
  const differenceLegend=$("liveDifferenceGradient").getContext("2d");
  for(let bin=1;bin<=21;bin++){differenceLegend.fillStyle=differenceColor(bin);differenceLegend.fillRect((bin-1)*15,0,15,18);}
  const select=$("liveSlot"),kindSelect=$("liveKind"),status=$("liveStatus"),point=$("livePoint");
  let mode="observed",kind=kindSelect.value;
  const selections={observed:null,forecast:{kind:"temp3h",selectedId:null,selectedTarget:null,followingLatest:false}};
  const view=()=>active && isDailyTemperature(kind) ? comparison : "value";
  const title=()=>shown ? shown.title + (view()==="value" ? "" : `の${COMPARISON_LABELS[view()]}`) : LIVE_KINDS[kind].label;
  function followSlot(values) {
    if(kind!=="daily")return forecastSlotAtTime(values,followTime);
    const date=new Date(followTime+9*3600000).toISOString().slice(0,10);
    const element=selectedTarget?.split(":").at(-1) || values.find(s=>s.id===selectedId)?.element || "min";
    return values.find(s=>s.target_date===date && s.element===element) ?? null;
  }

  function comparisonControls() {
    const current=view(), difference=current!=="value";
    $("liveComparisonControls").hidden=!active || !isDailyTemperature(kind);
    for (const [type,id] of Object.entries(COMPARISON_BUTTONS)) {
      $(id).setAttribute("aria-pressed",String(current===type));
    }
    $("liveObservedLegend").hidden=difference;
    $("liveDifferenceLegend").hidden=!difference;
    $("temperatureToggleLabel").textContent=difference ? "差を表示" : "気温を表示";
    const note=$("liveComparisonNote");
    note.hidden=!difference || !shown;
    if (!difference || !shown) {note.textContent="";return;}
    const daily=shown.slot.element==="min" ? "日最低" : "日最高";
    const previous=previousComparison(shown.slot);
    const basis=current==="normal" ? `同じ月日の${daily}の平年値（1991〜2020年）との比較`
      : previous ? `${previous.date.replaceAll("-","/")}の${daily}（${previous.source}）との比較`
      : "前日の比較資料なし";
    const provisional=shown.slot.source==="realtime" ? "当日は表示時刻までの暫定値です。" : "";
    const missing=shown.data.comparisons[current].count ? "" : "表示できる差はありません。";
    note.textContent=`${basis}。${provisional}${missing}道路の色は選択日の気温です。`;
  }
  function setMode(next) {
    if(!Object.hasOwn(MODE_KINDS,next)) throw new Error("気温モードが不正です");
    if(next!==mode) {
      selections[mode]={kind,selectedId,selectedTarget,followingLatest};
      ({kind,selectedId,selectedTarget,followingLatest}=selections[next]);
      mode=next;slots=[];
    }
    kindSelect.replaceChildren(...MODE_KINDS[mode].map(key=>new Option(({current:"現在の気温",observed:"日最低・日最高",temp3h:"3時間ごとの気温",daily:"日最低・日最高"})[key],key)));
    kindSelect.value=kind;
    const label=mode==="observed"?"実況":"予測";
    $("liveControls").setAttribute("aria-label",`${label}気温の設定`);
    $("liveKindLabel").textContent="気温の種類";
    $("liveColorNote").textContent="気温表示の面は全モード共通の1℃ごとの配色。差の表示は低い側が青、高い側が赤です。道路は選択日の気温で0・2・5℃を境に着色します。";
    $("liveUpdateNote").textContent="天気分布予報プラスと同じ数値を使用。10分ごと・タブ復帰時に更新を確認します。"+(mode==="observed"?"実況の最新枠を選択中は最新時刻へ進み、過去の対象を選んだ場合はその対象を保ちます。":"選択した予想の対象日時を保ちます。実況値は実況値モードで確認できます。");
    controls();
  }
  function setStatus(text,state) {status.textContent=text;status.dataset.state=state;$("liveRefresh").hidden=state!=="error";hooks.onChange?.();}
  function controls() {
    const index=slots.findIndex(s=>s.id===selectedId);
    $("livePrevious").disabled=index<=0;
    $("liveNext").disabled=index<0 || index>=slots.length-1;
    select.disabled=!slots.length;
    comparisonControls();
    hooks.onChange?.();
  }
  function valueAt(lng,lat) {
    const current=view();
    if(!shown) return {label:loading?`${COMPARISON_LABELS[current]}を準備中`:`${COMPARISON_LABELS[current]}を表示できません`};
    const index=lookupCell(grid,lng,lat),temperature=index<0?NaN:shown.data.values[index];
    const roadClass=index<0?0:shown.data.classes[index];
    if(current==="value") return {label:Number.isFinite(temperature)?`${degrees(temperature)}℃`:"気温なし",value:temperature,temperature,roadClass};
    const compared=shown.data.comparisons[current],value=compared?.values[index],reference=compared?.references[index];
    const label=Number.isFinite(value) ? `${value>0?"+":""}${degrees(value)}℃（${degrees(temperature)}℃ − ${degrees(reference)}℃）` : "比較資料なし";
    return {label,value,temperature,roadClass};
  }
  function refreshPoint() {
    if(!pinned) return;
    const value=valueAt(pinned.lng,pinned.lat);
    point.textContent=`選択地点：${value.label}`;
    point.dataset.longitude=String(pinned.lng);point.dataset.latitude=String(pinned.lat);
    point.dataset.temperature=Number.isFinite(value.temperature)?String(value.temperature):"";
    point.dataset.roadClass=String(value.roadClass ?? 0);
  }
  function paint() {
    if(!active || !shown) return;
    layer.setVisible($("temperatureToggle").checked);
    layer.setOpacity(Number($("temperatureOpacity").value)/100);
    const surface=view()==="value" ? "気温の面" : "差の色";
    $("mapTemperatureLabel").textContent=`${shown.label} · ${title()}${$("temperatureToggle").checked?"":` · ${surface}は非表示`}`;
    $("liveNotice").textContent=liveFreshness(manifest,kind,shown.slot);
    $("liveNotice").hidden=!$("liveNotice").textContent;
    refreshPoint();
  }
  function renderShown() {
    if (!shown) return;
    const current=view(), difference=current!=="value";
    if (!layer || layerGrid!==grid || layerMode!==mode || layerDifference!==difference) {
      if(layer && map.getLayer(layer.id)) map.removeLayer(layer.id);
      layer=createTemperatureLayer(grid,{id:"live-temperature",colorForBin:difference?differenceColor:paletteColor});
      map.addLayer(layer,MAP_OUTLINE_LAYER);
      layerGrid=grid;layerMode=mode;layerDifference=difference;
    }
    const compared=shown.data.comparisons[current];
    layer.setBins(difference?compared.bins:shown.data.bins);
    comparisonControls();
    paint();
    $("map").dataset.liveComparison=current;
    const count=difference?compared.count:grid.count;
    setStatus(count?`${shown.label} · ${title()}を表示中（${count.toLocaleString()}格子）`:`${title()}の比較資料がありません。`,"ready");
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
    delete $("map").dataset.liveComparison;comparisonControls();
    $("mapTemperatureLabel").textContent=`${mode==="observed"?"実況":"予測"}気温を準備中`;
    setStatus("対象時刻と気温を読み込んでいます","loading");refreshPoint();
    try {
      // A manifest and selected CSV are accepted together. Re-check generation
      // after fetching so an upstream update cannot mix two different slots.
      let data,nextManifest,slot,nextSlots;
      for(let attempt=0;attempt<3;attempt++) {
        nextManifest=await get(LIVE_KINDS[kind].manifest,true,signal);
        nextSlots=liveSlots(nextManifest,kind);
        slot=followTime!==null && mode==="forecast" ? followSlot(nextSlots) : chooseLiveSlot(nextSlots,{kind,id:selectedId,target:selectedTarget,followLatest:refresh && followingLatest && selectedTarget!==null});
        if(!slot || slot.status==="unavailable") break;
        try {data=decodeLiveCSV(await get(liveFile(kind,slot),false,signal),kind,slot);}
        catch(error) {if(attempt===2) throw error;continue;}
        const after=await get(LIVE_KINDS[kind].manifest,true,signal);
        if(after.generated_at===nextManifest.generated_at) break;
        data=null;
      }
      if(!active || token!==request) return;
      manifest=nextManifest;slots=nextSlots;
      if(!slot){loading=false;hooks.onUnavailable?.("unavailable");setStatus("通過時刻に対応する予測気温がありません","unavailable");$("mapTemperatureLabel").textContent="この通過時刻の予測気温は資料なし";return;}
      if(followTime===null){selectedId=slot.id;selectedTarget=liveSlotKey(slot,kind);followingLatest=(kind==="current" || kind==="observed") && slot.id===slots.at(-1).id;}
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
      if(!same)grid=data.grid;
      data.grid=grid;
      const dataTitle=isDailyTemperature(kind)?`${observed?"実況":"予想"}${slot.element==="min"?"最低":"最高"}気温`:observed?"実況気温":"予想気温";
      shown={data,slot,label,title:dataTitle};loading=false;
      const day=slot.target_date.slice(5,10);
      $("map").dataset.liveKind=kind;$("map").dataset.liveTarget=target;$("map").dataset.liveCells=String(grid.count);
      $("map").dataset.liveUpdated=manifest.generated_at;
      renderShown();hooks.onData?.({...shown,day});
    } catch(error) {
      if(!active || token!==request || error.name==="AbortError") return;
      loading=false;layer?.setVisible(false);hooks.onUnavailable?.("error");
      setStatus("気温を取得・確認できません。再読込できます。","error");
      $("mapTemperatureLabel").textContent=`${mode==="observed"?"実況":"予測"}気温を表示できません`;refreshPoint();
    }
  }
  function choose(id) {const slot=slots.find(s=>s.id===id);if(!active || !slot)return;selectedId=id;selectedTarget=liveSlotKey(slot,kind);followingLatest=(kind==="current" || kind==="observed") && id===slots.at(-1)?.id;select.value=id;controls();void load();}
  for (const [type,id] of Object.entries(COMPARISON_BUTTONS)) {
    $(id).addEventListener("click",()=>{
      if (!active || !isDailyTemperature(kind) || comparison===type) return;
      comparison=type;controls();
      try {renderShown();}
      catch {layer?.setVisible(false);setStatus("地図の色を切り替えられません。再読込できます。","error");}
    });
  }
  kindSelect.addEventListener("change",()=>{if(!MODE_KINDS[mode].includes(kindSelect.value))return;kind=kindSelect.value;selectedId=null;selectedTarget=null;slots=[];followingLatest=true;controls();void load();});
  select.addEventListener("change",()=>choose(select.value));
  $("livePrevious").addEventListener("click",()=>choose(slots[Math.max(0,slots.findIndex(s=>s.id===selectedId)-1)]?.id));
  $("liveNext").addEventListener("click",()=>choose(slots[Math.min(slots.length-1,slots.findIndex(s=>s.id===selectedId)+1)]?.id));
  $("liveRefresh").addEventListener("click",()=>void load(true));
  $("temperatureToggle").addEventListener("change",paint);$("temperatureOpacity").addEventListener("input",paint);
  $("clearLivePoint").addEventListener("click",()=>{pinned=null;point.textContent="地図をクリックすると、その格子の気温と道路の色区分を確認できます。";$("clearLivePoint").hidden=true;});
  map.on("click",event=>{if(!active || followTime!==null)return;pinned=event.lngLat;$("clearLivePoint").hidden=false;refreshPoint();});
  document.addEventListener("visibilitychange",()=>{if(active && !document.hidden && !loading) void load(true);});
  setMode(mode);
  return {
    setMode,
    setFollowTime(time){
      if(time!==null && !Number.isFinite(time))throw new Error("通過時刻が不正です");
      const changed=followTime!==time;followTime=time;
      if(changed && time!==null && active && mode==="forecast" && (!shown || followSlot(slots)?.id!==shown.slot.id))void load();
    },
    choose,
    timeline:()=>({selected:selectedId,slots:mode==="forecast"?slots.map(s=>({id:s.id,
      label:kind==="daily"?`${s.target_date} · 予想${s.element==="min"?"最低":"最高"}気温${s.status==="unavailable"?"（データなし）":""}`:timeLabel(utcTime(s.validtime)),
      shortLabel:kind==="daily"?`${Number(s.target_date.slice(-2))}日${s.element==="min"?"最低":"最高"}`:forecastTickLabel(utcTime(s.validtime))})):[]}),
    setActive(value) {
      active=value;++request;abort?.abort();clearInterval(timer);loading=false;shown=null;
      layer?.setVisible(false);controls();
      if(value) {void load(true);timer=setInterval(()=>{if(!document.hidden && !loading)void load(true);},LIVE_POLL_MS);}
      else {delete $("map").dataset.liveTarget;delete $("map").dataset.liveUpdated;delete $("map").dataset.liveComparison;}
    },
    timing:()=>shown?{issued:shown.slot.basetime?utcTime(shown.slot.basetime):null,observed:shown.slot.target_time || shown.slot.target_date}:null,
    tooltipAt:valueAt,
    title,
    label:()=>shown?.label || "対象時刻を準備中",
  };
}
