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
  function byId(id, login) {
    var lists = load(login);
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

  var SL = {
    /** 全部列表（按创建顺序） */
    all: function (login) { return load(login); },

    /** 列表里的仓库（快照对象数组，保持加入顺序） */
    reposIn: function (id) {
      var l = byId(id);
      if (!l || !l.repos) return [];
      return Object.keys(l.repos).map(function (k) { return l.repos[k]; });
    },

    /** 这个仓库在哪些列表里（返回 id 数组，勾选态用） */
    listsOf: function (fullName, login) {
      var hit = [], lists = load(login);
      for (var i = 0; i < lists.length; i++) {
        if (lists[i].repos && lists[i].repos[fullName]) hit.push(lists[i].id);
      }
      return hit;
    },

    /** 新建列表。重名返回 null（由调用方提示，弹层不关）。 */
    create: function (name, login) {
      name = (name || '').trim();
      if (!name) return null;
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
      var lists = load(login);
      for (var i = 0; i < lists.length; i++) {
        if (lists[i].id === id) { lists.splice(i, 1); save(login || me(), lists); return true; }
      }
      return false;
    },

    /** 加入仓库。列表/仓库不存在或已加入时返回 false。 */
    addRepo: function (id, repo, login) {
      var lists = load(login), l = find(lists, id);
      if (!l || !repo || !repo.full_name) return false;
      l.repos = l.repos || {};
      if (l.repos[repo.full_name]) return false;
      l.repos[repo.full_name] = snap(repo);
      save(login || me(), lists);
      /* 联动：进隔层的仓库自动也进抽屉（fav_stars）—— 单击「收藏」的老习惯
         不被打断：不管从哪条路把仓库归进列表，「全部收藏」里都看得到它。
         反方向不联动：从隔层移出不动抽屉，从抽屉移出也不动隔层。 */
      try {
        var fk = 'fav_stars_' + (login || me());
        var favs = window.Store.getJSON(fk, []) || [];
        if (Object.prototype.toString.call(favs) === '[object Array]' &&
            favs.indexOf(repo.full_name) < 0) {
          favs.push(repo.full_name);
          window.Store.setJSON(fk, favs);
        }
      } catch (e) {}
      return true;
    },

    removeRepo: function (id, fullName, login) {
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
          var r = isNew ? SL.create(name) : SL.rename(list.id, name);
          if (!r) {
            input.value = name.trim() ? '这个名字已经用过了' : '';
            if (!name.trim()) UI.toast('先给列表起个名字');
            else UI.toast('已经有叫这个名字的列表了');
            return;
          }
          close();
          UI.toast(isNew ? '列表「' + r.name + '」已创建' : '已重命名');
          if (onDone) onDone(r);
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
