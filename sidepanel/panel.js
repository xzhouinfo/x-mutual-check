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
  buildInteractionRank,
  interactionSummary,
  sortByScore,
  sortByInteractions,
  sortByRecentInteraction,
  toInteractionCsv,
  staleDays,
  filterStale,
  staleStats,
  sortByStale,
  STALE_BUCKETS,
  INTERACT_KINDS,
  quotaStats,
  formatMs,
  ptParts,
  ptDayKey,
  ptDayStart,
  toDailyCsv,
  ratioInfo,
  FOLLOW_DAY_LIMIT,
} from "../lib/core.js";
import { saveSnapshot, listSnapshots } from "../lib/db.js";

const $ = (id) => document.getElementById(id);
const el = {
  account: $("account"),
  recheck: $("recheck"),
  quota: $("quota"),
  qLeft: $("qLeft"),
  qLimit: $("qLimit"),
  qFill: $("qFill"),
  qUsed: $("qUsed"),
  qReset: $("qReset"),
  qUnf: $("qUnf"),
  qToggle: $("qToggle"),
  qDetail: $("qDetail"),
  qChart: $("qChart"),
  qRatio: $("qRatio"),
  qMode: $("qMode"),
  qCap: $("qCap"),
  qClear: $("qClear"),
  qExport: $("qExport"),
  qPeak: $("qPeak"),
  qSetVal: $("qSetVal"),
  qSetBtn: $("qSetBtn"),
  qHelp: $("qHelp"),
  withFollowers: $("withFollowers"),
  scanBtn: $("scanBtn"),
  intelBtn: $("intelBtn"),
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
  stNotBackNon: $("stNotBackNon"),
  cardNotBackNon: $("cardNotBackNon"),
  stPure: $("stPure"),
  stRate: $("stRate"),
  stStale: $("stStale"),
  cardStale: $("cardStale"),
  stZero: $("stZero"),
  cardZero: $("cardZero"),
  tabs: $("tabs"),
  toolbar: $("toolbar"),
  search: $("search"),
  sortBy: $("sortBy"),
  blueOnly: $("blueOnly"),
  exportBtn: $("exportBtn"),
  staleChips: $("staleChips"),
  list: $("list"),
  footer: $("footer"),
  toast: $("toast"),
};

const state = {
  tab: "notBack",
  query: "",
  blueMode: "all", // all=全部  blue=只看蓝V  nonblue=只看非蓝V
  staleBucket: "d180", // 沉默 tab 默认看「半年+」，跟需求「很久没更新」对得上
  sortBy: "weight", // 影响力 / 跟踪最久 / 最久没更新 / 互动分 / 互动次数 / 最近互动
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
  interactions: null, // 互动排行榜（已经按人汇总好）
  intelSummary: null, // 覆盖天数 / 条数 / 人数
  intelAt: null,
  intelScanned: 0,
  statusCovered: 0, // 有多少人拿到了「最后发帖时间」（旧接口有上限，拿不全）
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

/* ---------- 每日关注额度 ---------- */

/**
 * X 每天最多关注 400 个。官方只说「per day」，没写时区——
 * 这里默认按美西（X 总部时区）0 点切日，也可以在明细里换成滚动 24 小时。
 *
 * 记账有三个来源，全部汇总到 chrome.storage.local 的 xmc:followlog:<账号ID>：
 *   page   页面里点的关注（inject.js 嗅探请求方向）
 *   panel  这个面板里点的「+ 关注」
 *   scan   扫描时对比上次快照补记的（覆盖手机上关注的那部分）
 *   manual 手动校准
 * 算账的逻辑在 lib/core.js 的 quotaStats，这里只管展示和交互。
 */
const QUOTA_PREFIX = "xmc:followlog:";
const QUOTA_MODE_KEY = "xmc:quota-mode";

const quota = { events: [], stats: null, mode: "pt", dayKey: null, expanded: false };

const SRC_LABEL = { panel: "面板关注", page: "页面点击", scan: "扫描补记", manual: "手动校准" };

function quotaMode() {
  return quota.mode === "rolling" ? "rolling" : "pt";
}

async function loadQuotaMode() {
  try {
    const got = await chrome.storage.local.get(QUOTA_MODE_KEY);
    quota.mode = got[QUOTA_MODE_KEY] === "rolling" ? "rolling" : "pt";
  } catch (e) {
    quota.mode = "pt";
  }
  el.qMode.value = quota.mode;
}

async function loadQuota() {
  if (!state.userId) return;
  const key = QUOTA_PREFIX + state.userId;
  let events = [];
  try {
    const got = await chrome.storage.local.get(key);
    events = Array.isArray(got[key]) ? got[key] : [];
  } catch (e) {
    events = [];
  }
  quota.events = events;
  recomputeQuota();
}

function ratioSource() {
  const s = state.result && state.result.stats;
  if (!s) return null;
  return { following: s.following || 0, followers: s.followers || 0 };
}

function recomputeQuota() {
  const now = Date.now();
  quota.stats = quotaStats(quota.events, { now, mode: quotaMode(), ratio: ratioSource() });
  quota.dayKey = quota.stats.dayKey;
  renderQuota();
}

function renderQuotaCountdown() {
  const s = quota.stats;
  if (!s) return;
  if (s.mode === "rolling") {
    if (s.capped) {
      el.qReset.textContent = "已标记到上限";
      el.qReset.title = "滚动口径下没有固定重置点；点「今日清零」或等最早那笔关注满 24 小时再试";
      return;
    }
    if (!s.resetAt) {
      el.qReset.textContent = "近 24 小时没有关注";
      el.qReset.title = "滚动口径下，只有当最早的一笔关注满 24 小时才会腾出额度";
      return;
    }
    el.qReset.textContent = `${formatMs(s.msLeft)} 后开始回补`;
    el.qReset.title = "滚动 24 小时口径：最早那笔关注过期时才会腾出一个额度";
    return;
  }
  // 重置点本身就在美西 0 点，用 ptParts 取它自己的日期，别用本机时区算
  const p = ptParts(s.end);
  const mm = String(p.m).padStart(2, "0");
  const dd = String(p.d).padStart(2, "0");
  el.qReset.textContent = `${formatMs(s.msLeft)} 后重置`;
  el.qReset.title = `美西 ${mm}-${dd} 00:00 重置（北京时间当天 15~16 点）`;
}

function renderQuota() {
  const s = quota.stats;
  if (!s) {
    el.qLeft.textContent = "—";
    el.qLimit.textContent = "/ " + FOLLOW_DAY_LIMIT;
    el.qReset.textContent = "等待连接 x.com";
    return;
  }
  el.qLimit.textContent = "/ " + s.limit;
  el.qLeft.textContent = s.capped ? "0" : String(s.remaining);
  el.qUsed.textContent = `已关注 ${s.used}`;
  el.qUnf.textContent = `取关 ${s.unfollows}`;
  el.qFill.style.width = Math.min(100, Math.round((s.used / s.limit) * 100)) + "%";
  el.quota.classList.toggle("warn", s.capped || s.used >= s.limit * 0.8);
  el.quota.title = s.capped ? "今天已经到上限了（X 提示过不能再关注）" : "本机记录的今日关注数，不是 X 服务端计数";
  renderQuotaCountdown();
  if (quota.expanded) renderQuotaDetail();
}

function renderQuotaChart() {
  const s = quota.stats;
  el.qChart.innerHTML = "";
  if (!s) return;
  const max = Math.max(1, ...s.days.map((d) => d.follows));
  for (const d of s.days) {
    const b = document.createElement("div");
    b.className = "qb" + (d.key === s.dayKey ? " today" : "");
    b.title = `${d.key}：关注 ${d.follows}${d.unfollows ? ` · 取关 ${d.unfollows}` : ""}${d.capped ? " · 触及上限" : ""}`;
    const i = document.createElement("i");
    if (d.follows) i.style.height = Math.max(3, Math.round((d.follows / max) * 46)) + "px";
    else i.className = "zero";
    if (!d.follows) i.style.height = "2px";
    b.appendChild(i);
    el.qChart.appendChild(b);
  }
  el.qPeak.textContent = max > 1 ? `最多 ${max} 个/天` : "";
}

function ratioText(r, hasFollowers) {
  if (!r) return "";
  if (!hasFollowers) return `关注 ${r.following} 个。粉丝数这次没扫到，粉丝比限制算不了——勾上「同时拉取粉丝列表」再扫一次就有了。`;
  if (r.level === "ok") {
    return `关注 ${r.following} 个，离 5000 这个硬线还有 ${r.gap} 个。到 5000 之后才按「粉丝/关注」比限流。`;
  }
  if (r.level === "ratio") {
    return `关注 ${r.following} 个，已过 5000：粉丝 ${r.followers}，按社区经验值（粉丝×1.1）估算还能关注约 ${r.gap} 个。X 不公布具体比例，这条只是估算。`;
  }
  return `关注 ${r.following} 个，粉丝 ${r.followers}，已经碰到比例上限的估算值——想继续关注得先涨粉，或者取关一些。`;
}

function helpText(s) {
  const bits = Object.entries(s.bySrc || {})
    .filter(([k, v]) => v > 0 && k !== "manual")
    .map(([k, v]) => `${SRC_LABEL[k] || k} ${v}`);
  const srcLine = bits.length ? `今天这笔账：${bits.join(" · ")}。` : "";
  const manual = (s.bySrc && s.bySrc.manual) || 0;
  return (
    `<b>${srcLine}</b>` +
    (manual ? `其中 ${manual} 个是手动校准填的。` : "") +
    "数据只记在本机：面板里点的、x.com 页面上点的关注都会记（方向以接口返回为准，拿不准的不记）。" +
    "手机上、别的浏览器里关注的看不到，只能靠下次扫描对比快照补记，时间会落在扫描那一刻，所以和 X 的真实计数会有偏差——差得多就用下面「校准为」改一下。" +
    "官方只说「每天 400 个」没说时区，这里默认美西 0 点切日。"
  );
}

function renderQuotaDetail() {
  const s = quota.stats;
  if (!s) return;
  renderQuotaChart();
  if (!state.result) {
    el.qRatio.hidden = true;
    el.qRatio.textContent = "";
  } else {
    const st = state.result.stats;
    const hasFollowers = !!st.followers;
    el.qRatio.hidden = false;
    el.qRatio.textContent = ratioText(ratioInfo(st.following, st.followers || 0), hasFollowers);
  }
  el.qHelp.innerHTML = helpText(s);
}

function currentWindowStart() {
  return quotaMode() === "rolling" ? Date.now() - 86400000 : ptDayStart(Date.now());
}

/** 发一笔事件给后台记账（后台串行写入，避免多个标签页互相覆盖）。 */
function pushQuotaEvents(events) {
  if (!state.userId || !events || !events.length) return Promise.resolve(false);
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "XMC_LOG_FOLLOW", userId: state.userId, events }, (res) => {
      void chrome.runtime.lastError;
      resolve(!!(res && res.ok));
    });
  });
}

/** 整份覆盖（清零 / 校准用）。 */
function setQuotaEvents(events) {
  if (!state.userId) return Promise.resolve(false);
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "XMC_SET_LOG", userId: state.userId, events }, (res) => {
      void chrome.runtime.lastError;
      resolve(!!(res && res.ok));
    });
  });
}

/** 清掉当前窗口内的关注记录（cap 标记也一起清，否则上限还在）。 */
function withoutCurrentWindow(events) {
  const start = currentWindowStart();
  return (events || []).filter((e) => !(e && e.t >= start && (e.a === "follow" || e.a === "cap")));
}

/**
 * 扫描后把「新出现的关注」补记到今天的账上。
 *
 * 为什么不总是补：两次扫描隔了几天时，中间新增的关注没法拆到每一天，
 * 全塞进今天会把额度算爆（还以为你今天关注了 200 个）。所以只在间隔 20 小时内补，
 * 时间只能记成「扫描这一刻」——粒度到扫描，不到分钟。
 */
async function logScanDelta(prev, result) {
  if (!prev || !Number.isFinite(prev.ts) || !result) return { added: 0, skipped: 0 };
  const gap = Date.now() - prev.ts;
  const prevFol = prev.following || [];
  const prevSet = new Set(prevFol.map((u) => String(u.sn || "").toLowerCase()));
  const nextSet = new Set(result.following.map((u) => String(u.sn || "").toLowerCase()));
  const added = result.following.filter((u) => !prevSet.has(String(u.sn || "").toLowerCase()));
  const gone = prevFol.filter((u) => !nextSet.has(String(u.sn || "").toLowerCase()));

  if (gap > 20 * 3600000) return { added: 0, skipped: added.length + gone.length };
  if (!added.length && !gone.length) return { added: 0, skipped: 0 };

  // 页面上点过的关注已经实时记过账了，别在这里重复记一遍
  const seen = new Set(
    (quota.events || []).filter((e) => e && e.a === "follow" && e.u).map((e) => String(e.u))
  );
  const now = Date.now();
  const events = [];
  let dup = 0;
  for (const u of added) {
    if (u.id && seen.has(String(u.id))) {
      dup++;
      continue;
    }
    events.push({ t: now, a: "follow", u: u.id || "", s: "scan" });
  }
  for (const u of gone) events.push({ t: now, a: "unfollow", u: u.id || "", s: "scan" });
  if (!events.length) return { added: 0, skipped: 0, dup };
  const ok = await pushQuotaEvents(events);
  if (ok) await loadQuota();
  return { added: added.length - dup, skipped: 0, dup };
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
  el.intelBtn.disabled = on;
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

  const label = p.kind === "following" ? "关注列表" : p.kind === "followers" ? "粉丝列表" : "通知流";
  const stage = p.totalStages > 1 ? `第 ${p.stage}/${p.totalStages} 步 · ` : "";

  let pct = 0;
  if (p.totalCount) pct = Math.min(99, Math.round((p.loaded / p.totalCount) * 100));
  else if (p.kind === "interactions") pct = Math.min(90, p.pages * 18);
  else pct = Math.min(90, p.pages * 12);

  el.barFill.style.width = pct + "%";
  el.progressText.textContent =
    msg.phase === "backoff"
      ? `${stage}${label} 被限流，等待重试…（第 ${msg.retries} 次）`
      : msg.phase === "status"
        ? `${stage}补充最后发帖时间（旧接口，最多约 500 人）… 已补 ${p.loaded} 人`
        : p.kind === "interactions"
          ? `${label} 第 ${p.pages} 页，已提取 ${p.loaded} 条互动`
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
    state.statusCovered = fol.statusCovered || 0;

    let fans = null;
    let fansError = null;
    if (withFans) {
      state.prog.stage = 2;
      state.prog.pages = 0;
      state.prog.loaded = 0;
      state.prog.totalCount = null;
      updateProgress({ kind: "followers" });
      const f = await sendTab(tab.id, { type: "SCAN", kind: "followers", userId, jobId });
      // 粉丝列表只是补充（纯粉丝、掉粉、互关率）。它失败了也不能把已经扫好的关注侧数据丢掉：
      // 关注上千时要翻几十页，正好容易撞上 X 的读限流（表现为先密集 404，再 429）。
      if (f && f.ok) fans = f.users;
      else fansError = f ? f.error : "SCAN_FAILED";
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

    // 顺手把「上次扫描之后新增的关注」补进今日额度（覆盖在手机/别的浏览器上关注的那部分）
    await loadQuota();
    const delta = await logScanDelta(prev, result);

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

    const tip =
      `扫描完成：关注 ${result.stats.following} · 互关 ${result.stats.mutual} · 未回关 ${result.stats.notBack}` +
      (delta.added ? ` · 新关注 ${delta.added} 计入今日` : "");
    toast(tip, delta.added ? 4000 : 3000);
    if (fansError === "RATE_LIMITED" || fansError === "GQL_404") {
      setHint(
        "粉丝列表这次没扫到（X 的读接口限流了，表现是先密集 404 再 429）。关注侧数据已经出来了，可以先看未回关名单；纯粉丝、掉粉和互关率等 10~15 分钟后再扫一次就能补上。",
        true
      );
    } else if (fansError) {
      setHint("粉丝列表扫描失败（" + fansError + "），先按关注列表出结果。", true);
    } else if (!fans && !withFans) {
      setHint("本次未拉粉丝列表，所以纯粉丝和掉粉统计为空。", false);
    } else if (delta.skipped) {
      setHint(
        `距上次扫描超过 20 小时，中间新增的 ${delta.skipped} 个关注没法拆到具体哪一天，本次没有计入今日额度（避免把几天的量都算到今天）。想算准就每天扫一次，或者在上面的额度明细里手动「校准为」。`,
        false
      );
    } else if (state.statusCovered && state.statusCovered < result.stats.following) {
      setHint(
        `沉默号只覆盖 ${state.statusCovered}/${result.stats.following} 人：X 只有旧接口带「最后发帖时间」，它最多给约 500 个关注。其余人的最后发帖时间显示为未知，可点「时间未知」档查看。`,
        false
      );
    }
  } catch (e) {
    showProgress(false);
    explainScanError(e.message || String(e));
  } finally {
    setScanning(false);
  }
}

/* ---------- 互动扫描 ---------- */

/** 扫描失败的原因翻译成人话，两个扫描入口共用。 */
function explainScanError(msg) {
  if (msg === "NO_TAB") setHint("没有找到 x.com 标签页。先打开 <a href='https://x.com' target='_blank'>x.com</a> 并登录，再回来扫描。", true);
  else if (msg === "ABORTED") setHint("已停止扫描。", false);
  else if (msg === "NO_CONTENT") setHint("这个 x.com 页面还没注入脚本，刷新一下页面再试。", true);
  else if (msg === "NO_LOGIN") setHint("这个页面没有登录态，请先登录 X。", true);
  else if (msg === "NO_USER_ID") setHint("读不到当前账号 ID，刷新 x.com 页面后重试。", true);
  else if (msg === "RATE_LIMITED") setHint("请求被限流了，等几分钟再试。", true);
  else if (msg === "BAD_REQUEST") setHint("通知接口返回 400，通常是参数过期了，刷新 x.com 页面再试。", true);
  else if (/^GQL_404/.test(msg))
    setHint(
      "X 的列表接口连续返回 404。通常是 queryId 过期了：先打开 x.com 的个人主页、点一下「正在关注」和「关注者」，再回来点扫描（插件会自动从页面请求里取到新的 queryId）。",
      true
    );
  else if (/^GQL_SHAPE/.test(msg)) setHint("接口返回的结构变了，插件可能要先更新。先把 x.com 刷新一次再试。", true);
  else setHint("扫描失败：" + msg, true);
}

async function scanInteractions() {
  if (state.scanning) return;
  setScanning(true);
  showProgress(true);
  setHint("");
  state.prog = { kind: "interactions", pages: 0, loaded: 0, totalCount: null, stage: 1, totalStages: 1 };
  updateProgress({});

  try {
    const tab = await findXTab();
    if (!tab) throw new Error("NO_TAB");
    const info = await ensureContent(tab.id);
    if (!info) throw new Error("NO_CONTENT");
    if (!info.loggedIn) throw new Error("NO_LOGIN");

    const jobId = Math.random().toString(36).slice(2);
    const r = await sendTab(tab.id, { type: "SCAN_INTERACTIONS", jobId, maxPages: 12 });
    if (!r || !r.ok) throw new Error(r ? r.error : "SCAN_FAILED");

    state.interactions = buildInteractionRank(r.records || [], r.users || {});
    state.intelSummary = interactionSummary(r.records || []);
    state.intelAt = Date.now();
    state.intelScanned = (r.records || []).length;

    // 扫完直接切到互动榜，省得用户再点一次
    state.tab = "interact";
    state.blueMode = "all";
    state.query = "";
    el.search.value = "";
    state.sortBy = "score";
    el.sortBy.value = "score";

    renderAll();
    showProgress(false);

    const s = state.intelSummary;
    if (!s.events) {
      setHint("通知流是空的——可能你把通知清空了，或者这是个几乎没人互动的新号。", false);
      toast("没扫到互动记录");
    } else {
      toast(`互动榜：${state.interactions.length} 人 / ${s.events} 条互动${s.days ? `（近 ${s.days} 天）` : ""}`, 3600);
      if (r.unresolved) {
        setHint(`有 ${r.unresolved} 条通知反查不到是谁（对方可能注销或受保护），已跳过。`, false);
      }
    }
  } catch (e) {
    showProgress(false);
    explainScanError(e.message || String(e));
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
  const pureFans = followers.filter((f) => !folSet.has(String(f.sn).toLowerCase()));
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
        notBackBlue: notBack.filter((u) => u.verified).length,
        followingNonBlue: following.filter((u) => !u.verified).length,
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

const SORTERS = {
  weight: sortByWeight,
  tracked: sortByTracked,
  stale: (rows) => sortByStale(rows),
  score: sortByScore,
  count: sortByInteractions,
  recent: sortByRecentInteraction,
};

/** 每个 tab 有自己合适的默认排序：互动看分数，沉默看天数。 */
const DEFAULT_SORT = {
  notBack: "weight",
  mutual: "weight",
  pureFans: "weight",
  interact: "score",
  stale: "stale",
  changes: "weight",
};

const SORT_LABELS = {
  weight: "影响力",
  tracked: "跟踪最久",
  stale: "最久没更新",
  score: "互动分",
  count: "互动次数",
  recent: "最近互动",
};

/**
 * 每个 tab 只列自己有数据的排序项。
 *
 * 以前 6 个选项一股脑塞进下拉框，跨 tab 选到没字段的排序会静默失效——
 * 比如在「未回关」里选「互动分」，那批人根本没有 score，比较函数拿到 NaN，
 * 排序看起来「没反应」，其实是什么都没排。
 */
const TAB_SORTS = {
  notBack: ["weight", "tracked", "stale"],
  mutual: ["weight", "stale"],
  pureFans: ["weight", "stale"],
  changes: ["weight", "stale"],
  interact: ["score", "count", "recent", "weight"],
  stale: ["stale", "weight"],
};

/** 按当前 tab 重建下拉项；当前排序不适用时回落到该 tab 的默认排序。 */
function renderSortOptions() {
  const allowed = TAB_SORTS[state.tab] || ["weight"];
  const cur = allowed.includes(state.sortBy) ? state.sortBy : DEFAULT_SORT[state.tab] || allowed[0];
  state.sortBy = cur;
  el.sortBy.textContent = "";
  for (const k of allowed) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = SORT_LABELS[k] || k;
    el.sortBy.appendChild(o);
  }
  el.sortBy.value = cur;
}

const sortRows = (rows) => (SORTERS[state.sortBy] || sortByWeight)(rows);

/** 我关注的人里，很久没发帖的。沉默 tab 与统计栏共用这一份数据。 */
function staleRows() {
  const fol = (state.result && state.result.following) || [];
  return filterStale(fol, "all");
}

function tabItems() {
  switch (state.tab) {
    case "interact": {
      const rows = sortRows(state.interactions || []).map((u, i) => ({
        ...u,
        rank: i + 1,
        canFollow: !u.following && !state.followed.has(u.sn),
        rel: u.following && u.followedBy ? "互关" : u.following ? "已关注" : u.followedBy ? "关注我" : "",
      }));
      return rows;
    }
    case "stale": {
      const rows = sortRows(filterStale(staleRows(), state.staleBucket));
      for (const u of rows) u.canUnfollow = true;
      return rows;
    }
    default:
      break;
  }
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
  // 沉默 tab 的分档已经在 tabItems 里筛过，这里只叠蓝V/关键词
  return filterRows(tabItems(), { blueMode: state.blueMode, query: state.query });
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

  // 记账：面板里点的关注最准，直接记一笔
  await pushQuotaEvents([{ t: Date.now(), a: "follow", u: u.id || "", s: "panel" }]);
  await loadQuota();

  if (r.verified === false) toast(`已提交关注 @${u.sn}，但状态没核对上，去 x.com 看一眼`, 4200);
  else if (quota.stats && !quota.stats.capped && quota.stats.remaining <= 20) {
    toast(`已关注 @${u.sn}。今天还剩 ${quota.stats.remaining} 个额度，慢一点`, 3800);
  } else toast(`已关注 @${u.sn}，下次扫描会归入互关`, 2800);
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

const KIND_ORDER = ["reply", "like", "retweet", "mention", "quote", "follow", "other"];
const KIND_LABEL = Object.fromEntries(
  Object.entries(INTERACT_KINDS).map(([, v]) => [v.key, v.label])
);
KIND_LABEL.other = "其他";

/** 互动明细：回复 3 · 点赞 5 …按权重从重到轻 */
function kindsNode(kinds) {
  const box = document.createElement("div");
  box.className = "kinds";
  for (const key of KIND_ORDER) {
    const n = kinds[key];
    if (!n) continue;
    const s = document.createElement("span");
    s.className = "kind " + key;
    s.textContent = `${KIND_LABEL[key] || key} ${n}`;
    box.appendChild(s);
  }
  return box;
}

/** 「最后发帖 + 多久没发」那一行；沉默 tab 才用。 */
function staleNode(u) {
  const s = document.createElement("span");
  const days = staleDays(u);
  if (days === null) {
    s.className = "stale-num fresh";
    if ((u.tweets || 0) === 0) {
      s.textContent = "· 从没发过推文";
    } else {
      // 拿不到 ≠ 没更新。GraphQL 不给这个字段，旧接口只能覆盖前约 500 个关注，
      // 硬说成「零推文」会把正常人当死号。
      s.textContent = "· 最后发帖时间未知";
      s.title = "X 的新接口不返回最后发帖时间；旧接口最多只覆盖约 500 个关注";
    }
    return s;
  }
  s.className = "stale-num" + (days < 30 ? " fresh" : "");
  const d = new Date(u.lastTweetAt);
  s.textContent = `· 最后发帖 ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}（${days} 天前）`;
  return s;
}

function userNode(u) {
  const row = document.createElement("article");
  row.className = "user";

  if (u.rank) {
    const r = document.createElement("span");
    r.className = "rank" + (u.rank <= 3 ? " top" : "");
    r.textContent = u.rank;
    row.appendChild(r);
  }

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
  name.textContent = u.name || u.sn || "(未知账号)";
  name.title = "打开主页";
  if (u.sn) name.addEventListener("click", () => chrome.tabs.create({ url: "https://x.com/" + u.sn }));
  l1.appendChild(name);
  if (u.verified) {
    const v = document.createElement("span");
    v.className = "vbadge";
    v.textContent = "✓";
    v.title = "蓝V 认证";
    l1.appendChild(v);
  }
  if (u.rel) {
    const rel = document.createElement("span");
    rel.className = "rel" + (u.rel === "互关" ? " mutual" : "");
    rel.textContent = u.rel;
    l1.appendChild(rel);
  }

  const l2 = document.createElement("div");
  l2.className = "u-line2";
  const sn = document.createElement("span");
  sn.className = "u-sn";
  sn.textContent = "@" + (u.sn || "—");
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
  } else if (state.tab === "stale") {
    l2.appendChild(staleNode(u));
  } else if (state.tab === "interact" && u.lastAt) {
    const t = document.createElement("span");
    t.className = "u-order";
    t.textContent = "· 最后互动 " + timeText(u.lastAt);
    l2.appendChild(t);
  }

  main.append(l1, l2);

  if (u.bio && state.tab !== "interact") {
    // 互动榜一屏要看更多人，简介就省了
    const bio = document.createElement("div");
    bio.className = "u-bio";
    bio.textContent = u.bio;
    main.appendChild(bio);
  }

  if (u.kinds && u.count) main.appendChild(kindsNode(u.kinds));

  row.append(img, main);

  if (typeof u.score === "number") {
    const sc = document.createElement("div");
    sc.className = "score";
    const b = document.createElement("b");
    b.textContent = u.score;
    const sp = document.createElement("span");
    sp.textContent = u.count + " 次";
    sp.title = "加权分：" + u.count + " 次互动，回复/转发/@ 各算 3 分，点赞 1 分，关注 2 分";
    sc.append(b, sp);
    row.appendChild(sc);
  }

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
  el.staleChips.hidden = state.tab !== "stale";
  state.items = filtered();
  state.loaded = 0;
  if (!state.items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const p1 = document.createElement("p");
    const p2 = document.createElement("p");
    p2.className = "muted small";
    if (state.blueMode !== "all") {
      p1.textContent = state.blueMode === "blue" ? "这里没有蓝V。" : "这里没有非蓝V账号。";
      p2.textContent = "点一下筛选按钮切换到「全部」。";
    } else if (state.tab === "interact") {
      p1.textContent = state.interactions ? "这个筛选下没有互动记录。" : "还没扫过互动。";
      p2.textContent = state.interactions ? "" : "点上面的「扫互动」，读通知流统计最近谁跟你互动最多。";
    } else if (state.tab === "stale") {
      p1.textContent = state.result ? "这一档没有沉默号。" : "还没有扫描数据。";
      p2.textContent = state.result ? "换一档看看，或点「全部」。" : "先点「开始扫描」读取关注列表。";
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
  el.stNotBackNon.textContent = fmt(state.result.notBack.filter((u) => !u.verified).length);
  el.stPure.textContent = s.pureFans === null || s.pureFans === undefined ? "—" : fmt(s.pureFans);
  el.stRate.textContent = s.mutualRate + "%";

  const st = staleStats(state.result.following);
  el.stStale.textContent = fmt(st.d180);
  el.stZero.textContent = fmt(st.none);
}

const BLUE_LABEL = { all: "蓝V", blue: "仅蓝V", nonblue: "仅非V" };

function syncFilterUI() {
  el.blueOnly.textContent = BLUE_LABEL[state.blueMode] || "蓝V";
  el.blueOnly.setAttribute("aria-pressed", String(state.blueMode !== "all"));
  el.blueOnly.title =
    state.blueMode === "all" ? "点一下：只看蓝V" : state.blueMode === "blue" ? "再点一下：只看非蓝V" : "再点一下：显示全部";
}

/** 沉默 tab 的分档 chips：每档带人数 */
function renderStaleChips() {
  el.staleChips.innerHTML = "";
  if (state.tab !== "stale" || !state.result) {
    el.staleChips.hidden = true;
    return;
  }
  el.staleChips.hidden = false;
  const rows = staleRows();
  const st = staleStats(rows);
  // 拿不到最后发帖时间的那批，单独放一个「未知」档，而不是混进「不沉默」
  const defs = [{ key: "all", label: "全部", n: rows.length }]
    .concat(STALE_BUCKETS.map((b) => ({ key: b.key, label: b.label, n: st[b.key] || 0 })))
    .concat([{ key: "unknown", label: "时间未知", n: st.unknown || 0 }]);
  for (const d of defs) {
    const b = document.createElement("button");
    b.className = "chip";
    b.setAttribute("aria-pressed", String(state.staleBucket === d.key));
    b.append(document.createTextNode(d.label));
    const em = document.createElement("em");
    em.textContent = d.n;
    b.appendChild(em);
    b.addEventListener("click", () => {
      state.staleBucket = d.key;
      renderStaleChips();
      renderList();
      el.list.scrollTop = 0;
    });
    el.staleChips.appendChild(b);
  }
}

function renderTabs() {
  const hasAny = !!state.result || !!state.interactions;
  if (!hasAny) {
    el.tabs.hidden = true;
    el.toolbar.hidden = true;
    el.staleChips.hidden = true;
    return;
  }
  el.tabs.hidden = false;
  el.toolbar.hidden = false;
  renderSortOptions();
  const counts = {
    notBack: state.result ? state.result.notBack.length : 0,
    mutual: state.result ? state.result.mutual.length : 0,
    pureFans: state.result ? state.result.pureFans.length : 0,
    interact: state.interactions ? state.interactions.length : 0,
    stale: state.result ? filterStale(staleRows(), state.staleBucket).length : 0,
    changes: changeItems().length,
  };
  for (const btn of el.tabs.querySelectorAll("button")) {
    const t = btn.dataset.tab;
    btn.classList.toggle("active", t === state.tab);
    btn.querySelector("em").textContent = counts[t] || 0;
  }
  renderStaleChips();
}

function renderFooter() {
  const snap = state.currentSnapshot;
  if (!snap && !state.intelAt) {
    el.footer.innerHTML = "<span>数据仅保存在本机</span>";
    return;
  }
  el.footer.innerHTML = "";
  const left = document.createElement("span");
  const bits = [];
  if (snap) bits.push("上次扫描 " + timeText(snap.ts));
  if (state.intelAt) bits.push(`互动 ${timeText(state.intelAt)}`);
  left.textContent = bits.join(" · ");
  if (state.intelSummary && state.intelSummary.days) {
    left.title = `互动榜基于 ${state.intelSummary.events} 条通知，覆盖最近 ${state.intelSummary.days} 天`;
  }
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
    state.interactions = null;
    state.intelSummary = null;
    state.intelAt = null;
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
  // 额度卡也要跟着刷新：粉丝数变化会影响「5000 / 粉丝比」那段提示
  renderQuota();
}

/* ---------- 导出 ---------- */

function exportCsv() {
  const items = filtered();
  if (!items.length) {
    toast("当前列表是空的，没什么可导出");
    return;
  }
  const csv = state.tab === "interact" ? toInteractionCsv(items) : toCsv(items);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const nameMap = { notBack: "未回关", mutual: "互关", pureFans: "纯粉丝", interact: "互动榜", stale: "沉默号", changes: "变化" };
  const blueSuffix = state.blueMode === "blue" ? "_蓝V" : state.blueMode === "nonblue" ? "_非V" : "";
  const bucket = STALE_BUCKETS.find((b) => b.key === state.staleBucket);
  const bucketSuffix = state.tab === "stale" && bucket ? "_" + bucket.label : "";
  a.href = url;
  a.download = `X_${nameMap[state.tab] || "列表"}${blueSuffix}${bucketSuffix}_${stamp()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`已导出 ${items.length} 条`);
}

/* ---------- 启动 ---------- */

async function boot() {
  el.scanBtn.addEventListener("click", startScan);
  el.intelBtn.addEventListener("click", scanInteractions);
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
    state.blueMode = state.blueMode === "all" ? "blue" : state.blueMode === "blue" ? "nonblue" : "all";
    syncFilterUI();
    renderList();
    el.list.scrollTop = 0;
    toast(state.blueMode === "all" ? "显示全部账号" : state.blueMode === "blue" ? "只看蓝V" : "只看非蓝V");
  });
  el.sortBy.addEventListener("change", (e) => {
    state.sortBy = e.target.value;
    renderList();
    el.list.scrollTop = 0;
    const tips = {
      weight: "按影响力排序（蓝V优先、粉丝多在前）",
      tracked: "按跟踪时长排序（本机历史）",
      stale: "最久没发帖的排最前",
      score: "按互动加权分排序",
      count: "按互动次数排序",
      recent: "按最近互动时间排序",
    };
    toast(tips[state.sortBy] || "已切换排序");
  });
  el.cardNotBackBlue.addEventListener("click", () => {
    if (!state.result) return;
    jumpTo("notBack", { blueMode: "blue" });
    toast(`未回关的蓝V：${countBlue(state.result.notBack)} 人`);
  });
  el.cardNotBackNon.addEventListener("click", () => {
    if (!state.result) return;
    const n = state.result.notBack.filter((u) => !u.verified).length;
    jumpTo("notBack", { blueMode: "nonblue" });
    toast(`未回关、没有蓝V的：${n} 人`);
  });
  el.cardStale.addEventListener("click", () => {
    if (!state.result) return;
    jumpTo("stale", { bucket: "d180" });
    toast("半年以上没发帖的人");
  });
  el.cardZero.addEventListener("click", () => {
    if (!state.result) return;
    jumpTo("stale", { bucket: "none" });
    toast("一条推文都没发过的号");
  });
  el.search.addEventListener("input", (e) => {
    state.query = e.target.value;
    renderList();
  });
  el.tabs.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tab]");
    if (!btn) return;
    switchTab(btn.dataset.tab);
  });
  el.list.addEventListener("scroll", () => {
    if (state.loaded >= state.items.length) return;
    if (el.list.scrollTop + el.list.clientHeight >= el.list.scrollHeight - 160) appendChunk();
  });

  /* ---- 每日额度：展开 / 口径 / 校准 / 导出 ---- */

  el.qToggle.addEventListener("click", () => {
    quota.expanded = !quota.expanded;
    el.qDetail.hidden = !quota.expanded;
    el.qToggle.textContent = quota.expanded ? "收起" : "明细";
    el.qToggle.setAttribute("aria-expanded", String(quota.expanded));
    if (quota.expanded) renderQuotaDetail();
  });

  el.qMode.addEventListener("change", async (e) => {
    quota.mode = e.target.value === "rolling" ? "rolling" : "pt";
    try {
      await chrome.storage.local.set({ [QUOTA_MODE_KEY]: quota.mode });
    } catch (err) {}
    recomputeQuota();
    toast(quota.mode === "rolling" ? "改成按滚动 24 小时统计" : "改成按美西 0 点切日");
  });

  el.qCap.addEventListener("click", async () => {
    if (!state.userId) {
      toast("先打开 x.com 让插件连上账号");
      return;
    }
    // cap 是「X 明确说不能再关注了」——比数数准，出现就当今天满了
    await pushQuotaEvents([{ t: Date.now(), a: "cap", u: "", s: "manual" }]);
    await loadQuota();
    toast("已标记今天到上限，过了重置点会自动恢复");
  });

  el.qClear.addEventListener("click", async () => {
    if (!state.userId) return;
    await setQuotaEvents(withoutCurrentWindow(quota.events));
    await loadQuota();
    toast("今天记的关注数已清零（历史保留）");
  });

  el.qSetBtn.addEventListener("click", async () => {
    if (!state.userId) {
      toast("先打开 x.com 让插件连上账号");
      return;
    }
    const raw = String(el.qSetVal.value || "").trim();
    if (!raw) {
      toast("先填一个 0~400 的数字");
      return;
    }
    const n = Math.max(0, Math.min(FOLLOW_DAY_LIMIT, Math.round(Number(raw))));
    if (!Number.isFinite(n)) {
      toast("填的看不懂，重来");
      return;
    }
    const base = withoutCurrentWindow(quota.events);
    const now = Date.now();
    const fill = [];
    for (let i = 0; i < n; i++) fill.push({ t: now, a: "follow", u: "", s: "manual" });
    await setQuotaEvents(base.concat(fill));
    await loadQuota();
    el.qSetVal.value = "";
    toast(`今日已用校准为 ${n}，还剩 ${quota.stats ? quota.stats.remaining : "—"}`);
  });

  el.qExport.addEventListener("click", () => {
    if (!quota.stats) {
      toast("还没有数据");
      return;
    }
    const csv = toDailyCsv(quota.stats);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `X_每日关注_${stamp()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("已导出近 14 天");
  });

  // 内容脚本在别的标签页记账后，这里跟着刷新（不用手动点）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !state.userId) return;
    if (changes[QUOTA_PREFIX + state.userId]) loadQuota();
  });

  setInterval(tickQuota, 1000);

  await loadQuotaMode();
  await detect();
}

/** 每秒跑一次：只更新倒计时；跨过美西 0 点就整块重算（新的一天从 0 开始）。 */
function tickQuota() {
  const s = quota.stats;
  if (!s) return;
  const now = Date.now();
  if (s.mode === "pt" && ptDayKey(now) !== quota.dayKey) {
    recomputeQuota();
    return;
  }
  if (s.resetAt) s.msLeft = Math.max(0, s.resetAt - now);
  renderQuotaCountdown();
}

/** 切 tab：顺手把排序切到这个 tab 更合适的那档。 */
function switchTab(tab) {
  state.tab = tab;
  const def = DEFAULT_SORT[tab];
  if (def) {
    state.sortBy = def;
    el.sortBy.value = def;
  }
  renderTabs();
  renderList();
  el.list.scrollTop = 0;
}

/** 统计卡片点击：跳 tab + 带上筛选条件。 */
function jumpTo(tab, { blueMode = "all", bucket = "all" } = {}) {
  state.blueMode = blueMode;
  state.staleBucket = bucket;
  state.query = "";
  el.search.value = "";
  state.tab = tab;
  const def = DEFAULT_SORT[tab];
  state.sortBy = def;
  el.sortBy.value = def;
  syncFilterUI();
  renderTabs();
  renderList();
  el.list.scrollTop = 0;
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
  el.intelBtn.disabled = false;
  setHint("");

  await loadQuota();

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
