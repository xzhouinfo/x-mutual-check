/* 仅用于本地预览：伪造 chrome.* API，让 panel.js 能以假数据跑起来。 */
(function () {
  const firstNames = [
    "币圈老张", "CryptoLily", "Web3观察", "链上小纸条", "BTC阿康", "深潮TechFlow",
    "区块律动", "PANews", "Odaily星球", "Foresight News", "吴说区块链", "比特吴",
    "Alex在链上", "Vitalik Fan", "DeFi研究员", "NFT老王", "Solana日报", "以太坊中国",
    "链捕手", "律动BlockBeats", "TokenInsight", "Messari中文", "Glassnode", "Nansen",
    "Lookonchain", "SpotOnChain", "EmberCN", "余烬", "0xSun", "CryptoHayes",
  ];

  // 最后发帖时间的几种典型情况：正常活跃 / 沉默半年 / 沉默一年半 / 零推文
  const AGE_DAYS = [3, 12, 45, 200, 420, 30, 95, 730];

  function makeUser(i, followedBy) {
    const name = firstNames[i % firstNames.length] + (i > 29 ? " " + (i - 29) : "");
    const sn = ["bitcoinzhang", "cryptolily", "web3view", "chainnote", "btcakang"][i % 5] + i;
    const zeroTweets = i % 11 === 9;
    const age = AGE_DAYS[i % AGE_DAYS.length];
    return {
      // 用字符串拼，别写 String(1700000000000000000 + i)：超过 2^53 全部撞成同一个 id
      id_str: "17000000000000" + String(i).padStart(5, "0"),
      screen_name: sn,
      name,
      description: i % 3 === 0 ? "深度分析｜链上数据｜宏观经济｜偶尔聊聊 AI 和产品设计，欢迎交流" : "关注 Web3 与科技，理性讨论。",
      profile_image_url_https:
        "data:image/svg+xml;utf8," +
        encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><rect width="72" height="72" fill="hsl(${(i * 47) % 360},38%,62%)"/></svg>`
        ),
      followers_count: [123400, 8800, 45600, 1290, 234000, 5600][i % 6],
      friends_count: 500 + i,
      statuses_count: zeroTweets ? 0 : 3000 + i,
      created_at: "Wed Oct 10 20:19:24 +0000 2018",
      status: zeroTweets ? undefined : { created_at: new Date(Date.now() - age * 86400000).toUTCString() },
      ext_is_blue_verified: i % 4 === 0,
      protected: false,
      following: true,
      followed_by: followedBy,
    };
  }

  const following = Array.from({ length: 46 }, (_, i) => makeUser(i, i % 3 !== 0));
  const followers = following.filter((u) => u.followed_by).map((u) => ({ ...u }));
  for (let i = 0; i < 12; i++) {
    const u = makeUser(100 + i, true);
    u.following = false;
    followers.push(u);
  }

  /* ---- 额度用的假 storage：内存里的 Map，带 onChanged 回调 ---- */
  const store = new Map();
  const storageListeners = [];
  const storage = {
    local: {
      get: async (key) => {
        const out = {};
        if (typeof key === "string") {
          if (store.has(key)) out[key] = store.get(key);
        } else if (Array.isArray(key)) {
          for (const k of key) if (store.has(k)) out[k] = store.get(k);
        }
        return out;
      },
      set: async (obj) => {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: store.get(k), newValue: v };
          store.set(k, v);
        }
        storageListeners.forEach((fn) => fn(changes, "local"));
      },
    },
    onChanged: { addListener: (fn) => storageListeners.push(fn) },
  };

  // 预置近 14 天的关注记录：今天 37 笔（模拟页面点击 + 面板 + 扫描补记），前几天有多有少
  // 用美西的「今天 0 点」对齐，否则在北京时间上午预览会看到「今日 0 次」
  const PT_FMT = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const now = Date.now();
  const clock = {};
  for (const x of PT_FMT.formatToParts(new Date(now))) if (x.type !== "literal") clock[x.type] = x.value;
  const elapsedToday = ((+clock.hour % 24) * 3600 + +clock.minute * 60 + +clock.second) * 1000;
  const todayStart = now - elapsedToday;

  const seed = [];
  const EMPTY = /[?&]empty=1/.test(location.search);
  const history = [8, 0, 42, 17, 3, 96, 12, 0, 25, 60, 7, 31, 0];
  history.forEach((n, i) => {
    const base = todayStart - (history.length - i) * 86400000;
    for (let k = 0; k < n; k++) {
      seed.push({ t: base + 3600000 * (9 + (k % 8)), a: "follow", u: "17000" + i + k, s: k % 3 ? "page" : "scan" });
    }
  });
  for (let k = 0; k < 37; k++) {
    seed.push({
      t: todayStart + Math.floor((elapsedToday * (k + 1)) / 39),
      a: "follow",
      u: "17009" + k,
      s: k % 4 === 0 ? "panel" : k % 5 === 0 ? "scan" : "page",
    });
  }
  seed.push({ t: todayStart + Math.floor(elapsedToday / 2), a: "unfollow", u: "99", s: "page" });
  if (!EMPTY) store.set("xmc:followlog:1234567890", seed);

  window.chrome = {
    storage,
    runtime: {
      lastError: null,
      onMessage: { addListener() {} },
    },
    tabs: {
      query: async () => [{ id: 1, active: true, url: "https://x.com/home" }],
      create: async () => {},
      sendMessage: (tabId, msg, cb) => {
        setTimeout(() => {
          if (msg.type === "PING") {
            cb({ ok: true, loggedIn: true, userId: "1234567890", url: "https://x.com/home" });
          } else if (msg.type === "SCAN") {
            const users = (msg.kind === "following" ? following : followers).map((u) => ({ ...u }));
            for (let p = 1; p <= 2; p++) {
              setTimeout(() => {
                window.chrome.runtime._listeners.forEach((fn) =>
                  fn({ type: "PROGRESS", kind: msg.kind, phase: "page", pages: p, loaded: Math.round((users.length * p) / 2) })
                );
              }, p * 400);
            }
            // 沉默号补充接口只能覆盖一部分人（真实场景：旧接口只给约 500 个关注）。
            // 这里让后 40% 的人拿不到最后发帖时间，验证界面会显示「未知」而不是「零推文」。
            let covered = 0;
            if (msg.kind === "following") {
              covered = Math.floor(users.length * 0.6);
              for (let i = covered; i < users.length; i++) delete users[i].status;
              setTimeout(() => {
                window.chrome.runtime._listeners.forEach((fn) =>
                  fn({ type: "PROGRESS", kind: "following", phase: "status", pages: 1, loaded: covered })
                );
              }, 900);
            }
            setTimeout(
              () => cb({ ok: true, users, pages: 2, statusCovered: msg.kind === "following" ? covered : undefined }),
              1200
            );
          } else if (msg.type === "SCAN_INTERACTIONS") {
            const kinds = [
              "users_liked_your_tweet",
              "user_replied_to_your_tweet",
              "users_followed_you",
              "user_liked_multiple_tweets",
              "users_retweeted_your_tweet",
              "user_mentioned_you",
              "some_unknown_element",
            ];
            const records = [];
            const users = {};
            for (let i = 0; i < following.length; i++) {
              const u = following[i];
              const times = (i * 7) % 9;
              if (times === 0) continue;
              users[u.id_str] = u;
              for (let k = 0; k < times; k++) {
                records.push({
                  uid: u.id_str,
                  ts: Date.now() - (((i * 3 + k) % 26) + 1) * 86400000,
                  el: kinds[(i + k) % kinds.length],
                });
              }
            }
            for (let i = 0; i < 6; i++) {
              const u = followers[followers.length - 1 - i];
              if (!u) continue;
              users[u.id_str] = u;
              records.push({ uid: u.id_str, ts: Date.now() - (i + 1) * 86400000, el: "users_liked_your_tweet" });
            }
            for (let p = 1; p <= 3; p++) {
              setTimeout(() => {
                window.chrome.runtime._listeners.forEach((fn) =>
                  fn({ type: "PROGRESS", kind: "interactions", phase: "page", pages: p, loaded: Math.round((records.length * p) / 3) })
                );
              }, p * 300);
            }
            setTimeout(() => cb({ ok: true, records, users, pages: 3, unresolved: 0 }), 1000);
          } else if (msg.type === "FOLLOW") {
            (window.__mockFollows ||= []).push({ userId: msg.userId, sn: msg.screenName });
            // 尾部是 3 的 handle 模拟失败；尾部是 7 的模拟「状态没核对上」
            if (String(msg.screenName).endsWith("3")) cb({ ok: false, error: "CODE_161" });
            else
              cb({
                ok: true,
                following: true,
                verified: !String(msg.screenName).endsWith("7"),
                user: { sn: msg.screenName, id: msg.userId },
              });
          } else if (msg.type === "UNFOLLOW") {
            (window.__mockUnfollows ||= []).push({ userId: msg.userId, sn: msg.screenName });
            // 尾部是 1 的 handle 模拟被限流
            if (String(msg.screenName).endsWith("1")) cb({ ok: false, error: "CODE_88" });
            else cb({ ok: true, following: false, verified: !String(msg.screenName).endsWith("7") });
          } else {
            cb({ ok: true });
          }
        }, 60);
      },
    },
    scripting: { executeScript: async () => {} },
  };
  window.chrome.runtime._listeners = [];
  window.chrome.runtime.onMessage.addListener = (fn) => window.chrome.runtime._listeners.push(fn);
  window.chrome.runtime.sendMessage = (msg, cb) => {
    window.chrome.runtime._listeners.forEach((fn) => fn(msg));
    const key = "xmc:followlog:" + (msg && msg.userId);
    if (msg && msg.type === "XMC_LOG_FOLLOW") {
      const cur = store.get(key) || [];
      store.set(key, cur.concat(msg.events || []));
      storageListeners.forEach((fn) => fn({ [key]: { newValue: store.get(key) } }, "local"));
      if (cb) cb({ ok: true, total: (store.get(key) || []).length });
      return;
    }
    if (msg && msg.type === "XMC_SET_LOG") {
      store.set(key, msg.events || []);
      storageListeners.forEach((fn) => fn({ [key]: { newValue: store.get(key) } }, "local"));
      if (cb) cb({ ok: true, total: (store.get(key) || []).length });
      return;
    }
    if (cb) cb();
  };
})();
