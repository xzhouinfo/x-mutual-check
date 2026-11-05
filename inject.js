/**
 * 跑在页面的 MAIN world：只做一件事——盯住 X 自己发出的 GraphQL 请求，
 * 把 Following / Followers 的 queryId 和 features 抄下来，写到 <html data-xmc-gql>。
 *
 * 为什么要这样：queryId 是 X 每次发版都可能换的哈希，硬编码迟早失效。
 * 页面自己访问过「正在关注 / 关注者」时会把真实值发出来，抄下来就能一直用。
 * 这里不发任何请求，只读，且不改变原有行为。
 */
(function () {
  "use strict";
  if (window.__xmcQidHooked) return;
  window.__xmcQidHooked = true;

  var seen = {};

  function record(rawUrl) {
    try {
      var s = String(rawUrl || "");
      var m = s.match(/\/i\/api\/graphql\/([^/]+)\/(Following|Followers)\b/);
      if (!m) return;
      var abs = new URL(s, location.origin);
      var features = abs.searchParams.get("features") || "";
      var prev = seen[m[2]];
      if (prev && prev.qid === m[1] && prev.features === features) return;
      seen[m[2]] = { qid: m[1], features: features };
      document.documentElement.setAttribute("data-xmc-gql", JSON.stringify(seen));
    } catch (e) {}
  }

  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input) {
      try {
        record(typeof input === "string" ? input : input && input.url);
      } catch (e) {}
      return origFetch.apply(this, arguments);
    };
  }

  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      record(url);
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };
})();
