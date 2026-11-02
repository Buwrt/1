/* ============================================================
 * gql-lists.js — GitHub Lists（官网收藏夹分组）同步层
 *
 * 背景：GitHub 官网那个「?tab=stars 左侧的 Lists」是**账号绑定、云端存储**
 * 的——换手机登录同一个号还在。而 githup 原来的收藏夹是纯本机的
 * （starlists.js 存 localStorage），清数据就没了。
 *
 * 为什么走 GraphQL 而不是 REST：
 *   Lists **没有 REST 端点**。有人实测 /user/starred_lists 直接 404。
 *   官网自己调的就是 GraphQL，我们要读写同一份数据只能走同一条路。
 *
 * ⚠️ 三个必须知道的坑（都是第三方实测出来的，不在官方文档里）：
 *   1. Lists 仍是 public preview，字段和语义随时可能变，甚至下线；
 *   2. 需要 token 带 `user` scope，否则返回 INSUFFICIENT_SCOPES；
 *   3. updateUserListsForItem 是**替换式写入**——传进去的 listIds 是
 *      「这个仓库最终应该在的所有列表」，不是"追加"。分两次调用，
 *      第二次会把第一次覆盖掉。所以每次写都必须**先读当前完整集合，
 *      合并后再整体提交**。下面 setRepoLists 就是这么干的。
 *
 * 降级：任何一步失败（scope 不够 / API 变了 / 网络问题）都抛出带
 *       needUserScope 或 gqlFailed 标记的错误，上层据此退回本地收藏夹，
 *       绝不让用户的数据凭空消失。
 * ============================================================ */
(function () {
  'use strict';

  var KEY = 'gqlists_enabled_v1';

  /* ---------- 开关 ----------
     同步是【默认开启】的，没有设置项可关。

     理由：收藏夹本来就该跟着账号走 —— 官网建了列表、换手机还在，
     App 里却看不到，那才是让人困惑的。所以这里不提供关闭入口。

     但这不等于"强制联网"：令牌不带 user 权限、或 GraphQL 报错时，
     下面每一步都会抛出带 needUserScope / gqlFailed 的错误，上层
     （starlists.js）据此自动退回本机收藏夹。用户看到的是列表照常能用，
     只是不同步 —— 不会卡住、不会白屏、数据不会丢。 */
  function enabled() { return true; }
  function setEnabled(on) {
    /* 保留符号：老版本可能在别处调过。什么都不做，恒开。 */
  }

  /* ---------- GraphQL 文本 ---------- */

  /* 读全部列表 + 每个列表里的仓库。items 分页，先取 100 条。 */
  /*
   * ⚠️ items 是**联合类型** UserListItems —— 里面可能不全是仓库。
   * GraphQL 不允许在联合类型上直接选字段，必须用 `... on 具体类型`
   * 先声明"我只取这一种"，否则 GitHub 直接回：
   *   "Selections can't be made directly on unions (see selections on UserListItems)"
   * 这就是当初同步一直失败的原因。
   */
  var Q_LISTS =
    'query($n:Int!){viewer{lists(first:$n){nodes{' +
    'id name description isPrivate ' +
    'items(first:100){nodes{' +
    '... on Repository{' +
    'id name nameWithOwner description stargazerCount ' +
    'primaryLanguage{name} updatedAt' +
    '}}}}}}}';

  var Q_REPO_ID =
    'query($o:String!,$n:String!){repository(owner:$o,name:$n){id}}';

  var M_CREATE =
    'mutation($name:String!,$description:String,$isPrivate:Boolean!)' +
    '{createUserList(input:{name:$name,description:$description,isPrivate:$isPrivate})' +
    '{list{id name description isPrivate}}}';

  var M_UPDATE =
    'mutation($id:ID!,$name:String!,$description:String)' +
    '{updateUserList(input:{listId:$id,name:$name,description:$description})' +
    '{list{id name description}}}';

  /* 注意：deleteUserList 的 payload **不能**查 list 字段，实测只认
     clientMutationId。查了会直接报语法错误。 */
  var M_DELETE =
    'mutation($id:ID!){deleteUserList(input:{listId:$id}){clientMutationId}}';

  var M_SET_ITEM =
    'mutation($itemId:ID!,$listIds:[ID!]!)' +
    '{updateUserListsForItem(input:{itemId:$itemId,listIds:$listIds}){clientMutationId}}';

  /* ---------- 缓存：避免每次写都重新拉全量 ---------- */
  var cache = null;

  function invalidate() { cache = null; }

  /* ---------- 自动同步 ----------
     同步是双向的，所以「官网那头改了」这边也得跟着变。以前只在第一次
     进收藏夹时拉一次（用 flag 卡住），之后官网再怎么改都看不见 ——
     那不叫同步，叫一次性导入。

     现在改成节流重拉：进收藏夹、从后台切回来、写完一次，都会拉。
     20 秒内不重复拉，免得切个 tab 就打一串 GraphQL（写操作要预留配额）。 */
  var lastSyncAt = 0;
  var SYNC_MIN_GAP = 20000;

  /**
   * 需要就拉一次。
   * @param {boolean} force true = 无视节流立刻拉（切回前台、写完之后用）
   * @returns {Promise<Array|null>} 拉了就返回列表，跳过了返回 null
   */
  function syncIfStale(force) {
    var now = Date.now();
    if (!force && now - lastSyncAt < SYNC_MIN_GAP) return Promise.resolve(null);
    lastSyncAt = now;
    return fetchAll(true);
  }

  /* ---------- 读 ---------- */

  /**
   * 拉取官网的全部 Lists。
   * @returns {Promise<Array>} [{id,name,description,isPrivate,repos:[...]}]
   */
  function fetchAll(force) {
    if (cache && !force) return Promise.resolve(cache);
    if (!window.API || typeof window.API.graphql !== 'function') {
      return Promise.reject(new Error('当前版本不支持 GraphQL'));
    }
    return window.API.graphql(Q_LISTS, { n: 100 }).then(function (d) {
      var nodes = (d && d.viewer && d.viewer.lists && d.viewer.lists.nodes) || [];
      var out = nodes.map(function (l) {
        var items = (l && l.items && l.items.nodes) || [];
        /* 非仓库条目（比如仓库被删了）命中不到片段，字段全是空 —— 剔掉，
           不然列表里会出现一行没有名字的空条目。 */
        items = items.filter(function (r) { return r && r.nameWithOwner; });
        return {
          id: l.id,
          name: l.name,
          description: l.description || '',
          isPrivate: !!l.isPrivate,
          repos: items.map(function (r) {
            return {
              node_id: r.id,
              full_name: r.nameWithOwner,
              name: r.name,
              description: r.description || '',
              stargazers_count: r.stargazerCount || 0,
              language: (r.primaryLanguage && r.primaryLanguage.name) || '',
              updated_at: r.updatedAt || ''
            };
          })
        };
      });
      cache = out;
      return out;
    });
  }

  /** 仓库的 GraphQL Node ID（写操作必需，REST 的整数 ID 不行） */
  function repoNodeId(fullName) {
    var parts = String(fullName || '').split('/');
    if (parts.length !== 2) return Promise.reject(new Error('仓库名不合法'));
    return window.API.graphql(Q_REPO_ID, { o: parts[0], n: parts[1] })
      .then(function (d) {
        var id = d && d.repository && d.repository.id;
        if (!id) throw new Error('取不到仓库 ID');
        return id;
      });
  }

  /* ---------- 写 ---------- */

  function create(name, description, isPrivate) {
    return window.API.graphql(M_CREATE, {
      name: name,
      description: description || '',
      isPrivate: isPrivate !== false
    }).then(function (d) {
      invalidate();
      return d && d.createUserList && d.createUserList.list;
    });
  }

  function rename(id, name, description) {
    return window.API.graphql(M_UPDATE, {
      id: id, name: name, description: description || ''
    }).then(function (d) {
      invalidate();
      return d && d.updateUserList && d.updateUserList.list;
    });
  }

  function remove(id) {
    return window.API.graphql(M_DELETE, { id: id }).then(function () {
      invalidate();
      return true;
    });
  }

  /**
   * 设置某个仓库「最终应该在哪些列表里」——整体替换。
   * @param {string} fullName owner/repo
   * @param {Array<string>} listIds 完整的目标列表 ID 集合
   */
  function setRepoLists(fullName, listIds) {
    return repoNodeId(fullName).then(function (itemId) {
      return window.API.graphql(M_SET_ITEM, {
        itemId: itemId,
        listIds: listIds || []
      });
    }).then(function () {
      invalidate();
      return true;
    });
  }

  /**
   * 把一个仓库加进 / 移出某个列表。
   *
   * 这就是"替换式写入"的坑所在：不能只传目标那一个 ID，必须先把仓库
   * 当前所在的完整集合读出来，改完再整体提交，否则会把它在别处的
   * 归属全清掉。
   */
  function toggleRepoInList(fullName, listId, wantIn) {
    return fetchAll(true).then(function (lists) {
      var cur = [];
      lists.forEach(function (l) {
        var hit = l.repos.some(function (r) {
          return String(r.full_name).toLowerCase() === String(fullName).toLowerCase();
        });
        if (hit) cur.push(l.id);
      });
      var has = cur.indexOf(listId) >= 0;
      if (wantIn && has) return true;      // 已经在，不用动
      if (!wantIn && !has) return true;    // 本来就不在，不用动
      var next = cur.slice();
      if (wantIn) next.push(listId);
      else next = next.filter(function (x) { return x !== listId; });
      return setRepoLists(fullName, next);
    });
  }

  /**
   * 探一次：这个令牌到底能不能用官网 Lists。
   *
   * 开启开关之前必须先问这一句 —— 令牌缺 user 权限的话 GraphQL 会返回
   * INSUFFICIENT_SCOPES，那时不能把开关置成「开」，否则用户看到的是
   * 「开了但什么都不出现」，比不开更让人困惑。
   *
   * @returns {Promise<{ok:boolean, reason:string, needUserScope:boolean}>}
   */
  function probe() {
    if (!window.API || typeof window.API.graphql !== 'function') {
      return Promise.resolve({ ok: false, reason: '当前版本不支持官网同步', needUserScope: false });
    }
    return fetchAll(true).then(function (lists) {
      return { ok: true, count: (lists || []).length, reason: '', needUserScope: false };
    }).catch(function (e) {
      var msg = (e && e.message) || '';
      var need = !!(e && e.needUserScope);
      return {
        ok: false,
        needUserScope: need,
        reason: need ? '令牌缺少 user 权限'
          : (/不支持/.test(msg) ? msg : (msg || '官网接口异常'))
      };
    });
  }

  /** 某个仓库当前在哪些列表里（从缓存算，不发请求） */
  function listsOfRepo(fullName) {
    if (!cache) return [];
    var out = [];
    cache.forEach(function (l) {
      var hit = l.repos.some(function (r) {
        return String(r.full_name).toLowerCase() === String(fullName).toLowerCase();
      });
      if (hit) out.push(l.id);
    });
    return out;
  }

  /* ---------- 开关界面 ---------- */
  /**
   * settingsSheet(onDone)
   *
   * 为什么必须有这个界面：同步层写好了，但开关默认关着，而且没有任何
   * 入口能打开它 —— 等于功能不存在。用户能看到的就是「收藏夹是本地的」。
   *
   * ⚠️ 开启前先 probe：官网真的回得来才置开，回不来就把原因说清楚
   *    （多半是令牌缺 user 权限），并给出重新授权的直达链接。
   *    绝不能「先开了再说」——那会让人对着一个空收藏夹发懵。
   *
   * @param {function} onDone 状态变化后回调（调用方据此重绘 chips）
   */
  /**
   * 同步状态面板 —— 只有一个「立即从官网拉取」和一句状态说明。
   *
   * 没有开关键：同步是默认开的，不做成可关的选项。
   *
   * @param {function} onDone 拉取完成后回调（调用方据此重绘 chips）
   */
  function settingsSheet(onDone) {
    var UI = window.UI;
    if (!UI || typeof UI.sheet !== 'function') { if (onDone) onDone(); return; }

    function bodyHtml() {
      return '' +
        '<p class="muted tiny" style="margin:6px 10px 0;line-height:1.6">' +
          '列表跟 GitHub 账号走：官网 <b>?tab=stars</b> 里建的 Lists，' +
          '在这里直接可见；在这里新建、改名、加删仓库，也同步回官网。' +
          '换手机登录同一个号，列表还在。' +
        '</p>' +
        '<p class="muted tiny" style="margin:6px 10px 0;line-height:1.6">' +
          '这条路走的是 GitHub 的 GraphQL（Lists 没有 REST 接口），' +
          '需要令牌带 <b>user</b> 权限，且该功能官方仍在预览阶段。' +
          '权限不够时会自动退回本机收藏夹，不影响其他功能。' +
        '</p>' +
        '<div class="sep-line"></div>' +
        '<button class="opt" id="gq-now">' +
          '<span class="opt-ico">' + window.icon('download', 18) + '</span>' +
          '<span>立即从官网拉取</span></button>';
    }

    UI.sheet({
      title: '列表同步',
      body: bodyHtml(),
      onMount: function (bodyEl, close) {
        function bind() {
          var now = UI.$('#gq-now', bodyEl);
          if (now) now.onclick = function () {
            UI.loading(true);
            fetchAll(true).then(function (lists) {
              UI.loading(false);
              UI.toast('已同步 ' + (lists || []).length + ' 个列表');
              if (onDone) onDone();
            }).catch(function (e) {
              UI.loading(false);
              var msg = (e && e.message) || '';
              if (e && e.needUserScope) {
                UI.toast('令牌缺少 user 权限，请重新登录并勾选它');
              } else {
                UI.toast('同步失败：' + (msg || '官网接口异常'));
              }
            });
          };
        }
        bind();
      }
    });
  }


  window.GqLists = {
    enabled: enabled,
    setEnabled: setEnabled,
    probe: probe,
    settingsSheet: settingsSheet,
    fetchAll: fetchAll,
    create: create,
    rename: rename,
    remove: remove,
    setRepoLists: setRepoLists,
    toggleRepoInList: toggleRepoInList,
    listsOfRepo: listsOfRepo,
    syncIfStale: syncIfStale,
    invalidate: invalidate
  };
})();
