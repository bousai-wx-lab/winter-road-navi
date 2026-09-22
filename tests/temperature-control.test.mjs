import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { setImmediate as nextTurn } from "node:timers/promises";
import { initTemperature } from "../temperature-control.js";

const CELL_COUNT = 387717;
const DAYS = Array.from({ length: 366 }, (_, i) => new Date(Date.UTC(2000, 0, i + 1)).toISOString().slice(5, 10));

class Element {
  constructor(value = "") {
    this.value = value;
    this.textContent = "";
    this.dataset = {};
    this.options = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.checked = true;
    this.disabled = false;
    this.hidden = false;
  }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  replaceChildren(...children) { this.options = children; }
  getContext() { return { fillStyle: "", fillRect() {} }; }
  emit(name) { return this.listeners.get(name)?.({ target: this }); }
}

async function waitFor(predicate, description) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > 3000) throw new Error(`Timed out: ${description}`);
    await nextTurn();
  }
}

function payload(value, url) {
  const raw = Buffer.from(JSON.stringify(value));
  const bytes = url.endsWith(".gz") ? gzipSync(raw) : raw;
  return {
    bytes,
    record: { url, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), uncompressed_bytes: raw.byteLength },
  };
}

function fixture() {
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  get("temperatureOpacity").value = "70";
  get("playSpeed").value = "10000";
  const document = {
    hidden: false,
    getElementById: get,
    querySelector: () => get("legend"),
    listeners: new Map(),
    addEventListener(name, fn) { this.listeners.set(name, fn); },
  };
  const map = {
    layers: new Map(), listeners: new Map(),
    addLayer(layer, before) { assert.equal(before, "general-road-casing"); this.layers.set(layer.id, layer); },
    getLayer(id) { return this.layers.get(id); },
    removeLayer(id) { this.layers.delete(id); },
    on(name, fn) { this.listeners.set(name, fn); },
    click() { this.listeners.get("click")?.({ lngLat: { lng: 139.69375, lat: 35.6875 } }); },
  };
  const runs = [];
  for (let row = 4200, remaining = CELL_COUNT; remaining > 0; row++) {
    const length = Math.min(4000, remaining);
    runs.push(row, 10000, length);
    remaining -= length;
  }
  const grid = payload({ cell_count: CELL_COUNT, runs }, "grid.json");
  const data = DAYS.map((day, index) => payload({ day, cell_count: CELL_COUNT, runs: [index % 81 + 1, CELL_COUNT] }, `${day}.json.gz`));
  const manifest = {
    schema_version: 1, cell_count: CELL_COUNT, bin_min: -40, bin_step: 1, bin_count: 81, missing_bin: 0,
    days: DAYS, grid: grid.record, files: data.map((entry, i) => ({ day: DAYS[i], ...entry.record })),
  };
  let manual = false;
  let closed = false;
  let rafId = 0;
  const responses = new Map();
  const calls = new Map();
  const failures = new Set();
  const frames = new Map();
  const actions = [];
  const globals = ["document", "Option", "fetch", "requestAnimationFrame", "cancelAnimationFrame"];
  const original = globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.assign(globalThis, {
    document,
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    requestAnimationFrame: (fn) => { frames.set(++rafId, fn); return rafId; },
    cancelAnimationFrame: (id) => frames.delete(id),
    fetch: async (url) => {
      if (closed) throw new Error("Fixture closed");
      const name = String(url).split("/").at(-1);
      if (name === "manifest.json") return Response.json(manifest);
      if (name === "grid.json") return new Response(grid.bytes);
      const index = DAYS.indexOf(name.replace(".json.gz", ""));
      assert.notEqual(index, -1, `unexpected URL ${url}`);
      calls.set(index, (calls.get(index) || 0) + 1);
      if (failures.has(index)) return new Response("unavailable", { status: 503 });
      if (!manual) return new Response(data[index].bytes);
      return new Promise((resolve, reject) => responses.set(index, { resolve, reject }));
    },
  });
  const invoke = (id, event) => {
    const result = Promise.resolve(get(id).emit(event));
    actions.push(result);
    return result;
  };
  return {
    get, map, frames, responses, calls, failures,
    async boot() { initTemperature(map); await waitFor(() => get("map").dataset.temperatureDay === "01-15", "initial day"); },
    hold() { manual = true; },
    automatic() { manual = false; },
    play: () => invoke("playYear", "click"),
    retry: () => invoke("retryTemperature", "click"),
    select(index) { get("dateSlider").value = String(index); return invoke("dateSlider", "input"); },
    resolve(index) {
      const response = responses.get(index);
      assert.ok(response, `day ${index} is pending`);
      responses.delete(index);
      response.resolve(new Response(data[index].bytes));
    },
    progress() { return Number(get("temperatureStatus").textContent.match(/再生準備 (\d+)\//)?.[1] || 0); },
    async close() {
      document.hidden = true;
      document.listeners.get("visibilitychange")?.();
      closed = true;
      for (const response of responses.values()) response.reject(new Error("Fixture closed"));
      responses.clear();
      await Promise.allSettled(actions);
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

test("a late earlier-day response cannot replace the newer selection", async () => {
  const f = fixture();
  try {
    await f.boot();
    f.map.click();
    f.hold();
    const earlier = f.select(16);
    const later = f.select(17);
    f.resolve(17);
    await later;
    f.resolve(16);
    await earlier;
    assert.equal(f.get("map").dataset.temperatureDay, DAYS[17]);
    assert.match(f.get("temperaturePoint").textContent, /01\/18/);
    assert.match(f.get("temperaturePoint").textContent, /-23℃以上 -22℃未満/);
  } finally { await f.close(); }
});

test("cancelled preparation cannot resume or start an animation after immediate restart", async () => {
  const f = fixture();
  try {
    await f.boot();
    f.hold();
    let oldSettled = false;
    const old = f.play().then(() => { oldSettled = true; });
    assert.equal(f.responses.size, 6);
    await f.play(); // Stop the first preparation.
    const restarted = f.play();
    for (let i = 0; i < 6; i++) f.resolve(i);
    await waitFor(() => oldSettled, "cancelled generation settles without awaiting new requests");
    await old;
    await waitFor(() => f.responses.size === 6, "new generation progresses");
    assert.equal(f.get("playYear").getAttribute("aria-pressed"), "true");
    assert.equal(f.frames.size, 0);
    assert.deepEqual([...f.responses.keys()].sort((a, b) => a - b), [6, 7, 8, 9, 10, 11]);
    await f.play();
    for (const index of [...f.responses.keys()]) f.resolve(index);
    await restarted;
    assert.equal(f.frames.size, 0);
  } finally { await f.close(); }
});

test("clicking after a failed day load reports failure, and retry restores the selected point", async () => {
  const f = fixture();
  try {
    await f.boot();
    f.failures.add(15);
    await f.select(15);
    assert.equal(f.get("temperatureStatus").dataset.state, "error");
    assert.equal(f.get("retryTemperature").hidden, false);
    f.map.click();
    assert.doesNotMatch(f.get("temperaturePoint").textContent, /読み込み中/);
    assert.match(f.get("temperaturePoint").textContent, /失敗|再試行|表示でき/);
    f.failures.delete(15);
    await f.retry();
    assert.equal(f.get("temperatureStatus").dataset.state, "ready");
    assert.match(f.get("temperaturePoint").textContent, /01\/16/);
    assert.equal(f.get("retryTemperature").hidden, true);
  } finally { await f.close(); }
});

test("an old preparation failure cannot overwrite a successful manual selection", async () => {
  const f = fixture();
  try {
    await f.boot();
    f.hold();
    const preparation = f.play();
    const selection = f.select(20);
    f.resolve(20);
    await selection;
    const oldRequest = f.responses.get(0);
    f.responses.delete(0);
    oldRequest.reject(new Error("Delayed old request failed"));
    await preparation;
    assert.equal(f.get("map").dataset.temperatureDay, DAYS[20]);
    assert.equal(f.get("temperatureStatus").dataset.state, "ready");
    assert.equal(f.get("playYear").getAttribute("aria-pressed"), "false");
    assert.equal(f.frames.size, 0);
  } finally { await f.close(); }
});

test("stopping preparation trims the cache while preserving the selected day", async () => {
  const f = fixture();
  try {
    await f.boot();
    f.hold();
    f.play();
    // Only 45 representative days are decoded; the rest stay unrequested or pending.
    for (let i = 0; i < 45; i++) {
      if (i === 14) continue; // Initially displayed and already cached.
      await waitFor(() => f.responses.has(i), `prefetch ${i}`);
      f.resolve(i);
    }
    await waitFor(() => f.progress() === 45, "45 days cached");
    await f.play();
    f.automatic();
    const selectedCalls = f.calls.get(14);
    await f.select(14);
    assert.equal(f.calls.get(14), selectedCalls, "selected day remains cached");
    const oldCalls = f.calls.get(0);
    await f.select(0);
    assert.equal(f.calls.get(0), oldCalls + 1, "oldest nonselected day is fetched again after eviction");
    assert.equal(f.frames.size, 0);
  } finally { await f.close(); }
});
