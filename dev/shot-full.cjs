/**
 * 整页长图 + 关键尺寸体检。比 shot.cjs 简单，只截图和量尺寸。
 *
 *   node dev/shot-full.cjs <url> <out.png>
 *   环境变量：SCAN=1 先点扫描；DETAIL=1 展开额度明细；W=400 宽度；DARK=1 深色
 */
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9345;
const URL = process.argv[2] || "http://127.0.0.1:8765/dev/preview.html";
const OUT = process.argv[3] || path.join(os.tmpdir(), "xmc-full.png");
const W = Number(process.env.W || 400);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const proc = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--no-proxy-server",
    "--hide-scrollbars",
    "--user-data-dir=" + path.join(os.tmpdir(), "xmc-shotfull"),
    "about:blank",
  ],
  { stdio: "ignore" }
);

(async () => {
  let tabs = null;
  for (let i = 0; i < 40; i++) {
    try {
      tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (tabs.length) break;
    } catch (e) {}
    await sleep(250);
  }
  const ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)(m.result);
      waiting.delete(m.id);
    }
    if (m.method === "Runtime.exceptionThrown") {
      console.log("[exception]", m.params.exceptionDetails.exception?.description);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id;
      waiting.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expr) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

  await send("Emulation.setDeviceMetricsOverride", { width: W, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: process.env.DARK === "1" ? "dark" : "light" }] });
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Page.enable");
  await send("Page.navigate", { url: URL });
  await sleep(2600);

  if (process.env.SCAN === "1") {
    await ev("document.getElementById('scanBtn').click()");
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      if (await ev("!document.getElementById('tabs').hidden")) break;
    }
    await sleep(900);
  }
  if (process.env.DETAIL === "1") {
    await ev("document.getElementById('qToggle').click()");
    await sleep(500);
  }

  console.log("BLOCKS", await ev(`JSON.stringify(Array.from(document.querySelectorAll('.topbar,.quota,.scan-box,.stats,.tabs,.toolbar,.chips,.list,.footer')).map(n => (n.className.split(' ')[0]) + ':' + Math.round(n.getBoundingClientRect().height)).filter(x => !x.endsWith(':0')))`));
  const h = Number(process.env.CLIP || (await ev("document.body.scrollHeight")));
  console.log("HEIGHT", h, "| scrollW", await ev("document.body.scrollWidth"));
  const r = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: W, height: h, scale: 1.6 },
  });
  fs.writeFileSync(OUT, Buffer.from(r.data, "base64"));
  console.log("saved", OUT);
  ws.close();
  proc.kill();
  process.exit(0);
})().catch((e) => {
  console.error("FAIL", e.message);
  proc.kill();
  process.exit(1);
});
