"use strict";
(() => {
  // src/plugin.ts
  var TIMELINE_CAPABILITY = "flare.datasource.timeline/v1";
  var ARTICLE_CAPABILITY = "flare.datasource.article/v1";
  var POST_CAPABILITY = "flare.datasource.post/v1";
  var TAB_CATALOG_CAPABILITY = "flare.datasource.tab-catalog/v1";
  var NOTIFICATION_CAPABILITY = "flare.datasource.notification/v1";
  var SEARCH_CAPABILITY = "flare.datasource.search/v1";
  var COMPOSE_CAPABILITY = "flare.datasource.compose/v1";
  var PROFILE_CAPABILITY = "flare.datasource.profile/v1";
  var RELATION_CAPABILITY = "flare.datasource.relation/v1";
  var ZHIHU_HOST = "www.zhihu.com";
  var ZHIHU_ORIGIN = "https://www.zhihu.com";
  var ZSE93 = "101_3_3.0";
  var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  var MEMBER_INCLUDE = "id,name,url_token,avatar_url,headline,description,cover_url,gender,follower_count,following_count,answer_count,articles_count,is_following,is_followed,user_type";
  var ANSWER_DETAIL_INCLUDE = "content,excerpt,voteup_count,comment_count,question.title,question.id,author.name,author.url_token,author.avatar_url,author.headline,created_time,updated_time";
  var ARTICLE_DETAIL_INCLUDE = "content,excerpt,voteup_count,comment_count,author.name,author.url_token,author.avatar_url,author.headline,created,updated,image_url";
  var QUESTION_DETAIL_INCLUDE = "detail,excerpt,author,answer_count,created,created_time";
  var RECOMMEND_PATH = "/api/v3/feed/topstory/recommend";
  var PAGE_SIZE = 20;
  var MAX_PAGE_SIZE = 20;
  var PREVIEW_LENGTH = 144;
  var COMPOSE_LENGTH = 1e3;
  var URL_TOKEN_CACHE = /* @__PURE__ */ new Map();
  defineFlareSocialPlugin({
    detector: {
      detect(request) {
        if (request.origin.toLowerCase() !== ZHIHU_ORIGIN) {
          return { match: "none", canonicalOrigin: request.origin };
        }
        return {
          match: "exact",
          canonicalOrigin: request.origin,
          software: "Zhihu",
          instance: {
            domain: ZHIHU_HOST,
            title: "\u77E5\u4E4E",
            description: "Zhihu hot list, recommendations and answers"
          }
        };
      }
    },
    login: {
      browser: {
        async begin(_request, context) {
          return { type: "webCookie", startUrl: context.origin + "/signin?next=%2F" };
        },
        async check(request, context) {
          const path = "/api/v4/me";
          const probeUrl = context.origin + path;
          const cookies = request.cookies.cookies.filter((cookie) => cookie.sourceUrl === probeUrl).map(({ name: name2, value }) => ({ name: name2, value }));
          const auth = {
            cookies,
            dc0: cookieValue(cookies, "d_c0"),
            xsrf: cookieValue(cookies, "_xsrf")
          };
          if (!hasCookie(cookies, "z_c0") || !auth.dc0) {
            return { type: "pending" };
          }
          const response = await hostRequest({
            url: probeUrl,
            cookies,
            headers: signedHeaders(path, auth, false)
          });
          if (response.status === 401 || response.status === 403) {
            return { type: "pending" };
          }
          if (response.status < 200 || response.status >= 300) {
            fail("Remote", "\u77E5\u4E4E\u62D2\u7EDD\u4E86\u767B\u5F55\u6821\u9A8C\u8BF7\u6C42");
          }
          const root = parseJsonObject(response.body);
          if (!root || asObject(root.error) || root.user_type === "guest") {
            return { type: "pending" };
          }
          const userId = text(root.id).trim();
          if (!userId) return { type: "pending" };
          const name = text(root.name).trim();
          const urlToken = text(root.url_token).trim();
          return {
            type: "success",
            value: {
              accountId: userId,
              origin: context.origin,
              credential: {
                ...auth,
                userId,
                urlToken,
                userName: name,
                avatarUrl: text(root.avatar_url)
              },
              profile: {
                key: { id: userId, host: accountHost(context) },
                handle: urlToken || name || userId,
                displayName: name || urlToken || userId,
                avatarUrl: normalizeMediaUrl(text(root.avatar_url)),
                url: "https://www.zhihu.com/people/" + encodeURIComponent(urlToken || userId)
              },
              capabilities: {
                [TIMELINE_CAPABILITY]: ["page"],
                [ARTICLE_CAPABILITY]: ["detail", "comments"],
                [POST_CAPABILITY]: ["detail", "context", "mutate"],
                [TAB_CATALOG_CAPABILITY]: ["page"],
                [NOTIFICATION_CAPABILITY]: ["page"],
                [SEARCH_CAPABILITY]: ["posts", "profiles", "discoverPosts", "discoverProfiles", "discoverHashtags"],
                [COMPOSE_CAPABILITY]: ["publish"],
                [PROFILE_CAPABILITY]: [
                  "byId",
                  "byHandle",
                  "timeline",
                  "following",
                  "followers"
                ],
                [RELATION_CAPABILITY]: ["state", "mutate"]
              }
            }
          };
        }
      }
    },
    capabilities: {
      timeline: {
        async page(request, context) {
          if (request.page.direction === "newer") {
            fail("Unsupported", "\u77E5\u4E4E\u65F6\u95F4\u7EBF\u4E0D\u652F\u6301\u66F4\u65B0\u65B9\u5411\u7684\u5206\u9875");
          }
          if (request.timelineId === "recommend" || request.timelineId === "recommend-compact") {
            const result = await loadRecommend(request.page, context);
            return request.timelineId === "recommend-compact" ? compactTimeline(result, context) : result;
          }
          if (request.timelineId === "hot") {
            return loadHot(request.page, context);
          }
          if (request.timelineId === "following" || request.timelineId === "following-compact") {
            const result = await loadFollowing(request.page, context);
            return request.timelineId === "following-compact" ? compactTimeline(result, context) : result;
          }
          const collection = /^collection-(\d+)$/.exec(request.timelineId);
          if (collection) return loadCollection(collection[1], request.page, context);
          fail("Unsupported", "\u672A\u77E5\u7684\u77E5\u4E4E\u65F6\u95F4\u7EBF\uFF1A" + request.timelineId);
        }
      },
      tabCatalog: {
        page: loadCollectionTabs
      },
      notification: {
        async page(request, context) {
          return loadNotifications(request.page, context);
        }
      },
      search: {
        async posts(request, context) {
          return loadSearch(request, "general", context, (result) => {
            const post = mapFeedTarget(result, context);
            return post ? { type: "post", post } : void 0;
          });
        },
        async profiles(request, context) {
          return loadSearch(request, "people", context, (result) => result.type === "people" ? mapAuthor(result, context) : void 0);
        },
        async discoverPosts(request, context) {
          return loadHot(request.page, context);
        },
        async discoverProfiles(request, context) {
          const recommendations = await loadRecommend(request.page, context);
          const profiles = /* @__PURE__ */ new Map();
          for (const item of recommendations.items ?? []) {
            if (item.type !== "post" || !item.post.author) continue;
            const author = item.post.author;
            profiles.set(author.key.id, author);
          }
          return { ...recommendations, items: [...profiles.values()] };
        },
        async discoverHashtags(request, context) {
          const root = await apiGet("/api/v4/search/hot_search", context);
          const limit = clampLimit(request.page.limit);
          const words = /* @__PURE__ */ new Set();
          for (const value of asArray(asObject(root.top_search)?.words)) {
            const query = text(asObject(value)?.query).trim();
            if (query && query.length <= 1024) words.add(query);
            if (words.size === limit) break;
          }
          return { items: [...words].map((name) => ({ name })), endReached: true };
        }
      },
      compose: {
        publish: publishContent
      },
      post: {
        async detail(request, context) {
          const ref = parseArticleKey(request.key.id);
          if (ref) return { post: await loadContentPost(ref, context) };
          return { post: await loadQuestionPost(request.key.id, context) };
        },
        async context(request, context) {
          return loadQuestionAnswers(request.key.id, request.page, context);
        },
        async mutate(request, context) {
          const ref = parseArticleKey(request.key.id);
          if (!ref || request.action !== "Favourite" && request.action !== "Unfavourite") {
            fail("Unsupported", "\u8FD9\u6761\u77E5\u4E4E\u5185\u5BB9\u4E0D\u652F\u6301\u6B64\u64CD\u4F5C");
          }
          return mutateVote(ref, request.action === "Favourite", context);
        }
      },
      article: {
        async detail(request, context) {
          const ref = parseArticleKey(request.key.id);
          if (!ref) fail("NotFound", "\u65E0\u6CD5\u8BC6\u522B\u8FD9\u6761\u77E5\u4E4E\u5185\u5BB9");
          const root = await loadContent(ref, context);
          if (ref.kind === "pin") return mapPinDetail(root, request.key, ref.id, context);
          return mapArticleDetail(ref, root, request.key, context);
        },
        async comments(request, context) {
          const ref = parseArticleKey(request.key.id);
          if (!ref) fail("NotFound", "\u65E0\u6CD5\u8BC6\u522B\u8FD9\u6761\u77E5\u4E4E\u5185\u5BB9");
          if (request.page.direction === "newer") {
            fail("Unsupported", "\u77E5\u4E4E\u8BC4\u8BBA\u4E0D\u652F\u6301\u66F4\u65B0\u65B9\u5411\u7684\u5206\u9875");
          }
          if (ref.kind === "pin") return loadPinComments(ref, request.page, context);
          return loadArticleComments(ref, request.page, context);
        }
      },
      profile: {
        async byId(request, context) {
          const member = await fetchMember(request.key.id, context);
          return mapMemberProfile(member, request.key.id, context);
        },
        async byHandle(request, context) {
          const handle = request.handle.trim();
          if (!handle) fail("NotFound", "\u77E5\u4E4E\u7528\u6237\u540D\u4E0D\u80FD\u4E3A\u7A7A");
          const member = await fetchMember(handle, context);
          const id = memberIdOf(member) || handle;
          return mapMemberProfile(member, id, context);
        },
        async timeline(request, context) {
          const tabId = request.tabId || "answers";
          if (tabId !== "answers" && tabId !== "articles" && tabId !== "pins") {
            fail("Unsupported", "\u672A\u77E5\u7684\u77E5\u4E4E\u4E2A\u4EBA\u9875\u6807\u7B7E\uFF1A" + tabId);
          }
          if (request.page.direction === "newer") {
            fail("Unsupported", "\u77E5\u4E4E\u4E2A\u4EBA\u9875\u4E0D\u652F\u6301\u66F4\u65B0\u65B9\u5411\u7684\u5206\u9875");
          }
          const offset = parseOffset(request.page);
          const limit = clampLimit(request.page.limit);
          const memberId = await memberSubresourceId(request.profile.id, context);
          const path = "/api/v4/members/" + encodeURIComponent(memberId) + "/" + tabId + "?offset=" + String(offset) + "&limit=" + String(limit);
          const root = await apiGet(path, context);
          const items = [];
          for (const value of asArray(root.data)) {
            const obj = asObject(value);
            if (!obj) continue;
            const post = tabId === "answers" ? mapAnswerPreview(obj, void 0, context) : tabId === "articles" ? mapArticlePreview(obj, void 0, context) : mapPinPreview(obj, context);
            if (post) items.push({ type: "post", post });
          }
          return pageFromOffset(root, offset, limit, items);
        },
        async following(request, context) {
          return loadPeople(request.key.id, "followees", request.page, context);
        },
        async followers(request, context) {
          return loadPeople(request.key.id, "followers", request.page, context);
        }
      },
      relation: {
        async state(request, context) {
          const member = await fetchMember(request.key.id, context);
          return relationOf(member, request.key);
        },
        async mutate(request, context) {
          if (request.action !== "Follow" && request.action !== "Unfollow") {
            fail("Unsupported", "\u77E5\u4E4E\u53EA\u652F\u6301\u5173\u6CE8\u548C\u53D6\u6D88\u5173\u6CE8");
          }
          const path = "/api/v4/members/" + encodeURIComponent(request.key.id) + "/followers";
          const body = request.action === "Follow" ? {} : { _method: "DELETE" };
          await apiPost(path, body, context);
          const member = await fetchMember(request.key.id, context);
          return {
            type: "updatedRelation",
            relation: relationOf(member, request.key)
          };
        }
      }
    }
  });
  function contentEndpoint(ref) {
    return "/api/v4/" + ref.kind + "s/" + ref.id;
  }
  async function loadContent(ref, context) {
    const include = ref.kind === "pin" ? "topics" : (ref.kind === "answer" ? ANSWER_DETAIL_INCLUDE : ARTICLE_DETAIL_INCLUDE) + ",reaction,relationship.voting";
    const root = await apiGet(contentEndpoint(ref) + "?include=" + include, context, true);
    if (!root || root.is_deleted === true) fail("NotFound", "\u8FD9\u6761\u77E5\u4E4E\u5185\u5BB9\u4E0D\u5B58\u5728\u6216\u5DF2\u88AB\u5220\u9664");
    return root;
  }
  async function loadContentPost(ref, context) {
    const root = { ...await loadContent(ref, context), id: ref.id };
    const post = ref.kind === "pin" ? mapPinPreview(root, context) : ref.kind === "answer" ? mapAnswerPreview(root, void 0, context) : mapArticlePreview(root, void 0, context);
    if (!post) fail("InvalidResponse", "\u77E5\u4E4E\u5185\u5BB9\u8D44\u6599\u4E0D\u5B8C\u6574");
    return post;
  }
  async function mutateVote(ref, active, context) {
    const post = await loadContentPost(ref, context);
    if (post.actions?.[0]?.active === active) return { type: "updatedPost", post };
    const endpoint = contentEndpoint(ref) + "/voters";
    const response = ref.kind === "pin" ? await apiRequest(active ? "POST" : "DELETE", endpoint + "/up", void 0, context, false) : await apiPost(endpoint, ref.kind === "answer" ? { type: active ? "up" : "neutral" } : { voting: active ? 1 : 0 }, context);
    const count = numberOrUndefined(response?.liked_count ?? response?.voteup_count) ?? post.favouritesCount;
    const confirmed = typeof response?.is_liked === "boolean" ? response.is_liked : active;
    const actions = voteActions(confirmed, count) ?? [];
    const reply = post.actions?.find(({ action }) => action === "Reply");
    if (reply) actions.push(reply);
    return {
      type: "updatedPost",
      post: { ...post, favouritesCount: count, actions }
    };
  }
  function voteActions(active, count) {
    if (active === void 0 && count === void 0) return void 0;
    return [{ action: active ? "Unfavourite" : "Favourite", active, count }];
  }
  function contentActions(target, active, count) {
    const actions = voteActions(active, count) ?? [];
    if (target.can_comment !== false && target.admin_closed_comment !== true && target.comment_permission !== "none" && target.comment_permission !== "closed") {
      actions.push({ action: "Reply" });
    }
    return actions;
  }
  async function publishContent(request, context) {
    const body = request.text.trim();
    if (!body || body.length > COMPOSE_LENGTH) {
      fail("Validation", "\u77E5\u4E4E\u5185\u5BB9\u9700\u8981 1 \u81F3 " + COMPOSE_LENGTH + " \u4E2A\u5B57\u7B26");
    }
    if (request.assets.length || request.poll || request.sensitive || request.spoilerText || request.visibility !== "public" || request.languages.length) {
      fail("Unsupported", "\u77E5\u4E4E\u63D2\u4EF6\u76EE\u524D\u652F\u6301\u516C\u5F00\u53D1\u5E03\u7EAF\u6587\u5B57");
    }
    const html = body.split(/\r?\n/).map((line) => "<p>" + escapeHtml(line) + "</p>").join("");
    if (request.replyTo) {
      const ref = parseArticleKey(request.replyTo.id);
      if (!ref || request.replyTo.host !== accountHost(context)) {
        fail("Unsupported", "\u53EA\u652F\u6301\u8BC4\u8BBA\u77E5\u4E4E\u56DE\u7B54\u3001\u6587\u7AE0\u548C\u60F3\u6CD5");
      }
      const endpoint = "/api/v4/comment_v5/" + ref.kind + "s/" + ref.id + "/comment";
      const response2 = await apiPost(endpoint, { content: html }, context);
      const post = mapComment(response2, ref, context);
      if (!post) fail("InvalidResponse", "\u77E5\u4E4E\u6CA1\u6709\u8FD4\u56DE\u5DF2\u53D1\u9001\u7684\u8BC4\u8BBA");
      return { post: { ...post, replyTo: request.replyTo } };
    }
    const auth = await readAuth();
    if (!auth.xsrf) fail("AuthenticationRequired", "\u53D1\u5E03\u60F3\u6CD5\u9700\u8981\u91CD\u65B0\u767B\u5F55\u77E5\u4E4E");
    const response = await apiPost("/api/v4/content/publish", {
      action: "pin",
      data: {
        publish: { traceId: String(Date.now()) + "," + await flare.crypto.uuid() },
        commentsPermission: { comment_permission: "all" },
        extra_info: { view_permission: "all", publisher: "pc" },
        draft: { disabled: 1 },
        hybrid: { html, textLength: body.replace(/\s+/g, " ").length }
      }
    }, context);
    if (response.message !== "success") {
      fail("Remote", text(response.toast_message) || "\u77E5\u4E4E\u672A\u786E\u8BA4\u53D1\u5E03\u60F3\u6CD5");
    }
    const rawResult = asObject(response.data)?.result;
    const result = asObject(rawResult) ?? parseJsonObject(text(rawResult));
    const id = numericId(asObject(result?.publish)?.id ?? result?.id);
    if (!id) fail("InvalidResponse", "\u77E5\u4E4E\u5DF2\u786E\u8BA4\u53D1\u5E03\uFF0C\u4F46\u672A\u8FD4\u56DE\u6709\u6548\u7684\u60F3\u6CD5 ID\uFF0C\u8BF7\u5148\u5237\u65B0\u67E5\u770B");
    return {
      post: {
        key: { id: "pin:" + id, host: accountHost(context) },
        createdAt: nowIso(),
        content: { format: "html", value: html },
        sourceLanguages: zhihuSourceLanguages(body),
        detailType: "article",
        url: ZHIHU_ORIGIN + "/pin/" + id
      }
    };
  }
  function articleVoteState(target) {
    const relation = asObject(asObject(target.reaction)?.relation);
    const value = relation?.vote ?? asObject(target.relationship)?.voting ?? target.voting;
    if (value === "up" || value === 1) return true;
    if (value === "neutral" || value === "down" || value === 0 || value === -1) return false;
    return void 0;
  }
  async function loadArticleComments(ref, page, context) {
    const offset = parseOffset(page);
    const limit = clampLimit(page.limit);
    const isAnswerStart = ref.kind === "answer" && page.direction === "refresh";
    const commentLimit = isAnswerStart ? Math.max(1, limit - 1) : limit;
    const plural = ref.kind === "answer" ? "answers" : "articles";
    const [commentsResponse, answerResponse] = await Promise.allSettled([
      apiGet("/api/v4/" + plural + "/" + encodeURIComponent(ref.id) + "/comments?limit=" + commentLimit + "&offset=" + offset, context),
      isAnswerStart ? apiGet(
        "/api/v4/answers/" + encodeURIComponent(ref.id) + "?include=question.id,question.title,created_time",
        context,
        true
      ) : void 0
    ]);
    const answer = answerResponse.status === "fulfilled" ? answerResponse.value : void 0;
    const question = answer ? answerQuestionLink(answer, context) : void 0;
    if (commentsResponse.status === "rejected") {
      if (question) return { items: [question], endReached: false, olderCursor: "0" };
      throw commentsResponse.reason;
    }
    const root = commentsResponse.value;
    const comments = asArray(root.data).flatMap((value) => {
      const post = mapComment(value, ref, context);
      return post ? [{ type: "post", post }] : [];
    });
    const result = pageFromOffset(root, offset, commentLimit, comments);
    if (question && limit === 1) {
      const hasComments = comments.length > 0 || !result.endReached;
      return { items: [question], endReached: !hasComments, olderCursor: hasComments ? "0" : void 0 };
    }
    if (question) comments.unshift(question);
    return result;
  }
  function answerQuestionId(answer) {
    const question = asObject(answer.question);
    return numericId(question?.id_str) ?? numericId(question?.id) ?? numericId(answer.question_id);
  }
  function answerQuestionLink(answer, context) {
    const id = answerQuestionId(answer);
    if (!id) return void 0;
    const chinese = context.locale.toLowerCase().startsWith("zh");
    const title = text(asObject(answer.question)?.title).trim();
    return {
      type: "feed",
      feed: {
        url: ZHIHU_ORIGIN + "/question/" + id,
        createdAt: isoFromTimestamp(answer.created_time) ?? nowIso(),
        source: { name: chinese ? "\u77E5\u4E4E\u95EE\u9898" : "Zhihu Question" },
        title: chinese ? "\u5728 Flare \u67E5\u770B\u5168\u90E8\u56DE\u7B54" : "See all answers in Flare",
        description: title ? { format: "plain", value: title } : void 0,
        target: { type: "post", key: { id: "question:" + id, host: accountHost(context) } },
        sourceLanguages: chinese ? ["zh-Hans"] : void 0
      }
    };
  }
  function questionIdFromKey(key) {
    const id = /^(?:question:)?(\d+)$/.exec(key)?.[1];
    if (!id) fail("NotFound", "\u65E0\u6CD5\u8BC6\u522B\u8FD9\u4E2A\u77E5\u4E4E\u95EE\u9898");
    return id;
  }
  async function loadQuestionPost(keyId, context) {
    const id = questionIdFromKey(keyId);
    const question = await apiGet(
      "/api/v4/questions/" + id + "?include=" + QUESTION_DETAIL_INCLUDE,
      context,
      true
    );
    if (!question) fail("NotFound", "\u8FD9\u4E2A\u77E5\u4E4E\u95EE\u9898\u4E0D\u5B58\u5728\u6216\u5DF2\u88AB\u5220\u9664");
    const post = mapQuestionPreview({ ...question, id }, context, void 0, void 0, true);
    if (!post) fail("InvalidResponse", "\u77E5\u4E4E\u95EE\u9898\u8D44\u6599\u4E0D\u5B8C\u6574");
    return { ...post, key: { ...post.key, id: keyId } };
  }
  async function loadQuestionAnswers(keyId, page, context) {
    if (page.direction === "newer") fail("Unsupported", "\u77E5\u4E4E\u95EE\u9898\u4E0D\u652F\u6301\u66F4\u65B0\u65B9\u5411\u7684\u5206\u9875");
    const id = questionIdFromKey(keyId);
    const limit = clampLimit(page.limit);
    const refresh = page.direction === "refresh";
    const answerLimit = refresh ? limit - 1 : limit;
    if (answerLimit === 0) {
      const post = await loadQuestionPost(keyId, context);
      return { items: [{ type: "post", post }], olderCursor: "0", endReached: false };
    }
    const endpoint = "/api/v4/questions/" + id + "/feeds";
    const path = pagedPath(endpoint, "?limit=" + answerLimit + "&order=default", page);
    const [root, response] = await Promise.all([
      refresh ? loadQuestionPost(keyId, context) : void 0,
      apiGet(path, context)
    ]);
    const items = root ? [{ type: "post", post: root }] : [];
    for (const value of asArray(response.data)) {
      const entry = asObject(value);
      const answer = asObject(entry?.target);
      if (!answer || answer.type !== "answer") continue;
      const question = asObject(answer.question);
      const post = mapAnswerPreview({ ...answer, question: { ...question, id } }, void 0, context, void 0, false);
      if (post) items.push({ type: "post", post });
    }
    return pageFromNextUrl(response, endpoint, path, items);
  }
  async function loadPinComments(ref, page, context) {
    const endpoint = "/api/v4/comment_v5/pins/" + ref.id + "/root_comment";
    const path = pagedPath(endpoint, "?order_by=score&limit=" + clampLimit(page.limit), page);
    const root = await apiGet(path, context);
    const items = [];
    for (const value of asArray(root.data)) {
      const item = mapComment(value, ref, context);
      if (item) items.push({ type: "post", post: item });
    }
    return pageFromNextUrl(root, endpoint, path, items);
  }
  async function loadCollectionTabs(page, context) {
    if (page.direction === "newer") fail("Unsupported", "\u77E5\u4E4E\u6536\u85CF\u5939\u4E0D\u652F\u6301\u66F4\u65B0\u65B9\u5411\u7684\u5206\u9875");
    await readAuth();
    if (!context.accountId) fail("AuthenticationRequired", "\u8BF7\u5148\u767B\u5F55\u77E5\u4E4E");
    const member = await memberSubresourceId(context.accountId, context);
    const endpoint = "/api/v4/people/" + encodeURIComponent(member) + "/collections";
    const path = pagedPath(endpoint, "?limit=" + clampLimit(page.limit) + "&offset=0", page);
    const root = await apiGet(path, context);
    const items = [];
    for (const value of asArray(root.data)) {
      const collection = asObject(value);
      const id = numericId(collection?.id);
      const title = text(collection?.title).trim();
      if (!id || !title) continue;
      items.push({ id: "collection-" + id, title: { value: title }, icon: "Bookmark" });
    }
    const sections = items.length ? [{
      id: "collections",
      title: { key: "timeline.collections.title", fallback: "Collections" },
      timelines: { items, endReached: true }
    }] : [];
    return pageFromNextUrl(root, endpoint, path, sections);
  }
  async function loadCollection(id, page, context) {
    if (page.direction === "newer") fail("Unsupported", "\u77E5\u4E4E\u6536\u85CF\u5939\u4E0D\u652F\u6301\u66F4\u65B0\u65B9\u5411\u7684\u5206\u9875");
    const endpoint = "/api/v4/collections/" + id + "/items";
    const path = pagedPath(endpoint, "?limit=" + clampLimit(page.limit) + "&offset=0", page);
    const root = await apiGet(path, context);
    const items = [];
    for (const value of asArray(root.data)) {
      const post = mapFeedTarget(asObject(asObject(value)?.content), context);
      if (post) items.push({ type: "post", post });
    }
    return pageFromNextUrl(root, endpoint, path, items);
  }
  async function loadNotifications(page, context) {
    if (page.direction === "newer") fail("Unsupported", "\u77E5\u4E4E\u901A\u77E5\u4E0D\u652F\u6301\u66F4\u65B0\u65B9\u5411\u7684\u5206\u9875");
    const endpoint = "/api/v4/notifications/v2/recent";
    const path = pagedPath(endpoint, "?limit=" + clampLimit(page.limit) + "&entry_name=all&offset=0", page);
    const root = await apiGet(path, context);
    const items = [];
    for (const value of asArray(root.data)) {
      const event = asObject(value);
      const id = text(event?.id).trim();
      const createdAt = isoFromTimestamp(event?.create_time);
      const content = asObject(event?.content);
      if (!id || !createdAt || !content) continue;
      const actors = Array.isArray(content.actors) ? content.actors : [content.actors];
      const actor = mapAuthor(actors[0], context);
      const names = actors.map((entry) => text(asObject(entry)?.name).trim()).filter(Boolean);
      const summary = actor ? names.length > 1 ? "\u7B49 " + names.length + " \u4EBA" : "" : names.join("\u3001");
      const target = asObject(content.target);
      const comment = asObject(event?.target);
      const body = [
        [summary, stripTags(text(content.verb)).trim()].filter(Boolean).join(" "),
        stripTags(text(comment?.type === "comment" ? comment.content : "")).trim(),
        stripTags(text(target?.text) || text(content.text)).trim()
      ].filter(Boolean).join("\n");
      if (!body) continue;
      items.push({
        type: "message",
        message: {
          key: { id: "notification:" + id, host: accountHost(context) },
          createdAt,
          icon: "Notification",
          actor,
          text: body,
          target: zhihuNavigationTarget(text(target?.link), context)
        }
      });
    }
    return pageFromNextUrl(root, endpoint, path, items);
  }
  function zhihuNavigationTarget(raw, context) {
    const url = normalizeLinkUrl(raw);
    if (!url) return void 0;
    const host = accountHost(context);
    const answer = /^https:\/\/www\.zhihu\.com\/(?:question\/\d+\/)?answer\/(\d+)(?:[/?#]|$)/.exec(url)?.[1];
    if (answer) return { type: "article", key: { id: "answer:" + answer, host } };
    const pin = /^https:\/\/www\.zhihu\.com\/pin\/(\d+)(?:[/?#]|$)/.exec(url)?.[1];
    if (pin) return { type: "article", key: { id: "pin:" + pin, host } };
    const article = /^https:\/\/zhuanlan\.zhihu\.com\/p\/(\d+)(?:[/?#]|$)/.exec(url)?.[1];
    if (article) return { type: "article", key: { id: "article:" + article, host } };
    const question = /^https:\/\/www\.zhihu\.com\/question\/(\d+)(?:[/?#]|$)/.exec(url)?.[1];
    if (question) return { type: "post", key: { id: "question:" + question, host } };
    const profile = /^https:\/\/www\.zhihu\.com\/people\/([\w-]+)(?:[/?#]|$)/.exec(url)?.[1];
    if (profile) return { type: "profile", key: { id: profile, host } };
    return { type: "link", url };
  }
  async function loadSearch(request, type, context, map) {
    const query = request.query.trim();
    if (!query) return { items: [], endReached: true };
    const endpoint = "/api/v4/search_v3";
    const path = pagedPath(
      endpoint,
      "?gk_version=gz-gaokao&t=" + type + "&q=" + encodeURIComponent(query) + "&correction=1&offset=0&limit=" + clampLimit(request.page.limit) + "&search_source=Normal&show_all_topics=0",
      request.page
    );
    const root = await apiGet(path, context);
    const items = [];
    for (const value of asArray(root.data)) {
      const entry = asObject(value);
      if (entry?.type !== "search_result") continue;
      const result = asObject(entry.object);
      if (!result) continue;
      const item = map(result);
      if (item) items.push(item);
    }
    return pageFromNextUrl(root, endpoint, path, items);
  }
  function pagedPath(endpoint, query, page) {
    if (page.direction === "refresh" || page.cursor === "0") return endpoint + query;
    const path = nextPathForEndpoint(endpoint, page.cursor);
    if (!path) fail("Validation", "\u77E5\u4E4E\u5206\u9875\u6E38\u6807\u65E0\u6548");
    return path;
  }
  function nextPathForEndpoint(endpoint, value) {
    const path = text(value).trim().replace(/^(?:https?:)?\/\/www\.zhihu\.com(?=\/)/i, "");
    return path.startsWith(endpoint + "?") && !/[\s#\\]/.test(path) ? path : void 0;
  }
  function pageFromNextUrl(root, endpoint, currentPath, items) {
    const paging = asObject(root.paging);
    const next = nextPathForEndpoint(endpoint, paging?.next);
    const olderCursor = paging?.is_end !== true && next !== currentPath ? next : void 0;
    return { items, olderCursor, endReached: olderCursor === void 0 };
  }
  async function loadRecommend(page, context) {
    const limit = clampLimit(page.limit);
    const path = page.direction === "older" ? recommendPagePath(page.cursor ?? "", limit) : RECOMMEND_PATH + "?limit=" + String(limit);
    if (!path) {
      fail("Validation", "\u63A8\u8350\u6D41\u5206\u9875\u6E38\u6807\u65E0\u6548");
    }
    const root = await apiGet(path, context);
    const items = mapFeedItems(asArray(root.data), context).slice(0, limit);
    const paging = asObject(root.paging);
    const next = text(paging?.next).trim();
    const nextPath = recommendPagePath(next, limit);
    const olderCursor = paging?.is_end !== true && nextPath && nextPath !== path ? next : void 0;
    return {
      items,
      olderCursor,
      endReached: olderCursor === void 0
    };
  }
  function compactTimeline(page, context) {
    const chinese = context.locale.toLowerCase().startsWith("zh");
    const items = page.items?.map((item) => {
      if (item.type !== "post") return item;
      const { post, presentation } = item;
      const url = post.url;
      if (!url) return item;
      const html = post.content.value;
      const heading = /^<b>([^<]*)<\/b>(?:<br\/>)?/.exec(html);
      const [firstLine, ...rest] = previewText(heading ? html.slice(heading[0].length) : html).split("\n");
      const title = heading ? decodeEntities(heading[1]) : firstLine;
      const excerpt = heading ? [firstLine, ...rest].filter(Boolean).join(" ") : rest.join(" ");
      const activity = presentation?.message;
      const activityText = activity ? [activity.actor?.displayName, activity.text].filter(Boolean).join(" ") : "";
      const count = post.repliesCount;
      const commentCount = count === void 0 ? "" : count + (chinese ? " \u6761\u8BC4\u8BBA" : count === 1 ? " comment" : " comments");
      const description = [[activityText, commentCount].filter(Boolean).join(" \xB7 "), excerpt].filter(Boolean).join("\n");
      return {
        type: "feed",
        feed: {
          url,
          createdAt: post.createdAt,
          source: { name: post.author?.displayName || (chinese ? "\u77E5\u4E4E" : "Zhihu"), iconUrl: post.author?.avatarUrl },
          title: title || (chinese ? "\u77E5\u4E4E\u5185\u5BB9" : "Zhihu post"),
          description: description ? { format: "plain", value: description } : void 0,
          media: post.media?.find(({ type }) => type === "image"),
          sourceLanguages: post.sourceLanguages,
          target: post.detailType === "link" ? { type: "link", url } : { type: post.detailType === "article" ? "article" : "post", key: post.key }
        }
      };
    });
    return { ...page, items };
  }
  function recommendPagePath(cursor, limit) {
    const path = cursor.replace(/^(?:https?:)?\/\/www\.zhihu\.com(?=\/)/i, "");
    if (path.startsWith(RECOMMEND_PATH + "?") && !/[\s#\\]/.test(path)) return path;
    if (!/^[\w.~%+/=-]+$/.test(cursor) || cursor.startsWith("/")) return void 0;
    return RECOMMEND_PATH + "?limit=" + String(limit) + "&cursor=" + encodeURIComponent(cursor);
  }
  async function loadHot(page, context) {
    let index = parseOffset(page);
    const root = await apiGet(
      "/api/v3/feed/topstory/hot-lists/total?limit=50",
      context
    );
    const limit = clampLimit(page.limit);
    const items = [];
    const data = asArray(root.data);
    for (; index < data.length && items.length < limit; index += 1) {
      const item = mapHotItem(data[index], index + 1, context);
      if (item) items.push({ type: "post", post: item });
    }
    return {
      items,
      olderCursor: index < data.length ? String(index) : void 0,
      endReached: index >= data.length
    };
  }
  async function loadFollowing(page, context) {
    const limit = clampLimit(page.limit);
    const offset = page.direction === "older" ? parseCursorOffset(page.cursor) : 0;
    let path = "/api/v3/moments?limit=" + String(limit);
    if (offset > 0) path += "&offset=" + String(offset);
    const root = await apiGet(path, context);
    const items = mapMomentItems(asArray(root.data), context).slice(0, limit);
    const paging = asObject(root.paging);
    const next = nextOffsetFromUrl(paging?.next);
    const endReached = boolOr(paging?.is_end, next === void 0);
    return {
      items,
      olderCursor: endReached || next === void 0 ? void 0 : String(next),
      endReached
    };
  }
  async function loadPeople(profileId, kind, page, context) {
    if (page.direction === "newer") {
      fail("Unsupported", "\u77E5\u4E4E\u5173\u6CE8\u5217\u8868\u4E0D\u652F\u6301\u66F4\u65B0\u65B9\u5411\u7684\u5206\u9875");
    }
    const offset = parseOffset(page);
    const limit = clampLimit(page.limit);
    const memberId = await memberSubresourceId(profileId, context);
    const path = "/api/v4/members/" + encodeURIComponent(memberId) + "/" + kind + "?offset=" + String(offset) + "&limit=" + String(limit);
    const root = await apiGet(path, context);
    const items = [];
    for (const value of asArray(root.data)) {
      const member = asObject(value);
      if (!member) continue;
      const id = memberIdOf(member);
      if (!id) continue;
      const profile = mapMemberProfile(member, id, context);
      if (profile) items.push(profile);
    }
    return pageFromOffset(root, offset, limit, items);
  }
  function pageFromOffset(root, offset, limit, items) {
    const paging = asObject(root.paging);
    const endReached = boolOr(paging?.is_end, items.length < limit);
    const next = nextOffsetFromUrl(paging?.next) ?? (endReached ? void 0 : offset + Math.max(items.length, limit));
    return {
      items,
      olderCursor: endReached || next === void 0 ? void 0 : String(next),
      endReached
    };
  }
  function mapFeedItems(data, context) {
    const items = [];
    for (const value of data) {
      const entry = asObject(value);
      if (!entry) continue;
      const type = text(entry.type);
      if (type === "feed_advert" || type === "feed_ad") continue;
      if (type === "feed_group") {
        items.push(...mapFeedItems(asArray(entry.list), context));
        continue;
      }
      const children = asArray(entry.children);
      const thumbnail = text(asObject(children[0])?.thumbnail);
      const post = mapFeedTarget(asObject(entry.target), context, thumbnail);
      if (post) items.push({ type: "post", post });
    }
    return items;
  }
  function mapFeedTarget(target, context, thumbnail) {
    if (!target) return void 0;
    const type = text(target.type);
    if (type === "answer") {
      return mapAnswerPreview(target, thumbnail, context);
    }
    if (type === "article") {
      return mapArticlePreview(target, thumbnail, context);
    }
    if (type === "pin") return mapPinPreview(target, context);
    if (type === "zvideo" || type === "video") {
      return mapVideoPreview(target, context);
    }
    if (type === "question") return mapQuestionPreview(target, context);
    return void 0;
  }
  function mapAnswerPreview(target, thumbnail, context, createdAtOverride, showQuestionTitle = true) {
    const id = text(target.id).trim();
    if (!/^\d+$/.test(id)) return void 0;
    const question = asObject(target.question);
    const questionId = text(question?.id).trim();
    const title = showQuestionTitle ? text(question?.title).trim() : "";
    const body = text(target.content);
    const excerpt = previewText(body) || previewText(text(target.excerpt));
    const keyId = "answer:" + id;
    const voteCount = numberOrUndefined(target.voteup_count);
    return {
      key: { id: keyId, host: accountHost(context) },
      author: mapAuthor(target.author, context),
      createdAt: createdAtOverride ?? isoFromTimestamp(target.created_time ?? target.updated_time) ?? nowIso(),
      content: {
        format: "html",
        value: titleAndBody(title, excerpt)
      },
      sourceLanguages: zhihuSourceLanguages(title, excerpt),
      media: imageMedia(thumbnail || text(target.thumbnail) || text(target.cover_url), keyId + "-cover") ?? previewImage(body, keyId),
      detailType: "article",
      url: questionId ? "https://www.zhihu.com/question/" + encodeURIComponent(questionId) + "/answer/" + encodeURIComponent(id) : "https://www.zhihu.com/answer/" + encodeURIComponent(id),
      favouritesCount: voteCount,
      actions: contentActions(target, articleVoteState(target), voteCount),
      repliesCount: numberOrUndefined(target.comment_count)
    };
  }
  function mapArticlePreview(target, thumbnail, context, createdAtOverride) {
    const id = text(target.id).trim();
    if (!/^\d+$/.test(id)) return void 0;
    const title = text(target.title).trim();
    const body = text(target.content);
    const excerpt = previewText(body) || previewText(text(target.excerpt));
    const keyId = "article:" + id;
    const voteCount = numberOrUndefined(target.voteup_count);
    return {
      key: { id: keyId, host: accountHost(context) },
      author: mapAuthor(target.author, context),
      createdAt: createdAtOverride ?? isoFromTimestamp(
        target.created_time ?? target.created ?? target.updated_time
      ) ?? nowIso(),
      content: {
        format: "html",
        value: titleAndBody(title, excerpt)
      },
      sourceLanguages: zhihuSourceLanguages(title, excerpt),
      media: imageMedia(thumbnail, keyId + "-cover") ?? imageMedia(text(target.image_url), keyId + "-cover") ?? previewImage(body, keyId),
      detailType: "article",
      url: "https://zhuanlan.zhihu.com/p/" + encodeURIComponent(id),
      favouritesCount: voteCount,
      actions: contentActions(target, articleVoteState(target), voteCount),
      repliesCount: numberOrUndefined(target.comment_count)
    };
  }
  function mapPinPreview(target, context) {
    const urlId = /^https?:\/\/www\.zhihu\.com\/pin\/(\d+)(?:[/?#]|$)/i.exec(text(target.url))?.[1];
    const id = numericId(target.id_str) ?? urlId ?? numericId(target.id);
    if (!id) return void 0;
    const excerpt = pinExcerpt(target);
    const title = pinTitle(target) || (excerpt ? "" : pinLabel(context));
    const keyId = "pin:" + id;
    const voteCount = numberOrUndefined(target.like_count ?? target.reaction_count);
    const virtuals = asObject(target.virtuals);
    const liked = virtuals?.is_liked ?? virtuals?.isLiked ?? target.is_liked;
    return {
      key: { id: keyId, host: accountHost(context) },
      author: mapAuthor(target.author, context),
      createdAt: isoFromTimestamp(target.created ?? target.created_time) ?? nowIso(),
      content: { format: "html", value: titleAndBody(title, excerpt) },
      sourceLanguages: zhihuSourceLanguages(title, excerpt),
      media: pinMedia(target, keyId),
      detailType: "article",
      url: ZHIHU_ORIGIN + "/pin/" + id,
      favouritesCount: voteCount,
      actions: contentActions(target, typeof liked === "boolean" ? liked : void 0, voteCount),
      repliesCount: numberOrUndefined(target.comment_count)
    };
  }
  function mapQuestionPreview(target, context, hotText, rank, full = false) {
    const id = numericId(target.id_str) ?? numericId(target.id);
    const title = text(target.title).trim() || text(target.name).trim();
    if (!id || !title) return void 0;
    const detail = text(target.detail) || text(target.excerpt);
    const excerpt = previewText(detail);
    const heading = rank === void 0 ? title : "#" + String(rank) + " " + title;
    const answerCount = numberOrUndefined(target.answer_count);
    const answerUnit = context.locale.toLowerCase().startsWith("zh") ? " \u4E2A\u56DE\u7B54" : answerCount === 1 ? " answer" : " answers";
    const answers = answerCount === void 0 ? "" : String(answerCount) + answerUnit;
    const metadata = [hotText, answers].filter(Boolean).join(" \xB7 ");
    const body = [metadata, excerpt === title ? "" : excerpt].filter(Boolean).join("\n");
    const content = full ? "<p><b>" + escapeHtml(title) + "</b></p>" + (metadata ? "<p>" + escapeHtml(metadata) + "</p>" : "") + cleanHtml(detail, true) : titleAndBody(heading, body);
    return {
      key: { id: "question:" + id, host: accountHost(context) },
      author: full ? mapAuthor(target.author, context) : void 0,
      createdAt: isoFromTimestamp(target.created ?? target.created_time) ?? nowIso(),
      content: {
        format: "html",
        value: content
      },
      sourceLanguages: zhihuSourceLanguages(title, excerpt),
      media: imageMedia(text(target.thumbnail), "question:" + id + "-cover"),
      detailType: "post",
      url: "https://www.zhihu.com/question/" + encodeURIComponent(id)
    };
  }
  function mapVideoPreview(target, context) {
    const id = text(target.id).trim();
    if (!id) return void 0;
    const title = text(target.title).trim();
    const excerpt = stripTags(
      text(target.description) || text(target.excerpt)
    ).trim();
    const url = normalizeLinkUrl(text(target.url)) || "https://www.zhihu.com/zvideo/" + encodeURIComponent(id);
    return {
      key: { id: "video:" + id, host: accountHost(context) },
      author: mapAuthor(target.author, context),
      createdAt: isoFromTimestamp(
        target.created_time ?? target.created ?? target.updated
      ) ?? nowIso(),
      content: { format: "html", value: titleAndBody(title, excerpt) },
      sourceLanguages: zhihuSourceLanguages(title, excerpt),
      media: imageMedia(
        text(target.thumbnail) || text(target.cover_url),
        "video:" + id + "-cover"
      ),
      detailType: "link",
      url,
      favouritesCount: numberOrUndefined(
        target.vote_count ?? target.voteup_count
      ),
      repliesCount: numberOrUndefined(target.comment_count)
    };
  }
  function mapHotItem(value, rank, context) {
    const item = asObject(value);
    if (!item) return void 0;
    const target = asObject(item.target);
    if (!target) return void 0;
    const detail = text(item.detail_text).trim();
    const children = asArray(item.children);
    const firstChild = asObject(children[0]);
    const thumbnail = text(firstChild?.thumbnail) || text(target.thumbnail);
    const post = mapQuestionPreview(
      target,
      context,
      detail,
      rank
    );
    if (!post) return void 0;
    post.media = imageMedia(thumbnail, post.key.id + "-cover");
    return post;
  }
  function mapMomentItems(data, context) {
    const items = [];
    for (const value of data) {
      const entry = asObject(value);
      if (!entry) continue;
      const type = text(entry.type);
      if (type === "feed_advert" || type === "feed_ad") continue;
      if (type === "feed_group") {
        items.push(...mapMomentItems(asArray(entry.list), context));
        continue;
      }
      const item = mapMoment(entry, context);
      if (item) items.push(item);
    }
    return items;
  }
  function mapMoment(entry, context) {
    const target = asObject(entry.target);
    if (!target) return void 0;
    const targetType = text(target.type);
    const targetId = text(target.id).trim();
    if (!targetId) return void 0;
    const createdAt = isoFromTimestamp(entry.created_time) ?? nowIso();
    const thumbnail = text(target.thumbnail) || text(target.cover_url);
    let post;
    if (targetType === "answer") {
      post = mapAnswerPreview(target, thumbnail, context, createdAt);
    } else if (targetType === "article") {
      post = mapArticlePreview(target, thumbnail, context, createdAt);
    } else if (targetType === "pin") {
      post = mapPinPreview(target, context);
    } else if (targetType === "question") {
      post = mapQuestionPreview(target, context);
    } else if (targetType === "zvideo" || targetType === "video") {
      post = mapVideoPreview(target, context);
    }
    if (!post) return void 0;
    post.createdAt = createdAt;
    const activity = momentAction(text(entry.verb), context);
    const actor = asObject(asArray(entry.actors)[0]);
    const actorProfile = mapAuthor(actor, context);
    const sameAuthor = actorProfile && post.author && (actorProfile.key.id === post.author.key.id || actorProfile.handle === post.author.handle);
    if (!activity || activity.byAuthor && sameAuthor) return { type: "post", post };
    const actorName = actorProfile ? "" : text(actor?.name).trim();
    const message = {
      key: {
        id: "moment:" + targetType + ":" + targetId + ":" + createdAt,
        host: accountHost(context)
      },
      createdAt,
      icon: activity.icon,
      actor: actorProfile,
      text: [actorName, activity.text].filter(Boolean).join(" "),
      target: post.detailType === "article" ? { type: "article", key: post.key } : post.detailType === "post" ? { type: "post", key: post.key } : post.url ? { type: "link", url: post.url } : void 0
    };
    return { type: "post", post, presentation: { message } };
  }
  function momentAction(verb, context) {
    const chinese = context.locale.toLowerCase().startsWith("zh");
    if (/VOTEUP|VOTE_PIN|LIKE_PIN/.test(verb)) return { text: chinese ? "\u8D5E\u540C\u4E86" : "Liked", icon: "Like" };
    if (/ANSWER_QUESTION|CREATE_ANSWER/.test(verb)) return { text: chinese ? "\u56DE\u7B54\u4E86" : "Answered", icon: "Reply", byAuthor: true };
    if (verb.includes("CREATE_ARTICLE")) return { text: chinese ? "\u53D1\u8868\u4E86\u6587\u7AE0" : "Published an article", icon: "List", byAuthor: true };
    if (verb.includes("CREATE_PIN")) return { text: chinese ? "\u53D1\u5E03\u4E86\u60F3\u6CD5" : "Published a pin", icon: "List", byAuthor: true };
    if (verb.includes("FOLLOW")) return { text: chinese ? "\u5173\u6CE8\u4E86" : "Followed", icon: "Follow" };
    return void 0;
  }
  function mapArticleDetail(ref, root, key, context) {
    const title = ref.kind === "answer" ? text(asObject(root.question)?.title).trim() || "\u77E5\u4E4E\u56DE\u7B54" : text(root.title).trim() || "\u77E5\u4E4E\u6587\u7AE0";
    const content = cleanHtml(text(root.content) || text(root.excerpt), true);
    const coverUrl = normalizeMediaUrl(text(root.image_url));
    const coverInBody = coverUrl !== void 0 && content.includes('<img src="' + escapeAttribute(coverUrl) + '"');
    const questionId = ref.kind === "answer" ? answerQuestionId(root) : void 0;
    const questionLink = questionId ? '<p><a href="' + ZHIHU_ORIGIN + "/question/" + questionId + '">' + (context.locale.toLowerCase().startsWith("zh") ? "\u5728\u77E5\u4E4E\u67E5\u770B\u5168\u90E8\u56DE\u7B54" : "See all answers on Zhihu") + "</a></p>" : "";
    const url = ref.kind === "answer" ? questionId ? "https://www.zhihu.com/question/" + encodeURIComponent(questionId) + "/answer/" + encodeURIComponent(ref.id) : "https://www.zhihu.com/answer/" + encodeURIComponent(ref.id) : "https://zhuanlan.zhihu.com/p/" + encodeURIComponent(ref.id);
    const createdAt = isoFromTimestamp(
      root.created_time ?? root.updated_time ?? root.created ?? root.updated
    ) ?? nowIso();
    return {
      key,
      title,
      author: mapAuthor(root.author, context),
      createdAt,
      content: { format: "html", value: questionLink + content },
      url,
      coverUrl: coverInBody ? void 0 : coverUrl
    };
  }
  function mapPinDetail(pin, key, id, context) {
    const html = text(pin.content_html).trim();
    const main = html ? cleanHtml(html, true).trim() : "";
    const parts = main ? [main] : [];
    const images = /* @__PURE__ */ new Set();
    const links = /* @__PURE__ */ new Set();
    for (const value of asArray(pin.content)) {
      const item = asObject(value);
      if (!item) continue;
      if (!main && item.type === "text") {
        const body = cleanHtml(text(item.content), true).trim();
        if (body) parts.push(body);
      }
      for (const image of pinImages(item)) {
        if (!images.has(image.url) && !main.includes('src="' + escapeAttribute(image.url) + '"')) {
          images.add(image.url);
          parts.push('<figure><img src="' + escapeAttribute(image.url) + '" /></figure>');
        }
      }
      if (item.type === "link_card") {
        const url = normalizeLinkUrl(text(item.url));
        if (url && !links.has(url) && !main.includes('href="' + escapeAttribute(url) + '"')) {
          links.add(url);
          const title = text(item.title).trim() || url;
          parts.push('<p><a href="' + escapeAttribute(url) + '">' + escapeHtml(title) + "</a></p>");
        }
      }
    }
    const fallback = pinExcerpt(pin);
    return {
      key,
      title: pinTitle(pin) || pinLabel(context),
      author: mapAuthor(pin.author, context),
      createdAt: isoFromTimestamp(pin.created ?? pin.created_time),
      content: { format: "html", value: parts.join("\n") || escapeHtml(fallback) || " " },
      url: ZHIHU_ORIGIN + "/pin/" + id
    };
  }
  function mapComment(value, ref, context) {
    const comment = asObject(value);
    if (!comment) return void 0;
    const id = text(comment.id).trim();
    if (!id) return void 0;
    const authorObject = asObject(asObject(comment.author)?.member) ?? asObject(comment.author);
    const replyAuthor = asObject(comment.reply_to_author);
    const replyTo = text((asObject(replyAuthor?.member) ?? replyAuthor)?.name).trim();
    const body = cleanHtml(text(comment.content));
    const prefix = replyTo ? "<p>\u56DE\u590D @" + escapeHtml(replyTo) + "\uFF1A</p>" : "";
    const url = ref.kind === "answer" ? "https://www.zhihu.com/answer/" + encodeURIComponent(ref.id) : ref.kind === "pin" ? ZHIHU_ORIGIN + "/pin/" + ref.id : "https://zhuanlan.zhihu.com/p/" + encodeURIComponent(ref.id);
    return {
      key: { id: "comment:" + id, host: accountHost(context) },
      author: mapAuthor(authorObject, context),
      createdAt: isoFromTimestamp(comment.created_time) ?? nowIso(),
      content: { format: "html", value: prefix + body || " " },
      sourceLanguages: zhihuSourceLanguages(stripTags(body)),
      detailType: "link",
      url,
      favouritesCount: numberOrUndefined(comment.vote_count ?? comment.like_count)
    };
  }
  function mapMemberProfile(member, keyId, context) {
    const fallback = text(member.url_token).trim() || keyId;
    const id = keyId || memberIdOf(member) || fallback;
    const handle = text(member.url_token).trim() || id;
    const name = text(member.name).trim() || handle;
    const headline = text(member.headline).trim() || text(member.description).trim();
    return {
      key: { id, host: accountHost(context) },
      handle,
      displayName: name,
      avatarUrl: normalizeMediaUrl(text(member.avatar_url)),
      bannerUrl: normalizeMediaUrl(text(member.cover_url)),
      description: headline ? { format: "plain", value: headline } : void 0,
      url: "https://www.zhihu.com/people/" + encodeURIComponent(handle),
      followersCount: numberOrUndefined(member.follower_count),
      followingCount: numberOrUndefined(member.following_count),
      postsCount: numberOrUndefined(member.answer_count),
      entityToken: handle
    };
  }
  function mapAuthor(value, context) {
    const author = asObject(value);
    if (!author) return void 0;
    const id = text(author.id).trim() || text(author.url_token).trim();
    if (!id) return void 0;
    const handle = text(author.url_token).trim() || id;
    const name = text(author.name).trim() || handle;
    const headline = text(author.headline).trim() || text(author.description).trim();
    return {
      key: { id, host: accountHost(context) },
      handle,
      displayName: name,
      avatarUrl: normalizeMediaUrl(text(author.avatar_url)),
      description: headline ? { format: "plain", value: headline } : void 0,
      url: "https://www.zhihu.com/people/" + encodeURIComponent(handle)
    };
  }
  function relationOf(member, key) {
    return {
      profileKey: key,
      following: boolOr(member.is_following, false),
      followedBy: boolOr(member.is_followed, false)
    };
  }
  async function fetchMember(id, context) {
    const member = await apiGet(
      "/api/v4/members/" + encodeURIComponent(id) + "?include=" + MEMBER_INCLUDE,
      context,
      true
    );
    if (!member) fail("NotFound", "\u77E5\u4E4E\u7528\u6237\u4E0D\u5B58\u5728");
    if (!memberIdOf(member)) fail("InvalidResponse", "\u77E5\u4E4E\u7528\u6237\u8D44\u6599\u4E0D\u5B8C\u6574");
    return member;
  }
  async function memberSubresourceId(id, context) {
    const cached = URL_TOKEN_CACHE.get(id);
    if (cached) return cached;
    const needsResolution = /^\d+$/.test(id) || /^[0-9a-f]{32}$/i.test(id) || /^[0-9a-f-]{36}$/i.test(id);
    if (!needsResolution) {
      URL_TOKEN_CACHE.set(id, id);
      return id;
    }
    try {
      const member = await fetchMember(id, context);
      const token = text(member.url_token).trim() || id;
      URL_TOKEN_CACHE.set(id, token);
      URL_TOKEN_CACHE.set(token, token);
      return token;
    } catch {
      URL_TOKEN_CACHE.set(id, id);
      return id;
    }
  }
  async function apiGet(path, context, allowNotFound = false) {
    const result = await apiRequest("GET", path, void 0, context, allowNotFound);
    if (!result) fail("NotFound", "\u77E5\u4E4E\u5185\u5BB9\u4E0D\u5B58\u5728");
    return result;
  }
  async function apiPost(path, body, context) {
    const result = await apiRequest("POST", path, body, context, false);
    if (!result) fail("Remote", "\u77E5\u4E4E\u6CA1\u6709\u8FD4\u56DE\u7ED3\u679C");
    return result;
  }
  async function apiRequest(method, path, body, context, allowNotFound) {
    const auth = await readAuth();
    const response = await hostRequest({
      method,
      url: context.origin + path,
      cookies: auth.cookies,
      headers: signedHeaders(path, auth, method === "POST"),
      body: body === void 0 ? void 0 : { type: "json", value: body }
    });
    if (response.status === 401) {
      fail("AuthenticationRequired", "\u77E5\u4E4E\u767B\u5F55\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
    }
    if (response.status === 404 && allowNotFound) return void 0;
    if (response.status === 403) {
      fail("Remote", "\u77E5\u4E4E\u98CE\u63A7\u62E6\u622A\u4E86\u8BF7\u6C42\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5\u6216\u91CD\u65B0\u767B\u5F55");
    }
    if (response.status < 200 || response.status >= 300) {
      fail("Remote", "\u77E5\u4E4E\u63A5\u53E3\u8FD4\u56DE\u9519\u8BEF\uFF08" + String(response.status) + "\uFF09");
    }
    if (response.status === 204 || !response.body.trim()) {
      if (method !== "GET") return {};
      fail("InvalidResponse", "\u77E5\u4E4E\u6CA1\u6709\u8FD4\u56DE\u5185\u5BB9");
    }
    const root = parseJsonObject(response.body);
    if (!root) fail("InvalidResponse", "\u77E5\u4E4E\u6CA1\u6709\u8FD4\u56DE JSON");
    const error = asObject(root.error);
    if (error) {
      const message = text(error.message);
      if (text(error.code) === "101" || /未经过验证|登录/.test(message)) {
        fail("AuthenticationRequired", "\u77E5\u4E4E\u767B\u5F55\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
      }
      fail("Remote", message || "\u77E5\u4E4E\u63A5\u53E3\u8FD4\u56DE\u9519\u8BEF");
    }
    return root;
  }
  async function readAuth() {
    const stored = asObject(await flare.credential.read());
    if (!stored) fail("AuthenticationRequired", "\u8BF7\u5148\u767B\u5F55\u77E5\u4E4E");
    const cookies = parseStoredCookies(stored.cookies);
    if (!hasCookie(cookies, "z_c0")) {
      fail("AuthenticationRequired", "\u77E5\u4E4E\u767B\u5F55\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
    }
    const dc0 = text(stored.dc0) || cookieValue(cookies, "d_c0");
    if (!dc0) {
      fail("AuthenticationRequired", "\u77E5\u4E4E\u767B\u5F55\u7F3A\u5C11 d_c0\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
    }
    const xsrf = text(stored.xsrf) || cookieValue(cookies, "_xsrf") || cookieValue(cookies, "xsrf");
    const userId = text(stored.userId).trim();
    const urlToken = text(stored.urlToken).trim();
    if (userId && urlToken) {
      URL_TOKEN_CACHE.set(userId, urlToken);
      URL_TOKEN_CACHE.set(urlToken, urlToken);
    }
    return { cookies, dc0, xsrf };
  }
  function parseStoredCookies(value) {
    const list = Array.isArray(value) ? value : [];
    const cookies = [];
    for (const entry of list) {
      const cookie = asObject(entry);
      if (!cookie) continue;
      const name = text(cookie.name);
      const content = text(cookie.value);
      if (name && content) cookies.push({ name, value: content });
    }
    return cookies;
  }
  function signedHeaders(path, auth, post) {
    const headers = {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      Referer: ZHIHU_ORIGIN + "/",
      "User-Agent": USER_AGENT,
      "x-requested-with": "fetch",
      "x-zse-93": ZSE93,
      "x-zse-96": "2.0_" + encryptZseV4(md5Hex(ZSE93 + "+" + path + "+" + auth.dc0))
    };
    if (auth.xsrf) headers["x-xsrftoken"] = auth.xsrf;
    if (post) headers["Content-Type"] = "application/json";
    return headers;
  }
  async function hostRequest(request) {
    try {
      return await flare.http.request(request);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        const code = error.code;
        if (code === "host.unavailable") {
          fail("Network", "\u7F51\u7EDC\u8BF7\u6C42\u5931\u8D25");
        }
      }
      throw error;
    }
  }
  function parseArticleKey(id) {
    const match = /^(answer|article|pin):(\d+)$/.exec(id);
    if (!match) return void 0;
    return { kind: match[1], id: match[2] };
  }
  function parseOffset(page) {
    if (page.direction === "refresh") return 0;
    const cursor = page.cursor;
    if (!cursor || !/^\d+$/.test(cursor)) {
      fail("Validation", "\u5206\u9875\u6E38\u6807\u65E0\u6548");
    }
    const value = Number(cursor);
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("Validation", "\u5206\u9875\u6E38\u6807\u65E0\u6548");
    }
    return value;
  }
  function parseCursorOffset(cursor) {
    if (!cursor) fail("Validation", "\u5206\u9875\u6E38\u6807\u65E0\u6548");
    if (!/^\d+$/.test(cursor)) fail("Validation", "\u5206\u9875\u6E38\u6807\u65E0\u6548");
    const value = Number(cursor);
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("Validation", "\u5206\u9875\u6E38\u6807\u65E0\u6548");
    }
    return value;
  }
  function nextOffsetFromUrl(value) {
    const raw = text(value).trim();
    if (!raw) return void 0;
    const match = /[?&]offset=([^&]+)/.exec(raw);
    if (match) {
      const decoded = decodeURIComponent(match[1]);
      if (/^\d+$/.test(decoded)) {
        const parsed = Number(decoded);
        if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
      }
      return void 0;
    }
    if (/^\d+$/.test(raw)) {
      const parsed = Number(raw);
      if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    }
    return void 0;
  }
  function clampLimit(value) {
    if (!Number.isFinite(value)) return PAGE_SIZE;
    return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(value)));
  }
  function titleAndBody(title, body) {
    const parts = [];
    if (title) parts.push("<b>" + escapeHtml(title) + "</b>");
    if (body && body !== title) {
      const paragraphs = body.split(/\n+/).map((line) => line.trim()).filter(Boolean);
      const characters = Array.from(paragraphs.slice(0, 2).join("\n"));
      const clipped = paragraphs.length > 2 || characters.length > PREVIEW_LENGTH;
      const preview = characters.slice(0, PREVIEW_LENGTH).join("").trimEnd();
      parts.push(escapeHtml(clipped ? preview.replace(/[.。…]+$/, "") + "\u2026" : preview).replace(/\n/g, "<br/>"));
    }
    return parts.join("<br/>") || " ";
  }
  function previewText(value) {
    return decodeEntities(value.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?\s*>|<\/(?:p|div|li|blockquote|h[1-6])>/gi, "\n").replace(/<[^>]*>/g, "")).split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  }
  function pinExcerpt(target) {
    const parts = [];
    for (const value of asArray(target.content)) {
      const item = asObject(value);
      if (item?.type !== "text") continue;
      const content = previewText(text(item.content));
      if (content) parts.push(content);
    }
    return parts.join("\n") || previewText(text(target.content_html) || text(target.excerpt_title));
  }
  function previewImage(html, key) {
    for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
      if (isInlineIcon(tag)) continue;
      const previewUrl = normalizeMediaUrl(attribute(tag, "data-actualsrc") || attribute(tag, "src"));
      const url = normalizeMediaUrl(attribute(tag, "data-original")) ?? previewUrl;
      if (url) return [{
        id: key + "-cover",
        type: "image",
        url,
        previewUrl: previewUrl !== url ? previewUrl : void 0,
        description: decodeEntities(attribute(tag, "alt")) || void 0
      }];
    }
    return void 0;
  }
  function pinTitle(pin) {
    const textItem = asArray(pin.content).map(asObject).find((item) => item?.type === "text");
    return text(textItem?.title).trim();
  }
  function pinLabel(context) {
    return context.locale.toLowerCase().startsWith("zh") ? "\u60F3\u6CD5" : "Pin";
  }
  function pinImages(item) {
    const images = [];
    const direct = normalizeMediaUrl(
      text(item.original_url) || text(item.image_url) || (item.type === "image" ? text(item.url) : "")
    );
    if (direct) images.push({ url: direct, previewUrl: normalizeMediaUrl(text(item.thumbnail)) });
    for (const value of asArray(item.image_urls)) {
      const url = normalizeMediaUrl(text(value));
      if (url) images.push({ url });
    }
    return images;
  }
  function pinMedia(target, keyId) {
    const media = [];
    const urls = /* @__PURE__ */ new Set();
    for (const value of asArray(target.content)) {
      const item = asObject(value);
      if (!item) continue;
      for (const image of pinImages(item)) {
        if (urls.has(image.url)) continue;
        urls.add(image.url);
        media.push({ id: keyId + "-" + media.length, type: "image", ...image });
        if (media.length === 9) return media;
      }
    }
    return media.length ? media : void 0;
  }
  function imageMedia(value, id) {
    const url = normalizeMediaUrl(value || "");
    return url ? [{ id, type: "image", url }] : void 0;
  }
  function cleanHtml(value, blockImages = false) {
    let html = value.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<noscript[\s\S]*?<\/noscript>/gi, "").replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
    const imageMarkup = blockImages ? /<\/?figure\b[^>]*>|<img\b[^>]*>/gi : /<img\b[^>]*>/gi;
    let figureDepth = 0;
    html = html.replace(imageMarkup, (tag) => {
      if (/^<figure\b/i.test(tag)) {
        figureDepth += 1;
        return tag;
      }
      if (/^<\/figure\b/i.test(tag)) {
        figureDepth = Math.max(0, figureDepth - 1);
        return tag;
      }
      const source = attribute(tag, "data-original") || attribute(tag, "data-actualsrc") || attribute(tag, "src");
      const alt = attribute(tag, "alt");
      const url = normalizeMediaUrl(source);
      if (!url) return "";
      const altAttribute = alt ? ' alt="' + escapeAttribute(decodeEntities(alt)) + '"' : "";
      const image = '<img src="' + escapeAttribute(url) + '"' + altAttribute + " />";
      return blockImages && figureDepth === 0 && !isInlineIcon(tag) ? "<figure>" + image + "</figure>" : image;
    });
    html = html.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "").replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
    html = html.replace(/(src|href)=(["'])\/\//gi, "$1=$2https://");
    html = html.replace(/(src|href)=(["'])http:\/\//gi, "$1=$2https://");
    html = html.replace(
      /href="https:\/\/link\.zhihu\.com\/\?target=([^"]+)"/gi,
      (original, target) => {
        try {
          return 'href="' + escapeAttribute(decodeURIComponent(decodeEntities(target))) + '"';
        } catch {
          return original;
        }
      }
    );
    return html.trim() || " ";
  }
  function isInlineIcon(tag) {
    return /(?:^|[\s_-])(?:emoji|emoticon)(?:$|[\s_-])/i.test(attribute(tag, "class"));
  }
  function attribute(tag, name) {
    const pattern = new RegExp("\\b" + name + `\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i");
    const match = pattern.exec(tag);
    return match ? match[2] : "";
  }
  function normalizeMediaUrl(value) {
    let url = decodeEntities(value).trim();
    if (!url || /^data:/i.test(url) || /^javascript:/i.test(url)) {
      return void 0;
    }
    if (url.startsWith("//")) url = "https:" + url;
    url = url.replace(/^http:\/\//i, "https://");
    return /^https:\/\/[^\s]+$/i.test(url) ? url : void 0;
  }
  function normalizeLinkUrl(value) {
    return normalizeMediaUrl(value);
  }
  function stripTags(value) {
    return decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
  }
  function zhihuSourceLanguages(...parts) {
    const prose = parts.map((part) => part.replace(/(?:https?:\/\/|www\.)\S+/gi, ""));
    const combined = prose.join(" ");
    if (!/\p{Script=Han}/u.test(combined)) return void 0;
    if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(combined)) {
      return void 0;
    }
    for (const part of prose) {
      const hanCount = part.match(/\p{Script=Han}/gu)?.length ?? 0;
      const foreignWords = part.replace(/\p{Script=Han}/gu, " ").match(/\p{L}+/gu)?.length ?? 0;
      if (foreignWords >= 2 && foreignWords * 2 > hanCount) return void 0;
    }
    const simplified = /[与为书买亲们众会体写动发变听问国图场实对学应开当总戏战报换数时术机条样汉没测湾点现环画种简经网线号视计评语说读课车转这过还进选长门闭间队际难电风马验龙]/u;
    const traditional = /[與為書買親們眾會體寫動發變聽問國圖場實對學應開當總戲戰報換數時術機條樣漢沒測灣點現環畫種簡經網線號視計評語說讀課車轉這過還進選長門閉間隊際難電風馬驗龍個熱頁關]/u;
    if (!traditional.test(combined)) return ["zh-Hans"];
    return simplified.test(combined) ? void 0 : ["zh-Hant"];
  }
  function decodeEntities(value) {
    return value.replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  }
  function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function escapeAttribute(value) {
    return escapeHtml(value).replace(/'/g, "&#39;");
  }
  function memberIdOf(member) {
    return text(member.id).trim() || text(member.url_token).trim();
  }
  function hasCookie(cookies, name) {
    return cookies.some(
      (cookie) => cookie.name === name && cookie.value.length > 0
    );
  }
  function cookieValue(cookies, name) {
    const found = cookies.find((cookie) => cookie.name === name);
    return found ? found.value : "";
  }
  function parseJsonObject(body) {
    try {
      const json = /"id"\s*:\s*\d{16,}(?=\s*[,}])/.test(body) ? body.replace(
        /("id"\s*:\s*)(\d{16,})(?=\s*[,}])|"(?:[^"\\]|\\.)*"/g,
        (token, prefix, digits) => prefix && digits && !Number.isSafeInteger(Number(digits)) ? prefix + '"' + digits + '"' : token
      ) : body;
      const parsed = JSON.parse(json);
      return asObject(parsed);
    } catch {
      return void 0;
    }
  }
  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  }
  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }
  function text(value) {
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    return "";
  }
  function numericId(value) {
    if (typeof value === "number" && !Number.isSafeInteger(value)) return void 0;
    const id = text(value).trim();
    return /^\d+$/.test(id) ? id : void 0;
  }
  function numberOrUndefined(value) {
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : void 0;
  }
  function boolOr(value, fallback) {
    if (value === true || value === 1 || value === "1" || value === "true") {
      return true;
    }
    if (value === false || value === 0 || value === "0" || value === "false") {
      return false;
    }
    return fallback;
  }
  function isoFromTimestamp(value) {
    const raw = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isFinite(raw) || raw <= 0) return void 0;
    const milliseconds = raw > 1e12 ? raw : raw * 1e3;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : void 0;
  }
  function nowIso() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
  function accountHost(context) {
    return context.origin.slice("https://".length);
  }
  function fail(code, message) {
    throw flare.error({ code, message: { value: message } });
  }
  function encryptZseV4(input) {
    const inputBytes = utf8Bytes(input);
    const plain = new Uint8Array(2 + inputBytes.length);
    plain[0] = 210;
    plain[1] = 0;
    plain.set(inputBytes, 2);
    const pad = 16 - plain.length % 16;
    const padded = new Uint8Array(plain.length + pad);
    padded.set(plain);
    padded.fill(pad, plain.length);
    const first = new Uint8Array(16);
    for (let index = 0; index < 16; index += 1) {
      first[index] = padded[index] ^ KEY16[index] ^ 42;
    }
    let previous = rBlock(first);
    const cipher = new Uint8Array(padded.length);
    cipher.set(previous, 0);
    for (let offset = 16; offset < padded.length; offset += 16) {
      const block = new Uint8Array(16);
      for (let index = 0; index < 16; index += 1) {
        block[index] = padded[offset + index] ^ previous[index];
      }
      previous = rBlock(block);
      cipher.set(previous, offset);
    }
    return customEncode(cipher);
  }
  var ZSE_ZB = [
    20,
    223,
    245,
    7,
    248,
    2,
    194,
    209,
    87,
    6,
    227,
    253,
    240,
    128,
    222,
    91,
    237,
    9,
    125,
    157,
    230,
    93,
    252,
    205,
    90,
    79,
    144,
    199,
    159,
    197,
    186,
    167,
    39,
    37,
    156,
    198,
    38,
    42,
    43,
    168,
    217,
    153,
    15,
    103,
    80,
    189,
    71,
    191,
    97,
    84,
    247,
    95,
    36,
    69,
    14,
    35,
    12,
    171,
    28,
    114,
    178,
    148,
    86,
    182,
    32,
    83,
    158,
    109,
    22,
    255,
    94,
    238,
    151,
    85,
    77,
    124,
    254,
    18,
    4,
    26,
    123,
    176,
    232,
    193,
    131,
    172,
    143,
    142,
    150,
    30,
    10,
    146,
    162,
    62,
    224,
    218,
    196,
    229,
    1,
    192,
    213,
    27,
    110,
    56,
    231,
    180,
    138,
    107,
    242,
    187,
    54,
    120,
    19,
    44,
    117,
    228,
    215,
    203,
    53,
    239,
    251,
    127,
    81,
    11,
    133,
    96,
    204,
    132,
    41,
    115,
    73,
    55,
    249,
    147,
    102,
    48,
    122,
    145,
    106,
    118,
    74,
    190,
    29,
    16,
    174,
    5,
    177,
    129,
    63,
    113,
    99,
    31,
    161,
    76,
    246,
    34,
    211,
    13,
    60,
    68,
    207,
    160,
    65,
    111,
    82,
    165,
    67,
    169,
    225,
    57,
    112,
    244,
    155,
    51,
    236,
    200,
    233,
    58,
    61,
    47,
    100,
    137,
    185,
    64,
    17,
    70,
    234,
    163,
    219,
    108,
    170,
    166,
    59,
    149,
    52,
    105,
    24,
    212,
    78,
    173,
    45,
    0,
    116,
    226,
    119,
    136,
    206,
    135,
    175,
    195,
    25,
    92,
    121,
    208,
    126,
    139,
    3,
    75,
    141,
    21,
    130,
    98,
    241,
    40,
    154,
    66,
    184,
    49,
    181,
    46,
    243,
    88,
    101,
    183,
    8,
    23,
    72,
    188,
    104,
    179,
    210,
    134,
    250,
    201,
    164,
    89,
    216,
    202,
    220,
    50,
    221,
    152,
    140,
    33,
    235,
    214
  ];
  var ZSE_ZK = [
    1170614578,
    1024848638,
    1413669199,
    3951632832,
    3528873006,
    2921909214,
    4151847688,
    3997739139,
    1933479194,
    3323781115,
    3888513386,
    460404854,
    3747539722,
    2403641034,
    2615871395,
    2119585428,
    2265697227,
    2035090028,
    2773447226,
    4289380121,
    4217216195,
    2200601443,
    3051914490,
    1579901135,
    1321810770,
    456816404,
    2903323407,
    4065664991,
    330002838,
    3506006750,
    363569021,
    2347096187
  ];
  var ZSE_ALPHABET = "6fpLRqJO8M/c3jnYxFkUVC4ZIG12SiH=5v0mXDazWBTsuw7QetbKdoPyAl+hN9rgE";
  var KEY16 = new Uint8Array([
    48,
    53,
    57,
    48,
    53,
    51,
    102,
    55,
    100,
    49,
    53,
    101,
    48,
    49,
    100,
    55
  ]);
  function rotateLeft(value, bits) {
    return (value << bits | value >>> 32 - bits) >>> 0;
  }
  function zseG(tt) {
    const ti = (ZSE_ZB[tt >>> 24 & 255] << 24 | ZSE_ZB[tt >>> 16 & 255] << 16 | ZSE_ZB[tt >>> 8 & 255] << 8 | ZSE_ZB[tt & 255]) >>> 0;
    return (ti ^ rotateLeft(ti, 2) ^ rotateLeft(ti, 10) ^ rotateLeft(ti, 18) ^ rotateLeft(ti, 24)) >>> 0;
  }
  function rBlock(input) {
    const tr = new Array(36);
    for (let index = 0; index < 4; index += 1) {
      tr[index] = readU32Be(input, index * 4);
    }
    for (let index = 0; index < 32; index += 1) {
      tr[index + 4] = (tr[index] ^ zseG((tr[index + 1] ^ tr[index + 2] ^ tr[index + 3] ^ ZSE_ZK[index]) >>> 0)) >>> 0;
    }
    const output = new Uint8Array(16);
    writeU32Be(tr[35], output, 0);
    writeU32Be(tr[34], output, 4);
    writeU32Be(tr[33], output, 8);
    writeU32Be(tr[32], output, 12);
    return output;
  }
  function customEncode(bytesIn) {
    let bytes = bytesIn;
    const remainder = bytes.length % 3;
    if (remainder !== 0) {
      const padded = new Uint8Array(bytes.length + (3 - remainder));
      padded.set(bytes);
      bytes = padded;
    }
    let output = "";
    let index = 0;
    for (let position = bytes.length - 1; position >= 0; position -= 3) {
      let value = 0;
      const mask0 = 58 >>> 8 * (index % 4) & 255;
      index += 1;
      value |= (bytes[position] ^ mask0) & 255;
      const mask1 = 58 >>> 8 * (index % 4) & 255;
      index += 1;
      value |= ((bytes[position - 1] ^ mask1) & 255) << 8;
      const mask2 = 58 >>> 8 * (index % 4) & 255;
      index += 1;
      value |= ((bytes[position - 2] ^ mask2) & 255) << 16;
      output += ZSE_ALPHABET[value & 63];
      output += ZSE_ALPHABET[value >>> 6 & 63];
      output += ZSE_ALPHABET[value >>> 12 & 63];
      output += ZSE_ALPHABET[value >>> 18 & 63];
    }
    return output;
  }
  function readU32Be(bytes, offset) {
    return (bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]) >>> 0;
  }
  function writeU32Be(value, bytes, offset) {
    bytes[offset] = value >>> 24 & 255;
    bytes[offset + 1] = value >>> 16 & 255;
    bytes[offset + 2] = value >>> 8 & 255;
    bytes[offset + 3] = value & 255;
  }
  function md5Hex(value) {
    const message = utf8Bytes(value);
    const bitLengthLow = message.length << 3 >>> 0;
    const bitLengthHigh = Math.floor(message.length / 536870912) >>> 0;
    const paddedLength = (Math.floor((message.length + 8) / 64) + 1) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(message);
    padded[message.length] = 128;
    for (let index = 0; index < 4; index += 1) {
      padded[paddedLength - 8 + index] = bitLengthLow >>> 8 * index & 255;
      padded[paddedLength - 4 + index] = bitLengthHigh >>> 8 * index & 255;
    }
    let a0 = 1732584193;
    let b0 = 4023233417;
    let c0 = 2562383102;
    let d0 = 271733878;
    const words = new Array(16);
    for (let offset = 0; offset < padded.length; offset += 64) {
      for (let index = 0; index < 16; index += 1) {
        const wordOffset = offset + index * 4;
        words[index] = padded[wordOffset] | padded[wordOffset + 1] << 8 | padded[wordOffset + 2] << 16 | padded[wordOffset + 3] << 24;
      }
      let a = a0;
      let b = b0;
      let c = c0;
      let d = d0;
      for (let index = 0; index < 64; index += 1) {
        let f;
        let g;
        if (index < 16) {
          f = b & c | ~b & d;
          g = index;
        } else if (index < 32) {
          f = d & b | ~d & c;
          g = (5 * index + 1) % 16;
        } else if (index < 48) {
          f = b ^ c ^ d;
          g = (3 * index + 5) % 16;
        } else {
          f = c ^ (b | ~d);
          g = 7 * index % 16;
        }
        const nextD = c;
        c = b;
        b = b + rotateLeft(a + f + MD5_K[index] + words[g] >>> 0, MD5_S[index]) >>> 0;
        a = d;
        d = nextD;
      }
      a0 = a0 + a >>> 0;
      b0 = b0 + b >>> 0;
      c0 = c0 + c >>> 0;
      d0 = d0 + d >>> 0;
    }
    return littleEndianHex(a0) + littleEndianHex(b0) + littleEndianHex(c0) + littleEndianHex(d0);
  }
  var MD5_S = [
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    7,
    12,
    17,
    22,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    5,
    9,
    14,
    20,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    4,
    11,
    16,
    23,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21,
    6,
    10,
    15,
    21
  ];
  var MD5_K = (() => {
    const table = new Array(64);
    for (let index = 0; index < 64; index += 1) {
      table[index] = Math.floor(
        Math.abs(Math.sin(index + 1)) * 4294967296
      ) >>> 0;
    }
    return table;
  })();
  function littleEndianHex(value) {
    const bytes = [
      value & 255,
      value >>> 8 & 255,
      value >>> 16 & 255,
      value >>> 24 & 255
    ];
    let output = "";
    for (const byte of bytes) {
      output += HEX[byte >>> 4] + HEX[byte & 15];
    }
    return output;
  }
  var HEX = "0123456789abcdef";
  function utf8Bytes(value) {
    const bytes = [];
    for (let index = 0; index < value.length; index += 1) {
      let code = value.charCodeAt(index);
      if (code >= 55296 && code <= 56319 && index + 1 < value.length) {
        const next = value.charCodeAt(index + 1);
        if (next >= 56320 && next <= 57343) {
          code = 65536 + (code - 55296 << 10) + (next - 56320);
          index += 1;
        }
      }
      if (code <= 127) {
        bytes.push(code);
      } else if (code <= 2047) {
        bytes.push(192 | code >> 6, 128 | code & 63);
      } else if (code <= 65535) {
        bytes.push(
          224 | code >> 12,
          128 | code >> 6 & 63,
          128 | code & 63
        );
      } else {
        bytes.push(
          240 | code >> 18,
          128 | code >> 12 & 63,
          128 | code >> 6 & 63,
          128 | code & 63
        );
      }
    }
    return new Uint8Array(bytes);
  }
})();
