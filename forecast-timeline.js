// This control uses the active forecast controller's native slots and selection.
// It does not own another clock or generate intermediate forecast times.
export function forecastTickLabel(time) {
  const parts = new Intl.DateTimeFormat("ja-JP", {timeZone:"Asia/Tokyo",day:"numeric",hour:"2-digit",hourCycle:"h23"}).formatToParts(new Date(time));
  return `${parts.find(p=>p.type==="day").value}日${parts.find(p=>p.type==="hour").value}時`;
}

export function initForecastTimeline(map, getController) {
  const $ = id => document.getElementById(id);
  const panel = $("forecastTimeline"), range = $("forecastTimeRange"), ticks = $("forecastTimeTicks"), output = $("forecastTimeLabel");
  const previous = $("forecastTimePrevious"), next = $("forecastTimeNext");
  let visible = false, signature = "";
  function snapshot() { return getController()?.timeline() ?? {slots:[],selected:null}; }
  function choose(index) {
    if (!visible) return;
    const state = snapshot(), slot = state.slots[index];
    if (slot && slot.id !== state.selected) getController().choose(slot.id);
  }
  function render() {
    if (!visible) return;
    const {slots, selected} = snapshot(), index = slots.findIndex(s=>s.id===selected);
    panel.dataset.dense = String(slots.length > 5);
    range.max = String(Math.max(0, slots.length-1));
    range.value = String(Math.max(0,index));
    range.disabled = slots.length < 2 || index < 0;
    previous.disabled = index <= 0;
    next.disabled = index < 0 || index >= slots.length-1;
    const label = slots[index]?.label ?? "予測の対象時刻を準備中";
    output.textContent = label;
    range.setAttribute("aria-valuetext",label);
    const key = JSON.stringify(slots);
    if (key !== signature) {
      signature = key;
      ticks.replaceChildren(...slots.map((slot,i)=>{
        const button = document.createElement("button");
        button.type = "button"; button.className = "forecast-time-tick";
        button.style.left = `${slots.length<2 ? 50 : 100*i/(slots.length-1)}%`;
        button.dataset.edge = String(i===0 || i===slots.length-1);
        button.dataset.major = String(i%2===0);
        button.title = slot.label; button.setAttribute("aria-label",`${slot.label}へ移動`);
        const text = document.createElement("span"); text.textContent = slot.shortLabel;
        button.append(text); button.addEventListener("click",()=>choose(i));
        return button;
      }));
    }
    for (const [i,button] of Array.from(ticks.children).entries()) button.setAttribute("aria-current",String(i===index));
  }
  range.addEventListener("input",()=>choose(Number(range.value)));
  previous.addEventListener("click",()=>choose(snapshot().slots.findIndex(s=>s.id===snapshot().selected)-1));
  next.addEventListener("click",()=>choose(snapshot().slots.findIndex(s=>s.id===snapshot().selected)+1));
  return {render,setVisible(value) {
    if (visible !== value) {
      visible=value;panel.hidden=!value;
      // The toolbar takes space above the map, so resize the canvas as well.
      requestAnimationFrame(()=>map.resize());
    }
    render();
  }};
}
