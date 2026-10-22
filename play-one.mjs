// play-one.mjs —— 播放指定的一个视频（按课程目录里的行号）
// 用法: node play-one.mjs 57
//   57 = 课程目录中 div.leaf-detail 的下标（从 0 开始，含非视频行）
//
// 前置: 已有一个用 --remote-debugging-port=9333 启动、且已登录雨课堂的 Chrome，
//       页面上打开着 studentLog（学习进度）页面，里面有 studycontent iframe。
import { chromium } from "playwright-core";
import { appendFileSync } from "node:fs";
import path from "node:path";

const LOG = path.join(process.cwd(), ".watch-log.txt");
const idx = Number(process.argv[2] ?? 0);
const log = (m) => {
  const s = new Date().toISOString() + "  " + m;
  console.log(s);
  try { appendFileSync(LOG, s + "\n"); } catch {}
};

const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
const ctx = b.contexts()[0];
const sch = ctx.pages().find((p) => p.url().includes("studentLog"));
if (!sch) throw new Error("找不到 studentLog 页面，请先打开学习进度页");
const f = sch.frames().find((x) => x.url().includes("studycontent"));
if (!f) throw new Error("找不到 studycontent iframe");
await sch.bringToFront().catch(() => {});

// 拦截 window.open：拿到行点击后想打开的地址，而不是真的开新标签
await f.evaluate(() => {
  window.__pwOpenUrl = "";
  window.open = function (u) {
    window.__pwOpenUrl = String(u || "");
    return { closed: false, focus() {}, close() {}, location: { href: String(u || "") } };
  };
});

const info = await f.evaluate((i) => {
  const leaves = [...document.querySelectorAll("div.leaf-detail")];
  const leaf = leaves[i];
  const sec = leaf.closest("div.section-list");
  const ch = leaf.closest("div.chapter-list");
  return {
    sec: (sec?.querySelector("div.header span.title")?.textContent || "").trim(),
    chapter: (ch?.querySelector("div.header span.title")?.textContent || "").trim(),
    text: (leaf.innerText || "").replace(/\s+/g, " ").trim(),
  };
}, idx);
log(`TARGET [${idx}] ${info.chapter} / ${info.sec} :: ${info.text}`);
await f.locator("div.leaf-detail").nth(idx).click();
await sch.waitForTimeout(2500);
const url = await f.evaluate(() => window.__pwOpenUrl);
if (!url) { log("FAIL no popup url"); process.exit(1); }
log("url " + url);

let vp = ctx.pages().find((p) => p.url().includes("/video/"));
if (!vp) vp = await ctx.newPage();
await vp.goto(url, { waitUntil: "domcontentloaded" });
// 假装页面可见，避免播放器因切后台暂停
await vp.evaluate(() => {
  try { Object.defineProperty(document, "visibilityState", { get: () => "visible" }); } catch {}
  try { Object.defineProperty(document, "hidden", { get: () => false }); } catch {}
});
await vp.waitForTimeout(7000);

async function playOnce(fromStart) {
  const st = await vp.evaluate(async (fs) => {
    const v = document.querySelector("video");
    if (!v) return { err: "no video" };
    v.muted = true;
    if (v.playbackRate !== 1) v.playbackRate = 1; // 保持 1 倍速，平台按倍速可能不计进度
    if (fs) { try { v.currentTime = 2; } catch {} }
    try { await v.play(); } catch (e) { return { err: e.message, dur: v.duration }; }
    return { dur: v.duration, cur: v.currentTime };
  }, fromStart);
  if (st.err) { log("play error " + JSON.stringify(st)); return null; }
  log(`play start from=${fromStart} dur=${st.dur.toFixed(1)}s`);
  const t0 = Date.now();
  let lastLog = 0;
  while (true) {
    await vp.waitForTimeout(5000);
    const s = await vp.evaluate(() => {
      const v = document.querySelector("video");
      if (!v) return null;
      if (v.paused && !v.ended) { v.muted = true; v.play().catch(() => {}); }
      if (v.playbackRate !== 1) v.playbackRate = 1;
      return { cur: v.currentTime, dur: v.duration, paused: v.paused, ended: v.ended };
    });
    if (!s) { log("video element lost"); return null; }
    const el = (Date.now() - t0) / 1000;
    if (el - lastLog > 120) {
      lastLog = el;
      log(`  ${s.cur.toFixed(0)}/${s.dur.toFixed(0)}s ${((100 * s.cur) / s.dur).toFixed(1)}%`);
    }
    if (s.ended || s.cur >= s.dur - 1) { log(`  reached end at ${s.cur.toFixed(1)}s`); return s; }
    if (el > s.dur + 1200) { log("timeout"); return s; }
  }
}

// 回目录看这一行是否已变成「已完成」
async function rowStatus() {
  await f.evaluate(() => location.reload()).catch(() => {});
  await sch.waitForTimeout(8000);
  const f2 = sch.frames().find((x) => x.url().includes("studycontent"));
  return await f2.evaluate((i) => {
    const l = [...document.querySelectorAll("div.leaf-detail")][i];
    return l ? (l.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80) : "missing";
  }, idx);
}

let st = await playOnce(true);
let status = await rowStatus();
log(`after pass1: ${status}`);
if (!/已完成/.test(status)) {
  st = await playOnce(true);
  status = await rowStatus();
  log(`after pass2: ${status}`);
}
log(/已完成/.test(status) ? "DONE" : "NOT-COMPLETED");
process.exit(0);