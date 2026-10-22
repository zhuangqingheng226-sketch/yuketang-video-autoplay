// autoplay.mjs —— 一键入口：连 CDP（必要时自己拉起 Chrome）→ 找到学习进度页 → 连播未看视频
//
// 用法（在本目录下）：
//   node autoplay.mjs            # 按 config.json 的 limit（默认 999）连播
//   node autoplay.mjs 20         # 本次最多播 20 个
//   Windows 可双击 run.bat
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.env.NODE || process.execPath;

const DEFAULTS = {
  cdpPort: 9333,
  chromePath: "",
  profileDir: "./pw-profile",
  courseUrl: "",
  limit: 999,
};

function loadConfig() {
  const file = path.join(HERE, "config.json");
  const cfg = { ...DEFAULTS };
  if (existsSync(file)) {
    try {
      Object.assign(cfg, JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")));
    } catch (e) {
      console.log(`[warn] config.json 解析失败，用默认值：${e.message}`);
    }
  }
  return cfg;
}

const cfg = loadConfig();
const limitArg = process.argv[2];
const limit = Number(limitArg ?? cfg.limit ?? 999);

const cdpBase = `http://127.0.0.1:${cfg.cdpPort}`;

async function cdpUp() {
  try {
    const r = await fetch(`${cdpBase}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const candidates = [
    cfg.chromePath,
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

async function ensureChrome() {
  if (await cdpUp()) return { launched: false };

  const exe = findChrome();
  if (!exe) {
    console.error(
      "[x] 没找到 Chrome。请手动启动：\n" +
        `    chrome.exe --remote-debugging-port=${cfg.cdpPort} --user-data-dir="<登录过雨课堂的 profile 目录>"\n` +
        "    或在 config.json 里填 chromePath / profileDir。"
    );
    process.exit(2);
  }
  const profile = path.resolve(HERE, cfg.profileDir);
  const args = [
    `--remote-debugging-port=${cfg.cdpPort}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "--disable-blink-features=AutomationControlled",
  ];
  if (cfg.courseUrl) args.push(cfg.courseUrl);
  console.log(`[*] 启动 Chrome（profile: ${profile}）…`);
  const child = spawn(exe, args, { detached: true, stdio: "ignore" });
  child.unref();

  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await cdpUp()) {
      await sleep(2000);
      return { launched: true };
    }
  }
  console.error(`[x] Chrome 起来了但 CDP ${cdpBase} 不通（可能 profile 被占用，先关掉别的 Chrome）。`);
  process.exit(2);
}

const { launched } = await ensureChrome();
console.log(`[*] CDP 正常: ${cdpBase}${launched ? "（本次新启动）" : ""}`);

// 连上后确认有「学习进度」（studentLog + studycontent iframe）页面
const { chromium } = await import("playwright-core");
const browser = await chromium.connectOverCDP(cdpBase);
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes("studentLog"));
if (!page) {
  const url = cfg.courseUrl;
  if (url) {
    console.log(`[*] 没有 studentLog 页，按 config.courseUrl 打开：${url}`);
    page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    for (let i = 0; i < 20 && !page.url().includes("studentLog"); i++) await sleep(500);
  }
}
if (!page || !page.url().includes("studentLog")) {
  console.error(
    "[x] 找不到「学习进度」页面（studentLog）。\n" +
      "    请先在 Chrome 里打开雨课堂 → 进入课程 → 学习进度（能看到左侧章节/视频列表），\n" +
      "    或在 config.json 的 courseUrl 填成那个页面的地址，再运行本脚本。"
  );
  process.exit(3);
}
console.log(`[*] 使用标签页: ${page.url()}`);

// 交给连播器（同一份 watch-runner.mjs，实时输出直接继承到当前终端）
const runner = path.join(HERE, "watch-runner.mjs");
console.log(`[*] 开始连播，上限 ${limit} 个…\n`);
const code = await new Promise((resolve) => {
  const p = spawn(NODE, [runner, String(limit)], { cwd: HERE, stdio: "inherit" });
  p.on("exit", (c) => resolve(c ?? 0));
  p.on("error", (e) => {
    console.error("[x] 启动 watch-runner 失败:", e.message);
    resolve(1);
  });
});
console.log(`\n[*] 结束（exit=${code}），日志: .watch-log.txt`);
process.exit(code);