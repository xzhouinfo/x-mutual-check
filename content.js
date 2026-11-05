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

  /*
   * 关注/粉丝列表必须走 GraphQL，不能用 REST v1.1。
   * 实测：friends/following/list.json 翻到第 6 页就给 next_cursor=0，只能拿到 527 人，
   * 而账号主页显示 1406 —— 老接口有硬上限，用它统计互关必然漏一大半人。
   * GraphQL 的 Following 能一路翻到 1409 人（29 页 × 50），Followers 同理。
   *
   * queryId 是 X 每次发版可能更换的哈希，所以优先用 inject.js 从页面真实请求里抄到的值，
   * 下面这份只是兜底（2026-11-05 实测有效）。
   * 另外这两个端点会随机返回 404（同一 URL 交替 200/404，实测 3/6），必须重试。
   */
  const GQL_DEFAULT = {
    following: { qid: "QPaR5ONQTW_KyiEXQCHP4g", op: "Following" },
    followers: { qid: "QgDRdL1wGs4vS0mZ0qKHkA", op: "Followers" },
  };
  const GQL_FEATURES =
    "{\"rweb_video_screen_enabled\":false,\"rweb_cashtags_enabled\":true,\"profile_label_improvements_pcf_label_in_post_enabled\":true,\"responsive_web_profile_redirect_enabled\":true,\"rweb_tipjar_consumption_enabled\":false,\"verified_phone_label_enabled\":false,\"creator_subscriptions_tweet_preview_api_enabled\":true,\"responsive_web_graphql_timeline_navigation_enabled\":true,\"premium_content_api_read_enabled\":false,\"communities_web_enable_tweet_community_results_fetch\":true,\"c9s_tweet_anatomy_moderator_badge_enabled\":true,\"responsive_web_grok_analyze_button_fetch_trends_enabled\":false,\"responsive_web_grok_analyze_post_followups_enabled\":true,\"rweb_cashtags_composer_attachment_enabled\":true,\"responsive_web_jetfuel_frame\":true,\"rweb_sports_post_context_enabled\":true,\"x_elections_post_context_enabled\":true,\"responsive_web_grok_share_attachment_enabled\":true,\"responsive_web_grok_annotations_enabled\":true,\"articles_preview_enabled\":true,\"responsive_web_edit_tweet_api_enabled\":true,\"rweb_conversational_replies_downvote_enabled\":false,\"graphql_is_translatable_rweb_tweet_is_translatable_enabled\":true,\"view_counts_everywhere_api_enabled\":true,\"longform_notetweets_consumption_enabled\":true,\"responsive_web_twitter_article_tweet_consumption_enabled\":true,\"content_disclosure_indicator_enabled\":true,\"content_disclosure_ai_generated_indicator_enabled\":true,\"responsive_web_grok_show_grok_translated_post\":true,\"responsive_web_grok_analysis_button_from_backend\":true,\"post_ctas_fetch_enabled\":false,\"freedom_of_speech_not_reach_fetch_enabled\":true,\"standardized_nudges_misinfo\":true,\"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled\":true,\"longform_notetweets_rich_text_read_enabled\":true,\"longform_notetweets_inline_media_enabled\":false,\"responsive_web_nested_quote_preview_enabled\":true,\"responsive_web_grok_image_annotation_enabled\":true,\"responsive_web_grok_imagine_annotation_enabled\":true,\"responsive_web_made_on_x_label_enabled\":false,\"responsive_web_grok_community_note_auto_translation_is_enabled\":true,\"responsive_web_enhance_cards_enabled\":false}";

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

  /* ==================== GraphQL：拿全量关注 / 粉丝 ==================== */

  /** 优先用 inject.js 从页面真实请求里抄到的 queryId，拿不到再退回内置值。 */
  function gqlConfig(kind) {
    const fallback = GQL_DEFAULT[kind];
    let live = null;
    try {
      const raw = document.documentElement.getAttribute("data-xmc-gql");
      if (raw) live = JSON.parse(raw)[fallback.op];
    } catch (e) {}
    return {
      qid: (live && live.qid) || fallback.qid,
      op: fallback.op,
      features: (live && live.features) || GQL_FEATURES,
      fromPage: !!(live && live.qid),
    };
  }

  /** GraphQL 的用户对象是拆散的新结构，摊平成 REST v1.1 的样子，UI 只维护一套读法。 */
  function normalizeGqlUser(u) {
    if (!u || !u.rest_id) return null;
    const rel = u.relationship_perspectives || {};
    return {
      id_str: String(u.rest_id),
      screen_name: (u.core && u.core.screen_name) || "",
      name: (u.core && u.core.name) || "",
      description: (u.profile_bio && u.profile_bio.description) || "",
      profile_image_url_https: (u.avatar && u.avatar.image_url) || "",
      followers_count: (u.relationship_counts && u.relationship_counts.followers) || 0,
      friends_count: (u.relationship_counts && u.relationship_counts.following) || 0,
      statuses_count: (u.tweet_counts && u.tweet_counts.tweets) || 0,
      created_at: (u.core && u.core.created_at) || "",
      ext_is_blue_verified: !!u.is_blue_verified,
      verified: !!(u.verification && u.verification.verified),
      protected: !!(u.privacy && u.privacy.protected),
      following: !!rel.following,
      followed_by: !!rel.followed_by,
    };
  }

  /**
   * 翻 GraphQL 列表。每页固定 50 人（count 传 100 也只给 50）。
   *
   * 注意 404：这个端点会随机返回 404——同一个 URL 连发六次实测 404/200/404/200/200/404，
   * 纯抖动，不是真的没有数据。所以 404 必须重试，绝不能当成「翻完了」，否则会静默少人。
   */
  async function gqlScan({ kind, userId, jobId, delayMs = 650, maxPages = 80 }) {
    const ct0 = readCookie("ct0");
    if (!ct0) throw new Error("NO_LOGIN");
    const uid = userId || viewerId();
    if (!uid) throw new Error("NO_USER_ID");

    let cfg = gqlConfig(kind);
    let triedFallback = false;
    const headers = {
      authorization: "Bearer " + PUBLIC_BEARER,
      "x-csrf-token": ct0,
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": "zh-cn",
    };

    const users = [];
    const seenCursors = new Set();
    let cursor = "";
    let pages = 0;
    abortFlag = false;

    while (pages < maxPages) {
      if (abortFlag) throw new Error("ABORTED");

      const variables = {
        userId: uid,
        count: 50,
        cursor,
        includePromotedContent: false,
        withGrokTranslatedBio: true,
      };
      const url =
        `/i/api/graphql/${cfg.qid}/${cfg.op}` +
        `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
        `&features=${encodeURIComponent(cfg.features)}`;

      let res = null;
      let ok = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        res = await fetch(url, { headers, credentials: "include" });
        if (res.status === 200) {
          ok = true;
          break;
        }
        if (res.status === 429 || res.status === 503) {
          emit({ type: "PROGRESS", jobId, kind, phase: "backoff", pages, loaded: users.length, retries: attempt + 1 });
          await sleep(4000 * (attempt + 1));
          continue;
        }
        if (res.status === 404 || res.status >= 500) {
          await sleep(400 + attempt * 500);
          continue;
        }
        throw new Error("HTTP_" + res.status);
      }
      if (!ok) {
        // 页面抄来的 queryId 也可能是别的版本留下的，连续失败就用内置兜底再试一次
        if (cfg.fromPage && !triedFallback) {
          triedFallback = true;
          cfg = { qid: GQL_DEFAULT[kind].qid, op: GQL_DEFAULT[kind].op, features: GQL_FEATURES, fromPage: false };
          continue;
        }
        throw new Error(res && res.status === 429 ? "RATE_LIMITED" : "GQL_" + (res ? res.status : "FAIL"));
      }

      const json = await res.json();
      const timeline = json && json.data && json.data.user && json.data.user.result &&
        json.data.user.result.timeline && json.data.user.result.timeline.timeline;
      if (!timeline) throw new Error("GQL_SHAPE");

      const inst = timeline.instructions || [];
      let entries = [];
      let bottom = null;
      for (const ins of inst) {
        if (ins.type === "TimelineAddEntries") entries = entries.concat(ins.entries || []);
        if (ins.type === "TimelineReplaceEntry" && ins.entry && ins.entry.content &&
          ins.entry.content.cursorType === "Bottom") {
          bottom = ins.entry.content.value;
        }
      }
      for (const e of entries) {
        if (e.content && e.content.cursorType === "Bottom") bottom = e.content.value;
      }

      const batch = [];
      for (const e of entries) {
        const r = e.content && e.content.itemContent && e.content.itemContent.user_results &&
          e.content.itemContent.user_results.result;
        const n = normalizeGqlUser(r);
        if (n && n.screen_name) batch.push(n);
      }

      users.push(...batch);
      pages++;
      emit({ type: "PROGRESS", jobId, kind, phase: "page", pages, loaded: users.length, totalCount: null });

      // 只看 cursor 判断结束：TimelineTerminateTimeline 在第一页就会出现（表示「顶部到头」），
      // 拿它当「翻完了」会让扫描在第一页 50 人就停。
      if (!bottom || batch.length === 0) break;
      // 到底时 bottom 形如 "0|2118..."，再翻就是空页
      if (String(bottom).startsWith("0|")) break;
      if (seenCursors.has(bottom)) break;
      seenCursors.add(bottom);
      cursor = bottom;
      await sleep(delayMs);
    }

    return { users, pages, totalCount: null, qidFromPage: cfg.fromPage };
  }

  /**
   * 沉默号要「最后一条推文时间」，但 GraphQL 不返回 status 字段，
   * 只有 REST v1.1 的老列表接口带 status.created_at。
   * 那个接口有硬上限（~500 人），所以这份数据只做补充：能补上的补，补不上的留空，不假装知道。
   */
  async function restStatusMap({ userId, jobId, delayMs = 500, maxPages = 10 }) {
    const ct0 = readCookie("ct0");
    const uid = userId || viewerId();
    if (!ct0 || !uid) return { map: {}, pages: 0, known: 0 };

    const headers = { authorization: "Bearer " + PUBLIC_BEARER, "x-csrf-token": ct0 };
    const map = {};
    let known = 0;
    let cursor = "-1";
    let pages = 0;

    while (pages < maxPages) {
      if (abortFlag) break;
      let res = null;
      try {
        res = await fetch(buildUrl("following", uid, cursor, 200, true), { headers, credentials: "include" });
      } catch (e) {
        break;
      }
      if (!res.ok) break;
      const data = await res.json();
      const batch = data.users || [];
      for (const u of batch) {
        const sn = String(u.screen_name || "").toLowerCase();
        if (!sn) continue;
        if (u.status && u.status.created_at) {
          const ts = Date.parse(u.status.created_at);
          if (Number.isFinite(ts)) {
            map[sn] = ts;
            known++;
          }
        } else if (u.statuses_count === 0) {
          map[sn] = null; // 零推文号
        }
      }
      pages++;
      emit({ type: "PROGRESS", jobId, kind: "following", phase: "status", pages, loaded: known, totalCount: null });
      const next = data.next_cursor_str;
      if (!next || next === "0" || next === "-1" || batch.length === 0) break;
      cursor = next;
      await sleep(delayMs);
    }

    return { map, pages, known };
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

  /**
   * 扫一档关系（关注 / 粉丝）。
   *
   * 主数据走 GraphQL 拿全量；只看关注列表时，额外用 REST v1.1 补一次「最后发帖时间」。
   * 以前整份数据都靠 REST，结果一个 1406 关注的账号只扫出 527 人，统计全错——
   * 那个接口只给前 ~500 个，翻到第 6 页 next_cursor 就变 0 了。
   */
  async function scan({ kind, userId, jobId, delayMs = 650, maxPages = 80, withStatus = true }) {
    const result = await gqlScan({ kind, userId, jobId, delayMs, maxPages });

    if (withStatus && kind === "following") {
      try {
        const { map, known } = await restStatusMap({ userId, jobId });
        let covered = 0;
        for (const u of result.users) {
          const sn = String(u.screen_name || "").toLowerCase();
          if (!Object.prototype.hasOwnProperty.call(map, sn)) continue;
          u.last_tweet_at = map[sn];
          u.status_known = true;
          covered++;
        }
        result.statusCovered = covered;
        result.statusKnown = known;
      } catch (e) {
        result.statusCovered = 0;
      }
    }

    return result;
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
