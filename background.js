/**
 * 后台只干两件事：
 * 1. 点扩展图标开侧边栏
 * 2. 收「关注 / 取关」事件并落到 chrome.storage.local（每日关注额度要用）
 *
 * 为什么记账放在后台：多个 x.com 标签页会各自动发事件，内容脚本之间互相看不见，
 * 各写各的会互相覆盖。service worker 只有一个，用它把写入串成一条队列最省事。
 */
import { appendEvents } from "./lib/core.js";

const LOG_PREFIX = "xmc:followlog:";

function openPanelOnClick() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(openPanelOnClick);
chrome.runtime.onStartup.addListener(openPanelOnClick);

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    if (tab && tab.windowId) await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) {
    // 老版本浏览器没有 sidePanel.open，交给 setPanelBehavior 兜底
  }
});

/** 写入串行化：读 → 合并 → 写，中间不会有第二个事件插进来。 */
let chain = Promise.resolve();
function enqueue(fn) {
  chain = chain.then(fn, fn);
  return chain;
}

async function appendFollowEvents(userId, events) {
  if (!userId || !Array.isArray(events) || !events.length) return 0;
  const key = LOG_PREFIX + userId;
  const got = await chrome.storage.local.get(key);
  const next = appendEvents(got[key], events, { now: Date.now() });
  await chrome.storage.local.set({ [key]: next });
  return next.length;
}

/** 整份覆盖：面板的「今日清零」「校准为 N」用。同样走队列，免得和追加打架。 */
async function replaceFollowLog(userId, events) {
  if (!userId) return 0;
  const key = LOG_PREFIX + userId;
  const next = appendEvents([], Array.isArray(events) ? events : [], { now: Date.now() });
  await chrome.storage.local.set({ [key]: next });
  return next.length;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "XMC_LOG_FOLLOW") {
    enqueue(() => appendFollowEvents(msg.userId, msg.events))
      .then((n) => sendResponse({ ok: true, total: n }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === "XMC_SET_LOG") {
    enqueue(() => replaceFollowLog(msg.userId, msg.events))
      .then((n) => sendResponse({ ok: true, total: n }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
});
