import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const pluginPath = fileURLToPath(new URL("../plugin.js", import.meta.url));
const source = await readFile(pluginPath, "utf8");
const requests = [];
let following = false;
let pinLiked = false;
let answerVote = "neutral";
let articleVote = 0;
const pinId = "2050290260991534603";
const pinUrl = "https://www.zhihu.com/pin/" + pinId;
const pinBody = {
  id: pinId,
  type: "pin",
  url: pinUrl + "?native=0",
  author: { id: "u1", url_token: "alice", name: "Alice" },
  content_html: '<p>想法全文第一段</p><p>想法全文最后一段</p><img src="//pic1.zhimg.com/existing.jpg">',
  content: [
    { type: "text", title: "想法标题", content: "<p>想法全文第一段</p>" },
    { type: "image", url: "//pic1.zhimg.com/existing.jpg" },
    { type: "image", url: "//pic1.zhimg.com/image.jpg", thumbnail: "//pic1.zhimg.com/small.jpg" },
    { type: "link_card", url: "https://www.zhihu.com/question/999" },
  ],
  created: 1700000150,
  comment_count: 2,
};

const zhihuUserId = "0123456789abcdef0123456789abcdef";
const cookies = [
  { name: "z_c0", value: "z-c0-value" },
  { name: "d_c0", value: "dummy" },
  { name: "_xsrf", value: "xsrf-value" },
];

const context = {
  origin: "https://www.zhihu.com",
  pluginId: "dev.maxlec.zhihu",
  platformId: "zhihu",
  packageHash: "test",
  scope: "account",
  accountId: zhihuUserId,
  locale: "zh-Hans",
  approvedOrigins: ["https://www.zhihu.com"],
  credentialAvailable: true,
  assetHandles: [],
};

function json(value) {
  return {
    status: 200,
    headers: { "content-type": ["application/json"] },
    body: JSON.stringify(value),
  };
}

function route(request) {
  requests.push(request);
  const url = new URL(request.url);
  const path = url.pathname;
  const search = url.search;
  if (path === "/api/v4/me") {
    assert.equal(request.headers["x-zse-93"], "101_3_3.0");
    assert.match(request.headers["x-zse-96"], /^2\.0_.+/);
    assert.equal(request.headers["x-xsrftoken"], "xsrf-value");
    return json({
      id: zhihuUserId,
      name: "Alice",
      url_token: "alice",
      user_type: "people",
      avatar_url: "https://pic1.zhimg.com/avatar.jpg",
    });
  }
  if (path === "/api/v4/members/abc/pins") {
    return json({
      data: [{ ...pinBody, id: Number(pinId), like_count: 3, virtuals: { is_liked: false } }],
      paging: { is_end: true },
    });
  }
  if (path === "/api/v4/pins/" + pinId) {
    assert.equal(search, "?include=topics");
    return json({ ...pinBody, like_count: pinLiked ? 4 : 3, virtuals: { is_liked: pinLiked } });
  }
  if (path === "/api/v4/pins/" + pinId + "/voters/up") {
    assert.ok(request.method === "POST" || request.method === "DELETE");
    assert.equal(request.body, undefined);
    pinLiked = request.method === "POST";
    return json({ is_liked: pinLiked, liked_count: pinLiked ? 4 : 3 });
  }
  if (path === "/api/v4/comment_v5/pins/" + pinId + "/root_comment") {
    const second = search.includes("offset=");
    if (second) assert.equal(url.searchParams.get("offset"), "a+b/c=");
    return json({
      data: [{
        id: second ? "pc2" : "pc1",
        author: { id: "u2", url_token: "bob", name: "Bob" },
        reply_to_author: second ? { name: "Alice" } : undefined,
        content: "<p>想法评论</p>",
        created_time: 1700000200,
        like_count: 3,
      }],
      paging: second ? { is_end: true } : {
        is_end: false,
        next: "https://www.zhihu.com" + path + "?order_by=score&limit=20&offset=a%2Bb%2Fc%3D",
      },
    });
  }
  if (path === "/api/v4/questions/999") {
    return json({
      id: "999", title: "今天的热门问题", answer_count: 2,
      detail: "<p>问题完整描述</p>", created: 1700000300,
    });
  }
  if (path === "/api/v4/questions/999/feeds") {
    const second = search.includes("offset=");
    if (second) assert.equal(url.searchParams.get("offset"), "next+offset");
    else assert.equal(url.searchParams.get("limit"), "19");
    return json({
      data: [{
        type: "feed",
        target: { type: "answer", id: second ? "124" : "123", excerpt: "回答列表摘要" },
      }],
      paging: second ? { is_end: true } : {
        is_end: false,
        next: "https://www.zhihu.com" + path + "?limit=19&order=default&offset=next%2Boffset",
      },
    });
  }
  if (path === "/api/v4/people/alice/collections") {
    return json({ data: [{ id: "456", title: "我的收藏" }], paging: { is_end: true } });
  }
  if (path === "/api/v4/collections/456/items") {
    return json({
      data: [{ content: pinBody }, { content: { id: "789", type: "article", title: "一篇文章" } }],
      paging: { is_end: true },
    });
  }
  if (path === "/api/v4/notifications/v2/recent") {
    assert.equal(url.searchParams.get("entry_name"), "all");
    return json({
      data: [1, 2].map((id) => ({
        id: "note" + id,
        create_time: 1700000210 + id,
        content: {
          verb: "回复了你的想法",
          actors: [{ id: "u2", url_token: "bob", name: "Bob" }],
          target: { text: "想法标题", link: pinUrl },
        },
        target: { type: "comment", content: "<p>通知里的评论</p>" },
      })),
      paging: { is_end: true },
    });
  }
  if (path === "/api/v4/search/hot_search") {
    return json({ top_search: { words: [{ query: "测试热搜" }, { query: "测试热搜" }] } });
  }
  if (path === "/api/v4/search_v3") {
    assert.equal(url.searchParams.get("q"), "Flare & 知乎");
    if (url.searchParams.get("t") === "people") {
      return json({
        data: [{ type: "search_result", object: { type: "people", id: "abc", url_token: "alice", name: "Alice" } }],
        paging: { is_end: true },
      });
    }
    assert.equal(url.searchParams.get("t"), "general");
    const second = url.searchParams.get("offset") === "20";
    return json({
      data: [{ type: "search_result", object: second ? pinBody : {
        type: "answer", id: "123", excerpt: "搜索回答摘要",
      } }],
      paging: second ? { is_end: true } : {
        is_end: false,
        next: "https://www.zhihu.com/api/v4/search_v3?t=general&q=Flare%20%26%20%E7%9F%A5%E4%B9%8E&offset=20",
      },
    });
  }
  if (path === "/api/v4/answers/123/voters") {
    assert.equal(request.method, "POST");
    answerVote = request.body.value.type;
    assert.ok(answerVote === "up" || answerVote === "neutral");
    return json({ voteup_count: answerVote === "up" ? 43 : 42 });
  }
  if (path === "/api/v4/articles/789/voters") {
    assert.equal(request.method, "POST");
    articleVote = request.body.value.voting;
    assert.ok(articleVote === 1 || articleVote === 0);
    return json({ voteup_count: articleVote === 1 ? 10 : 9 });
  }
  if (path === "/api/v4/content/publish") {
    assert.equal(request.method, "POST");
    assert.equal(request.headers["x-xsrftoken"], "xsrf-value");
    assert.equal(request.body.value.action, "pin");
    const data = request.body.value.data;
    assert.equal(data.hybrid.html, "<p>新想法 &amp; 测试</p><p>第二段</p>");
    assert.ok(data.publish.traceId.endsWith(",00000000-0000-4000-8000-000000000000"));
    return json({
      message: "success",
      data: { result: JSON.stringify({ publish: { id: pinId } }) },
    });
  }
  if (path === "/api/v4/comment_v5/pins/" + pinId + "/comment") {
    assert.equal(request.method, "POST");
    assert.equal(request.body.value.content, "<p>&lt;测试评论&gt;</p>");
    return json({ id: "new-comment", created_time: 1700000500, content: request.body.value.content });
  }
  if (path === "/api/v3/feed/topstory/hot-lists/total") {
    return json({
      data: [
        {
          detail_text: "1234 万热度",
          target: {
            id: "999",
            title: "今天的热门问题",
            excerpt: "问题描述",
            answer_count: 88,
            created: 1700000300,
          },
          children: [{ thumbnail: "https://pic1.zhimg.com/hot.jpg" }],
        },
        ...Array.from({ length: 49 }, (_, index) => ({
          target: { id: String(1000 + index), title: "热榜问题 " + String(index + 2) },
        })),
      ],
    });
  }
  if (path === "/api/v3/moments") {
    return json({
      data: [
        {
          type: "feed_group",
          list: [
            {
              type: "feed",
              verb: "VOTEUP_ANSWER",
              created_time: 1700000400,
              actors: [
                {
                  id: "u9",
                  url_token: "dave",
                  name: "Dave",
                  avatar_url: "https://pic1.zhimg.com/d.jpg",
                },
              ],
              target: {
                type: "answer",
                id: "321",
                question: { id: "654", title: "关注页问题" },
                author: {
                  id: "u10",
                  url_token: "erin",
                  name: "Erin",
                },
                excerpt: "关注页摘要",
                voteup_count: 5,
                comment_count: 1,
                created_time: 1700000350,
              },
            },
          ],
        },
      ],
      paging: { is_end: true },
    });
  }
  if (path === "/api/v4/articles/789") {
    return json({
      id: "789",
      title: "一篇文章",
      author: { id: "u1", url_token: "alice", name: "Alice" },
      content: '<p>文章正文</p><img data-original="https://pic1.zhimg.com/article.jpg">',
      image_url: "https://pic1.zhimg.com/article-cover.jpg",
      created: 1700000500,
      voteup_count: 9,
      relationship: { voting: articleVote },
      comment_count: 2,
    });
  }
  if (path === "/api/v3/feed/topstory/recommend") {
    if (search !== "?limit=20") {
      assert.equal(search, "?limit=20&cursor=next%2B%2F%3D&session_token=feed");
      return json({
        data: [
          {
            type: "feed",
            target: {
              type: "article",
              id: "789",
              title: "一篇文章",
              content: "<p>" + "文".repeat(300) + "</p>",
              image_url: "https://pic1.zhimg.com/article-cover.jpg",
            },
          },
          ...[
            ["这套方案适合初学者吗？", "This approach works well for long lists."],
            ["日本語の質問", "この方法を使っています。"],
            ["這個方法值得推薦嗎？", "簡單而且實用，適合剛開始學習的人。"],
          ].map(([title, excerpt], index) => ({
            type: "feed",
            target: { type: "answer", id: String(800 + index), question: { title }, excerpt },
          })),
        ],
        paging: { is_end: true },
      });
    }
    return json({
      data: [
        {
          type: "feed",
          target: {
            type: "answer",
            id: "123",
            question: { id: "456", title: "如何评价 Flutter？" },
            author: {
              id: "u1",
              url_token: "alice",
              name: "Alice",
              avatar_url: "https://pic1.zhimg.com/a.jpg",
              headline: "开发者",
            },
            excerpt: "Flutter 是一个跨平台框架。",
            voteup_count: 42,
            comment_count: 7,
            created_time: 1700000000,
          },
          children: [{ thumbnail: "//pic1.zhimg.com/cover.jpg" }],
        },
      ],
      paging: {
        next: "https://www.zhihu.com/api/v3/feed/topstory/recommend?limit=20&cursor=next%2B%2F%3D&session_token=feed",
      },
    });
  }
  if (path === "/api/v4/answers/123" && search.includes("include=")) {
    return json({
      id: "123",
      type: "answer",
      question: { id: "456", title: "如何评价 Flutter？" },
      author: {
        id: "u1",
        url_token: "alice",
        name: "Alice",
        avatar_url: "https://pic1.zhimg.com/a.jpg",
        headline: "开发者",
      },
      content:
        '<p>正文</p><img src="data:image/gif;base64,AAAA" data-original="//pic1.zhimg.com/real.jpg"><script>alert(1)</script>',
      created_time: 1700000000,
      voteup_count: 42,
      reaction: { relation: { vote: answerVote } },
      comment_count: 7,
    });
  }
  if (path === "/api/v4/answers/123/comments") {
    return json({
      data: [
        {
          id: "c1",
          content: "<p>同意</p>",
          created_time: 1700000100,
          vote_count: 3,
          author: {
            member: {
              id: "u2",
              url_token: "bob",
              name: "Bob",
              avatar_url: "https://pic1.zhimg.com/b.jpg",
            },
          },
          reply_to_author: { member: { name: "Alice" } },
        },
      ],
      paging: { is_end: true },
    });
  }
  if (path === "/api/v4/members/abc" && search.includes("include=")) {
    return json({
      id: "abc",
      name: "Alice",
      url_token: "alice",
      avatar_url: "https://pic1.zhimg.com/a.jpg",
      headline: "开发者",
      follower_count: 10,
      following_count: 5,
      answer_count: 3,
      is_following: following,
      is_followed: false,
    });
  }
  if (path === "/api/v4/members/abc/answers") {
    return json({
      data: [
        {
          id: "124",
          question: { id: "457", title: "另一个问题" },
          author: { id: "abc", url_token: "alice", name: "Alice" },
          excerpt: "回答摘要",
          voteup_count: 1,
          comment_count: 2,
          created_time: 1700000200,
        },
      ],
      paging: { is_end: true },
    });
  }
  if (path === "/api/v4/members/abc/followees") {
    return json({
      data: [
        {
          id: "u3",
          name: "Carol",
          url_token: "carol",
          headline: "设计师",
          follower_count: 2,
        },
      ],
      paging: { is_end: true },
    });
  }
  if (path === "/api/v4/members/abc/followers" && request.method === "POST") {
    following = true;
    return { status: 204, headers: {}, body: "" };
  }
  return {
    status: 404,
    headers: {},
    body: JSON.stringify({ error: { code: 404, message: "not found" } }),
  };
}

const definitions = [];
const sandbox = {
  defineFlareSocialPlugin(definition) {
    definitions.push(definition);
  },
  flare: {
    http: { request: async (request) => route(request) },
    credential: {
      read: async () => ({
        cookies,
        dc0: "dummy",
        xsrf: "xsrf-value",
        userId: zhihuUserId,
        urlToken: "alice",
      }),
      replace: async () => true,
    },
    crypto: {
      randomHex: async (size) => "ab".repeat(size),
      uuid: async () => "00000000-0000-4000-8000-000000000000",
      sha256: async () => "00".repeat(32),
    },
    locale: { current: async () => "zh-Hans" },
    error(value) {
      const error = new Error(value.message?.value || value.message?.fallback || "error");
      error.code = value.code;
      return error;
    },
  },
};

vm.runInNewContext(source, sandbox, { filename: "plugin.js" });
assert.equal(definitions.length, 1, "plugin must register once");
const plugin = definitions[0];

const manifest = JSON.parse(
  await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
);
const services = {
  "flare.datasource.timeline/v1": plugin.capabilities.timeline,
  "flare.datasource.article/v1": plugin.capabilities.article,
  "flare.datasource.post/v1": plugin.capabilities.post,
  "flare.datasource.tab-catalog/v1": plugin.capabilities.tabCatalog,
  "flare.datasource.notification/v1": plugin.capabilities.notification,
  "flare.datasource.search/v1": plugin.capabilities.search,
  "flare.datasource.compose/v1": plugin.capabilities.compose,
  "flare.datasource.profile/v1": plugin.capabilities.profile,
  "flare.datasource.relation/v1": plugin.capabilities.relation,
};
assert.equal(manifest.platform.loginMethods[0].id, "browser");
assert.equal(typeof plugin.login.browser.check, "function");
for (const [capabilityId, declaration] of Object.entries(
  manifest.platform.capabilities,
)) {
  const service = services[capabilityId];
  assert.ok(service, "missing service for " + capabilityId);
  for (const operation of Object.keys(declaration.operations || {})) {
    assert.equal(
      typeof service[operation],
      "function",
      capabilityId + " is missing " + operation,
    );
  }
}
const locale = JSON.parse(
  await readFile(new URL("../locales/zh-Hans.json", import.meta.url), "utf8"),
);
const textKeys = [];
const collectKeys = (value) => {
  if (Array.isArray(value)) {
    value.forEach(collectKeys);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (typeof value.key === "string") textKeys.push(value.key);
  Object.values(value).forEach(collectKeys);
};
collectKeys(manifest);
for (const key of textKeys) {
  assert.equal(typeof locale[key], "string", "missing locale key " + key);
}

assert.equal(
  JSON.stringify(plugin.detector.detect({ origin: "https://www.zhihu.com" }, context)),
  JSON.stringify({
    match: "exact",
    canonicalOrigin: "https://www.zhihu.com",
    software: "Zhihu",
    instance: {
      domain: "www.zhihu.com",
      title: "知乎",
      description: "Zhihu hot list, recommendations and answers",
    },
  }),
);
assert.equal(
  plugin.detector.detect({ origin: "https://example.com" }, context).match,
  "none",
);

const loginContext = { ...context, scope: "login" };
const loginRequest = { methodId: "browser", origin: context.origin, flowId: "flow" };
const loginStart = await plugin.login.browser.begin(loginRequest, loginContext);
const cookieLogin = manifest.platform.loginMethods[0].cookie;
const manifestStartUrl = cookieLogin.startUrl.replace(
  "$accountOrigin",
  loginContext.origin,
);
assert.equal(loginStart.type, "webCookie");
assert.equal(loginStart.startUrl, "https://www.zhihu.com/signin?next=%2F");
assert.equal(loginStart.startUrl, manifestStartUrl);

const login = await plugin.login.browser.check(
  {
    ...loginRequest,
    cookies: {
      cookies: cookieLogin.probes.flatMap((probe) => {
        const sourceUrl = probe.url.replace("$accountOrigin", loginContext.origin);
        return cookies
          .filter((cookie) => probe.cookies.some(({ name }) => name === cookie.name))
          .map((cookie) => ({ ...cookie, sourceUrl }));
      }),
    },
  },
  loginContext,
);
assert.equal(login.type, "success");
assert.equal(login.value.accountId, zhihuUserId);
assert.equal(login.value.profile.key.id, zhihuUserId);
assert.equal(login.value.profile.handle, "alice");
assert.equal(login.value.capabilities["flare.datasource.timeline/v1"][0], "page");
for (const [capability, declaration] of Object.entries(manifest.platform.capabilities)) {
  assert.deepEqual(
    Array.from(login.value.capabilities[capability]).sort(),
    Object.keys(declaration.operations).sort(),
  );
}

const recommend = await plugin.capabilities.timeline.page(
  {
    timelineId: "recommend",
    page: { direction: "refresh", limit: 20, parameters: {} },
    parameters: {},
  },
  context,
);
assert.equal(recommend.items.length, 1);
assert.equal(recommend.items[0].type, "post");
assert.equal(recommend.items[0].post.key.id, "answer:123");
assert.equal(recommend.items[0].post.detailType, "article");
assert.deepEqual(Array.from(recommend.items[0].post.sourceLanguages ?? []), ["zh-Hans"]);
assert.equal(recommend.items[0].post.author.key.id, "u1");
assert.equal(recommend.items[0].post.media[0].url, "https://pic1.zhimg.com/cover.jpg");
assert.equal(recommend.endReached, false);
const recommendOlder = await plugin.capabilities.timeline.page(
  {
    timelineId: "recommend",
    page: { direction: "older", cursor: recommend.olderCursor, limit: 20, parameters: {} },
    parameters: {},
  },
  context,
);
assert.equal(recommendOlder.endReached, true);
assert.equal(recommendOlder.items[0].post.key.id, "article:789");
assert.equal(recommendOlder.items[0].post.media[0].url, "https://pic1.zhimg.com/article-cover.jpg");
assert.ok(recommendOlder.items[0].post.content.value.endsWith("…"));
assert.deepEqual(Array.from(recommendOlder.items[0].post.sourceLanguages ?? []), ["zh-Hans"]);
assert.equal(recommendOlder.items[1].post.sourceLanguages, undefined);
assert.equal(recommendOlder.items[2].post.sourceLanguages, undefined);
assert.deepEqual(Array.from(recommendOlder.items[3].post.sourceLanguages ?? []), ["zh-Hant"]);
await assert.rejects(plugin.capabilities.timeline.page(
  {
    timelineId: "recommend",
    page: {
      direction: "older",
      cursor: "https://www.zhihu.com.example.com/api/v3/feed/topstory/recommend?cursor=next",
      limit: 20,
      parameters: {},
    },
    parameters: {},
  },
  context,
), { code: "Validation" });

const hot = await plugin.capabilities.timeline.page(
  {
    timelineId: "hot",
    page: { direction: "refresh", limit: 20, parameters: {} },
    parameters: {},
  },
  context,
);
assert.equal(hot.items.length, 20);
assert.equal(hot.items[0].post.key.id, "question:999");
assert.equal(hot.items[0].post.detailType, "post");
assert.ok(hot.items[0].post.content.value.startsWith("<b>#1 今天的热门问题</b>"));
assert.ok(hot.items[0].post.content.value.includes("1234 万热度 · 88 个回答"));
assert.equal(hot.items[0].post.media[0].url, "https://pic1.zhimg.com/hot.jpg");
const hotOlder = (cursor) => plugin.capabilities.timeline.page(
  {
    timelineId: "hot",
    page: { direction: "older", cursor, limit: 20, parameters: {} },
    parameters: {},
  },
  context,
);
const hotSecond = await hotOlder(hot.olderCursor);
const hotThird = await hotOlder(hotSecond.olderCursor);
assert.equal(hotSecond.items.length, 20);
assert.ok(hotSecond.items[0].post.content.value.startsWith("<b>#21 "));
assert.equal(hotThird.items.length, 10);
assert.ok(hotThird.items.at(-1).post.content.value.startsWith("<b>#50 "));
assert.equal(hotThird.endReached, true);

const followingTimeline = await plugin.capabilities.timeline.page(
  {
    timelineId: "following",
    page: { direction: "refresh", limit: 20, parameters: {} },
    parameters: {},
  },
  context,
);
assert.equal(followingTimeline.items.length, 1);
assert.equal(followingTimeline.items[0].post.key.id, "answer:321");
assert.equal(
  followingTimeline.items[0].presentation.message.text,
  "Dave 赞同了",
);
assert.equal(
  followingTimeline.items[0].presentation.message.target.type,
  "article",
);

const signedRequest = requests.find((request) =>
  request.url.includes("/api/v3/feed/topstory/recommend"),
);
assert.equal(
  signedRequest.headers["x-zse-96"],
  "2.0_dgGnx1w3jf3iqpSWeQvqbtS7l+Jq/RZz8JnJ=QppJkjXCYRWQ7J8faceQX2cyFTp",
);
assert.equal(signedRequest.headers["x-zse-93"], "101_3_3.0");
assert.equal(JSON.stringify(signedRequest.cookies), JSON.stringify(cookies));
assert.equal("Cookie" in signedRequest.headers, false);

const detail = await plugin.capabilities.article.detail(
  { key: { id: "answer:123", host: "www.zhihu.com" } },
  context,
);
assert.equal(detail.title, "如何评价 Flutter？");
assert.ok(detail.content.value.includes('<img src="https://pic1.zhimg.com/real.jpg"'));
assert.ok(!detail.content.value.includes("<script"));
assert.equal(detail.coverUrl, undefined);
assert.equal(detail.url, "https://www.zhihu.com/question/456/answer/123");

const articleDetail = await plugin.capabilities.article.detail(
  { key: { id: "article:789", host: "www.zhihu.com" } },
  context,
);
assert.equal(articleDetail.title, "一篇文章");
assert.equal(articleDetail.url, "https://zhuanlan.zhihu.com/p/789");
assert.equal(articleDetail.coverUrl, "https://pic1.zhimg.com/article-cover.jpg");
assert.ok(articleDetail.content.value.includes("https://pic1.zhimg.com/article.jpg"));

const comments = await plugin.capabilities.article.comments(
  {
    key: { id: "answer:123", host: "www.zhihu.com" },
    page: { direction: "refresh", limit: 20, parameters: {} },
  },
  context,
);
assert.equal(comments.items.length, 1);
assert.equal(comments.items[0].post.author.displayName, "Bob");
assert.deepEqual(Array.from(comments.items[0].post.sourceLanguages ?? []), ["zh-Hans"]);
assert.ok(comments.items[0].post.content.value.includes("回复 @Alice"));
assert.equal(comments.endReached, true);

const profile = await plugin.capabilities.profile.byId(
  { key: { id: "abc", host: "www.zhihu.com" } },
  context,
);
assert.equal(profile.displayName, "Alice");
assert.equal(profile.handle, "alice");
assert.equal(profile.followersCount, 10);
assert.equal(profile.key.id, "abc");

const answers = await plugin.capabilities.profile.timeline(
  {
    profile: { id: "abc", host: "www.zhihu.com" },
    tabId: "answers",
    page: { direction: "refresh", limit: 20, parameters: {} },
    parameters: {},
  },
  context,
);
assert.equal(answers.items.length, 1);
assert.equal(answers.items[0].post.key.id, "answer:124");

const followingPage = await plugin.capabilities.profile.following(
  {
    key: { id: "abc", host: "www.zhihu.com" },
    page: { direction: "refresh", limit: 20, parameters: {} },
  },
  context,
);
assert.equal(followingPage.items.length, 1);
assert.equal(followingPage.items[0].handle, "carol");

const relation = await plugin.capabilities.relation.state(
  { key: { id: "abc", host: "www.zhihu.com" } },
  context,
);
assert.equal(relation.following, false);
assert.equal(relation.followedBy, false);

const mutation = await plugin.capabilities.relation.mutate(
  {
    key: { id: "abc", host: "www.zhihu.com" },
    action: "Follow",
    parameters: {},
  },
  context,
);
assert.equal(mutation.type, "updatedRelation");
assert.equal(mutation.relation.following, true);

const refresh = { direction: "refresh", limit: 20, parameters: {} };
const older = (cursor) => ({ ...refresh, direction: "older", cursor });
const pinTimeline = await plugin.capabilities.profile.timeline({
  profile: { id: "abc", host: "www.zhihu.com" }, tabId: "pins", page: refresh, parameters: {},
}, context);
const pinPreview = pinTimeline.items[0].post;
assert.equal(pinPreview.key.id, "pin:" + pinId);
assert.equal(pinPreview.detailType, "article");
assert.equal(pinPreview.media[1].previewUrl, "https://pic1.zhimg.com/small.jpg");
assert.equal(pinPreview.url, pinUrl);
const pinDetail = await plugin.capabilities.article.detail({ key: pinPreview.key }, context);
assert.equal(pinDetail.title, "想法标题");
assert.ok(pinDetail.content.value.includes("想法全文最后一段"));
assert.equal(pinDetail.content.value.split("existing.jpg").length, 2);
assert.ok(pinDetail.content.value.includes('src="https://pic1.zhimg.com/image.jpg"'));
assert.ok(pinDetail.content.value.includes('href="https://www.zhihu.com/question/999"'));
const pinComments = await plugin.capabilities.article.comments({ key: pinPreview.key, page: refresh }, context);
assert.equal(pinComments.items[0].post.author.displayName, "Bob");
assert.equal(pinComments.items[0].post.url, pinUrl);
assert.equal(pinComments.items[0].post.favouritesCount, 3);
const morePinComments = await plugin.capabilities.article.comments({
  key: pinPreview.key, page: older(pinComments.olderCursor),
}, context);
assert.equal(morePinComments.endReached, true);
assert.ok(morePinComments.items[0].post.content.value.includes("回复 @Alice"));

const questionKey = hot.items[0].post.key;
const question = await plugin.capabilities.post.detail({ key: questionKey }, context);
assert.ok(question.post.content.value.includes("问题完整描述"));
const questionPage = await plugin.capabilities.post.context({ key: questionKey, page: refresh }, context);
assert.equal(questionPage.items[0].post.key.id, questionKey.id);
assert.equal(questionPage.items[1].post.detailType, "article");
assert.equal(questionPage.items[1].post.url, "https://www.zhihu.com/question/999/answer/123");
assert.equal(questionPage.items[1].post.content.value, "回答列表摘要");
const moreQuestion = await plugin.capabilities.post.context({
  key: questionKey, page: older(questionPage.olderCursor),
}, context);
assert.equal(moreQuestion.items.length, 1);
assert.equal(moreQuestion.items[0].post.key.id, "answer:124");

const collectionTabs = await plugin.capabilities.tabCatalog.page(refresh, context);
const folder = collectionTabs.items[0].timelines.items[0];
assert.equal(folder.id, "collection-456");
assert.equal(folder.title.value, "我的收藏");
const collection = await plugin.capabilities.timeline.page({
  timelineId: folder.id, page: refresh, parameters: {},
}, context);
assert.equal(collection.items[0].post.key.id, "pin:" + pinId);
assert.equal(collection.items[1].post.key.id, "article:789");

const notifications = await plugin.capabilities.notification.page({ filterId: "all", page: refresh }, context);
const [firstNotice, secondNotice] = notifications.items;
assert.equal(firstNotice.message.target.type, "article");
assert.equal(firstNotice.message.target.key.id, "pin:" + pinId);
assert.ok(firstNotice.message.text.includes("通知里的评论"));
assert.notEqual(firstNotice.message.key.id, secondNotice.message.key.id);

const query = "Flare & 知乎";
const searchPosts = await plugin.capabilities.search.posts({ query, page: refresh }, context);
assert.equal(searchPosts.items[0].post.key.id, "answer:123");
const moreSearch = await plugin.capabilities.search.posts({
  query, page: older(searchPosts.olderCursor),
}, context);
assert.equal(moreSearch.items[0].post.key.id, "pin:" + pinId);
const searchProfiles = await plugin.capabilities.search.profiles({ query, page: refresh }, context);
assert.equal(searchProfiles.items[0].handle, "alice");
const trending = await plugin.capabilities.search.discoverHashtags({ query: "", page: refresh }, context);
assert.equal(trending.items.length, 1);
assert.equal(trending.items[0].name, "测试热搜");
const discoveryAuthors = await plugin.capabilities.search.discoverProfiles({ query: "", page: refresh }, context);
assert.equal(discoveryAuthors.items[0].handle, "alice");
const discoveryPosts = await plugin.capabilities.search.discoverPosts({ query: "", page: refresh }, context);
assert.equal(discoveryPosts.items[0].post.key.id, questionKey.id);

for (const [key, count] of [[pinPreview.key, 4], [recommend.items[0].post.key, 43], [articleDetail.key, 10]]) {
  const mutate = (action) => plugin.capabilities.post.mutate({ key, action, parameters: {} }, context);
  const liked = await mutate("Favourite");
  assert.equal(liked.post.key.id, key.id);
  assert.equal(liked.post.actions[0].action, "Unfavourite");
  assert.equal(liked.post.actions[0].count, count);
  assert.equal(liked.post.actions[1].action, "Reply");
  const undone = await mutate("Unfavourite");
  assert.equal(undone.post.actions[0].action, "Favourite");
  assert.equal(undone.post.actions[0].count, count - 1);
}

const compose = { visibility: "public", languages: [], assets: [], sensitive: false };
const published = await plugin.capabilities.compose.publish({
  ...compose, text: "新想法 & 测试\n第二段",
}, context);
assert.equal(published.post.key.id, "pin:" + pinId);
assert.equal(published.post.detailType, "article");
const publishedComment = await plugin.capabilities.compose.publish({
  ...compose, text: "<测试评论>", replyTo: pinPreview.key,
}, context);
assert.equal(publishedComment.post.key.id, "comment:new-comment");
assert.equal(publishedComment.post.replyTo.id, pinPreview.key.id);
await assert.rejects(plugin.capabilities.compose.publish({
  ...compose, text: "不支持附件", assets: [{ handle: "asset" }],
}, context), { code: "Unsupported" });

console.log("zhihu plugin tests passed");
