// 用 CDP 驱动无头 Chrome 给侧边栏预览截图（dev 用，不进包）
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9333;
const URL = process.argv[2] || "http://127.0.0.1:8765/dev/preview.html";
const OUT = process.argv[3] || "/tmp/xmc-shot.png";
const DO_SCAN = process.argv[4] !== "nofollow";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      "--user-data-dir=/tmp/xmc-chrome-prof",
      "--no-first-run",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-proxy-server",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let wsUrl = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page");
      if (page) {
        wsUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch (e) {}
  }
  if (!wsUrl) {
    proc.kill();
    throw new Error("chrome 没起来");
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === "Runtime.consoleAPICalled") {
      const t = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
      console.log("[console]", msg.params.type, t);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      console.log("[exception]", JSON.stringify(msg.params.exceptionDetails.exception && msg.params.exceptionDetails.exception.description));
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  await send("Page.enable");
  if (process.env.XMC_DARK !== "1") {
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
  }
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 400,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await send("Page.navigate", { url: URL });
  const waitFor = async (expr, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const ok = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
      if (ok.result && ok.result.value) return true;
      await sleep(150);
    }
    return false;
  };
  const ready = await waitFor("!!document.getElementById('scanBtn')");
  console.log("READY", ready);
  if (!ready) console.log("BODY", await (async () => {
    const r = await send("Runtime.evaluate", { expression: "document.body.innerHTML.slice(0,300)", returnByValue: true });
    return r.result.value;
  })());

  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  if (DO_SCAN) {
    await evalJs("document.getElementById('scanBtn').click()");
    await sleep(2600);
  }

  const metrics = await evalJs(`(() => {
    const q = document.getElementById('quota');
    const body = document.body;
    return {
      quotaH: q ? Math.round(q.getBoundingClientRect().height) : null,
      docW: body.scrollWidth,
      winW: window.innerWidth,
      left: document.getElementById('qLeft').textContent,
      used: document.getElementById('qUsed').textContent,
      reset: document.getElementById('qReset').textContent,
      unf: document.getElementById('qUnf').textContent,
      fill: document.getElementById('qFill').style.width,
      rows: document.querySelectorAll('#list .user').length,
    };
  })()`);
  console.log("METRICS1", JSON.stringify(metrics));

  const shot = async (path, h = 560) => {
    const r = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 400, height: h, scale: 2 },
    });
    fs.writeFileSync(path, Buffer.from(r.data, "base64"));
    console.log("saved", path);
  };
  await shot(OUT);

  await evalJs("document.getElementById('qToggle').click()");
  await sleep(700);
  const metrics2 = await evalJs(`(() => {
    const d = document.getElementById('qDetail');
    const bars = document.querySelectorAll('#qChart .qb').length;
    return {
      detailHidden: d.hidden,
      detailH: Math.round(d.getBoundingClientRect().height),
      bars,
      ratio: document.getElementById('qRatio').textContent.slice(0, 120),
      usedTitle: document.getElementById('qUsed').title.slice(0, 80),
      docW: document.body.scrollWidth,
      winW: window.innerWidth,
    };
  })()`);
  console.log("METRICS2", JSON.stringify(metrics2));
  await shot(OUT.replace(/\.png$/, "-detail.png"), 620);

  // 今天满了 → 再点一次取消
  console.log("NOTE (有记录时)", await evalJs("document.getElementById('qNote').hidden"));
  await evalJs("document.getElementById('qCap').click()");
  await sleep(700);
  console.log("AFTER CAP", await evalJs("document.getElementById('qLeft').textContent + ' | ' + document.getElementById('qCap').getAttribute('aria-pressed') + ' | ' + document.getElementById('quota').className"));
  await evalJs("document.getElementById('qCap').click()");
  await sleep(700);
  console.log("AFTER UNCAPPED", await evalJs("document.getElementById('qLeft').textContent + ' | ' + document.getElementById('qCap').getAttribute('aria-pressed')"));
  // 布局体检：两行控件有没有换行 / 溢出
  console.log("ROWS", await evalJs(`JSON.stringify(Array.from(document.querySelectorAll('.q-row')).map(r => ({h: Math.round(r.getBoundingClientRect().height), w: Math.round(r.getBoundingClientRect().width), kids: Array.from(r.children).map(c => Math.round(c.getBoundingClientRect().left) + '+' + Math.round(c.getBoundingClientRect().width))})))`));

  // 窄宽体检：340px 下两行会不会挤到一起
  await send("Emulation.setDeviceMetricsOverride", { width: 340, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(400);
  console.log("NARROW", await evalJs(`JSON.stringify({docW: document.body.scrollWidth, rows: Array.from(document.querySelectorAll('.q-row')).map(r => Math.round(r.getBoundingClientRect().height)), capColor: getComputedStyle(document.getElementById('qCap')).color})`));
  await evalJs("document.getElementById('qCap').click()");
  await sleep(600);
  console.log("CAP STYLE", await evalJs(`(() => { const c = document.getElementById('qCap'); return c.textContent + ' | pressed=' + c.getAttribute('aria-pressed') + ' | color=' + getComputedStyle(c).color + ' | left=' + document.getElementById('qLeft').textContent; })()`));
  await shot(OUT.replace(/\.png$/, "-narrow-cap.png"), 520);
  await send("Emulation.clearDeviceMetricsOverride");
  await sleep(300);
  await evalJs("document.getElementById('qCap').click()");
  await sleep(500);

  // 切到「滚动 24 小时」口径，确认倒计时文案和剩余数会跟着变
  await evalJs(`(() => { const m = document.getElementById('qMode'); m.value = 'rolling'; m.dispatchEvent(new Event('change')); })()`);
  await sleep(800);
  console.log(
    "ROLLING",
    await evalJs(`document.getElementById('qLeft').textContent + ' | ' + document.getElementById('qReset').textContent + ' | ' + document.getElementById('qReset').title`)
  );

  ws.close();
  proc.kill();
}

main().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
