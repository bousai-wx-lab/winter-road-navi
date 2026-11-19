import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("../analytics-consent.js", import.meta.url), "utf8");
const key = "winter-road-navi-analytics-v1";
const id = "G-XK9F132CT4";
const pageUrl = "https://bousai-wx-lab.github.io/winter-road-navi/";

function setup({ saved = null, brokenStorage = false, url = pageUrl } = {}) {
  const storage = new Map(saved === null ? [] : [[key, saved]]);
  const nodes = new Map();
  const scripts = [];
  const cookies = [];
  let reloads = 0;
  let focused = null;
  const node = (id) => ({
    id, hidden: true, dataset: {}, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    focus() { focused = id; },
    remove() { scripts.splice(scripts.indexOf(this), 1); },
  });
  const document = {
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); },
    createElement: (type) => node(type),
    head: { append: (script) => scripts.push(script) },
    querySelector: () => scripts[0],
    set cookie(value) { cookies.push(value); },
  };
  const location = new URL(url);
  location.reload = () => { reloads++; };
  const window = {
    location,
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    ["local" + "Storage"]: {
      getItem(k) { if (brokenStorage) throw Error("unavailable"); return storage.get(k) ?? null; },
      setItem(k, v) { if (brokenStorage) throw Error("unavailable"); storage.set(k, v); },
    },
  };
  vm.runInNewContext(source, { document, window, Date });
  return {
    window, storage, scripts, cookies,
    click: (id) => nodes.get(id).listeners.click(),
    panel: nodes.get("analyticsConsentPanel"),
    focused: () => focused,
    reloads: () => reloads,
    commands: () => (window.dataLayer ?? []).map((args) => Array.from(args)),
  };
}

test("a fresh visit and explicit refusal never load or queue Google requests", () => {
  const s = setup();
  assert.equal(s.panel.hidden, false);
  assert.equal(s.focused(), "analyticsDeclineButton");
  assert.equal(s.window[`ga-disable-${id}`], true);
  assert.equal(s.scripts.length, 0);
  s.click("analyticsDeclineButton");
  assert.equal(s.panel.hidden, true);
  assert.equal(s.storage.get(key), "denied");
  assert.equal(s.scripts.length, 0);
  assert.equal(s.commands().length, 0);
  assert.equal(s.reloads(), 0);
  assert.equal(setup({ saved: "denied" }).scripts.length, 0);
});

test("consent sends one pageview with fixed page information, never user inputs or referrers", () => {
  const s = setup({ url: `${pageUrl}?lat=35&lon=139&route=synthetic#departure=example` });
  s.click("analyticsAcceptButton");
  s.click("analyticsAcceptButton");
  assert.equal(s.scripts.length, 1);
  assert.equal(s.scripts[0].src, `https://www.googletagmanager.com/gtag/js?id=${id}`);
  assert.equal(s.scripts[0].referrerPolicy, "no-referrer");
  assert.deepEqual([...s.storage.entries()], [[key, "granted"]]);
  const commands = s.commands();
  const config = commands.find((c) => c[0] === "config");
  assert.equal(config[1], id);
  assert.equal(config[2].send_page_view, true);
  assert.equal(config[2].page_location, pageUrl);
  assert.equal(config[2].page_referrer, "");
  assert.equal(config[2].allow_google_signals, false);
  assert.equal(config[2].allow_ad_personalization_signals, false);
  assert.equal(config[2].cookie_path, "/winter-road-navi/");
  assert.equal(config[2].cookie_expires, 5184000);
  assert.equal(commands.filter((c) => c[0] === "config").length, 1);
  assert.equal(commands.filter((c) => c[0] === "event" && c[1] === "page_view").length, 0);
  assert.equal(/lat=|lon=|route=|departure=|synthetic/.test(JSON.stringify(commands)), false);
  const consent = commands.find((c) => c[0] === "consent")[2];
  assert.equal(consent.analytics_storage, "granted");
  assert.equal(consent.ad_storage, "denied");
});

test("revoking consent stops this tag, removes only its cookies and reloads without a denial ping", () => {
  const s = setup({ saved: "granted" });
  const previousCommands = s.commands().length;
  s.click("analyticsSettingsButton");
  assert.equal(s.panel.hidden, false);
  s.click("analyticsDeclineButton");
  assert.equal(s.storage.get(key), "denied");
  assert.equal(s.window[`ga-disable-${id}`], true);
  assert.equal(s.scripts.length, 0);
  assert.equal(s.commands().length, previousCommands);
  assert.equal(s.reloads(), 1);
  assert.equal(s.cookies.length, 4);
  for (const cookie of s.cookies) {
    assert.match(cookie, /^wrn_ga(?:_XK9F132CT4)?=; Max-Age=0; Path=\/winter-road-navi\//);
  }
});

test("storage failure leaves the tool usable and does not imply consent", () => {
  const s = setup({ brokenStorage: true });
  assert.equal(s.scripts.length, 0);
  s.click("analyticsAcceptButton");
  assert.equal(s.scripts.length, 1);
  s.click("analyticsSettingsButton");
  s.click("analyticsDeclineButton");
  assert.equal(s.window[`ga-disable-${id}`], true);
});

test("consent is tool specific, synchronizes revocation, and does not count local previews", () => {
  const s = setup({ saved: "granted" });
  s.window.listeners.storage({ key: "another-tool", newValue: "denied" });
  assert.equal(s.reloads(), 0);
  s.window.listeners.storage({ key, newValue: "denied" });
  assert.equal(s.reloads(), 1);
  const local = setup({ saved: "granted", url: "http://127.0.0.1:8765/" });
  assert.equal(local.scripts.length, 0);
});
