/* 仅用于本地预览：伪造 chrome.* API，让 panel.js 能以假数据跑起来。 */
(function () {
  const firstNames = [
    "币圈老张", "CryptoLily", "Web3观察", "链上小纸条", "BTC阿康", "深潮TechFlow",
    "区块律动", "PANews", "Odaily星球", "Foresight News", "吴说区块链", "比特吴",
    "Alex在链上", "Vitalik Fan", "DeFi研究员", "NFT老王", "Solana日报", "以太坊中国",
    "链捕手", "律动BlockBeats", "TokenInsight", "Messari中文", "Glassnode", "Nansen",
    "Lookonchain", "SpotOnChain", "EmberCN", "余烬", "0xSun", "CryptoHayes",
  ];

  function makeUser(i, followedBy) {
    const name = firstNames[i % firstNames.length] + (i > 29 ? " " + (i - 29) : "");
    const sn = ["bitcoinzhang", "cryptolily", "web3view", "chainnote", "btcakang"][i % 5] + i;
    return {
      id_str: String(1700000000000000000 + i),
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
      statuses_count: 3000 + i,
      created_at: "Wed Oct 10 20:19:24 +0000 2018",
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

  window.chrome = {
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
            const users = msg.kind === "following" ? following : followers;
            for (let p = 1; p <= 2; p++) {
              setTimeout(() => {
                window.chrome.runtime._listeners.forEach((fn) =>
                  fn({ type: "PROGRESS", kind: msg.kind, phase: "page", pages: p, loaded: Math.round((users.length * p) / 2) })
                );
              }, p * 400);
            }
            setTimeout(() => cb({ ok: true, users, pages: 2 }), 1200);
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
    if (cb) cb();
  };
})();
