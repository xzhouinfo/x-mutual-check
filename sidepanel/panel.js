import {
  classify,
  diffSnapshots,
  toCsv,
  sortByWeight,
  sortByTracked,
  trackedDays,
  filterRows,
  countBlue,
  applyUnfollow,
  FOLLOW_ERRORS,
} from "../lib/core.js";
import { saveSnapshot, listSnapshots } from "../lib/db.js";

const $ = (id) => document.getElementById(id);
const el = {
  account: $("account"),
  recheck: $("recheck"),
  withFollowers: $("withFollowers"),
  scanBtn: $("scanBtn"),
  stopBtn: $("stopBtn"),
  progress: $("progress"),
  barFill: $("barFill"),
  progressText: $("progressText"),
  hint: $("hint"),
  stats: $("stats"),
  stFollowing: $("stFollowing"),
  stMutual: $("stMutual"),
  stNotBack: $("stNotBack"),
  stNotBackBlue: $("stNotBackBlue"),
  cardNotBackBlue: $("cardNotBackBlue"),
  stPure: $("stPure"),
  stRate: $("stRate"),
  tabs: $("tabs"),
  toolbar: $("toolbar"),
  search: $("search"),
  sortBy: $("sortBy"),
  blueOnly: $("blueOnly"),
  exportBtn: $("exportBtn"),
  list: $("list"),
  footer: $("footer"),
  toast: $("toast"),
};

const state = {
  tab: "notBack",
  query: "",
  onlyBlue: false,
  sortBy: "weight", // weight=影响力（蓝V+粉丝数）  tracked=跟踪最久（本地历史）
  result: null,
  changes: null,
  prevSnapshot: null,
  currentSnapshot: null,
  userId: null,
  accountName: null,
  scanning: false,
  loaded: 0,
  items: [],
  followed: new Set(), // 本次会话里手动关注过的 handle，重渲染后仍要保留「已关注」
  unfollowed: new Set(), // 本次会话里取关过的 handle，用于防止误重复操作
  prog: { kind: "following", pages: 0, loaded: 0, totalCount: null, stage: 1, totalStages: 1 },
};

/* ---------- 工具 ---------- */

const fmt = (n) => {
  if (n === null || n === undefined) return "—";
  if (n >= 100000000) return (n / 100000000).toFixed(1) + "亿";
  if (n >= 10000) return (n / 10000).toFixed(1) + "万";
  return String(n);
};

const pad = (n) => String(n).padStart(2, "0");
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}
function timeText(ts) {
  const d = new Date(ts);
  const diff = Date.now() - ts;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
  if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

let toastTimer = null;
function toast(msg, ms = 2400) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), ms);
}

function setHint(html, isWarn = false) {
  el.hint.innerHTML = html || "";
  el.hint.classList.toggle("warn", !!isWarn);
  el.hint.hidden = !html;
}

function setAccount(text, isErr = false) {
  el.account.textContent = text;
  el.account.classList.toggle("err", !!isErr);
}

/* ---------- 与页面通信 ---------- */

async function findXTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://x.com/*", "https://twitter.com/*"],
  });
  return tabs.find((t) => t.active) || tabs[0] || null;
}

function sendTab(tabId, msg, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs);
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      clearTimeout(timer);
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(res);
    });
  });
}

async function ping(tabId) {
  try {
    return await sendTab(tabId, { type: "PING" }, 4000);
  } catch (e) {
    return null;
  }
}

async function ensureContent(tabId) {
  const first = await ping(tabId);
  if (first && first.ok) return first;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (e) {
    return null;
  }
  return await ping(tabId);
}

/* ---------- 扫描 ---------- */

function showProgress(on) {
  el.progress.hidden = !on;
  if (!on) {
    el.barFill.style.width = "0%";
    el.progressText.textContent = "";
  }
}

function setScanning(on) {
  state.scanning = on;
  el.scanBtn.disabled = on;
  el.scanBtn.textContent = on ? "扫描中…" : "开始扫描";
  el.stopBtn.hidden = !on;
  el.withFollowers.disabled = on;
}

function updateProgress(msg) {
  const p = state.prog;
  if (msg.kind) p.kind = msg.kind;
  if (typeof msg.pages === "number") p.pages = msg.pages;
  if (typeof msg.loaded === "number") p.loaded = msg.loaded;
  if (typeof msg.totalCount === "number") p.totalCount = msg.totalCount;

  const label = p.kind === "following" ? "关注列表" : "粉丝列表";
  const stage = p.totalStages > 1 ? `第 ${p.stage}/${p.totalStages} 步 · ` : "";

  let pct = 0;
  if (p.totalCount) pct = Math.min(99, Math.round((p.loaded / p.totalCount) * 100));
  else pct = Math.min(90, p.pages * 12);

  el.barFill.style.width = pct + "%";
  el.progressText.textContent =
    msg.phase === "backoff"
      ? `${stage}${label} 被限流，等待重试…（第 ${msg.retries} 次）`
      : `${stage}${label} 第 ${p.pages} 页，已读取 ${p.loaded} 人`;
}

async function startScan() {
  if (state.scanning) return;
  const withFans = el.withFollowers.checked;
  setScanning(true);
  showProgress(true);
  setHint("");

  try {
    const tab = await findXTab();
    if (!tab) throw new Error("NO_TAB");

    const info = await ensureContent(tab.id);
    if (!info) throw new Error("NO_CONTENT");
    if (!info.loggedIn) throw new Error("NO_LOGIN");

    const userId = info.userId;
    if (!userId) throw new Error("NO_USER_ID");

    const jobId = Math.random().toString(36).slice(2);
    state.prog = {
      kind: "following",
      pages: 0,
      loaded: 0,
      totalCount: null,
      stage: 1,
      totalStages: withFans ? 2 : 1,
    };
    updateProgress({});

    const fol = await sendTab(tab.id, { type: "SCAN", kind: "following", userId, jobId });
    if (!fol || !fol.ok) throw new Error(fol ? fol.error : "SCAN_FAILED");

    let fans = null;
    if (withFans) {
      state.prog.stage = 2;
      state.prog.pages = 0;
      state.prog.loaded = 0;
      state.prog.totalCount = null;
      updateProgress({ kind: "followers" });
      const f = await sendTab(tab.id, { type: "SCAN", kind: "followers", userId, jobId });
      if (f && f.ok) fans = f.users;
      else if (f && f.error === "RATE_LIMITED") toast("粉丝列表被限流，已跳过（结果仍可用）", 3200);
      else throw new Error(f ? f.error : "SCAN_FAILED");
    }

    // 从本地历史里翻出每个人「第一次被记录到」的时间，用来算「已跟踪 N 天仍未回关」
    const snaps = await listSnapshots(userId);
    const firstSeen = new Map();
    for (const s of snaps) {
      for (const u of s.following || []) {
        if (!u || !u.sn) continue;
        const k = String(u.sn).toLowerCase();
        const ts = Number.isFinite(u.firstSeen) ? u.firstSeen : s.ts;
        const prevTs = firstSeen.get(k);
        if (prevTs === undefined || ts < prevTs) firstSeen.set(k, ts);
      }
    }

    const result = classify(fol.users, fans, { firstSeen });
    const prev = snaps[0] || null;
    const changes = prev ? diffSnapshots(prev, { following: result.following, followers: result.followers }) : null;

    const snapshot = {
      userId,
      ts: Date.now(),
      following: result.following,
      followers: result.followers,
      stats: result.stats,
    };
    await saveSnapshot(snapshot);

    state.result = result;
    state.changes = changes;
    state.prevSnapshot = prev;
    state.currentSnapshot = snapshot;
    state.userId = userId;
    state.tab = result.notBack.length ? "notBack" : "mutual";
    state.query = "";
    el.search.value = "";

    renderAll();
    showProgress(false);

    const tip = `扫描完成：关注 ${result.stats.following} · 互关 ${result.stats.mutual} · 未回关 ${result.stats.notBack}`;
    toast(tip, 3000);
    if (!fans) setHint("本次未拉粉丝列表，所以纯粉丝和掉粉统计为空。", false);
  } catch (e) {
    showProgress(false);
    const msg = e.message || String(e);
    if (msg === "NO_TAB") setHint("没有找到 x.com 标签页。先打开 <a href='https://x.com' target='_blank'>x.com</a> 并登录，再回来扫描。", true);
    else if (msg === "ABORTED") setHint("已停止扫描。", false);
    else if (msg === "NO_CONTENT") setHint("这个 x.com 页面还没注入脚本，刷新一下页面再试。", true);
    else if (msg === "NO_LOGIN") setHint("这个页面没有登录态，请先登录 X。", true);
    else if (msg === "NO_USER_ID") setHint("读不到当前账号 ID，刷新 x.com 页面后重试。", true);
    else if (msg === "RATE_LIMITED") setHint("请求被限流了，等几分钟再试。", true);
    else setHint("扫描失败：" + msg, true);
  } finally {
    setScanning(false);
  }
}

/* ---------- 渲染 ---------- */

function rebuildResult(snap) {
  const following = snap.following || [];
  const followers = snap.followers || [];
  const mutual = following.filter((u) => u.mutual);
  const notBack = following.filter((u) => !u.mutual);
  const folSet = new Set(following.map((u) => String(u.sn).toLowerCase()));
  const pureFans = followers.filter((u) => !folSet.has(String(u.sn).toLowerCase()));
  return {
    following,
    followers,
    mutual,
    notBack,
    pureFans,
    stats:
      snap.stats || {
        following: following.length,
        followers: followers.length,
        mutual: mutual.length,
        notBack: notBack.length,
        pureFans: pureFans.length,
        mutualRate: following.length ? Math.round((mutual.length / following.length) * 1000) / 10 : 0,
      },
  };
}

function changeItems() {
  const c = state.changes;
  if (!c) return [];
  const out = [];
  for (const u of c.unfollowedYou) out.push({ ...u, tag: "掉粉", tagClass: "lost" });
  for (const u of c.newNotBack) out.push({ ...u, tag: "新增未回关", tagClass: "new" });
  for (const u of c.youUnfollowed) out.push({ ...u, tag: "你取关了", tagClass: "unfol" });
  for (const u of c.resolved) out.push({ ...u, tag: "已回关", tagClass: "back" });
  for (const u of c.newFollowers) out.push({ ...u, tag: "新粉丝", tagClass: "back" });
  return out;
}

const sortRows = (rows) => (state.sortBy === "tracked" ? sortByTracked(rows) : sortByWeight(rows));

function tabItems() {
  if (!state.result) return [];
  switch (state.tab) {
    case "notBack": {
      const rows = sortRows(state.result.notBack);
      for (const u of rows) u.canUnfollow = true;
      return rows;
    }
    case "mutual":
      return sortRows(state.result.mutual);
    case "pureFans": {
      const rows = sortRows(state.result.pureFans);
      for (const u of rows) u.canFollow = true;
      return rows;
    }
    case "changes": {
      const rows = changeItems();
      for (const u of rows) if (u.tag === "新粉丝") u.canFollow = true;
      return rows;
    }
    default:
      return [];
  }
}

function filtered() {
  return filterRows(tabItems(), { onlyBlue: state.onlyBlue, query: state.query });
}

/* ---------- 关注 / 取关动作 ---------- */

function actionErrorText(raw, verb = "操作") {
  const s = String(raw || "");
  const m = s.match(/^CODE_(\d+)$/);
  if (m) {
    const code = Number(m[1]);
    if (code === 429) return "被限流了，等十几分钟再试";
    return FOLLOW_ERRORS[code] || `${verb}失败（错误码 ${code}）`;
  }
  if (s === "NO_LOGIN") return "登录态失效，刷新 x.com 再试";
  if (s === "NO_TARGET") return "这个账号缺少 ID，重新扫描一次再试";
  if (s === "NOT_APPLIED") return "请求被接受但没生效，去 x.com 手动确认一下";
  if (s === "NO_TAB") return "找不到 x.com 标签页";
  if (s === "TIMEOUT") return "请求超时，稍后重试";
  return `${verb}失败：` + s;
}

// 写操作不能连点：UI 层守 3 秒，content.js 里还有一道 3~6 秒随机延迟。
// 实测连续几次写就会 429，这里宁慢不快。
let writeCooldownUntil = 0;

/** 取关后刷新整块界面：统计、"变化"列表、页脚都要跟着动。 */
function rerenderAfterUnfollow(sn) {
  state.result = applyUnfollow(state.result, sn);
  state.changes = state.prevSnapshot
    ? diffSnapshots(state.prevSnapshot, { following: state.result.following, followers: state.result.followers })
    : state.changes;
  renderAll();
}

async function sendWrite(type, u, btn, busyText) {
  const wait = writeCooldownUntil - Date.now();
  if (wait > 0) {
    toast(`操作太快了，等 ${Math.ceil(wait / 1000)} 秒`);
    return null;
  }
  writeCooldownUntil = Date.now() + 3000;

  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;

  try {
    const tab = await findXTab();
    if (!tab) throw new Error("NO_TAB");
    const info = await ensureContent(tab.id);
    if (!info) throw new Error("NO_TAB");
    if (!info.loggedIn) throw new Error("NO_LOGIN");

    const res = await sendTab(tab.id, { type, userId: u.id || "", screenName: u.sn }, 30000);
    if (!res || !res.ok) throw new Error(res ? res.error : "FAILED");
    return res;
  } catch (e) {
    btn.disabled = false;
    btn.textContent = label;
    toast(actionErrorText(e.message || e, type === "FOLLOW" ? "关注" : "取关"), 3800);
    return null;
  }
}

async function followUser(u, btn) {
  if (state.followed.has(u.sn)) return;
  const r = await sendWrite("FOLLOW", u, btn, "关注中…");
  if (!r) return;
  state.followed.add(u.sn);
  btn.classList.add("done");
  btn.textContent = "已关注";
  if (r.verified === false) toast(`已提交关注 @${u.sn}，但状态没核对上，去 x.com 看一眼`, 4200);
  else toast(`已关注 @${u.sn}，下次扫描会归入互关`, 2800);
}

async function unfollowUser(u, btn) {
  if (state.unfollowed.has(u.sn)) return;
  const r = await sendWrite("UNFOLLOW", u, btn, "取关中…");
  if (!r) {
    // sendWrite 会把文字还原成点击时的样子（此时是「确认?」），这里再归位到初始态
    btn.textContent = "取关";
    btn.classList.remove("armed");
    return;
  }
  state.unfollowed.add(u.sn);
  state.followed.delete(u.sn);
  rerenderAfterUnfollow(u.sn);
  if (r.verified === false) toast(`已提交取关 @${u.sn}，但状态没核对上，去 x.com 看一眼`, 4200);
  else toast(`已取关 @${u.sn}，统计已更新`, 3000);
}

function followBtn(u) {
  const b = document.createElement("button");
  b.className = "follow-btn";
  if (state.followed.has(u.sn)) {
    b.classList.add("done");
    b.textContent = "已关注";
    b.disabled = true;
    return b;
  }
  b.textContent = "+ 关注";
  b.title = `关注 @${u.sn}`;
  b.addEventListener("click", () => followUser(u, b));
  return b;
}

/**
 * 取关按钮：两段式确认。
 * 第一次点击进入「确认取关?」并 3 秒后自动复原，期间再点才真正执行——
 * 既挡住了误触，又不用弹 modal 打断浏览。
 */
function unfollowBtn(u) {
  const b = document.createElement("button");
  b.className = "act-btn";
  b.textContent = "取关";
  b.title = `取消关注 @${u.sn}`;

  let armed = false;
  let timer = null;
  const disarm = () => {
    armed = false;
    b.classList.remove("armed");
    b.textContent = "取关";
    clearTimeout(timer);
  };

  b.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      b.classList.add("armed");
      b.textContent = "确认?";
      timer = setTimeout(disarm, 3000);
      return;
    }
    clearTimeout(timer);
    unfollowUser(u, b);
  });

  return b;
}

function userNode(u) {
  const row = document.createElement("article");
  row.className = "user";

  const img = document.createElement("img");
  img.className = "avatar";
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  if (u.avatar) img.src = u.avatar;
  img.alt = "";

  const main = document.createElement("div");
  main.className = "u-main";

  const l1 = document.createElement("div");
  l1.className = "u-line1";
  const name = document.createElement("span");
  name.className = "u-name";
  name.textContent = u.name || u.sn;
  name.title = "打开主页";
  name.addEventListener("click", () => chrome.tabs.create({ url: "https://x.com/" + u.sn }));
  l1.appendChild(name);
  if (u.verified) {
    const v = document.createElement("span");
    v.className = "vbadge";
    v.textContent = "✓";
    v.title = "蓝V 认证";
    l1.appendChild(v);
  }

  const l2 = document.createElement("div");
  l2.className = "u-line2";
  const sn = document.createElement("span");
  sn.className = "u-sn";
  sn.textContent = "@" + u.sn;
  const fc = document.createElement("span");
  fc.textContent = "· " + fmt(u.followers) + " 粉丝";
  l2.append(sn, fc);

  // 按「跟踪最久」排序时标出已经记录了多久：一直没回关的天数，才是决定去留的依据
  if (state.sortBy === "tracked") {
    const days = trackedDays(u);
    if (days !== null) {
      const ord = document.createElement("span");
      ord.className = "u-order";
      ord.textContent = days >= 1 ? `· 已跟踪 ${days} 天` : "· 今天新记录";
      ord.title = "来自你本机的扫描历史，不是 X 的关注时间";
      l2.appendChild(ord);
    }
  }

  main.append(l1, l2);

  if (u.bio) {
    const bio = document.createElement("div");
    bio.className = "u-bio";
    bio.textContent = u.bio;
    main.appendChild(bio);
  }

  row.append(img, main);

  if (u.canFollow) row.appendChild(followBtn(u));
  else if (u.canUnfollow) row.appendChild(unfollowBtn(u));

  if (u.tag) {
    const tag = document.createElement("span");
    tag.className = "tag " + (u.tagClass || "unfol");
    tag.textContent = u.tag;
    row.appendChild(tag);
  }

  return row;
}

const CHUNK = 60;

function appendChunk() {
  const items = state.items;
  const end = Math.min(state.loaded + CHUNK, items.length);
  const frag = document.createDocumentFragment();
  for (let i = state.loaded; i < end; i++) frag.appendChild(userNode(items[i]));
  el.list.appendChild(frag);
  state.loaded = end;
  if (state.loaded >= items.length) {
    const done = document.createElement("div");
    done.className = "empty small muted";
    done.textContent = `已显示全部 ${items.length} 人`;
    el.list.appendChild(done);
  }
}

function renderList() {
  el.list.innerHTML = "";
  state.items = filtered();
  state.loaded = 0;
  if (!state.items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const p1 = document.createElement("p");
    const p2 = document.createElement("p");
    p2.className = "muted small";
    if (state.onlyBlue) {
      p1.textContent = "这里没有蓝V。";
      p2.textContent = "点一下「蓝V」按钮取消筛选。";
    } else if (state.tab === "notBack") {
      p1.textContent = "没有未回关的人。";
      p2.textContent = "或者本次没拉粉丝列表，判定依据只有接口字段。";
    } else if (state.tab === "pureFans") {
      p1.textContent = state.result && state.result.followers.length ? "没有纯粉丝。" : "本次未拉取粉丝列表。";
      p2.textContent = state.result && state.result.followers.length ? "" : "勾选「同时拉取粉丝列表」后再扫一次。";
    } else if (state.tab === "changes") {
      p1.textContent = state.changes ? "和上次相比没有变化。" : "还没有历史快照。";
      p2.textContent = state.changes ? "" : "再扫描一次就能看到变化。";
    } else {
      p1.textContent = "列表为空。";
    }
    empty.append(p1, p2);
    el.list.appendChild(empty);
    return;
  }
  appendChunk();
}

function renderStats() {
  if (!state.result) {
    el.stats.hidden = true;
    return;
  }
  const s = state.result.stats;
  el.stats.hidden = false;
  el.stFollowing.textContent = fmt(s.following);
  el.stMutual.textContent = fmt(s.mutual);
  el.stNotBack.textContent = fmt(s.notBack);
  el.stNotBackBlue.textContent = fmt(countBlue(state.result.notBack));
  el.stPure.textContent = s.pureFans === null || s.pureFans === undefined ? "—" : fmt(s.pureFans);
  el.stRate.textContent = s.mutualRate + "%";
}

function syncFilterUI() {
  el.blueOnly.setAttribute("aria-pressed", String(state.onlyBlue));
}

function renderTabs() {
  if (!state.result) {
    el.tabs.hidden = true;
    el.toolbar.hidden = true;
    return;
  }
  el.tabs.hidden = false;
  el.toolbar.hidden = false;
  const counts = {
    notBack: state.result.notBack.length,
    mutual: state.result.mutual.length,
    pureFans: state.result.pureFans.length,
    changes: changeItems().length,
  };
  for (const btn of el.tabs.querySelectorAll("button")) {
    const t = btn.dataset.tab;
    btn.classList.toggle("active", t === state.tab);
    btn.querySelector("em").textContent = counts[t] || 0;
  }
}

function renderFooter() {
  const snap = state.currentSnapshot;
  if (!snap) {
    el.footer.innerHTML = "<span>数据仅保存在本机</span>";
    return;
  }
  el.footer.innerHTML = "";
  const left = document.createElement("span");
  left.textContent = "上次扫描 " + timeText(snap.ts);
  const right = document.createElement("a");
  right.href = "#";
  right.textContent = "清除本机记录";
  right.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!state.userId) return;
    const { clearUser } = await import("../lib/db.js");
    await clearUser(state.userId);
    state.result = null;
    state.changes = null;
    state.currentSnapshot = null;
    renderAll();
    toast("已清除本机快照");
  });
  el.footer.append(left, right);
}

function renderAll() {
  renderStats();
  renderTabs();
  syncFilterUI();
  renderList();
  renderFooter();
}

/* ---------- 导出 ---------- */

function exportCsv() {
  const items = filtered();
  if (!items.length) {
    toast("当前列表是空的，没什么可导出");
    return;
  }
  const csv = toCsv(items);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const nameMap = { notBack: "未回关", mutual: "互关", pureFans: "纯粉丝", changes: "变化" };
  a.href = url;
  a.download = `X_${nameMap[state.tab] || "列表"}${state.onlyBlue ? "_蓝V" : ""}_${stamp()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`已导出 ${items.length} 条`);
}

/* ---------- 启动 ---------- */

async function boot() {
  el.scanBtn.addEventListener("click", startScan);
  el.stopBtn.addEventListener("click", async () => {
    const tab = await findXTab();
    if (tab) sendTab(tab.id, { type: "STOP" }, 3000).catch(() => {});
    setScanning(false);
    showProgress(false);
    toast("已停止扫描，本次结果不保存");
  });
  el.recheck.addEventListener("click", detect);
  el.exportBtn.addEventListener("click", exportCsv);
  el.blueOnly.addEventListener("click", () => {
    state.onlyBlue = !state.onlyBlue;
    syncFilterUI();
    renderList();
    toast(state.onlyBlue ? "只看蓝V" : "显示全部");
  });
  el.sortBy.addEventListener("change", (e) => {
    state.sortBy = e.target.value;
    renderList();
    el.list.scrollTop = 0;
    toast(state.sortBy === "tracked" ? "按跟踪时长排序（本机历史）" : "按影响力排序（蓝V优先）");
  });
  el.cardNotBackBlue.addEventListener("click", () => {
    if (!state.result) return;
    state.tab = "notBack";
    state.onlyBlue = true;
    state.query = "";
    el.search.value = "";
    syncFilterUI();
    renderTabs();
    renderList();
    el.list.scrollTop = 0;
    toast(`未回关的蓝V：${countBlue(state.result.notBack)} 人`);
  });
  el.search.addEventListener("input", (e) => {
    state.query = e.target.value;
    renderList();
  });
  el.tabs.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tab]");
    if (!btn) return;
    state.tab = btn.dataset.tab;
    renderTabs();
    renderList();
    el.list.scrollTop = 0;
  });
  el.list.addEventListener("scroll", () => {
    if (state.loaded >= state.items.length) return;
    if (el.list.scrollTop + el.list.clientHeight >= el.list.scrollHeight - 160) appendChunk();
  });

  await detect();
}

async function detect() {
  setAccount("正在检测页面…");
  el.scanBtn.disabled = true;
  const tab = await findXTab();
  if (!tab) {
    setAccount("未发现 x.com 标签页", true);
    setHint("先打开 <a href='https://x.com' target='_blank'>x.com</a> 并登录，再回来点「开始扫描」。", true);
    return;
  }
  const info = await ensureContent(tab.id);
  if (!info) {
    setAccount("页面脚本未就绪", true);
    setHint("刷新一下 x.com 页面再点 ⟳。", true);
    return;
  }
  if (!info.loggedIn) {
    setAccount("x.com 未登录", true);
    setHint("在 x.com 页面登录后再试。", true);
    return;
  }

  state.userId = info.userId;
  setAccount("已连接 · 账号 ID " + info.userId);
  el.scanBtn.disabled = false;
  setHint("");

  // 已有快照就直接渲染，不用每次重扫
  if (state.userId) {
    const snaps = await listSnapshots(state.userId);
    if (snaps.length) {
      state.result = rebuildResult(snaps[0]);
      state.currentSnapshot = snaps[0];
      state.prevSnapshot = snaps[1] || null;
      state.changes = snaps[1]
        ? diffSnapshots(snaps[1], { following: snaps[0].following, followers: snaps[0].followers })
        : null;
      renderAll();
    }
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "PROGRESS" && state.scanning) updateProgress(msg);
});

boot();
