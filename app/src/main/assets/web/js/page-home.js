/* ============================================================
 * page-home.js — 登录、首页动态、通知、搜索、探索
 * ============================================================ */
(function () {
  'use strict';
  var U = window.Util, UI = window.UI, P = (window.Pages = window.Pages || {});

  /* ================= 登录 ================= */
  P.login = {
    noTab: true,
    title: '登录',
    render: function (ctx, host) {
      var redirect = ctx.query.redirect || '/';
      host.innerHTML =
        '<div class="login-wrap">' +
        '<div class="login-logo">' + window.icon('mark-github', 64) + '</div>' +
        '<div class="login-title">githup</div>' +
        '<div class="login-sub">使用 GitHub 账号登录，畅享完整的仓库与协作功能</div>' +
        '<div class="login-card">' +
        '<div class="field"><label>个人访问令牌（Personal Access Token）</label>' +
        '<div class="tk-wrap">' +
        '<input class="input" id="tk" type="password" placeholder="ghp_xxxxxxxxxxxx 或 github_pat_xxxx" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">' +
        '<button type="button" class="tk-eye" id="tkeye" aria-label="显示令牌">' + window.icon('eye-closed', 16) + '</button>' +
        '</div>' +
        '<div class="hint">令牌仅保存在本机加密存储中，不会上传任何服务器。</div></div>' +
        '<button class="btn primary block lg" id="go">登录</button>' +
        '<button class="btn block mt12" id="create">' + window.icon('plus', 15) + ' 在 GitHub 官网创建 Token</button>' +
        '</div>' +
        '<div class="login-alt">' +
        '<button id="how">如何获取令牌？</button> · <button id="dev">设备码登录</button> · <button id="skip">先随便看看</button>' +
        '</div></div>';

      // 记住上次用过的令牌：输入框自动回填，直接点登录即可
      var savedTok = window.Session.savedToken || window.Native.getToken();
      if (savedTok) {
        UI.$('#tk', host).value = savedTok;
        UI.$('#go', host).textContent = '使用上次的令牌登录';
        var forget = document.createElement('button');
        forget.className = 'btn block mt12';
        forget.id = 'forget';
        forget.textContent = '忘记此令牌';
        UI.$('#create', host).parentNode.insertBefore(forget, UI.$('#create', host));
        forget.onclick = function () {
          UI.confirm('忘记此令牌', '将删除本机保存的令牌。下次登录需要重新粘贴。', '删除', true).then(function (ok) {
            if (!ok) return;
            window.Session.forget();
            UI.toast('已清除保存的令牌');
            UI.$('#tk', host).value = '';
            UI.$('#go', host).textContent = '登录';
            var f = UI.$('#forget', host);
            if (f) f.remove();
          });
        };
      }

      // 明文/隐藏 切换：默认隐藏（圆点），点眼睛图标才显示明文
      var tkInput = UI.$('#tk', host);
      var eyeBtn = UI.$('#tkeye', host);
      var setEye = function (shown) {
        tkInput.type = shown ? 'text' : 'password';
        eyeBtn.innerHTML = window.icon(shown ? 'eye' : 'eye-closed', 16);
        eyeBtn.setAttribute('aria-label', shown ? '隐藏令牌' : '显示令牌');
        eyeBtn.classList.toggle('on', shown);
      };
      eyeBtn.onclick = function () { setEye(tkInput.type === 'password'); };
      setEye(false);

      UI.$('#go', host).onclick = function () {
        var t = UI.$('#tk', host).value.trim();
        if (!t) return UI.toast('请输入令牌');
        UI.loading(true);
        window.Session.setToken(t);
        window.API.me().then(function (r) {
          UI.loading(false);
          if (!r.data || !r.data.login) throw new Error('bad');
          window.Session.user = r.data;
          window.Store.set('lastUser', r.data.login);
          UI.toast('欢迎回来，' + r.data.login);
          window.Router.replace(redirect);
        }).catch(function (e) {
          UI.loading(false);
          window.Session.clear();
          UI.toast(e.status === 401 ? '令牌无效或已过期' : ('登录失败：' + e.message));
        });
      };
      UI.$('#create', host).onclick = function () {
        UI.sheet({
          title: '创建访问令牌',
          icon: 'key',
          body: '<div style="font-size:14px;line-height:1.75">' +
            '<p>将在<b>应用内置浏览器</b>中打开 GitHub 的令牌创建页，按下面步骤操作：</p>' +
            '<p>1. 页面底部 <b>Note</b> 随便填个名字，例如 <span class="mono">githup</span></p>' +
            '<p>2. <b>Expiration</b> 建议选 90 天或 No expiration</p>' +
            '<p>3. 勾选权限（本应用需要这些）：</p>' +
            '<p class="mono tiny" style="background:var(--canvas);padding:10px;border-radius:6px">' +
            'repo（仓库读写）<br>workflow（Actions）<br>read:org（组织）<br>gist（代码片段）<br>user（资料与关注）<br>notifications（通知）</p>' +
            '<p>4. 点 <b>Generate token</b>，复制生成的 <span class="mono">ghp_...</span></p>' +
            '<p>5. 返回本页，粘贴到输入框并登录。</p>' +
            '<div class="set-note">令牌只保存在本机加密存储中，不会上传。下次打开会自动回填。</div></div>',
          foot: '<button class="btn" data-close="1">稍后</button><button class="btn primary" id="createGo">立即前往创建</button>',
          onMount: function () {
            UI.$('#createGo').onclick = function () {
              UI.closeSheet();
              // GitHub 官方令牌创建页：默认带好 note 与所需 scope，减少手填
              var scopes = 'repo,workflow,read:org,gist,user,notifications';
              var url = 'https://github.com/settings/tokens/new?description=githup&scopes=' + encodeURIComponent(scopes);
              window.Native.openInApp(url, '创建访问令牌');
              UI.toast('创建完成后复制令牌，回到这里粘贴');
            };
          }
        });
      };
      UI.$('#how', host).onclick = function () {
        UI.sheet({
          title: '获取访问令牌',
          body: '<div style="font-size:14px;line-height:1.75">' +
            '<p>1. 在浏览器中打开 GitHub → <b>Settings</b> → <b>Developer settings</b> → <b>Personal access tokens</b> → <b>Tokens (classic)</b></p>' +
            '<p>2. 点击 <b>Generate new token (classic)</b>，勾选以下权限：</p>' +
            '<p class="mono tiny" style="background:var(--canvas);padding:10px;border-radius:6px">' +
            'repo（仓库读写）<br>workflow（Actions）<br>read:org（组织）<br>gist（代码片段）<br>user:follow / read:user（资料与关注）<br>notifications（通知）</p>' +
            '<p>3. 生成后复制令牌，粘贴到上方输入框。</p></div>',
          foot: '<button class="btn" id="open">用系统浏览器打开</button><button class="btn primary" id="openin">应用内打开</button>',
          onMount: function () {
            var target = 'https://github.com/settings/tokens/new?description=githup&scopes=' + encodeURIComponent('repo,workflow,read:org,gist,user,notifications');
            UI.$('#open').onclick = function () {
              window.NativeBridge && NativeBridge.openExternal
                ? NativeBridge.openExternal(target)
                : window.open(target, '_blank');
            };
            UI.$('#openin').onclick = function () {
              UI.closeSheet();
              window.Native.openInApp(target, '创建访问令牌');
            };
          }
        });
      };
      UI.$('#dev', host).onclick = function () { deviceFlow(host, redirect); };
      UI.$('#skip', host).onclick = function () {
        window.Session.clear();
        UI.toast('已进入浏览模式（部分功能受限）');
        window.Router.replace('/');
      };
    }
  };

  function deviceFlow(host, redirect) {
    UI.sheet({
      title: '设备码登录',
      body: '<p class="muted tiny">需要你自己的 OAuth App Client ID（OAuth Apps → 勾选 Enable Device Flow）。' +
        '授权后应用会自动换取访问令牌。</p>' +
        '<div class="field"><label>Client ID</label><input class="input" id="cid" placeholder="Iv1.xxxxxxxxxxxxxxxx"></div>' +
        '<div id="dfbox"></div>',
      foot: '<button class="btn primary" id="start">开始授权</button>',
      onMount: function () {
        UI.$('#start').onclick = function () {
          var cid = UI.$('#cid').value.trim();
          if (!cid) return UI.toast('请填写 Client ID');
          var box = UI.$('#dfbox');
          box.innerHTML = '<div class="center mt12"><div class="spinner"></div></div>';
          postForm('https://github.com/login/device/code', { client_id: cid, scope: 'repo,read:org,gist,user,workflow,notifications' })
            .then(function (r) {
              if (!r.access_token) throw new Error(JSON.stringify(r));
              window.Session.setToken(r.access_token);
              UI.closeSheet();
              window.API.me().then(function (m) {
                window.Session.user = m.data; window.Store.set('lastUser', m.data.login);
                UI.toast('登录成功'); window.Router.replace(redirect);
              }).catch(function () { window.Router.replace(redirect); });
            })
            .catch(function (e) {
              box.innerHTML = '<div class="center mt12" style="font-size:13px">' +
                '<div style="margin-bottom:8px">请在浏览器中打开下方地址并输入设备码完成授权：</div>' +
                '<div class="mono" style="font-size:20px;letter-spacing:2px">' + (e.user_code || '----') + '</div>' +
                '<button class="btn mt12" id="opendev">打开 ' + U.esc(e.verify || 'github.com/login/device') + '</button>' +
                '<div class="muted tiny mt12">完成后请重新点击「开始授权」。错误信息：' + U.esc(e.message || '') + '</div></div>';
              if (e.verify) UI.$('#opendev').onclick = function () {
                window.NativeBridge && NativeBridge.openExternal ? NativeBridge.openExternal(e.verify) : window.open(e.verify, '_blank');
              };
            });
        };
      }
    });
  }

  // 设备码轮询（简化：直接提示用户授权后重试换取令牌）
  function postForm(url, data) {
    var body = Object.keys(data).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(data[k]); }).join('&');
    if (window.NativeBridge && typeof window.NativeBridge.http === 'function') {
      return window.Native.http('POST', url, body, { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' })
        .then(function (res) { var d = null; try { d = JSON.parse(res.body); } catch (e) {} return d || {}; });
    }
    return fetch(url, { method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: body })
      .then(function (r) { return r.json(); });
  }

  /* ================= 首页动态 ================= */
  P.feed = {
    tab: 'home',
    title: '首页',
    menu: function () {
      return [
        { icon: 'sync', label: '刷新', key: 'refresh' },
        { icon: 'person', label: '我的主页', key: 'me' },
        { icon: 'gear', label: '设置', key: 'settings' }
      ];
    },
    onMenu: function (key) {
      // 刷新必须先清缓存再重画：这页 /user（60s）与 /user/repos（30s）都带
      // 内存缓存，只 reload 的话请求全部命中旧缓存，内容原样闪一下 ——
      // 用户看到的就是「点了刷新没反应」。清掉缓存才叫真的刷新。
      if (key === 'refresh') { window.API.clearCache(); window.Router.reload(); }
      if (key === 'me') window.Router.go('/' + (window.Session.user ? window.Session.user.login : ''));
      if (key === 'settings') window.Router.go('/settings');
    },
    render: function (ctx, host) {
      if (!window.Session.isLogin) return guestHome(ctx, host);
      var user = window.Session.user;
      host.innerHTML = '<div class="card flat" style="border:0">' + UI.skeleton(3) + '</div>';
      var login = user ? user.login : '';
      // 渲染纪元：这页两个请求都要跑一会儿，用户要是在这期间按了返回，
      // 响应落地时页面已经换了人 —— 整份丢弃，别把新页面顶掉
      // （这是全 App 的制度，见 Router.render 里 viewEpoch 的注释）。
      var epoch = window.Router.viewEpoch;
      // 登录态：只展示「我的仓库」，不出现关注动态、不出现热门仓库
      return Promise.all([
        window.API.get('/user', null, { cache: 60000 }),
        window.API.get('/user/repos', { sort: 'updated', per_page: 30 }, { cache: 30000 }).catch(function () { return { data: [] }; })
      ]).then(function (rs) {
        if (epoch !== window.Router.viewEpoch) return;
        var me = rs[0] && rs[0].data;
        var myRepos = ((rs[1] && rs[1].data) || []).filter(function (r) { return !r.fork; });
        if (!myRepos.length) myRepos = (rs[1] && rs[1].data) || [];
        /*
         * /user 的响应体必须拿到才往下渲染 —— 这个页面每一处都在读 me.login。
         *
         * 以前不管拿到什么都没有判断：网络层把 body 弄丢时 me 是 null，
         * 先被写进 Session.user（把整站登录态一起带坏），紧接着
         * UI.avatar(me.login, ...) 抛出 "Cannot read properties of null
         * (reading 'login')"，首页只剩一句报错。
         *
         * 拿不到就用已经有的登录态顶一下；连那个也没有才报错。
         */
        if (!me || typeof me !== 'object') {
          if (user && user.login) {
            me = user;
          } else {
            host.innerHTML = UI.errorBox(new Error('用户信息读取失败'));
            return;
          }
        }
        window.Session.user = me;
        window.App.updateBadge();
        host.innerHTML =
          '<div class="page">' +
          '<div class="card">' +
          '<div class="list-row static" style="align-items:center">' +
          UI.avatar(me.login, me.avatar_url, 40) +
          '<div class="row-main"><div class="row-title">' + U.esc(me.name || me.login) + '</div>' +
          '<div class="row-desc">@' + U.esc(me.login) + '</div></div>' +
          '<button class="btn sm" id="tome">' + window.icon('chevron-right', 14) + '</button></div>' +
          quickGrid(me) +
          '</div>' +
          '<div class="section-title">' + window.icon('repo', 14) + ' 我的仓库' +
          '<span style="margin-left:auto;display:flex;gap:6px">' +
          '<button class="btn sm" id="newrepo">' + window.icon('plus', 13) + ' 新建</button>' +
          '<button class="btn sm" data-go="/' + U.esc(me.login) + '?tab=repos">全部</button></span></div>' +
          (myRepos.length
            ? '<div class="list">' + myRepos.map(function (r) { return window.repoRow(r); }).join('') + '</div>'
            : UI.empty('repo', '还没有仓库', '点击「新建」创建第一个仓库')) +
          '</div>';
        UI.$('#tome', host).onclick = function () { window.Router.go('/' + me.login); };
        var nb = UI.$('#newrepo', host);
        if (nb) nb.onclick = function () { window.newRepo(); };
        bindEvents(host);
      }).catch(function (e) {
        if (epoch !== window.Router.viewEpoch) return;
        host.innerHTML = UI.errorBox(e);
      });
    }
  };

  function quickGrid(me) {
    var items = [
      { icon: 'repo', label: '我的仓库', path: '/' + me.login + '?tab=repos' },
      { icon: 'star', label: '我的 Star', path: '/' + me.login + '?tab=stars' },
      { icon: 'issue-opened', label: '我的议题', path: '/issues/mine' },
      { icon: 'git-pull-request', label: '我的 PR', path: '/pulls/mine' },
      { icon: 'code-square', label: '我的 Gist', path: '/gists' },
      { icon: 'organization', label: '组织', path: '/' + me.login + '?tab=orgs' }
    ];
    return '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;border-top:1px solid var(--border-muted)">' +
      items.map(function (it) {
        return '<button data-p="' + U.esc(it.path) + '" style="background:var(--bg);border:0;border-right:1px solid var(--border-muted);border-bottom:1px solid var(--border-muted);padding:14px 4px;display:flex;flex-direction:column;align-items:center;gap:6px;color:var(--fg-muted);font-size:11px;cursor:pointer">' +
          window.icon(it.icon, 20) + '<span>' + U.esc(it.label) + '</span></button>';
      }).join('') + '</div>';
  }

  function guestHome(ctx, host) {
    host.innerHTML =
      '<div class="page">' +
      '<div class="card" style="padding:16px">' +
      '<div class="rowflex" style="gap:12px">' + window.icon('mark-github', 34) +
      '<div class="grow"><div style="font-weight:600;font-size:15px">未登录浏览模式</div>' +
      '<div class="muted tiny mt8">登录后可查看动态、通知，并参与 Issue / PR 协作</div></div></div>' +
      '<button class="btn primary block mt12" id="login">立即登录</button>' +
      '</div>' +
      '<div class="section-title">' + window.icon('zap', 14) + ' 热门仓库</div>' +
      '<div id="pubfeed"><div class="card flat" style="border:0">' + UI.skeleton(4) + '</div></div>' +
      '</div>';
    UI.$('#login', host).onclick = function () { window.Router.go('/login?redirect=' + encodeURIComponent(location.hash.substring(1) || '/')); };
    loadHotRepos(host);
  }

  /** 未登录首页的热门仓库：star 数最高的活跃项目 */
  function loadHotRepos(host) {
    var recent = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    window.API.get('/search/repositories',
      { q: 'stars:>20000 pushed:>' + recent, sort: 'stars', order: 'desc', per_page: 15 },
      { cache: 600000 }
    ).then(function (r) {
      var box = UI.$('#pubfeed', host); if (!box) return;
      var items = (r.data && r.data.items) || [];
      box.innerHTML = items.length
        ? '<div class="list">' + items.map(function (r) { return repoRow(r); }).join('') + '</div>'
        : UI.empty('telescope', '暂无数据', '请稍后重试');
      bindEvents(box);
    }).catch(function (e) {
      var box = UI.$('#pubfeed', host);
      if (box) box.innerHTML = '<div class="empty">' + window.icon('alert', 36) +
        '<div class="t">加载失败</div>' +
        '<div class="d">' + (e.rateLimited ? ' 未登录时接口频率限制较严，登录后可正常使用。' : '请检查网络后重试。') + '</div>' +
        '<button class="btn mt12" id="hotretry">重试</button></div>';
      var rb = box && UI.$('#hotretry', box);
      if (rb) rb.onclick = function () { loadHotRepos(host); };
    });
  }

  /* ---------- 事件流渲染 ---------- */
  function renderEvent(e) {
    var who = e.actor && e.actor.login;
    var repo = e.repo && e.repo.name;
    var whoHtml = '<a href="#/' + U.esc(who) + '" class="who">' + U.esc(who) + '</a>';
    var repoHtml = '<a href="#/' + U.esc(repo) + '">' + U.esc(repo) + '</a>';
    var head = '', extra = '', iconName = 'dot-fill';
    var p = e.payload || {};

    switch (e.type) {
      case 'PushEvent':
        iconName = 'git-commit';
        var branch = (p.ref || '').replace('refs/heads/', '');
        head = whoHtml + ' 推送了 ' + p.size + ' 个提交到 ' + repoHtml + ' 的 <span class="mono">' + U.esc(branch) + '</span>';
        extra = (p.commits || []).slice(0, 4).map(function (c) {
          return '<div class="event-commit">' + U.esc((c.sha || '').substring(0, 7)) + ' ' + U.esc((c.message || '').split('\n')[0]) + '</div>';
        }).join('');
        if (extra) extra = '<div class="event-commits">' + extra + '</div>';
        break;
      case 'WatchEvent': iconName = 'star'; head = whoHtml + ' star 了 ' + repoHtml; break;
      case 'ForkEvent': iconName = 'repo-forked';
        head = whoHtml + ' fork 了 ' + repoHtml + (p.forkee ? ' 到 <a href="#/' + U.esc(p.forkee.full_name) + '">' + U.esc(p.forkee.full_name) + '</a>' : ''); break;
      case 'CreateEvent': iconName = p.ref_type === 'repository' ? 'repo' : 'git-branch';
        head = whoHtml + ' 创建了 ' + (p.ref_type === 'repository' ? '仓库' : (p.ref_type === 'tag' ? '标签' : '分支')) +
          ' ' + (p.ref_type === 'repository' ? repoHtml : '<span class="mono">' + U.esc(p.ref || '') + '</span>' + ' 于 ' + repoHtml); break;
      case 'DeleteEvent': iconName = 'trash'; head = whoHtml + ' 删除了 ' + U.esc(p.ref_type || '') + ' <span class="mono">' + U.esc(p.ref || '') + '</span> 于 ' + repoHtml; break;
      case 'IssuesEvent': iconName = 'issue-opened';
        head = whoHtml + ' ' + (p.action === 'closed' ? '关闭' : p.action === 'reopened' ? '重新打开' : '创建') + ' 议题 ' +
          '<a href="#/' + U.esc(repo) + '/issues/' + (p.issue && p.issue.number) + '">#' + (p.issue && p.issue.number) + '</a> 于 ' + repoHtml;
        if (p.issue) extra = '<div class="muted" style="margin-top:4px">' + U.esc(U.excerpt ? window.MD.excerpt(p.issue.title, 90) : p.issue.title) + '</div>';
        break;
      case 'IssueCommentEvent': iconName = 'comment';
        head = whoHtml + ' 评论了议题 ' + '<a href="#/' + U.esc(repo) + '/issues/' + (p.issue && p.issue.number) + '">#' + (p.issue && p.issue.number) + '</a> 于 ' + repoHtml;
        if (p.comment) extra = '<div class="muted" style="margin-top:4px">' + U.esc(window.MD.excerpt(p.comment.body, 110)) + '</div>';
        break;
      case 'PullRequestEvent': iconName = p.payload ? 'git-pull-request' : 'git-pull-request';
        var pr = p.pull_request || {};
        iconName = pr.merged ? 'git-merge' : p.action === 'closed' ? 'git-pull-request' : 'git-pull-request';
        head = whoHtml + ' ' + (p.action === 'closed' ? (pr.merged ? '合并' : '关闭') : p.action === 'opened' ? '创建' : '更新') + ' PR ' +
          '<a href="#/' + U.esc(repo) + '/pull/' + pr.number + '">#' + pr.number + '</a> 于 ' + repoHtml;
        if (pr.title) extra = '<div class="muted" style="margin-top:4px">' + U.esc(window.MD.excerpt(pr.title, 90)) + '</div>';
        break;
      case 'PullRequestReviewEvent': iconName = 'check'; head = whoHtml + ' 评审了 PR <a href="#/' + U.esc(repo) + '/pull/' + (p.pull_request && p.pull_request.number) + '">#' + (p.pull_request && p.pull_request.number) + '</a> 于 ' + repoHtml; break;
      case 'PullRequestReviewCommentEvent': iconName = 'comment'; head = whoHtml + ' 评论了 PR 代码 于 ' + repoHtml; break;
      case 'ReleaseEvent': iconName = 'tag'; head = whoHtml + ' 发布了 ' + U.esc((p.release && p.release.tag_name) || '新版本') + ' 于 ' + repoHtml; break;
      case 'FollowEvent': iconName = 'person'; head = whoHtml + ' 关注了 <a href="#/' + U.esc(p.target && p.target.login) + '">' + U.esc(p.target && p.target.login) + '</a>'; break;
      case 'MemberEvent': iconName = 'people'; head = whoHtml + ' 将 <a href="#/' + U.esc(p.member && p.member.login) + '">' + U.esc(p.member && p.member.login) + '</a> 添加为 ' + repoHtml + ' 的协作者'; break;
      case 'ForkEvent2': break;
      case 'GollumEvent': iconName = 'book'; head = whoHtml + ' 编辑了 ' + repoHtml + ' 的 Wiki'; break;
      case 'PublicEvent': iconName = 'globe'; head = whoHtml + ' 将 ' + repoHtml + ' 设为公开'; break;
      case 'CommitCommentEvent': iconName = 'comment'; head = whoHtml + ' 评论了提交 于 ' + repoHtml; break;
      case 'SponsorshipEvent': iconName = 'heart'; head = whoHtml + ' 发起了赞助'; break;
      case 'OrgBlockEvent': iconName = 'blocked'; head = whoHtml + ' 更新了组织屏蔽设置'; break;
      default:
        iconName = 'dot-fill';
        head = whoHtml + ' · ' + U.esc(String(e.type).replace(/Event$/, '')) + ' 于 ' + repoHtml;
    }
    return '<div class="event"><div class="event-ico">' + window.icon(iconName, 16) + '</div>' +
      '<div class="event-body"><div>' + head + '</div>' + extra +
      '<div class="when">' + U.timeAgo(e.created_at) + '</div></div></div>';
  }

  function bindEvents(root) {
    UI.$$('a[href^="#/"]', root).forEach(function (a) {
      a.onclick = function (ev) { ev.preventDefault(); window.Router.go(a.getAttribute('href').substring(1)); };
    });
    // data-p / data-go 由 app.js 的全局委托统一处理，无需逐元素绑定
  }
  P.feed.bindEvents = bindEvents;
  window.renderEvent = renderEvent;
  window.bindHashLinks = bindEvents;

  /* ================= 通知 ================= */
  /* 长按进入多选：勾选的 id 存在这里，翻页/刷新会重置 */
  var notifSel = { on: false, ids: {} };

  /**
   * 本机「已清除（Done）」清单 —— 修「点击删除之后刷新又出现」的根。
   *
   * 病根不在删除动作（DELETE threads 标 Done 在服务端是成功的，204），
   * 而在 GitHub REST API 的结构性缺陷：标了 Done 的线程，GET /notifications
   * ?all=true 照样原样返回，返回体里也没有任何字段标记它已 Done（连
   * 2026-03-10 新版 API 都没加）。官方网页版用的是带 is:done 过滤的私有
   * beta 接口，第三方用不了 —— 社区（gh-notify #47）多人实测证实。
   *
   * 我们「已读 / 全部」tab 是客户端过滤 !unread 的：Done 线程 unread=false，
   * 刷新后自然又被画回来 —— 「删了刷新又出现」就是这么来的。
   *
   * REST 层面无解，只能本机记账：标 Done 成功的 id 记进这份清单，
   * 渲染时挡在收件箱外。未读的一律放行 —— Done 后有新活动的线程会被
   * GitHub 复活成未读，那是真新消息，必须看得见。
   * 清单按登录账号隔离，FIFO 上限 500 条，只进不出（复活的也留着，
   * 反正 unread=true 时不过滤它）。
   */
  var NOTIF_DONE_PREFIX = 'notif_done_v1_';
  var NOTIF_DONE_MAX = 500;
  function notifDoneKey() {
    return NOTIF_DONE_PREFIX + ((window.Session.user && window.Session.user.login) || '_');
  }
  function notifDoneSet() {
    var arr = [];
    try { arr = window.Store.getJSON(notifDoneKey(), []) || []; } catch (e) { arr = []; }
    var set = {};
    if (Object.prototype.toString.call(arr) === '[object Array]') {
      arr.forEach(function (id) { set[String(id)] = true; });
    }
    return set;
  }
  function notifMarkDones(ids) {
    if (!ids || !ids.length) return;
    try {
      var arr = window.Store.getJSON(notifDoneKey(), []) || [];
      if (Object.prototype.toString.call(arr) !== '[object Array]') arr = [];
      ids.forEach(function (id) {
        id = String(id);
        if (arr.indexOf(id) < 0) arr.push(id);
      });
      if (arr.length > NOTIF_DONE_MAX) arr = arr.slice(arr.length - NOTIF_DONE_MAX);
      window.Store.setJSON(notifDoneKey(), arr);
    } catch (e) {}
  }

  function notifSelCount() {
    return Object.keys(notifSel.ids).filter(function (k) { return notifSel.ids[k]; }).length;
  }

  /** 长按 500ms 触发；手指滑动超过 8px 当作滚动，不触发 */
  function bindLongPress(el, fn) {
    var t = null, sx = 0, sy = 0, moved = false;
    function start(x, y) {
      moved = false; sx = x; sy = y;
      clearTimeout(t);
      t = setTimeout(function () { if (!moved) fn(); }, 500);
    }
    function move(x, y) {
      if (Math.abs(x - sx) > 8 || Math.abs(y - sy) > 8) { moved = true; clearTimeout(t); }
    }
    function end() { clearTimeout(t); }
    function pt(e) { var p = e.touches && e.touches[0]; return p ? [p.clientX, p.clientY] : [e.clientX, e.clientY]; }
    el.addEventListener('touchstart', function (e) { var p = pt(e); start(p[0], p[1]); }, { passive: true });
    el.addEventListener('touchmove', function (e) { var p = pt(e); move(p[0], p[1]); }, { passive: true });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    el.addEventListener('mousedown', function (e) { var p = pt(e); start(p[0], p[1]); });
    el.addEventListener('mousemove', function (e) { var p = pt(e); move(p[0], p[1]); });
    el.addEventListener('mouseup', end);
    el.addEventListener('mouseleave', end);
  }

  P.notifications = {
    tab: 'notifications',
    title: '通知',
    menu: function () {
      return [
        { icon: 'check', label: '全部标为已读', key: 'readall' },
        { icon: 'trash', label: '清空已读', key: 'clearread' },
        { icon: 'tasklist', label: '批量选择', key: 'multi' },
        { icon: 'sync', label: '刷新', key: 'refresh' },
        { icon: 'eye', label: '只看未读', key: 'unread' }
      ];
    },
    onMenu: function (key) {
      // 与首页菜单同理：刷新 = 清缓存 + 重画，保证拿到的是最新数据
      if (key === 'refresh') { window.API.clearCache(); return window.Router.reload(); }
      if (key === 'unread') return window.Router.go('/notifications?all=0');
      if (key === 'multi') {
        notifSel = { on: true, ids: {} };
        window.Router.reload();
        return UI.toast('已进入多选，点条目可勾选');
      }
      if (key === 'readall') {
        UI.confirm('全部标为已读', '将把所有通知标记为已读，确定继续？', '标记').then(function (ok) {
          if (!ok) return;
          window.API.put('/notifications', {}).then(function () { UI.toast('已全部标为已读'); window.Router.reload(); })
            .catch(function (e) { UI.toast('操作失败：' + e.message); });
        });
      }
      /**
       * 清空已读：把所有「已读」通知批量标记为 Done（成功 204）。
       *
       * 已读 tab 以前没有一键清理入口 —— 只能长按进多选再删，藏得深。
       * 未读通知不受任何影响；接口同 removeSelected（DELETE threads）。
       * 成功的 id 一律 notifMarkDones 记账 —— REST 的 all=true 会把 Done
       * 线程照样拉回来，不记账的话「清空」后一刷新全部复活。
       */
      if (key === 'clearread') {
        UI.confirm('清空已读通知',
          '将把所有「已读」通知标记为「已完成」（Done），从收件箱彻底消失（和网页版点 Done 效果相同）。未读通知不受影响。',
          '清空', true).then(function (ok) {
          if (!ok) return;
          UI.loading(true);
          window.API.paged('/notifications', { all: 'true', per_page: 100 }, 5).then(function (r) {
            var reads = (r.data || []).filter(function (n) { return !n.unread; });
            if (!reads.length) { UI.loading(false); UI.toast('没有已读通知'); return; }
            return Promise.all(reads.map(function (n) {
              return window.API.del('/notifications/threads/' + n.id).then(function () { return String(n.id); })
                .catch(function (e) { return (e && (e.status === 404 || e.notFound)) ? String(n.id) : null; });
            })).then(function (rs) {
              UI.loading(false);
              var failed = rs.filter(function (x) { return !x; }).length;
              notifMarkDones(rs.filter(function (x) { return !!x; }));   // 记账：刷新后别再回来
              window.App.refreshBadge();
              window.Router.reload();
              UI.toast(failed
                ? ('已清除 ' + (reads.length - failed) + ' 条，' + failed + ' 条失败')
                : ('已清除 ' + reads.length + ' 条已读通知'));
            });
          }).catch(function (e) { UI.loading(false); UI.toast('操作失败：' + e.message); });
        });
      }
    },
    render: function (ctx, host) {
      var mode = ctx.query.read === '1' ? 'read' : (ctx.query.all === '1' ? 'all' : 'unread');
      host.innerHTML = '<div class="seg-wrap" style="padding:10px 12px">' +
        UI.seg('nseg', [{ key: 'unread', label: '未读' }, { key: 'read', label: '已读' }, { key: 'all', label: '全部' }], mode) +
        '</div><div id="nlist">' + UI.skeleton(4) + '</div>';
      UI.$$('#nseg button', host).forEach(function (b) {
        b.onclick = function () {
          var v = b.getAttribute('data-v');
          window.Router.go('/notifications' + (v === 'all' ? '?all=1' : v === 'read' ? '?read=1' : ''));
        };
      });
      // 已读 / 全部都需要向服务端要全量数据，再由前端筛选；只看未读则用默认接口
      var params = { per_page: 50 };
      if (mode !== 'unread') params.all = 'true';
      return window.API.get('/notifications', params).then(function (r) {
        var list = r.data || [];
        /* Done 线程在 all=true 里照样回来（REST 不过滤、无字段可区分），
           用本机「已清除」清单挡掉；未读（含 Done 后复活的）一律放行。 */
        var dones = notifDoneSet();
        list = list.filter(function (n) { return n.unread || !dones[String(n.id)]; });
        if (mode === 'read') list = list.filter(function (n) { return !n.unread; });
        else if (mode === 'unread') list = list.filter(function (n) { return n.unread; });
        var box = UI.$('#nlist', host);
        if (!box) return;
        if (!list.length) {
          box.innerHTML = mode === 'read'
            ? UI.empty('check', '没有已读通知', '读过的通知会归档到这里')
            : UI.empty('bell', '没有通知', '有新消息时会显示在这里');
          return;
        }
        box.innerHTML = '<div class="list">' + list.map(function (n) {
          var type = (n.subject && n.subject.type) || 'Issue';
          var ico = type === 'PullRequest' ? 'git-pull-request' : type === 'Release' ? 'tag' : type === 'Commit' ? 'git-commit' : 'issue-opened';
          return '<button class="notif' + (n.unread ? ' unread' : '') + '" data-id="' + U.esc(n.id) + '" data-url="' + U.esc(n.subject && n.subject.url || '') +
            '" data-latest="' + U.esc(n.subject && n.subject.latest_comment_url || '') + '">' +
            '<span class="notif-pick" aria-hidden="true"></span>' +
            '<span class="notif-ico">' + window.icon(ico, 18) + '</span>' +
            '<span class="row-main"><span class="notif-title">' + U.esc(n.subject && n.subject.title || '(无标题)') + '</span>' +
            '<span class="notif-desc">' + U.esc(n.repository && n.repository.full_name || '') + ' · ' + U.esc(type) + '</span>' +
            '<span class="notif-desc">' + U.timeAgo(n.updated_at) + '</span></span></button>';
        }).join('') + '</div>' +
          '<div class="sel-bar" id="nselbar" hidden>' +
          '<button class="sel-btn" data-act="all" id="nselall">全选</button>' +
          '<span class="sel-count" id="nselcount">已选 0 条</span>' +
          '<button class="sel-btn danger" data-act="del">' + window.icon('trash', 15) + ' 删除</button>' +
          '<button class="sel-btn" data-act="exit">完成</button>' +
          '</div>';
        // 通知标题是英文原文，这一句让译过的一先还原、新的跟着补翻
        touchTran(box);

        /** 勾选状态同步到界面：显示/隐藏操作栏、打勾、更新计数 */
        function sync() {
          var bar = UI.$('#nselbar', box);
          if (bar) bar.hidden = !notifSel.on;
          var c = UI.$('#nselcount', box);
          if (c) c.textContent = '已选 ' + notifSelCount() + ' 条';
          var rows = UI.$$('.notif', box);
          rows.forEach(function (b) {
            b.classList.toggle('picking', notifSel.on);
            b.classList.toggle('sel', !!notifSel.ids[b.getAttribute('data-id')]);
          });
          // 全选按钮在「全选 / 取消」之间切换
          var ab = UI.$('#nselall', box);
          if (ab) {
            var all = rows.length > 0 && notifSelCount() === rows.length;
            ab.textContent = all ? '取消全选' : '全选';
          }
          // 底部操作栏浮在内容上，给列表留出空间
          box.style.paddingBottom = notifSel.on ? '56px' : '';
        }

        /**
         * 彻底删除选中的通知。
         *
         * 动作本身：DELETE /notifications/threads/{id} = 「标记为 Done」（成功 204），
         * 和网页版收件箱点 Done 是同一个动作。
         *
         * 「删了刷新又出现」的调查结论（这层窗户纸捅了三次才捅对）：
         * 1) 最早用 PATCH —— 不是 Done 端点的方法，404 被吞，假删除；
         * 2) 换成 DELETE 后曾以为「成功返回 205 被误判空 body 故障」是根 ——
         *    方向又偏了：Done 成功返回的是 204，本来就在白名单里。
         *    （205 白名单没白加：单条标已读的正确方法 PATCH 就返回 205。）
         * 3) 真正的根：GitHub REST 的结构性缺陷 —— 标 Done 成功后，
         *    GET /notifications?all=true 照样把 Done 线程拉回来，返回体里
         *    没有任何字段标记它已 Done（2026-03-10 新版 API 也没加；
         *    官方网页版用的是带 is:done 的私有 beta 接口，第三方用不了）。
         *    「已读 / 全部」tab 按 !unread 过滤，Done 线程自然又画回来。
         *    → 解法：notifMarkDones 本机记账，渲染时挡掉（见上方注释）。
         *
         * 另：DELETE 一条已 Done / 已不存在的通知会回 404，按成功算。
         * 只有真正成功的条目才从界面移除并记账；失败的留在列表里。
         */
        function removeSelected() {
          var ids = Object.keys(notifSel.ids).filter(function (k) { return notifSel.ids[k]; });
          if (!ids.length) return UI.toast('还没有勾选通知');
          UI.confirm('删除 ' + ids.length + ' 条通知',
            '会把这些通知标记为「已完成」（Done）—— 从通知收件箱里彻底消失，' +
            '下次打开不会再出现（和网页版点 Done 效果相同）。',
            '删除', true).then(function (ok) {
            if (!ok) return;
            UI.loading(true);
            Promise.all(ids.map(function (id) {
              return window.API.del('/notifications/threads/' + id).then(function () { return id; })
                .catch(function (e) { return (e && (e.status === 404 || e.notFound)) ? id : null; });
            })).then(function (rs) {
              UI.loading(false);
              var failed = 0, okIds = [];
              ids.forEach(function (id, i) {
                if (rs[i]) {
                  okIds.push(id);
                  var el = UI.$('.notif[data-id="' + id + '"]', box);
                  if (el) el.remove();
                } else {
                  failed++;
                  notifSel.ids[id] = false;   // 失败的留下，不再勾着
                }
              });
              notifMarkDones(okIds);   // 记账：刷新后别再被 all=true 拉回来
              var left = UI.$('.notif', box);
              if (!left) {
                notifSel = { on: false, ids: {} };
                box.innerHTML = UI.empty('check', '通知都处理完了', '有新的消息会再出现在这里');
              } else {
                sync();
              }
              window.App.refreshBadge();
              UI.toast(failed ? ('已移除 ' + (ids.length - failed) + ' 条，' + failed + ' 条失败') : ('已移除 ' + ids.length + ' 条通知'));
            });
          });
        }

        UI.$$('.notif', box).forEach(function (btn) {
          var id = btn.getAttribute('data-id');
          var suppress = false;   // 长按抬起时会补一次 click，要挡掉
          bindLongPress(btn, function () {
            suppress = true;
            UI.haptic();
            notifSel.on = true;
            notifSel.ids[id] = !notifSel.ids[id];
            sync();
          });
          btn.onclick = function () {
            if (suppress) { suppress = false; return; }
            if (notifSel.on) { notifSel.ids[id] = !notifSel.ids[id]; sync(); return; }
            openNotification(btn.getAttribute('data-url'), id);
          };
        });

        UI.$$('#nselbar .sel-btn', box).forEach(function (b) {
          b.onclick = function () {
            var act = b.getAttribute('data-act');
            if (act === 'all') {
              var rows = UI.$$('.notif', box);
              var all = rows.length > 0 && notifSelCount() === rows.length;
              if (all) {
                notifSel.ids = {};
              } else {
                rows.forEach(function (n) { notifSel.ids[n.getAttribute('data-id')] = true; });
              }
            } else if (act === 'exit') {
              notifSel = { on: false, ids: {} };
            } else if (act === 'del') {
              removeSelected();
            }
            sync();
          };
        });

        sync();
      }).catch(function (e) { UI.$('#nlist', host).innerHTML = UI.errorBox(e); });
    }
  };

  function openNotification(url, id) {
    if (!url) return;
    UI.loading(true);
    window.API.get(url.replace('https://api.github.com', '')).then(function (r) {
      UI.loading(false);
      var d = r.data || {};
      var html = d.html_url || '';
      var m = html.match(/github\.com\/(.+?)\/(pull|issues)\/(\d+)/);
      if (m) window.Router.go('/' + m[1] + '/' + (m[2] === 'pull' ? 'pull/' : 'issues/') + m[3]);
      else if (d.sha) window.Router.go('/' + (d.url || '').split('/repos/')[1].split('/commits/')[0] + '/commit/' + d.sha);
      else UI.toast('暂不支持打开该类型');
      // 打开 = 标记已读。文档方法是 PATCH（成功 205，已进 api.js 白名单）——
      // 之前用 PUT 是错的：PUT 不是这个端点的方法，404 被静默吞掉，
      // 「打开之后还是未读」。整箱标已读才是 PUT /notifications，别搞混。
      if (id) window.API.patch('/notifications/threads/' + id, {}).catch(function () {});
      window.App.refreshBadge();
    }).catch(function (e) {
      UI.loading(false);
      if (id) window.API.patch('/notifications/threads/' + id, {}).catch(function () {});
      UI.toast('打开失败：' + e.message);
    });
  }

  /* ================= 搜索 ================= */
  var SEARCH_TABS = [
    { key: 'repositories', label: '仓库', ep: '/search/repositories' },
    { key: 'users', label: '用户', ep: '/search/users' },
    { key: 'issues', label: '议题', ep: '/search/issues' },
    { key: 'code', label: '代码', ep: '/search/code' },
    { key: 'commits', label: '提交', ep: '/search/commits' },
    { key: 'topics', label: '话题', ep: '/search/topics' }
  ];

  /* ----------------------------------------------------------------
   * 搜索结果的「瘦身」与「上限」
   *
   * GitHub 返回的每一条搜索结果是个完整的 API 对象：仓库有 83 个顶层字段
   * （owner 里再套 19 个），实测单条 JSON 平均 5456 字节。而这一页要画的
   * 只有仓库名、描述、语言、Star、Fork、更新时间这几个。
   *
   * 更麻烦的是 SEARCH_STATE 是会一直攒的：它是「多个关键词 → 各自的结果」
   * 的缓存，只有再次搜到完全同一个 key 才会被覆盖，除此之外从来没人删过它。
   * 以前敲一个词就往里丢一份 30 条 × 5.4KB 的完整对象，换十个词就是 1.6MB，
   * 同一个词翻到 GitHub 的 1000 条上限则是 5.2MB（堆里接近 16MB）。
   *
   * 这笔账涨到最后就是「用着用着，界面突然变成一张不会动的图」：
   * WebView 的渲染进程吃满内存被系统杀掉。下面的瘦身 + 上限就是堵这个口子。
   *
   * 瘦身只挑渲染真正用到的字段，实测 5456B → 约 150B，掉到原来的 1/36，
   * 而界面上一个字都不会少。
   * ---------------------------------------------------------------- */
  var SEARCH_SLIM = {
    repositories: function (r) {
      return { full_name: r.full_name, private: r.private, description: r.description,
        language: r.language, stargazers_count: r.stargazers_count,
        forks_count: r.forks_count, updated_at: r.updated_at };
    },
    users: function (u) {
      return { login: u.login, avatar_url: u.avatar_url, type: u.type };
    },
    topics: function (t) {
      return { name: t.name, display_name: t.display_name, short_description: t.short_description };
    },
    code: function (c) {
      // 代码搜索每一条里都嵌着一个完整仓库对象，这一项省得最多
      return { name: c.name, path: c.path,
        repository: c.repository ? { full_name: c.repository.full_name,
          default_branch: c.repository.default_branch } : null };
    },
    commits: function (c) {
      return { sha: c.sha,
        commit: { message: c.commit && c.commit.message,
          author: c.commit && c.commit.author ? { name: c.commit.author.name } : null },
        repository: c.repository ? { full_name: c.repository.full_name } : null };
    },
    issues: function (i) {
      return { repository_url: i.repository_url, number: i.number,
        pull_request: i.pull_request, state: i.state, title: i.title,
        created_at: i.created_at, comments: i.comments };
    }
  };
  function slimItems(type, items) {
    var f = SEARCH_SLIM[type];
    if (!f) return items;
    var out = new Array(items.length);
    for (var i = 0; i < items.length; i++) out[i] = f(items[i]);
    return out;
  }
  /* SEARCH_STATE 的容量上限：留够「几个关键词来回切」的份儿，
   * 而不是让它随手写下去。淘汰最久没被碰过的那一份。 */
  var SEARCH_STATE_MAX = 8;
  function touchSearchState(k) {
    /* SEARCH_STATE 是 Object.create(null)，Object.keys 拿到的顺序就是写入顺序，
     * 第一个是最老的。刚用过的一份不许被淘汰 —— 否则「点加载更多」翻一半
     * 会把正在看的那份结果踢出去。 */
    var keys = Object.keys(SEARCH_STATE);
    if (keys.length <= SEARCH_STATE_MAX) return;
    var drop = keys.slice(0, keys.length - SEARCH_STATE_MAX);
    for (var j = 0; j < drop.length; j++) {
      if (drop[j] !== k) delete SEARCH_STATE[drop[j]];
    }
  }

  /* ----------------------------------------------------------------
   * 搜索的结果区是原地 innerHTML 重建的，不走 Router —— 没有 pushState、
   * 也没有 hashchange。翻译那边据此判断「页面换了」的两个信号一个都不会响，
   * 唯一能感知的通道只剩 MutationObserver 的兜底链，而它在最后一次改动
   * 之后还要再等一拍才动手。那段等待直接叠加在「900ms 防抖 + GitHub
   * 搜索往返」后面，就是「搜索出来的结果翻译特别慢」的主体。
   * 所以每处重画后面都要补一句 touchTran()：先让缓存里的中文回来，
   * 剩下的新段再走常规流程（详见 translate.js 的 refresh）。
   * ---------------------------------------------------------------- */
  function touchTran(box) {
    try { if (box && window.UI) window.UI.noticeRefresh(box); } catch (e) { }
  }

  /* ----------------------------------------------------------------
   * 排序与筛选
   *
   * 以前搜索页只传 q + per_page + page，一个筛选条件都没有 ——
   * 网页端那个 Filter 按钮和 Sort by 菜单在这儿完全缺席。
   *
   * GitHub 的搜索排序是 sort + order 两个参数配合：
   *   Best match  = 不传 sort（默认相关度）
   *   Most stars  = sort=stars&order=desc
   *   Fewest stars= sort=stars&order=asc
   *   其余同理
   * 而且 sort 并非所有类型都支持 —— users / topics 没有 stars/forks 这些维度，
   * 只有 repositories / issues / commits 能用。所以下面按类型给出可用项，
   * 不支持的就不显示，免得点了没反应。
   *
   * 筛选走的是【限定符拼进 q】这条路，和网页端一样：
   *   语言        -> language:java
   *   星级        -> stars:>=100
   *   Fork 数     -> forks:>=10
   *   更新时间    -> pushed:>=2026-01-01
   *   只看未归档  -> archived:false
   *   许可证      -> license:mit
   * 这样不用额外的 API 参数，且和用户自己敲的限定符天然共存。
   * ---------------------------------------------------------------- */
  var SORT_OPTIONS = {
    repositories: [
      { key: '', label: '最佳匹配' },
      { key: 'stars-desc', label: 'Star 最多' },
      { key: 'stars-asc', label: 'Star 最少' },
      { key: 'forks-desc', label: 'Fork 最多' },
      { key: 'forks-asc', label: 'Fork 最少' },
      { key: 'updated-desc', label: '最近更新' },
      { key: 'updated-asc', label: '最久未更新' },
      { key: 'help-wanted-issues-desc', label: '最需要帮助' }
    ],
    issues: [
      { key: '', label: '最佳匹配' },
      { key: 'created-desc', label: '最新创建' },
      { key: 'created-asc', label: '最早创建' },
      { key: 'updated-desc', label: '最近更新' },
      { key: 'comments-desc', label: '评论最多' },
      { key: 'reactions-desc', label: '点赞最多' },
      { key: 'reactions-+1-desc', label: '👍 最多' },
      { key: 'interactions-desc', label: '互动最多' }
    ],
    commits: [
      { key: '', label: '最佳匹配' },
      { key: 'committer-date-desc', label: '最新提交' },
      { key: 'committer-date-asc', label: '最早提交' }
    ]
  };
  // users / code / topics 不支持 sort，一律不显示排序入口
  function sortOptionsFor(type) { return SORT_OPTIONS[type] || null; }

  /** 'stars-desc' -> { sort:'stars', order:'desc' }；'' -> {}
   *  只给了字段没给方向时按 GitHub 默认降序处理。 */
  function parseSort(key) {
    if (!key) return {};
    var i = key.lastIndexOf('-');
    if (i < 0) return { sort: key, order: 'desc' };
    return { sort: key.substring(0, i), order: key.substring(i + 1) };
  }

  /** 常用语言（网页端下拉里的前几项，够用且不用请求接口） */
  var TOP_LANGS = [
    'JavaScript', 'TypeScript', 'Python', 'Java', 'Go', 'C', 'C++', 'C#',
    'Rust', 'PHP', 'Ruby', 'Swift', 'Kotlin', 'Dart', 'Shell', 'HTML', 'CSS', 'Vue'
  ];
  var LICENSE_OPTIONS = [
    { key: 'mit', label: 'MIT' },
    { key: 'apache-2.0', label: 'Apache-2.0' },
    { key: 'gpl-3.0', label: 'GPL-3.0' },
    { key: 'bsd-3-clause', label: 'BSD-3-Clause' },
    { key: 'mpl-2.0', label: 'MPL-2.0' },
    { key: 'unlicense', label: 'Unlicense' }
  ];
  var STAR_RANGES = [
    { key: '>=1', label: '≥ 1' },
    { key: '>=10', label: '≥ 10' },
    { key: '>=100', label: '≥ 100' },
    { key: '>=1000', label: '≥ 1,000' },
    { key: '>=10000', label: '≥ 10,000' },
    { key: '>=50000', label: '≥ 50,000' }
  ];
  var FORK_RANGES = [
    { key: '>=1', label: '≥ 1' },
    { key: '>=10', label: '≥ 10' },
    { key: '>=100', label: '≥ 100' },
    { key: '>=1000', label: '≥ 1,000' }
  ];
  var PUSH_RANGES = [
    { key: '1d', label: '今天' },
    { key: '7d', label: '最近一周' },
    { key: '30d', label: '最近一月' },
    { key: '90d', label: '最近三月' },
    { key: '1y', label: '最近一年' }
  ];
  /** 相对时间 -> 具体的 pushed: 日期（GitHub 只认日期，不认 "7d"） */
  function pushQualifier(rel) {
    var days = { '1d': 1, '7d': 7, '30d': 30, '90d': 90, '1y': 365 }[rel];
    if (!days) return '';
    var d = new Date(Date.now() - days * 86400000);
    var iso = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    return 'pushed:>=' + iso;
  }
  function pushRangeLabel(rel) {
    var it = PUSH_RANGES.filter(function (x) { return x.key === rel; })[0];
    return it ? it.label : rel;
  }

  /**
   * 把筛选条件拼进查询串。
   * 已有的同名前缀先摘掉，避免用户敲了 language:go 又选一次语言导致条件打架。
   */
  function composeQuery(q, f) {
    var base = String(q || '');
    var quals = [];
    function strip(prefix) {
      // 删掉「前缀:值」形式的既有条件（值里不含空格）
      base = base.replace(new RegExp('(^|\\s)' + prefix + ':\\S+', 'gi'), ' ').trim();
    }
    if (f.lang) { strip('language'); quals.push('language:' + f.lang); }
    if (f.stars) { strip('stars'); quals.push('stars:' + f.stars); }
    if (f.forks) { strip('forks'); quals.push('forks:' + f.forks); }
    if (f.pushed) { strip('pushed'); var pq = pushQualifier(f.pushed); if (pq) quals.push(pq); }
    if (f.license) { strip('license'); quals.push('license:' + f.license); }
    if (f.archived === 'exclude') { strip('archived'); quals.push('archived:false'); }
    if (f.archived === 'only') { strip('archived'); quals.push('archived:true'); }
    base = base.replace(/\s+/g, ' ').trim();
    return [base].concat(quals).filter(Boolean).join(' ');
  }

  /** 筛选条件里有没有生效的项（决定是否显示「清除筛选」） */
  function hasFilters(f) {
    return !!(f.lang || f.stars || f.forks || f.pushed || f.license || f.archived);
  }
  /** 生效条数，显示在 Filter 按钮上 */
  function filterCount(f) {
    var n = 0;
    ['lang', 'stars', 'forks', 'pushed', 'license', 'archived'].forEach(function (k) { if (f[k]) n++; });
    return n;
  }
  /** 从 ctx.query 里取出筛选条件 */
  function readFilters(query) {
    return {
      lang: query.f_lang || '', stars: query.f_stars || '', forks: query.f_forks || '',
      pushed: query.f_pushed || '', license: query.f_license || '', archived: query.f_archived || '',
      sort: query.sort || ''
    };
  }
  function searchStateQs(q, type) {
    return { q: q, type: type };
  }

  /* 各搜索类型认哪些限定符 / 排序。
   *
   * GitHub 对「这个类型不认的 qualifier」不是忽略，而是直接拒绝整条查询
   * （422，报「搜索语法有误」）。于是在「仓库」页签下选了「语言：Python +
   * Star ≥ 100」，切到「用户」时如果把这些原样带走，发过去的就是一条必然
   * 报错的查询串 —— 用户只会看到「搜索语法有误」，而那两个条件其实是他自己
   * 在上一个页签里设的。
   * 排序同理：只有仓库 / 议题 / 提交三档认得 sort，其余三档带上就是废参数。 */
  var TYPE_QUALS = {
    repositories: ['lang', 'stars', 'forks', 'pushed', 'license', 'archived'],
    code: ['lang'],
    issues: [], commits: [], users: [], topics: []
  };
  /** 按目标类型裁一遍筛选与排序，只留下它还认得的那些 */
  function pruneFilters(f, type) {
    var allow = TYPE_QUALS[type] || [];
    var out = { lang: '', stars: '', forks: '', pushed: '', license: '', archived: '', sort: '' };
    allow.forEach(function (k) { out[k] = f[k] || ''; });
    var list = sortOptionsFor(type) || [];
    if (f.sort && list.some(function (x) { return x.key === f.sort; })) out.sort = f.sort;
    return out;
  }
  /*
   * 搜索结果：分页 + 结果缓存
   *
   * 以前只拉第 1 页 30 条，而且没有翻页入口 —— 议题 #1「只显示一栏无法继续加载」。
   * 另外点进详情再返回时，Router 会把整个 view 重建并回到顶部，
   * 于是「返回后又要重新搜一遍、还停在顶部」—— 议题 #2。
   * 现在：结果按「类型::关键词」缓存，返回时直接还原；底部给「加载更多」翻页。
   */
  var SEARCH_PER_PAGE = 30;
  var SEARCH_STATE = Object.create(null);   // key -> { items, total, page, done, loading }
  /* 请求票据：每发起一次搜索自增，回来的结果对不上号就丢弃。
     没有它的话，「打字快一点 + 网络慢一点」时，先发的慢请求
     后到，会把新关键词的结果覆盖掉。 */
  var loadSeq = 0;
  /* 渲染实例：每进一次搜索页就换一个新的，用来判断「回来的结果还属不属于当前页面」。
   *
   * 这里原先比的是地址栏字符串，那是不成立的：在输入框里改词、按回车、让节流自动搜，
   * 走的都是 doSearch()，页面不会跳转，地址栏一动不动；而 navQs() 拼出来的目标串
   * 恒带 type —— 两者永远不相等，结果全被判成「过期」丢掉，界面就一直停在骨架屏，
   * 非得切一下页签（那时才更新地址栏）才肯显示。
   *
   * 换词导致的过期由 loadSeq 兜着，这里只管「页面是不是被换走了」。 */
  var renderSeq = null;
  function searchKey(t, q) { return t + '::' + q; }
  /** GitHub 搜索最多返回 1000 条，翻页翻不过去 */
  function searchCap(total) { return Math.max(0, Math.min(total || 0, 1000)); }

  P.search = {
    tab: 'search',
    title: '搜索',
    render: function (ctx, host) {
      var q = ctx.query.q || '';
      var type = ctx.query.type || 'repositories';
      var f = readFilters(ctx.query);
      var hist = window.Store.getJSON('gh_search_hist', []);
      // 真实发给 GitHub 的查询串 = 关键词 + 筛选限定符
      var effQ = composeQuery(q, f);
      var sorts = sortOptionsFor(type);

      host.innerHTML =
        '<div class="search-bar">' +
        '<div class="search-input">' + window.icon('search', 18) +
        '<input id="q" value="' + U.esc(q) + '" placeholder="搜索仓库、用户、代码…" autocomplete="off">' +
        // 清除按钮 / 搜索按钮无条件渲染，可见性交给 JS 按输入框实际内容切
        '<button class="clear" id="clr">' + window.icon('x-circle-fill', 17) + '</button></div>' +
        '<button class="btn" id="go">搜索</button>' +
        '</div>' +
        /* GitHub 链接的「直接打开」提示条。
           位置放在类型页签之上而不是结果区里：它是「这一次输入的东西」
           而不是搜索的设置或结果，塞在下面会被当成一条搜索结果。 */
        '<div class="openlink" id="olwrap" hidden></div>' +
        '<div class="chips" id="tabs">' + SEARCH_TABS.map(function (t) {
          return '<span class="chip' + (t.key === type ? ' active' : '') + '" data-k="' + t.key + '">' + U.esc(t.label) + '</span>';
        }).join('') + '</div>' +
        // 排序 + 筛选条：固定占位，可见性也跟着输入框走（见 syncToolbar）
        '<div class="chips" id="sflt"' + (q ? '' : ' hidden') + '>' +
        (sorts ? '<span class="chip' + (f.sort ? ' active' : '') + '" id="f-sort">' +
          window.icon('filter', 13) + '<span id="f-sorttext">' +
          U.esc(f.sort ? sortLabel(type, f.sort) : (type === 'repositories' ? '最佳匹配' : '排序')) +
          '</span></span>' : '') +
        '<span class="chip' + (filterCount(f) ? ' active' : '') + '" id="f-open">' +
        window.icon('three-bars', 13) + '筛选' +
        (filterCount(f) ? ' ' + filterCount(f) : '') + '</span>' +
        (hasFilters(f) ? '<span class="chip" id="f-reset">' + window.icon('x', 13) + '清除筛选</span>' : '') +
        '</div>' +
        '<div class="fnote" id="f-sortnote"' + (effQ && f.sort ? '' : ' hidden') + '>' +
        window.icon('arrow-up', 12) + ' 按「<span id="f-sortlabel">' + U.esc(sortLabel(type, f.sort)) + '</span>」排序</div>' +
        '<div class="fnote" id="f-eqnote"' + (effQ && hasFilters(f) ? '' : ' hidden') + '>' +
        window.icon('search', 12) + ' 实际搜索：<span class="mono" id="f-eqtext">' + U.esc(effQ) + '</span></div>' +
        '<div id="sres">' + (q ? UI.skeleton(4) : renderHistory(hist)) + '</div>';

      // 本次渲染的身份：结果回来时拿它对一下，页面换过就不要这份数据了
      var myRender = (renderSeq = {});
      /* 搜索框里那条「直接打开」当前对应的链接（没有就是 null）。
         ⚠️ 这行必须留在**所有调用之前**：var 会被提升到函数顶部，但初值
         `= null` 是原地执行的 —— 把它写在 syncOpenLink 的调用点下面，
         render 走到那行时就会把刚算出来的结果冲掉，点下去自然是空的。 */
      var curHit = null;
      var input = UI.$('#q', host);

      /* 工具栏可见性 = 输入框里有没有字。
       *
       * 以前这三样（清除按钮、搜索按钮、排序筛选条）是渲染时按地址栏的 q 一次性
       * 拼进去的：q 为空就不生成。可用户经常是「先在搜索页打字、再回车」——
       * 这条路走的是 doSearch()，页面不跳转、地址栏一动不动，于是那三样永远不出现，
       * 只有切换到别的页签再切回来（那时才会重新渲染）才冒出来。
       * 现在改成不管 q 空不空都先渲染出来，再由这里按输入框的实际内容切换显隐，
       * 打字、清空、贴入、语音输入统统即时生效。 */
      function syncToolbar() {
        var has = !!input.value.trim();
        var clr = UI.$('#clr', host);
        if (clr) clr.hidden = !has;
        var go = UI.$('#go', host);
        if (go) go.hidden = !has;
        var flt = UI.$('#sflt', host);
        if (flt) flt.hidden = !has;
      }

      /** 更新「排序」按钮上的文字（'最佳匹配' / 具体排序名） */
      function paintSortChip() {
        var t = UI.$('#f-sorttext', host);
        if (!t) return;
        t.textContent = f.sort ? sortLabel(type, f.sort)
          : (type === 'repositories' ? '最佳匹配' : '排序');
      }

      /** 刷新两条说明文字（排序 / 实际搜索式）的显隐与内容 */
      function syncNotes() {
        var text = input.value.trim();
        var eq = composeQuery(text, f);
        paintSortChip();
        var sn = UI.$('#f-sortnote', host);
        if (sn) {
          sn.hidden = !(eq && f.sort);
          var sl = UI.$('#f-sortlabel', host);
          if (sl) sl.textContent = sortLabel(type, f.sort);
        }
        var en = UI.$('#f-eqnote', host);
        if (en) {
          var show = !!(eq && (hasFilters(f) || f.sort));
          en.hidden = !show;
          var et = UI.$('#f-eqtext', host);
          if (et) et.textContent = eq;
        }
      }

      input.onkeydown = function (e) { if (e.key === 'Enter') doSearch(input.value.trim()); };
      if (UI.$('#go', host)) UI.$('#go', host).onclick = function () { doSearch(input.value.trim()); };
      if (UI.$('#clr', host)) UI.$('#clr', host).onclick = function () {
        // 清空而不是跳走：跳走要重建整个 view，输入框里已有筛选条件时也会被一并清掉
        input.value = '';
        syncToolbar();
        syncNotes();
        syncOpenLink();
        /* 只清不搜 —— 用户可能只是想把词删掉重打。
           若刚才已经搜过，这里把结果区退回历史记录，跟「地址栏 q 为空」的样子一致。 */
        var box = sres();
        if (box) box.innerHTML = renderHistory(window.Store.getJSON('gh_search_hist', []));
        bindHistory(host, input, type);
        try { input.focus(); } catch (e) { }
      };
      syncToolbar();
      syncNotes();
      syncOpenLink();     // 刚进来时输入框里可能就带着链接（比如别处跳来的 ?q=）
      bindHistory(host, input, type);
      /* 输入框里改词只影响关键词，保留筛选条件。
       *
       * 节流从 500ms 提到 900ms：GitHub 搜索一次要好几秒，
       * 边打字边搜只会把并发配额和线程都占满，后面的请求全在排队，
       * 结果是「越打越慢」。宁可等手停下来再发一次。
       * 另外至少 3 个字才触发，两个字以内的搜索命中太宽、也没意义。 */
      input.oninput = U.debounce(function () {
        var v = input.value.trim();
        /* 链接不自动跳：粘贴完还需要半秒就甩走的体验太吓人 ——
           用户可以自己决定（点提示条 / 回车 / 点「搜索」）。
           这里的防抖只是「手停下来自动搜」，跳转必须是主动动作。 */
        if (window.GhLink && window.GhLink.parse(v)) return;
        if (v.length > 2 && v !== q) doSearch(v, true);
      }, 900);
      /* 上面那个是防抖的（等手停下才发请求），而按钮显隐必须跟手 ——
         打字、退格、粘贴、语音输入都要立刻反映，所以这里单独挂一个不防抖的。 */
      input.addEventListener('input', function () { syncToolbar(); syncNotes(); syncOpenLink(); });
      UI.$$('#tabs .chip', host).forEach(function (c) {
        c.onclick = function () {
          var k = c.getAttribute('data-k');
          /* 代码搜索的鉴权门槛和其它几个不一样：GitHub 的 Code Search
             必须带 token，匿名调用直接 401。其它 tab 匿名也能搜 */
          if (k === 'code' && !window.Session.isLogin) {
            return UI.confirm('代码搜索需要登录',
              'GitHub 的代码搜索接口只对已登录用户开放，匿名调用会被拒绝。\n\n登录之后就能直接搜别人仓库里的代码。',
              '去登录').then(function (ok) { if (ok) window.Router.go('/login'); });
          }
          /* 换页签 = 换一套搜索语法：先按新类型裁一遍筛选与排序，
             不然会把上一个类型才认得的条件带过去（见 pruneFilters 的注释）。 */
          window.Router.go('/search?' + navQs(input.value.trim(), k, pruneFilters(f, k)));
        };
      });
      bindSearchFilters(host, q, type, f, input);
      function sres() { return UI.$('#sres', host); }

      /* 已有缓存就直接还原：从详情页返回时不再重新请求、也不再跳回顶部。
         缓存键要带上「排序 + 筛选」，否则改了筛选会命中旧结果。 */
      if (q) {
        var ck = cacheKey(type, effQ, f.sort);
        var cached = SEARCH_STATE[ck];
        if (cached && cached.items && cached.items.length) {
          sres().innerHTML = renderResults(type, cached, q);
          window.bindHashLinks(sres());
          bindRepoCards(sres());
          bindMore(sres());
          touchTran(sres());          // 这些结果多半译过：先让中文回来
        } else {
          loadPage(q, 1, false);
        }
      }

      /* ---------------- 搜索框里贴进来的 GitHub 链接 ---------------- */

      /**
       * 按输入框里的内容重画那条「直接打开」提示。
       *
       * 只在「整串都是一条 GitHub 链接」时才亮出来 —— 半句 search 词里
       * 夹一个链接不算数（ghlink.js 那边也是这么判的），
       * 否则打字打到一半就会有一条提示跳来跳去。
       */
      function syncOpenLink() {
        var wrap = UI.$('#olwrap', host);
        if (!wrap) return;
        var text = input.value.trim();
        curHit = (window.GhLink && text) ? window.GhLink.parse(text) : null;
        if (!curHit) { wrap.hidden = true; wrap.innerHTML = ''; return; }
        wrap.hidden = false;
        wrap.innerHTML =
          '<button class="ol-go" id="olgo">' +
          window.icon(curHit.kind === 'download' ? 'download'
            : (curHit.kind === 'external' ? 'link-external' : 'link'), 18) +
          '<span class="ol-main"><span class="ol-title">' + U.esc(curHit.label) + '</span>' +
          '<span class="ol-sub mono">' + U.esc(curHit.sub) + '</span></span>' +
          window.icon('chevron-right', 16) + '</button>' +
          '<button class="ol-alt" id="olalt">仍然搜索</button>';
        UI.$('#olgo', wrap).onclick = function () { openHit(curHit); };
        /* 「仍然搜索」是给「我确实就想搜这串 URL」留的出口 ——
           默认行为是打开，但把这条路彻底堵死同样不合理。 */
        UI.$('#olalt', wrap).onclick = function () {
          wrap.hidden = true;
          curHit = null;
          runSearch(input.value.trim());
        };
      }

      /** 按识别结果执行：跳转 / 内置浏览器 / 下载 */
      function openHit(hit) {
        if (!hit) return;
        if (hit.kind === 'route') { window.Router.go(hit.path); return; }
        if (hit.kind === 'external') {
          if (window.Native && window.Native.openInApp) window.Native.openInApp(hit.url, 'GitHub');
          else window.open(hit.url, '_blank');
          return;
        }
        /* 下载走原生通道而不是丢给浏览器：浏览器的下载管理器受 SAF（分区存储）
           限制，下完了还得去浏览器里翻；原生这条是 App 自己的下载管理，
           发布详情页那份 APK 也是这么下的，行为必须一致。
           认证头照带上 —— 私有仓库的附件、API 给出的直链都需要它。 */
        if (hit.kind === 'download' && window.Native && window.Native.download) {
          var ok = window.Native.download(hit.url, hit.name, window.Native.authHeaders());
          UI.toast(ok ? '开始下载 ' + hit.name : '下载未能发起');
        }
      }

      function doSearch(text, keepFocus) {
        if (!text) return;
        /* 链接优先：粘一条链接进来通常是想「打开它」，不是想搜这串 URL。
           命中就走，不写搜索历史 —— 那一长串 https://… 躺在历史里只会碍事。 */
        var hit = window.GhLink ? window.GhLink.parse(text) : null;
        if (hit) { openHit(hit); return; }
        runSearch(text, keepFocus);
      }

      function runSearch(text, keepFocus) {
        var h = window.Store.getJSON('gh_search_hist', []);
        h = [text].concat(h.filter(function (x) { return x !== text; })).slice(0, 12);
        window.Store.setJSON('gh_search_hist', h);
        var box = sres(); if (!box) return;
        box.innerHTML = UI.skeleton(4);
        syncToolbar();
        syncNotes();
        var eq = composeQuery(text, f);
        delete SEARCH_STATE[cacheKey(type, eq, f.sort)];   // 换关键词：旧结果作废
        loadPage(text, 1, keepFocus);
      }

      /** 拉第 page 页。第 1 页覆盖，后面几页追加 */
      function loadPage(text, page, keepFocus) {
        var eq = composeQuery(text, f);
        var k = cacheKey(type, eq, f.sort);
        var st = SEARCH_STATE[k] ||
          (SEARCH_STATE[k] = { items: [], total: 0, page: 0, done: false, loading: false });
        if (st.loading) return;
        // 已经拿到过这一页就别再打一次接口（切页签回来时以前会重复请求）
        if (page <= 1 && st.items.length && st.page >= 1) {
          var box0 = sres();
          if (box0) {
            box0.innerHTML = renderResults(type, st, text);
            window.bindHashLinks(box0); bindRepoCards(box0); bindMore(box0);
            touchTran(box0);          // 这一整块是刚重画出来的
          }
          return;
        }
        st.loading = true;
        var ep = (SEARCH_TABS.filter(function (t) { return t.key === type; })[0] || SEARCH_TABS[0]).ep;
        // sort / order 只在支持的搜索类型上传；不传等于「最佳匹配」
        var so = parseSort(f.sort);
        // 本次请求的标识：回来时若已换词/换筛选，直接丢弃，别覆盖新内容
        var ticket = (loadSeq = loadSeq + 1);
        window.API.get(ep, {
          q: eq, per_page: SEARCH_PER_PAGE, page: page,
          sort: so.sort || undefined,
          order: so.order || undefined
        }).then(function (r) {
          if (ticket !== loadSeq) return;   // 过期结果：丢掉
          st.loading = false;
          var d = r.data || {};
          /* 只留下画这一页要用到的字段。一条完整的 GitHub 结果平均 5456 字节
           * （仓库对象 83 个顶层字段），而这页用到的不到十个 —— 剩下的全是被
           * SEARCH_STATE 一直攥着不许回收的死重量。 */
          var items = slimItems(type, d.items || []);
          touchSearchState(k);
          st.items = page <= 1 ? items : st.items.concat(items);
          if (d.total_count !== undefined) st.total = d.total_count;
          st.page = page;
          // 到底了：这一页没装满，或者已经到 GitHub 的 1000 条上限
          st.done = items.length < SEARCH_PER_PAGE || st.items.length >= searchCap(st.total);
          var box = sres();
          if (!box) return;
          // 页面已经被换走了（点了别的页签、跳去了详情页）：这次结果作废，别覆盖新内容
          if (myRender !== renderSeq) return;
          box.innerHTML = renderResults(type, st, text);
          if (keepFocus && UI.$('#q', host) !== document.activeElement) {
            try { UI.$('#q', host).focus(); } catch (e) { }
          }
          // bindEvents/绑卡片都要落在 #sres 这个容器上（它们接受容器元素、
          // 内部再查子节点），三处写一致。
          window.bindHashLinks(box);
          bindRepoCards(box);
          bindMore(box);
          /* 结果刚落地：通知翻译。这里不走 Router（没有 pushState、
           * 没有 hashchange），翻译那边收不到任何「页面换了」的信号，
           * 只能靠 MutationObserver 的兜底链去发现 —— 实测那一拍就要
           * 900ms，还叠在 GitHub 往返后面。先还原缓存、再补新段。 */
          touchTran(box);
        }).catch(function (e) {
          if (ticket !== loadSeq) return;
          st.loading = false;
          var box = sres(); if (!box) return;
          box.innerHTML = e.status === 422 ? UI.empty('alert', '搜索语法有误', e.message ||
            '筛选条件和关键词可能冲突，试试「清除筛选」')
            : e.status === 403 ? UI.empty('clock', '搜索过于频繁', '请稍后再试，或登录以提升配额')
              : UI.errorBox(e);
        });
      }

      /** 「加载更多」按钮：翻下一页并追加结果 */
      function bindMore(box) {
        var btn = box && UI.$('#more', box);
        if (!btn) return;
        btn.onclick = function () {
          var text = (UI.$('#q', host) || {}).value || '';
          text = text.trim();
          var st = SEARCH_STATE[cacheKey(type, composeQuery(text, f), f.sort)];
          btn.disabled = true;
          btn.textContent = '加载中…';
          loadPage(text, (st ? st.page : 0) + 1, false);
        };
      }
    }
  };

  /* ---------------- 排序 / 筛选 条 ---------------- */

  /** 缓存键：类型 + 真实查询串 + 排序（三者任一变化都是另一份结果） */
  function cacheKey(type, effQ, sort) { return type + '::' + effQ + '::' + (sort || ''); }

  /** 排序中文名 */
  function sortLabel(type, key) {
    var list = sortOptionsFor(type);
    if (!list) return '';
    var it = list.filter(function (x) { return x.key === (key || ''); })[0];
    return it ? it.label : '';
  }

  /** 拼搜索页的 query string（保留筛选与排序） */
  function navQs(q, type, f) {
    var o = { q: q, type: type };
    // 排序无条件带上：不写的话地址栏里没有 sort，「最佳匹配」在 UI 上分不出来，
    // 切页签、点历史、刷新之后排序状态也会丢。
    o.sort = f.sort || '';
    if (f.lang) o.f_lang = f.lang;
    if (f.stars) o.f_stars = f.stars;
    if (f.forks) o.f_forks = f.forks;
    if (f.pushed) o.f_pushed = f.pushed;
    if (f.license) o.f_license = f.license;
    if (f.archived) o.f_archived = f.archived;
    return window.qs(o);
  }

  /** 绑定排序菜单与筛选面板 */
  function bindSearchFilters(host, q, type, f, input) {
    var fs = UI.$('#f-sort', host);
    if (fs) fs.onclick = function () {
      var list = sortOptionsFor(type) || [];
      UI.menu('排序方式', list.map(function (x) {
        return { icon: x.key === (f.sort || '') ? 'check' : 'filter', label: x.label, key: x.key };
      })).then(function (k) {
        if (k === null) return;
        var nf = Object.assign({}, f, { sort: k });
        window.Router.go('/search?' + navQs(input.value.trim(), type, nf));
      });
    };

    var fo = UI.$('#f-open', host);
    if (fo) fo.onclick = function () { openFilterSheet(q, type, f, input.value.trim()); };

    var fr = UI.$('#f-reset', host);
    if (fr) fr.onclick = function () {
      window.Router.go('/search?' + navQs(input.value.trim(), type, { sort: f.sort }));
    };
  }

  /**
   * 筛选面板。
   * 用底部弹层而不是官网那种浮层 —— 手机上浮层太窄，弹层能放更多条件且更好点。
   */
  function openFilterSheet(q, type, f, text) {
    var root = document.getElementById('sheet-root');
    var draft = Object.assign({}, f);

    function chipRow(id, label, items, cur) {
      return '<div class="ffield"><label>' + label + '</label><div class="chips" id="' + id + '">' +
        '<span class="chip' + (!cur ? ' active' : '') + '" data-v="">不限</span>' +
        items.map(function (x) {
          return '<span class="chip' + (x.key === cur ? ' active' : '') + '" data-v="' + U.esc(x.key) + '">' +
            U.esc(x.label) + '</span>';
        }).join('') + '</div></div>';
    }

    var body =
      // 只看仓库类才给星级/Fork/语言/许可证 —— 搜用户时这些毫无意义
      (type === 'repositories' ?
        chipRow('g-lang', '语言', TOP_LANGS.map(function (l) { return { key: l, label: l }; }), draft.lang) +
        chipRow('g-stars', 'Star 数', STAR_RANGES, draft.stars) +
        chipRow('g-forks', 'Fork 数', FORK_RANGES, draft.forks) +
        chipRow('g-pushed', '更新时间', PUSH_RANGES, draft.pushed) +
        chipRow('g-license', '许可证', LICENSE_OPTIONS, draft.license) +
        chipRow('g-arch', '归档状态', [{ key: 'exclude', label: '排除已归档' }, { key: 'only', label: '只看已归档' }], draft.archived)
        :
        chipRow('g-arch', '归档状态', [{ key: 'exclude', label: '排除已归档' }, { key: 'only', label: '只看已归档' }], draft.archived)
      ) +
      '<div class="fnote" id="g-preview"></div>';

    function paintPreview() {
      var el = root.querySelector('#g-preview');
      if (!el) return;
      var eq = composeQuery(text, draft);
      el.innerHTML = '将搜索：<span class="mono">' + U.esc(eq || '（空）') + '</span>';
    }

    UI.sheet({
      title: '筛选条件',
      body: body,
      foot: '<button class="btn" data-no>取消</button>' +
        '<button class="btn primary" data-yes>应用</button>',
      onMount: function (b, close) {
        [['g-lang', 'lang'], ['g-stars', 'stars'], ['g-forks', 'forks'],
        ['g-pushed', 'pushed'], ['g-license', 'license'], ['g-arch', 'archived']].forEach(function (pair) {
          var row = root.querySelector('#' + pair[0]);
          if (!row) return;
          UI.$$('.chip', row).forEach(function (c) {
            c.onclick = function () {
              var v = c.getAttribute('data-v');
              draft[pair[1]] = v;
              UI.$$('.chip', row).forEach(function (x) { x.classList.remove('active'); });
              c.classList.add('active');
              paintPreview();
            };
          });
        });
        paintPreview();
        root.querySelector('[data-yes]').onclick = function () {
          close();
          window.Router.go('/search?' + navQs(text, type, draft));
        };
        root.querySelector('[data-no]').onclick = function () { close(); };
      }
    });
  }

  function renderHistory(hist) {
    if (!hist.length) return UI.empty('search', '搜索 GitHub', '支持仓库、用户、议题、代码与提交，可使用 language:、stars:> 等限定符');
    return '<div class="section-title">' + window.icon('history', 14) + ' 历史记录 <button id="clrh" class="btn sm" style="margin-left:auto">清空</button></div>' +
      '<div class="list">' + hist.map(function (h) {
        return '<button class="hist-row" data-q="' + U.esc(h) + '">' + window.icon('history', 15) + '<span class="grow">' + U.esc(h) + '</span>' + window.icon('chevron-right', 14) + '</button>';
      }).join('') + '</div>';
  }

  /* 绑定历史记录区：清空按钮 + 历史词条点击回填。
     type 要跟着一起走：历史里存的是纯关键词，以前跳的是 /search?q=…（不带 type），
     于是在「用户」页签下点一条历史，页面会掉回默认的「仓库」页签 ——
     看着像「点历史就把我切回去了」。 */
  function bindHistory(host, input, type) {
    var clr = UI.$('#clrh', host);
    if (clr) clr.onclick = function () {
      UI.confirm('清空搜索历史', '将删除全部本地搜索记录，确定继续？', '清空').then(function (ok) {
        if (!ok) return;
        window.Store.setJSON('gh_search_hist', []);
        var box = UI.$('#sres', host);
        if (box) box.innerHTML = renderHistory([]);
        UI.toast('已清空搜索历史');
      });
    };
    UI.$$('.hist-row', host).forEach(function (r) {
      r.onclick = function () {
        var v = r.getAttribute('data-q') || '';
        input.value = v;
        // 同步地址栏并重新渲染，使历史区切换为结果区；类型跟着当前页签
        window.Router.go('/search?' + window.qs({ q: v, type: type || 'repositories' }));
      };
    });
  }

  /** 只画列表本体，表头与「加载更多」交给 renderResults */
  function renderItems(type, items) {
    if (type === 'users') {
      return '<div class="list">' + items.map(function (u) {
        return '<button class="list-row" data-go="/' + U.esc(u.login) + '">' + UI.avatar(u.login, u.avatar_url, 40) +
          '<span class="row-main"><span class="row-title">' + U.esc(u.login) + '</span>' +
          (u.type ? '<span class="row-desc">' + U.esc(u.type === 'Organization' ? '组织' : '用户') + '</span>' : '') + '</span></button>';
      }).join('') + '</div>';
    }
    if (type === 'topics') {
      return '<div class="list">' + items.map(function (t) {
        return '<button class="list-row" data-go="/search?q=' + encodeURIComponent('topic:' + t.name) + '&type=repositories">' +
          '<span class="row-main"><span class="row-title">' + U.esc(t.display_name || t.name) + '</span>' +
          '<span class="row-desc">' + U.esc(t.short_description || '') + '</span></span></button>';
      }).join('') + '</div>';
    }
    if (type === 'code') {
      return '<div class="list">' + items.map(function (c) {
        return '<button class="list-row" data-go="/' + U.esc(c.repository.full_name) + '/blob/' + U.esc(c.repository.default_branch || 'HEAD') + '/' + U.esc(c.path) + '">' +
          '<span class="row-main"><span class="row-title mono tiny">' + U.esc(c.repository.full_name) + '</span>' +
          '<span class="row-desc mono">' + U.esc(c.name) + '</span></span></button>';
      }).join('') + '</div>';
    }
    if (type === 'commits') {
      return '<div class="list">' + items.map(function (c) {
        return '<button class="list-row" data-go="/' + U.esc(c.repository ? c.repository.full_name : '') + '/commit/' + U.esc(c.sha) + '">' +
          '<span class="row-main"><span class="row-title">' + U.esc((c.commit.message || '').split('\n')[0]) + '</span>' +
          '<span class="row-desc">' + U.esc(c.repository ? c.repository.full_name : '') + ' · ' + U.esc(c.commit.author ? c.commit.author.name : '') + '</span></button>';
      }).join('') + '</div>';
    }
    if (type === 'issues') {
      return '<div class="list">' + items.map(function (i) {
        var repo = (i.repository_url || '').replace('https://api.github.com/repos/', '');
        return '<button class="list-row" data-go="/' + U.esc(repo) + '/issues/' + i.number + '">' +
          '<span style="color:var(--success);margin-top:2px">' + window.icon(i.pull_request ? 'git-pull-request' : (i.state === 'closed' ? 'issue-closed' : 'issue-opened'), 16) + '</span>' +
          '<span class="row-main"><span class="row-title">' + U.esc(i.title) + '</span>' +
          '<span class="row-desc">' + U.esc(repo) + ' #' + i.number + ' · ' + U.timeAgo(i.created_at) + '</span>' +
          (i.comments ? '<span class="row-meta"><span>' + window.icon('comment', 12) + i.comments + '</span></span>' : '') + '</span></button>';
      }).join('') + '</div>';
    }
    return '<div class="list">' + items.map(function (r) { return repoRow(r); }).join('') + '</div>';
  }

  function renderResults(type, st, q) {
    var items = st.items || [];
    if (!items.length) return UI.empty('search', '没有结果', '换个关键词试试');
    var total = st.total;
    var head = '';
    if (total) {
      head = '<div class="section-title">共 ' + U.num(total) + ' 条结果' +
        (items.length < searchCap(total) ? '（已加载 ' + items.length + ' 条）' : '') + '</div>';
    }
    var more = '';
    if (!st.done) {
      more = '<div class="load-more"><button class="btn" id="more">加载更多</button></div>';
    } else if (items.length >= 1000) {
      more = '<div class="load-more"><span class="done">GitHub 搜索最多返回 1000 条，换个更精确的关键词试试</span></div>';
    }
    return head + renderItems(type, items) + more;
  }

  /** 仓库行（多处复用） */
  /**
   * 仓库行。
   * extra 可选：追加在「描述下方」的一行附加内容（Star 时间、收藏按钮等），
   * 由调用方拼好 HTML 传入 —— 避免为某个列表复制一份整行模板。
   */
  /**
   * 一行仓库。
   *
   * extra 会被塞进 row-main 里当**新的一行**（.row-meta 是块级），
   * 所以只适合放「一整条补充说明」这类内容。
   *
   * 只想往已有的那行 meta 里加一项、或者在行尾放个按钮，用 opt：
   *   opt.meta —— 插进主 meta 行（与语言 / 星数 / 时间同排，排不下自动折行）
   *   opt.side —— 放进行尾操作区（垂直居中，不占整行）
   *
   * 「我的 Star」的收藏按钮就走 side：早先它走 extra，等于每行下面再挂一条，
   * 列表里每一条都多出一行，看着特别突兀。
   */
  function repoRow(r, extra, opt) {
    /* ⚠️ 这一行是踩过的坑，别删：
       `items.map(function (r) { return repoRow(r); })` 看着没传参数，其实 map 会送三个 —— 元素、下标、数组。
       下标就落到了 extra 上：第 1 条下标 0（假值，看不出来），第 2 条开始
       下标 1、2、3 被当成「额外一行」渲染成了裸数字挂在条目下面。
       所以这里只认字符串，传什么都好，别再让下标混进来。 */
    if (typeof extra !== 'string') extra = '';
    opt = opt || {};
    return '<button class="list-row" data-go="/' + U.esc(r.full_name) + '">' +
      '<span class="row-main">' +
      '<span class="row-title">' + U.esc(r.full_name) + (r.private ? ' <span class="chip" style="padding:0 6px">私有</span>' : '') + '</span>' +
      (r.description ? '<span class="row-desc">' + U.esc(r.description) + '</span>' : '') +
      '<span class="row-meta">' +
      (r.language ? '<span><i style="width:8px;height:8px;border-radius:50%;background:' + U.langColor(r.language) + ';display:inline-block"></i>' + U.esc(r.language) + '</span>' : '') +
      '<span>' + window.icon('star', 12) + U.num(r.stargazers_count) + '</span>' +
      '<span>' + window.icon('repo-forked', 12) + U.num(r.forks_count) + '</span>' +
      /* opt.time：排序用的那个时间。传了就显示它，不传才退回 updated_at。
         列表按 A 排、卡片上写 B，是最容易被当成「排序坏了」的一件事 ——
         调这个字段的调用方必须保证「显示的那串 = 排序用的那串」。 */
      (opt.time ? '<span>' + U.timeAgo(opt.time) + '</span>'
        : (r.updated_at ? '<span>' + U.timeAgo(r.updated_at) + '</span>' : '')) +
      (opt.meta || '') +
      '</span>' +
      (extra ? '<span class="row-meta">' + extra + '</span>' : '') +
      '</span>' +
      (opt.side ? '<span class="row-side">' + opt.side + '</span>' : '') +
      '</button>';
  }
  window.repoRow = repoRow;

  function bindRepoCards(root) {
    // 空实现：data-go 由 app.js 全局事件委托处理
    // 保留函数以兼容现有调用点
    void root;
  }
  window.bindRepoCards = bindRepoCards;

  /* ================= 探索 ================= */
  P.explore = {
    tab: 'explore',
    title: '探索',
    render: function (ctx, host) {
      var range = ctx.query.range || 'daily';
      var lang = ctx.query.lang || '';
      var since = '';
      var d = new Date();
      if (range === 'daily') d.setDate(d.getDate() - 7);
      else if (range === 'weekly') d.setDate(d.getDate() - 30);
      else d.setDate(d.getDate() - 120);
      since = d.toISOString().slice(0, 10);

      host.innerHTML =
        '<div class="seg-wrap" style="padding:10px 12px">' + UI.seg('eseg', [
          { key: 'daily', label: '今日' }, { key: 'weekly', label: '本周' }, { key: 'monthly', label: '本月' }], range) + '</div>' +
        '<div class="chips" id="langs">' + ['', 'TypeScript', 'JavaScript', 'Python', 'Go', 'Rust', 'Java', 'Kotlin', 'Swift', 'C++', 'Vue', 'HTML'].map(function (l) {
          return '<span class="chip' + (lang === l ? ' active' : '') + '" data-l="' + U.esc(l) + '">' + (l || '全部语言') + '</span>';
        }).join('') + '</div>' +
        '<div id="eres">' + UI.skeleton(4) + '</div>';

      UI.$$('#eseg button', host).forEach(function (b) {
        b.onclick = function () { window.Router.go('/explore?range=' + b.getAttribute('data-v') + '&lang=' + encodeURIComponent(lang)); };
      });
      UI.$$('#langs .chip', host).forEach(function (c) {
        c.onclick = function () { window.Router.go('/explore?range=' + range + '&lang=' + encodeURIComponent(c.getAttribute('data-l'))); };
      });

      var q = 'created:>' + since + (lang ? ' language:' + lang : '');
      Promise.all([
        window.API.get('/search/repositories', { q: q, sort: 'stars', order: 'desc', per_page: 30 }, { cache: 120000 }),
        window.API.get('/search/repositories', { q: 'stars:>50000 pushed:>' + new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10), sort: 'stars', per_page: 8 }, { cache: 300000 })
      ]).then(function (rs) {
        var box = UI.$('#eres', host); if (!box) return;
        var list = (rs[0].data && rs[0].data.items) || [];
        var hot = (rs[1].data && rs[1].data.items) || [];
        var html = '';
        if (hot.length) {
          html += '<div class="section-title">' + window.icon('zap', 14) + ' 热门仓库</div><div class="list">' + hot.slice(0, 5).map(function (r) { return repoRow(r); }).join('') + '</div>';
        }
        html += '<div class="section-title">' + window.icon('telescope', 14) + ' 趋势榜（' + U.esc(range === 'daily' ? '近期创建' : range === 'weekly' ? '本月创建' : '本季创建') + '）</div>' +
          /* 趋势榜的排名是**刻意**的：它是「榜」，左边那列 1、2、3 就是名次。
             ⚠️ 别和上面「热门仓库」那块混为一谈 —— 那块以前写作
             `hot.slice(0, 5).map(repoRow)`，map 把下标当成 extra 传了进去，
             于是第 2 条开始凭空多出 1、2、3、4 一行（已修，见 repoRow 的注释）。
             一个是有意的名次，一个是下标漏出来，两码事。 */
          (list.length ? '<div class="list">' + list.map(function (r, i) {
            return '<button class="list-row" data-go="/' + U.esc(r.full_name) + '">' +
              '<span class="mono muted" style="width:22px;flex:none">' + (i + 1) + '</span>' +
              '<span class="row-main"><span class="row-title">' + U.esc(r.full_name) + '</span>' +
              (r.description ? '<span class="row-desc">' + U.esc(r.description) + '</span>' : '') +
              '<span class="row-meta">' +
              (r.language ? '<span><i style="width:8px;height:8px;border-radius:50%;background:' + U.langColor(r.language) + ';display:inline-block"></i>' + U.esc(r.language) + '</span>' : '') +
              '<span>' + window.icon('star', 12) + U.num(r.stargazers_count) + '</span>' +
              '<span>' + window.icon('repo-forked', 12) + U.num(r.forks_count) + '</span></span></span></button>';
          }).join('') + '</div>' : UI.empty('telescope', '暂无数据', '换个语言或时间范围试试'));
        box.innerHTML = html;
        bindRepoCards(box);
      }).catch(function (e) {
        var box = UI.$('#eres', host); if (box) box.innerHTML = UI.errorBox(e);
      });
    }
  };

  /* ================= 我的议题 / PR（搜索视图） ================= */
  function mineView(kind) {
    return {
      title: kind === 'pr' ? '我的拉取请求' : '我的议题',
      render: function (ctx, host) {
        if (!window.Session.isLogin) return needLogin(host);
        var state = ctx.query.state || 'open';
        host.innerHTML = '<div class="seg-wrap" style="padding:10px 12px">' +
          UI.seg('mseg', [{ key: 'open', label: '待处理' }, { key: 'closed', label: '已完成' }, { key: 'all', label: '全部' }], state) +
          '</div><div id="mlist">' + UI.skeleton(4) + '</div>';
        UI.$$('#mseg button', host).forEach(function (b) {
          b.onclick = function () { window.Router.go((kind === 'pr' ? '/pulls/mine' : '/issues/mine') + '?state=' + b.getAttribute('data-v')); };
        });
        var q = 'is:' + (kind === 'pr' ? 'pr' : 'issue') + ' involves:@me' + (state !== 'all' ? ' is:' + state : '') + ' archived:false';
        return window.API.get('/search/issues', { q: q, per_page: 50, sort: 'updated' }).then(function (r) {
          var box = UI.$('#mlist', host); if (!box) return;
          var items = (r.data && r.data.items) || [];
          if (!items.length) { box.innerHTML = UI.empty('check', '没有相关内容', ''); return; }
          box.innerHTML = '<div class="list">' + items.map(function (i) {
            var repo = (i.repository_url || '').replace('https://api.github.com/repos/', '');
            var isPR = !!i.pull_request;
            return '<button class="list-row" data-go="/' + U.esc(repo) + '/' + (isPR ? 'pull/' : 'issues/') + i.number + '">' +
              '<span style="margin-top:2px;color:' + (i.state === 'open' ? 'var(--success)' : 'var(--done)') + '">' +
              window.icon(isPR ? 'git-pull-request' : (i.state === 'open' ? 'issue-opened' : 'issue-closed'), 16) + '</span>' +
              '<span class="row-main"><span class="row-title">' + U.esc(i.title) + '</span>' +
              '<span class="row-desc">' + U.esc(repo) + ' #' + i.number + ' · ' + U.timeAgo(i.updated_at) + '</span>' +
              (i.comments ? '<span class="row-meta"><span>' + window.icon('comment', 12) + i.comments + '</span></span>' : '') + '</span></button>';
          }).join('') + '</div>';
          bindRepoCards(box);
        }).catch(function (e) { UI.$('#mlist', host).innerHTML = UI.errorBox(e); });
      }
    };
  }
  P.issuesMine = mineView('issue');
  P.pullsMine = mineView('pr');

  function needLogin(host) {
    host.innerHTML = '<div class="page"><div class="card" style="padding:20px;text-align:center">' +
      '<div class="muted mb12">此功能需要登录后使用</div>' +
      '<button class="btn primary block" id="lg">去登录</button></div></div>';
    UI.$('#lg', host).onclick = function () { window.Router.go('/login'); };
  }
  window.needLogin = needLogin;

  UI.errorBox = function (e) {
    return '<div class="empty">' + window.icon('alert', 36) + '<div class="t">' + U.esc(e.message || '加载失败') + '</div>' +
      '<div class="d">' + (e.rateLimited ? 'API 调用频率已达上限，登录可提升到 5000 次/小时。' : e.status === 401 ? '令牌无效，请重新登录。' : '请检查网络后下拉重试。') + '</div>' +
      '<button class="btn mt12" onclick="window.Router.reload()">重试</button></div>';
  };
})();
