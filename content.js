/**
 * 内容脚本：跑在 x.com 页面里，借用页面自身的登录态发 REST 请求。
 * 读：只 GET 关注/粉丝列表。
 * 写：只有 FOLLOW 一个动作（单条关注），必须由用户点击触发，带硬节流。
 * 注意：content script 不能用 ES module，这里的接口常量与 lib/core.js 保持一致。
 */
(function () {
  "use strict";
  if (window.__xmcInstalled) return;
  window.__xmcInstalled = true;

  const API_PATH = {
    following: "/i/api/1.1/friends/following/list.json",
    followers: "/i/api/1.1/followers/list.json",
  };
  const FOLLOW_PATH = "/i/api/1.1/friendships/create.json";
  const UNFOLLOW_PATH = "/i/api/1.1/friendships/destroy.json";
  const SHOW_PATH = "/i/api/1.1/friendships/show.json";
  const COMMON_PARAMS = [
    "include_profile_interstitial_type=1",
    "include_blocking=1",
    "include_blocked_by=1",
    "include_followed_by=1",
    "include_want_retweets=1",
    "include_mute_edge=1",
    "include_can_dm=1",
    "include_can_media_tag=1",
    "include_ext_is_blue_verified=1",
    "include_ext_verified_type=1",
    "include_ext_profile_image_shape=1",
    "skip_status=1",
  ].join("&");
  const PUBLIC_BEARER =
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let abortFlag = false;

  /* 写操作节流：实测连续几次写就会 429，所以间隔取 3~6 秒随机。
     宁可慢，也不要被判成自动化（226）或被限流（88）。 */
  const WRITE_MIN_GAP = 3000;
  const WRITE_JITTER = 3000;
  let lastWriteAt = 0;

  function readCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
    return m ? m[1] : null;
  }

  function viewerId() {
    const twid = readCookie("twid");
    if (!twid) return null;
    let dec = twid;
    try {
      dec = decodeURIComponent(twid);
    } catch (e) {}
    const m = dec.match(/u=(\d+)/);
    return m ? m[1] : null;
  }

  function buildUrl(kind, userId, cursor, count) {
    const path = API_PATH[kind];
    return `${path}?${COMMON_PARAMS}&user_id=${userId}&count=${count}&cursor=${encodeURIComponent(cursor)}`;
  }

  function emit(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch (e) {}
  }

  async function scan({ kind, userId, jobId, count = 200, delayMs = 1200, maxPages = 60 }) {
    const ct0 = readCookie("ct0");
    if (!ct0) throw new Error("NO_LOGIN");
    const uid = userId || viewerId();
    if (!uid) throw new Error("NO_USER_ID");

    const headers = { authorization: "Bearer " + PUBLIC_BEARER, "x-csrf-token": ct0 };
    const users = [];
    let cursor = "-1";
    let pages = 0;
    let retries = 0;
    let totalCount = null;
    abortFlag = false;

    while (pages < maxPages) {
      if (abortFlag) throw new Error("ABORTED");
      const res = await fetch(buildUrl(kind, uid, cursor, count), {
        headers,
        credentials: "include",
      });

      if (res.status === 429 || res.status === 503) {
        if (retries >= 3) throw new Error("RATE_LIMITED");
        retries++;
        emit({ type: "PROGRESS", jobId, kind, phase: "backoff", pages, loaded: users.length, retries });
        await sleep(4000 * retries);
        continue;
      }
      if (!res.ok) throw new Error("HTTP_" + res.status);

      const data = await res.json();
      retries = 0;
      const batch = data.users || [];
      if (totalCount === null && typeof data.total_count === "number") totalCount = data.total_count;
      users.push(...batch);
      pages++;
      emit({ type: "PROGRESS", jobId, kind, phase: "page", pages, loaded: users.length, totalCount });

      const next = data.next_cursor_str;
      if (!next || next === "0" || next === "-1" || next === cursor || batch.length === 0) break;
      cursor = next;
      await sleep(delayMs);
    }

    return { users, pages, totalCount };
  }

  /**
   * 关注 / 取关共用的写入口。
   * 有 id 用 id，老快照没存 id 就退回 screen_name——两条路都实测 200。
   * 写操作带 3~6 秒随机间隔：实测连续几次写就会 429，间隔太小等于自找限流。
   */
  async function friendshipWrite(path, { userId, screenName }) {
    const ct0 = readCookie("ct0");
    if (!ct0) throw new Error("NO_LOGIN");
    if (!userId && !screenName) throw new Error("NO_TARGET");

    const waitFor = WRITE_MIN_GAP + Math.random() * WRITE_JITTER - (Date.now() - lastWriteAt);
    if (waitFor > 0) await sleep(waitFor);
    lastWriteAt = Date.now();

    const form = new URLSearchParams();
    if (userId) form.set("user_id", String(userId));
    else form.set("screen_name", String(screenName));

    const res = await fetch(path, {
      method: "POST",
      headers: {
        authorization: "Bearer " + PUBLIC_BEARER,
        "x-csrf-token": ct0,
        "content-type": "application/x-www-form-urlencoded",
      },
      credentials: "include",
      body: form.toString(),
    });

    const txt = await res.text();
    let json = null;
    try {
      json = JSON.parse(txt);
    } catch (e) {}

    if (res.status === 429) throw new Error("CODE_88");
    if (!res.ok) {
      const code = json && json.errors && json.errors[0] && json.errors[0].code;
      throw new Error("CODE_" + (code || res.status));
    }
    return json;
  }

  /**
   * 查「我是否关注了某人」。writing 接口的响应体会滞后（实测 destroy 返回 200 但
   * 里面的 following 还是 true），所以成败以这个查询为准。
   * 返回 true / false / null（查不到，不判定）。
   */
  async function readFollowing({ userId, screenName }) {
    const ct0 = readCookie("ct0");
    const me = viewerId();
    if (!ct0 || !me) return null;
    const qs = userId
      ? `source_id=${me}&target_id=${encodeURIComponent(userId)}`
      : `source_id=${me}&target_screen_name=${encodeURIComponent(screenName)}`;
    try {
      const res = await fetch(`${SHOW_PATH}?${qs}`, {
        headers: { authorization: "Bearer " + PUBLIC_BEARER, "x-csrf-token": ct0 },
        credentials: "include",
      });
      if (!res.ok) return null;
      const j = await res.json();
      const src = j && j.relationship && j.relationship.source;
      return src ? !!src.following : null;
    } catch (e) {
      return null;
    }
  }

  /** 写完之后核对真实状态，最多两次（服务端有延迟）。null = 无法判定。 */
  async function confirmState(target, want) {
    for (const wait of [700, 1400]) {
      await sleep(wait);
      const cur = await readFollowing(target);
      if (cur === null) return null;
      if (cur === want) return cur;
    }
    return !want;
  }

  /** 关注。返回 { following: true, verified }，失败抛带错误码的 Error。 */
  async function follow(msg) {
    const json = await friendshipWrite(FOLLOW_PATH, msg);
    const confirmed = await confirmState(msg, true);
    return {
      following: true,
      // false = 状态没核对上（可能是服务端延迟），此时不报错，交给 UI 提示用户自己看一眼
      verified: confirmed === true,
      user: json
        ? {
            id: json.id_str || "",
            sn: json.screen_name || msg.screenName || "",
            name: json.name || "",
            followers: json.followers_count ?? 0,
            verified: !!json.ext_is_blue_verified,
            followedBy: !!json.followed_by,
          }
        : null,
    };
  }

  /** 取关。返回 { following: false, verified }。 */
  async function unfollow(msg) {
    await friendshipWrite(UNFOLLOW_PATH, msg);
    const confirmed = await confirmState(msg, false);
    return { following: false, verified: confirmed === false };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === "PING") {
      const ct0 = readCookie("ct0");
      sendResponse({
        ok: true,
        loggedIn: !!ct0,
        userId: viewerId(),
        url: location.href,
      });
      return;
    }

    if (msg.type === "STOP") {
      abortFlag = true;
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === "SCAN") {
      scan(msg)
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
      return true;
    }

    if (msg.type === "FOLLOW") {
      follow(msg)
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
      return true;
    }

    if (msg.type === "UNFOLLOW") {
      unfollow(msg)
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
      return true;
    }
  });
})();
