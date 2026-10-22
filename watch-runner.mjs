import { chromium } from "playwright-core";
import { writeFileSync, appendFileSync } from "node:fs";

const LIMIT = Number(process.argv[2] ?? "999");
const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  appendFileSync(".watch-log.txt", line + "\n", "utf8");
};

const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes("studentLog"));
if (!page) throw new Error("studentLog page not found");
const frameOf = () => page.frames().find((f) => f.url().includes("studycontent"));

// 复用一个视频标签页：全程不新开窗口，避免抢焦点/切换虚拟桌面
let videoPage = ctx.pages().find((p) => p.url().includes("/video/")) ?? null;

const listUnwatched = async () =>
  frameOf().evaluate(() => {
    const out = [];
    [...document.querySelectorAll("div.leaf-detail")].forEach((el, idx) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (!/Video|视频/.test(text) || !/未开始/.test(text)) return;
      const id = `pw${idx}`;
      el.setAttribute("data-pw-id", id);
      out.push({ id, key: String(idx), text });
    });
    return out;
  });

// 拦截 window.open：拿到点击想打开的地址，而不是真的开新标签
const injectOpenHook = async () =>
  frameOf()
    .evaluate(() => {
      window.__pwOpenUrl = null;
      if (window.__pwHooked) return;
      window.__pwHooked = true;
      window.open = function (url) {
        window.__pwOpenUrl = String(url || "");
        return { closed: false, focus() {}, close() {}, location: { href: String(url || "") } };
      };
    })
    .catch(() => {});

const clickRowAndGetUrl = async (row) => {
  await injectOpenHook();
  const target = frameOf().locator(`div.leaf-detail[data-pw-id="${row.id}"]`);
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.click({ timeout: 15000 }).catch(() => {});
  for (let i = 0; i < 25; i++) {
    const u = await frameOf().evaluate(() => window.__pwOpenUrl).catch(() => null);
    if (u) return u;
    await page.waitForTimeout(300);
  }
  return null;
};

const readPlayerPercent = (vp) =>
  vp
    .evaluate(() => {
      const m = document.body.innerText.match(/完成度[：:]\s*([\d.]+)%/g) || [];
      const vals = m.map((s) => parseFloat(s.replace(/[^\d.]/g, ""))).filter((n) => Number.isFinite(n));
      return vals.length ? Math.max(...vals) : null;
    })
    .catch(() => null);

const playWhole = async (vp, dur) => {
  const t0 = Date.now();
  while (Date.now() - t0 < dur * 1000 + 300000) {
    await vp.waitForTimeout(5000);
    const st = await vp
      .evaluate(() => {
        const v = document.querySelector("video");
        return v ? { ct: v.currentTime, dur: v.duration, paused: v.paused, rate: v.playbackRate, ended: v.ended } : null;
      })
      .catch(() => null);
    if (!st) return { lost: true };
    if (st.ended || st.ct >= st.dur - 1) return { ended: true };
    if (st.paused) await vp.evaluate(() => document.querySelector("video").play().catch(() => {}));
    if (st.rate !== 1) await vp.evaluate(() => { document.querySelector("video").playbackRate = 1; });
  }
  return { timeout: true };
};

const initial = await listUnwatched();
log(`START unwatched=${initial.length} limit=${LIMIT}`);

const processed = new Set();
let done = 0;
let consecutiveFail = 0;

while (done < LIMIT) {
  const rows = (await listUnwatched()).filter((r) => !processed.has(r.key));
  if (!rows.length) { log("no more unwatched rows"); break; }
  const row = rows[0];
  processed.add(row.key);
  log(`OPEN [row ${row.key}] ${row.text.slice(0, 40)}`);

  const url = await clickRowAndGetUrl(row);
  if (!url) {
    log("  cannot capture url from window.open — skip");
    if (++consecutiveFail >= 3) break;
    continue;
  }
  log(`  url ${url.slice(0, 90)}`);

  if (!videoPage || videoPage.isClosed()) {
    videoPage = await ctx.newPage(); // 仅首次创建，之后一直复用
  }
  await videoPage.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => log(`  goto failed: ${e.message}`));

  if (/\/web\/\?(next=|$)/.test(videoPage.url())) {
    log("SESSION EXPIRED — 需要扫码登录，停止本批");
    break;
  }

  await videoPage
    .evaluate(() => {
      try {
        Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
        Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
      } catch {}
    })
    .catch(() => {});

  const ready = await videoPage
    .waitForFunction(() => {
      const v = document.querySelector("video");
      return !!v && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0;
    }, { timeout: 45000 })
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    log("  metadata not ready — skip");
    if (++consecutiveFail >= 3) break;
    continue;
  }
  consecutiveFail = 0;

  if (videoPage.frames().some((f) => f.url().includes("captcha"))) {
    log("CAPTCHA detected — stop for manual solve");
    break;
  }

  const dur = await videoPage.evaluate(() => document.querySelector("video").duration);

  // 按已计入的完成度续播，不重看
  let pct = null;
  for (let i = 0; i < 8; i++) {
    pct = await readPlayerPercent(videoPage);
    if (pct !== null && pct > 0) break;
    await videoPage.waitForTimeout(1000);
  }
  let startAt = 0;
  let mode = "from-zero";
  if (pct !== null && pct > 0) {
    startAt = Math.max(0, (dur * pct) / 100 - 15);
    mode = "resume";
  }
  await videoPage.evaluate((t) => {
    const v = document.querySelector("video");
    try { v.currentTime = t; } catch {}
    v.playbackRate = 1;
    v.play().catch(() => {});
  }, startAt);
  await videoPage.waitForTimeout(2500);
  const ct0 = await videoPage.evaluate(() => document.querySelector("video").currentTime);
  log(`  ${(dur / 60).toFixed(1)} min, start=${ct0.toFixed(0)}s (${mode}${pct ? `, 已计入 ${pct}%` : ""})`);

  const r = await playWhole(videoPage, dur);
  let pctEnd = await readPlayerPercent(videoPage);
  log(`  ${r.ended ? "ENDED" : r.timeout ? "TIMEOUT" : "LOST"} 完成度=${pctEnd === null ? "?" : pctEnd + "%"}`);

  if (r.ended && pctEnd !== null && pctEnd < 92) {
    log("  INCOMPLETE — 从头补播一次");
    await videoPage.evaluate(() => {
      const v = document.querySelector("video");
      v.currentTime = 0; v.playbackRate = 1; v.play().catch(() => {});
    });
    await playWhole(videoPage, dur);
    pctEnd = await readPlayerPercent(videoPage);
    log(`  replay done, 完成度=${pctEnd === null ? "?" : pctEnd + "%"}`);
  }

  done++;
  log(`DONE #${done}`);

  if (done % 5 === 0) {
    await frameOf().evaluate(() => location.reload()).catch(() => {});
    await page.waitForTimeout(6000);
    log(`  refreshed: remaining=${(await listUnwatched()).length}`);
  }
}

const remaining = await listUnwatched();
log(`FINISH remaining=${remaining.length}`);
writeFileSync(".watch-remaining.json", JSON.stringify(remaining, null, 2), "utf8");
process.exit(0);