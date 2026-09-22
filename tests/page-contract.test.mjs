import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("page explains the intentionally limited first release", () => {
  for (const phrase of [
    "現在は道路表示までの初期版です",
    "気温・積雪・凍結・通行規制・経路案内",
    "現在の道路状況や安全を示す地図ではありません",
    "現在地を取得せず",
    "アクセス解析を使用しません",
  ]) {
    assert.equal(html.includes(phrase), true, phrase);
  }
});

test("page has no inline event handlers or executable inline scripts", () => {
  assert.equal(/\son[a-z]+\s*=/i.test(html), false);
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false);
  assert.equal(html.includes("javascript:"), false);
});

test("thin header links to the blog and X without a usage guide", () => {
  assert.equal(html.includes('class="header-inner"'), true);
  assert.equal(html.includes('href="https://bousai-wx-lab.com/"'), true);
  assert.equal(html.includes('href="https://x.com/bousai_wx_lab"'), true);
  assert.equal(html.includes("使い方"), false);
});

test("application does not use location, storage, cookies, or HTML injection", () => {
  for (const token of [
    "geo" + "location",
    "local" + "Storage",
    "session" + "Storage",
    "indexed" + "DB",
    "document." + "cookie",
    "inner" + "HTML",
    "outer" + "HTML",
    "eval" + "(",
    "new " + "Function",
  ]) {
    assert.equal(app.includes(token), false, token);
  }
});
