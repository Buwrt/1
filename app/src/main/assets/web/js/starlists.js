/* ============================================================
 * starlists.js — 星标列表（本机分类，交互照抄官方客户端的 Lists）
 *
 * 官方 App 的「Lists」（星标列表）至今没有公开 API —— REST 里翻得到
 * /user/starred，翻不到任何 list 端点。所以这层做成本机功能，并且**住在
 * 收藏夹里面**：收藏夹是抽屉，列表是抽屉里的隔层 ——
 *  · 单击「收藏」= 放进抽屉（fav_stars，老习惯原样保留）；
 *  · 长按仓库勾进某个列表 = 放进隔层，同时自动进抽屉（addRepo 联动）；
 *  · 数据存 Store（localStorage），key 按登录名隔离，跟收藏夹一个待遇；
 *  · 仓库快照在「加入列表」那一刻顺手存下（full_name / 描述 / 星数 /
 *    语言 / 更新时间），列表页先画快照再悄悄刷新，断网也不至于白屏；
 *  · 只存展示字段，绝不碰令牌 —— 令牌只进原生加密存储，这是 api.js 的铁律。
 *
 * 三个入口（跟官方客户端一致）：
 *  1. 「我的 Star」页顶部一行「我的列表」→ 列表管理（加号创建）；
 *  2. Star 条目长按 → 「加入列表」勾选弹层；
 *  3. 仓库页「更多」菜单 → 「加入列表」。
 * ============================================================ */
(function () {
  'use strict';
  var U = window.Util, UI = window.UI, P = (window.Pages = window.Pages || {});

  /* ============ 存取 ============ */
  var PREFIX = 'starlists_v1_';

  function me() {
    return (window.Session && window.Session.user && window.Session.user.login) || '_';
  }
  function keyOf(login) { return PREFIX + (login || me()); }
  function load(login) {
    var v = window.Store.getJSON(keyOf(login), []);
    return Object.prototype.toString.call(v) === '[object Array]' ? v : [];
  }
  function save(login, lists) { window.Store.setJSON(keyOf(login), lists); }
  /**
   * 按 id 取一个列表。
   *
   * ⚠️ 开着同步时必须读**镜像**：all() 返回的是官网列表（id 是官网的
   * UL_xxx 那一套），而本机那份里根本没有这个 id。以前这里只 load()
   * 本机，结果就是「隔层计数显示 1，点进去却是空的」—— 计数走 all()
   * （镜像）拿到了，内容走 byId（本机）拿不到。两个数据源必须一致。
   */
  function byId(id, login) {
    var lists = syncOn() ? (loadMirror(login) || load(login)) : load(login);
    for (var i = 0; i < lists.length; i++) if (lists[i].id === id) return lists[i];
    return null;
  }
  /* 在「这一份」数组里找列表 —— 写操作必须用它：
     Store.getJSON 每次都从 localStorage 解析出**新对象**，byId 拿到的引用
     改完再 save(load()) 就存了个没改过的拷贝，等于白改（测试 A5 抓到的）。 */
  function find(lists, id) {
    for (var i = 0; i < lists.length; i++) if (lists[i].id === id) return lists[i];
    return null;
  }
  /* 仓库快照：字段对齐 GitHub repo API，列表页直接喂给 repoRow */
  function snap(repo) {
    return {
      full_name: repo.full_name,
      description: repo.description || '',
      stargazers_count: repo.stargazers_count || 0,
      forks_count: repo.forks_count || 0,
      language: repo.language || '',
      updated_at: repo.updated_at || '',
      private: !!repo.private
    };
  }
  function newId() {
    return 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  function indexOfName(lists, name) {
    for (var i = 0; i < lists.length; i++) if (lists[i].name === name) return i;
    return -1;
  }

  /* ============ 官网同步（GitHub Lists） ============
     开着同步时：列表与「仓库归谁」都以官网为准，本机留一份镜像用于
     秒开与离线查看。写操作走「先改镜像（界面立刻响应）→ 再推官网」，
     推失败就回滚镜像并提示，绝不出现"界面显示成功、官网其实没改"。
     关着同步时：一切照旧，纯本机，下面的代码全部不生效。 */
  var MIRROR_PREFIX = 'gqlists_mirror_v1_';
  function mirrorKey(login) { return MIRROR_PREFIX + (login || me()); }
  function loadMirror(login) {
    try {
      var v = window.Store.getJSON(mirrorKey(login), null);
      return (v && v.lists) ? v.lists : null;
    } catch (e) { return null; }
  }
  function saveMirror(login, lists) {
    try {
      window.Store.setJSON(mirrorKey(login), {
        lists: lists, at: new Date().toISOString()
      });
    } catch (e) { }
  }
  function syncOn() {
    return !!(window.GqLists && typeof window.GqLists.enabled === 'function'
      && window.GqLists.enabled());
  }
  /** 官网格式 → 本机格式（repos 由数组变成以 full_name 为键的对象） */
  function toLocal(gl) {
    var repos = {};
    (gl.repos || []).forEach(function (r) { repos[r.full_name] = r; });
    return {
      id: gl.id, name: gl.name, description: gl.description || '',
      created_at: '', repos: repos
    };
  }
  function failTip(e, what) {
    var msg = (e && e.message) || '';
    if (e && e.needUserScope) {
      UI.toast('令牌缺少 user 权限，' + what + '失败。请重新登录并勾选它');
    } else if (/不支持 GraphQL/.test(msg)) {
      UI.toast('当前版本不支持官网同步');
    } else {
      UI.toast(what + '失败：' + (msg || '官网接口异常'));
    }
  }

  var SL = {
    /** 全部列表（按创建顺序）。开着同步时优先用官网镜像。 */
    all: function (login) {
      if (syncOn()) {
        var m = loadMirror(login);
        if (m) return m;
      }
      return load(login);
    },

    /** 从官网拉一次，覆盖镜像。返回 Promise<Array> */
    syncFromGitHub: function (login) {
      if (!syncOn()) return Promise.resolve(load(login));
      if (!window.GqLists) return Promise.reject(new Error('不支持官网同步'));
      return window.GqLists.fetchAll(true).then(function (gls) {
        var lists = (gls || []).map(toLocal);
        saveMirror(login || me(), lists);
        return lists;
      });
    },

    /* ════════════════════════════════════════════════
     * 自动同步
     *
     * 双向的意思是：官网改了这里要看得见，这里改了官网也要跟着变。
     *   · 官网 → App：进收藏夹 / 打开勾选弹层时自动拉；
     *   · App → 官网：加删改之后立刻推，推完再拉一次，以官网为准。
     *
     * 但"自动"不等于"随时狂拉"。两个闸门：
     *   · syncing —— 正在拉就不再起新的，避免并发把镜像写乱；
     *   · 节流窗 —— 拉完重绘往往会再次触发同步（重绘 → 进收藏夹 → 又拉），
     *     没有这个窗就会转成死循环，转起来没完。
     * ════════════════════════════════════════════════ */
    _syncing: false,
    _lastSyncAt: 0,
    /** 拉一次并在成功后回调；正在拉或刚拉过就静默跳过。force 可越过节流。 */
    autoSync: function (cb, force) {
      var self = this;
      var now = Date.now();
      if (self._syncing) return;
      if (!force && now - self._lastSyncAt < 8000) return;
      if (!syncOn() || !window.GqLists) return;
      self._syncing = true;
      self._lastSyncAt = now;
      self.syncFromGitHub().then(function (lists) {
        self._syncing = false;
        if (cb) cb(null, lists);
      }).catch(function (e) {
        self._syncing = false;
        if (cb) cb(e, null);
      });
    },

    /**
     * 把本机攒下的老列表搬到官网去 —— 双向的另一半。
     *
     * 同步默认开着之后，界面只显示官网镜像。要是官网一个列表都没有、
     * 而本机攒了一堆，那些列表就凭空"消失"了（不是丢了，是被镜像遮住）。
     * 这一趟把它们建到官网上，老数据才算真正接上。
     *
     * 只做一次：做完打个标记，以后不再动。
     */
    migrateToGitHub: function (login) {
      var MK = 'starlists_migrated_v1_' + (login || me());
      try { if (window.Store.get(MK, '0') === '1') return Promise.resolve(0); } catch (e) { }
      if (!syncOn() || !window.GqLists) return Promise.resolve(0);

      var local = load(login);
      if (!local.length) return Promise.resolve(0);

      return window.GqLists.fetchAll(true).then(function (gls) {
        /* 官网上已经有列表了 —— 说明是老用户，不搬，免得凭空多出一堆重名 */
        if (gls && gls.length) {
          try { window.Store.set(MK, '1'); } catch (e) { }
          return 0;
        }
        var done = 0;
        /* 一个一个来：创建列表 → 把里面的仓库加进去。
           并发写容易撞次级限流，这里量不大，串行更稳。 */
        return local.reduce(function (chain, l) {
          return chain.then(function () {
            return window.GqLists.create(l.name, '').then(function (gl) {
              if (!gl || !gl.id) return;
              done++;
              var names = Object.keys(l.repos || {});
              return names.reduce(function (c2, nm) {
                return c2.then(function () {
                  return window.GqLists.toggleRepoInList(nm, gl.id, true)
                    .catch(function () { /* 单个失败不影响整体搬迁 */ });
                });
              }, Promise.resolve());
            }).catch(function () { /* 建失败就跳过，下次还会再试 */ });
          });
        }, Promise.resolve()).then(function () {
          /* 搬完了把标记打上，并让镜像立刻反映官网结果 */
          if (done) {
            try { window.Store.set(MK, '1'); } catch (e) { }
            return window.GqLists.fetchAll(true).then(function (gls2) {
              saveMirror(login || me(), (gls2 || []).map(toLocal));
              return done;
            });
          }
          return 0;
        });
      }).catch(function () { return 0; });
    },

    /** 列表里的仓库（快照对象数组，保持加入顺序） */
    reposIn: function (id) {
      var l = byId(id);
      if (!l || !l.repos) return [];
      return Object.keys(l.repos).map(function (k) { return l.repos[k]; });
    },

    /**
     * 这个仓库在哪些列表里（返回 id 数组，勾选态用）。
     *
     * ⚠️ 必须和 all() 读同一份数据。all() 在同步时走镜像，而这里以前
     * 死读本机那份 —— 于是「加入列表」写进了镜像、勾选态却去本机查，
     * 结果就是：提示"已加入列表"，复选框却是空的。写入和读取必须是
     * 同一份，不然界面永远在撒谎。
     */
    listsOf: function (fullName, login) {
      var hit = [], lists = syncOn() ? (loadMirror(login) || load(login)) : load(login);
      for (var i = 0; i < lists.length; i++) {
        if (lists[i].repos && lists[i].repos[fullName]) hit.push(lists[i].id);
      }
      return hit;
    },

    /** 新建列表。重名返回 null（由调用方提示，弹层不关）。 */
    create: function (name, login) {
      name = (name || '').trim();
      if (!name) return null;
      /* 官网同步：必须等官网返回，因为列表 id 要用官网的（后面加仓库要拿
         这个 id 去调 updateUserListsForItem，本机生成的 id 官网不认）。 */
      if (syncOn()) {
        var m0 = loadMirror(login) || [];
        if (indexOfName(m0, name) >= 0) return null;
        if (!window.GqLists) return null;
        return window.GqLists.create(name, '').then(function (gl) {
          var item = toLocal({
            id: gl && gl.id, name: gl && gl.name, description: '', repos: []
          });
          var m = loadMirror(login) || [];
          m.push(item);
          saveMirror(login || me(), m);
          return item;
        }).catch(function (e) {
          failTip(e, '创建列表');
          return null;
        });
      }
      var lists = load(login);
      if (indexOfName(lists, name) >= 0) return null;
      var l = { id: newId(), name: name, created_at: new Date().toISOString(), repos: {} };
      lists.push(l);
      save(login || me(), lists);
      return l;
    },

    rename: function (id, name, login) {
      name = (name || '').trim();
      if (!name) return null;
      if (syncOn()) {
        var mm = loadMirror(login) || [];
        for (var k = 0; k < mm.length; k++) {
          if (mm[k].name === name && mm[k].id !== id) return null;
        }
        if (!window.GqLists) return null;
        return window.GqLists.rename(id, name, '').then(function () {
          var m = loadMirror(login) || [], t = null;
          for (var i = 0; i < m.length; i++) if (m[i].id === id) t = m[i];
          if (t) { t.name = name; saveMirror(login || me(), m); }
          return t;
        }).catch(function (e) {
          failTip(e, '重命名');
          return null;
        });
      }
      var lists = load(login), l = find(lists, id);
      if (!l) return null;
      if (l.name === name) return l;                 // 名字没变，原样返回
      for (var i = 0; i < lists.length; i++) {
        if (lists[i].name === name) return null;     // 别的列表已占用
      }
      l.name = name;
      save(login || me(), lists);
      return l;
    },

    remove: function (id, login) {
      if (syncOn()) {
        if (!window.GqLists) return false;
        return window.GqLists.remove(id).then(function () {
          var m = (loadMirror(login) || []).filter(function (x) { return x.id !== id; });
          saveMirror(login || me(), m);
          return true;
        }).catch(function (e) {
          failTip(e, '删除列表');
          return false;
        });
      }
      var lists = load(login);
      for (var i = 0; i < lists.length; i++) {
        if (lists[i].id === id) { lists.splice(i, 1); save(login || me(), lists); return true; }
      }
      return false;
    },

    /** 加入仓库。列表/仓库不存在或已加入时返回 false。 */
    addRepo: function (id, repo, login) {
      if (syncOn()) {
        if (!repo || !repo.full_name || !window.GqLists) return false;
        var m = loadMirror(login) || [], l = null;
        for (var i = 0; i < m.length; i++) if (m[i].id === id) l = m[i];
        if (!l) return false;
        l.repos = l.repos || {};
        if (l.repos[repo.full_name]) return false;
        l.repos[repo.full_name] = snap(repo);
        saveMirror(login || me(), m);
        favLink(repo, login);
        /* 异步推官网。失败就回滚镜像 —— 宁可界面回到原样，也不能让人
           以为加成功了其实官网没加。 */
        window.GqLists.toggleRepoInList(repo.full_name, id, true)
          .then(function () {
            /* 推完了再拉一次：官网才是权威，本地镜像只是缓存。
               不回拉的话，官网那边的真实状态（可能因为并发、权限、
               或者仓库已被删除而不一致）我们永远看不到。 */
            if (window.GqLists.invalidate) window.GqLists.invalidate();
            SL.autoSync(null, true);
          })
          .catch(function (e) {
            var m2 = loadMirror(login) || [], l2 = null;
            for (var j = 0; j < m2.length; j++) if (m2[j].id === id) l2 = m2[j];
            if (l2 && l2.repos) {
              delete l2.repos[repo.full_name];
              saveMirror(login || me(), m2);
            }
            failTip(e, '加入列表');
          });
        return true;
      }
      var lists = load(login), l = find(lists, id);
      if (!l || !repo || !repo.full_name) return false;
      l.repos = l.repos || {};
      if (l.repos[repo.full_name]) return false;
      l.repos[repo.full_name] = snap(repo);
      save(login || me(), lists);
      /* 单击「收藏」的老习惯不被打断：不管从哪条路把仓库归进列表，
         「全部收藏」里都看得到它。反方向不联动：从隔层移出不动抽屉。 */
      favLink(repo, login);
      return true;
    },

    removeRepo: function (id, fullName, login) {
      if (syncOn()) {
        if (!window.GqLists) return false;
        var m = loadMirror(login) || [], l = null;
        for (var i = 0; i < m.length; i++) if (m[i].id === id) l = m[i];
        if (!l || !l.repos || !l.repos[fullName]) return false;
        delete l.repos[fullName];
        saveMirror(login || me(), m);
        window.GqLists.toggleRepoInList(fullName, id, false)
          .then(function () {
            if (window.GqLists.invalidate) window.GqLists.invalidate();
            SL.autoSync(null, true);
          })
          .catch(function (e) {
            var m2 = loadMirror(login) || [], l2 = null;
            for (var j = 0; j < m2.length; j++) if (m2[j].id === id) l2 = m2[j];
            if (l2) {
              l2.repos = l2.repos || {};
              /* 回滚要有东西放回去，这里只放一个最小快照 */
              l2.repos[fullName] = l2.repos[fullName] ||
                { full_name: fullName, description: '', stargazers_count: 0 };
              saveMirror(login || me(), m2);
            }
            failTip(e, '移出列表');
          });
        return true;
      }
      var lists = load(login), l = find(lists, id);
      if (!l || !l.repos || !l.repos[fullName]) return false;
      delete l.repos[fullName];
      save(login || me(), lists);
      return true;
    },

    /** 刷新快照：列表详情页后台逐仓 /repos/<full_name> 后调用 */
    updateRepo: function (id, repo, login) {
      var lists = load(login), l = find(lists, id);
      if (!l || !l.repos || !l.repos[repo.full_name]) return false;
      l.repos[repo.full_name] = snap(repo);
      save(login || me(), lists);
      return true;
    }
  };

  /* 联动：进隔层的仓库自动也进抽屉（fav_stars） */
  function favLink(repo, login) {
    try {
      var fk = 'fav_stars_' + (login || me());
      var favs = window.Store.getJSON(fk, []) || [];
      if (Object.prototype.toString.call(favs) === '[object Array]' &&
          favs.indexOf(repo.full_name) < 0) {
        favs.push(repo.full_name);
        window.Store.setJSON(fk, favs);
      }
    } catch (e) { }
  }

  /* ============ 新建 / 重命名弹层 ============ */
  /**
   * editor(list|null, onDone)
   *  list 为 null → 新建；否则重命名该列表。
   *  成功后 onDone(列表对象)（关闭弹层以后才回调，调用方安全重绘）。
   */
  function editor(list, onDone) {
    var isNew = !list;
    UI.sheet({
      title: isNew ? '新建列表' : '重命名列表',
      body: '<div class="search-bar" style="margin-top:2px"><div class="search-input">' +
        window.icon('pencil', 15) +
        '<input id="sl-name" placeholder="列表名称，比如：工具 / 追更 / 以后再看" maxlength="40"></div></div>' +
        (isNew ? '' : '<p class="muted tiny" style="text-align:center;margin:6px 0 0">重命名不影响列表里已加入的仓库</p>'),
      foot: '<button class="btn primary block" id="sl-ok">' + (isNew ? '创建' : '保存') + '</button>',
      onMount: function (body, close) {
        var input = document.getElementById('sl-name');
        if (isNew) setTimeout(function () { try { input.focus(); } catch (e) {} }, 120);
        var submit = function () {
          var name = input.value;
          /* 官网同步时 create/rename 返回 Promise（要等官网回 id），
             用 Promise.resolve 包一层，同步异步都能往下走。 */
          var r = isNew ? SL.create(name) : SL.rename(list.id, name);
          Promise.resolve(r).then(function (v) {
            if (!v) {
              input.value = name.trim() ? '这个名字已经用过了' : '';
              if (!name.trim()) UI.toast('先给列表起个名字');
              else UI.toast('已经有叫这个名字的列表了');
              return;
            }
            close();
            UI.toast(isNew ? '列表「' + v.name + '」已创建' : '已重命名');
            if (onDone) onDone(v);
          });
        };
        var ok = document.getElementById('sl-ok');
        if (ok) ok.onclick = submit;
        if (input) input.onkeydown = function (e) { if (e.key === 'Enter') submit(); };
      }
    });
  }

  /* ============ 「加入列表」勾选弹层 ============ */
  /**
   * SL.picker(repo, onDone)
   *  repo 至少要带 full_name（Star 页/仓库页都拿得到完整对象）。
   *  勾选 = 加入，再点 = 移出，跟官方客户端的复选一致；
   *  底部「新建列表」创建完自动把当前仓库加进去。
   *  onDone 在每次增删后回调（Star 页用它刷新入口行的计数）。
   */
  SL.picker = function (repo, onDone) {
    if (!repo || !repo.full_name) return;
    var full = repo.full_name;

    function bodyHtml() {
      var lists = SL.all();
      var inSet = {};
      SL.listsOf(full).forEach(function (id) { inSet[id] = true; });
      var rows = lists.map(function (l) {
        var on = !!inSet[l.id];
        return '<button class="opt" data-lid="' + U.esc(l.id) + '">' +
          '<span class="opt-ico" data-box="1" style="width:20px;height:20px;border-radius:4px;display:flex;align-items:center;justify-content:center;' +
          (on ? 'background:var(--accent);color:#fff' : 'border:1.5px solid var(--border)') + '">' +
          (on ? window.icon('check', 14) : '') + '</span>' +
          '<span>' + U.esc(l.name) + '</span>' +
          '<span class="muted tiny" style="margin-left:auto">' + (l.repos ? Object.keys(l.repos).length : 0) + '</span>' +
          '</button>';
      }).join('');
      return (rows || '<p class="muted" style="text-align:center;margin:8px 0">还没有列表，先建一个</p>') +
        '<div class="sep-line"></div>' +
        '<button class="opt" data-new="1" style="color:var(--accent)">' +
        '<span class="opt-ico">' + window.icon('plus', 18) + '</span><span>新建列表</span></button>';
    }

    UI.sheet({
      title: '加入列表：' + full,
      body: bodyHtml(),
      onMount: function (bodyEl, close) {
        var wrap = function () { bodyEl.innerHTML = bodyHtml(); bind(); };
        /* 打开就拉一次官网最新：列表可能是在网页上建的，本机镜像里
           还没有。拉完重画，不然对着一份过期的列表勾半天，勾了个
           官网已经删掉的东西。 */
        SL.autoSync(function (err) { if (!err) wrap(); }, true);
        function bind() {
          UI.$$('.opt', bodyEl).forEach(function (btn) {
            var lid = btn.getAttribute('data-lid');
            if (lid) {
              btn.onclick = function () {
                if (SL.listsOf(full).indexOf(lid) >= 0) {
                  SL.removeRepo(lid, full);
                  UI.toast('已移出列表');
                } else {
                  SL.addRepo(lid, repo);
                  UI.toast('已加入列表');
                }
                if (onDone) onDone();
                wrap();   // 重画勾选态与计数，弹层不关（官方就是勾完还开着）
              };
            } else if (btn.getAttribute('data-new')) {
              btn.onclick = function () {
                close();
                editor(null, function (created) {
                  if (created) {
                    SL.addRepo(created.id, repo);
                    UI.toast('已加入「' + created.name + '」');
                    if (onDone) onDone();
                  }
                });
              };
            }
          });
        }
        bind();
      }
    });
  };

  /* 新建 / 重命名弹层对收藏夹 chips 开放（＋新建、长按改名都走这里） */
  SL.editor = editor;

  window.StarLists = SL;
})();
