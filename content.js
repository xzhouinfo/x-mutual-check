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
  const NOTIF_PATH = "/i/api/2/notifications/all.json";
  const NOTIF_PARAMS = [
    "include_mention_filter=true",
    "include_nsfw_user_flag=false",
    "include_nsfw_admin_flag=false",
    "include_ranked_timeline=true",
    "include_alerter_filter=true",
  ].join("&");
  const FOLLOW_PATH = "/i/api/1.1/friendships/create.json";
  const UNFOLLOW_PATH = "/i/api/1.1/friendships/destroy.json";
  const SHOW_PATH = "/i/api/1.1/friendships/show.json";
  // 注意：这里没有 skip_status。带上 status 才能拿到每个人的最后一条推文时间（沉默号要用），
  // 代价是响应体积约为原来的 3 倍（实测 524 人 ≈ 1.7MB）。不需要时用 withStatus:false 换回来。
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

  function buildUrl(kind, userId, cursor, count, withStatus) {
    const path = API_PATH[kind];
    const extra = withStatus === false ? "&skip_status=1" : "";
    return `${path}?${COMMON_PARAMS}${extra}&user_id=${userId}&count=${count}&cursor=${encodeURIComponent(cursor)}`;
  }

  function buildNotifUrl(cursor, count) {
    const c = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    return `${NOTIF_PATH}?${NOTIF_PARAMS}&count=${count}${c}`;
  }

  /** 通知里的 user 只留 UI 要用的字段，字段名保持接口原名，交给 panel 的 normalizeUser 处理。 */
  function pickUser(u) {
    if (!u) return null;
    return {
      id_str: u.id_str || (u.id !== undefined ? String(u.id) : ""),
      screen_name: u.screen_name || "",
      name: u.name || "",
      description: u.description || "",
      profile_image_url_https: u.profile_image_url_https || u.profile_image_url || "",
      followers_count: u.followers_count || 0,
      friends_count: u.friends_count || 0,
      statuses_count: u.statuses_count || 0,
      ext_is_blue_verified: !!u.ext_is_blue_verified,
      verified: !!u.verified,
      following: !!u.following,
      followed_by: !!u.followed_by,
    };
  }

  function emit(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch (e) {}
  }

  async function scan({ kind, userId, jobId, count = 200, delayMs = 1200, maxPages = 60, withStatus = true }) {
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
      const res = await fetch(buildUrl(kind, uid, cursor, count, withStatus), {
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
   * 扫通知流，抽「谁跟我互动过」。
   *
   * 通知条目长这样：entry.content.item.{content, clientEventInfo}
   *   - item.clientEventInfo.element → 动作类型（users_followed_you / user_replied_to_your_tweet …）
   *   - item.content.notification.fromUsers → 一批 uid（关注/点赞/转发这类）
   *   - item.content.tweet.id → 回复这类只有推文 id，要回 globalObjects.tweets 查 user_id_str
   * 实测 27/27 条回复都能反查到人，没有漏的。
   *
   * 只能翻到有限历史（实测 371 条 / 26 天），翻到底 next_cursor 就没了，属正常结束。
   */
  async function scanInteractions({ jobId, count = 40, delayMs = 900, maxPages = 12 }) {
    const ct0 = readCookie("ct0");
    if (!ct0) throw new Error("NO_LOGIN");

    const headers = { authorization: "Bearer " + PUBLIC_BEARER, "x-csrf-token": ct0 };
    const records = [];
    const users = {};
    let cursor = null;
    let pages = 0;
    let retries = 0;
    let unresolved = 0;
    abortFlag = false;

    while (pages < maxPages) {
      if (abortFlag) throw new Error("ABORTED");
      const res = await fetch(buildNotifUrl(cursor, count), { headers, credentials: "include" });

      if (res.status === 429 || res.status === 503) {
        if (retries >= 3) throw new Error("RATE_LIMITED");
        retries++;
        emit({ type: "PROGRESS", jobId, kind: "interactions", phase: "backoff", pages, loaded: records.length, retries });
        await sleep(4000 * retries);
        continue;
      }
      // 400 一般是 count 传大了（上限 40），别当成登录问题
      if (res.status === 400) throw new Error("BAD_REQUEST");
      if (!res.ok) throw new Error("HTTP_" + res.status);
      retries = 0;

      const data = await res.json();
      const go = data.globalObjects || {};
      for (const [id, u] of Object.entries(go.users || {})) users[id] = pickUser(u);

      const instr = (data.timeline && data.timeline.instructions) || [];
      const entries = [];
      for (const i of instr) {
        const add = Array.isArray(i.addEntries) ? i.addEntries : (i.addEntries && i.addEntries.entries) || null;
        if (add) entries.push(...add);
      }

      let next = null;
      let got = 0;
      for (const e of entries) {
        if (!e.entryId) continue;
        if (e.entryId.startsWith("cursor-bottom")) {
          const c = e.content || {};
          next = (c.operation && c.operation.cursor && c.operation.cursor.value) || c.value || null;
          continue;
        }
        if (!e.entryId.startsWith("notification-")) continue;

        const item = (e.content && e.content.item) || {};
        const content = item.content || {};
        const el = (item.clientEventInfo && item.clientEventInfo.element) || "unknown";
        const ts = Number(e.sortIndex) || 0;

        let ids = [];
        if (content.notification && Array.isArray(content.notification.fromUsers)) {
          ids = content.notification.fromUsers.map(String);
        }
        if (!ids.length && content.tweet && content.tweet.id) {
          const t = (go.tweets || {})[content.tweet.id];
          const uid = t && (t.user_id_str || (t.user && t.user.id_str));
          if (uid) ids = [String(uid)];
          else unresolved++;
        }
        for (const uid of ids) records.push({ uid, ts, el });
        got++;
      }

      pages++;
      emit({ type: "PROGRESS", jobId, kind: "interactions", phase: "page", pages, loaded: records.length, totalCount: null });
      if (!next || next === cursor || got === 0) break;
      cursor = next;
      await sleep(delayMs);
    }

    return { records, users, pages, unresolved };
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

    if (msg.type === "SCAN_INTERACTIONS") {
      scanInteractions(msg)
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
