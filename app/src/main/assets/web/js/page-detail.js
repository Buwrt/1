/* ============================================================
 * page-detail.js — 议题 / 拉取请求 / 提交 / 发布 / Actions 运行
 * ============================================================ */
(function () {
  'use strict';
  var U = window.Util, UI = window.UI, P = (window.Pages = window.Pages || {});

  /* 取正文时要「markdown + 官方渲染好的 html」两份：
   * markdown 留给引用 / 编辑（那两处必须是原文），html 用来渲染 ——
   * 官方那份里，附件的类型（<img> 还是 <video>）和宽高都是服务端写好的，
   * 客户端不用猜。实测 `full` 一次请求就能把两份都带回来，
   * 不必为 html 再打一遍接口。 */
  var FULL = 'application/vnd.github.full+json';

  /* 正文渲染：有官方渲染好的 HTML 就用它（类型、宽高都是现成的），
   * 没有（老缓存、接口没给）就退回自己渲染 Markdown —— 行为与以前一致。 */
  function mountBody(el, it, full) {
    if (!el) return;
    if (it && it.body_html) window.MD.mountHtml(el, it.body_html, { repo: full });
    else window.MD.mount(el, (it && it.body) || '', { repo: full });
  }

  /* =================== 议题 / PR 详情 =================== */
  P.issue = {
    title: function (ctx) { return '#' + ctx.number; },
    render: function (ctx, host) {
      var full = ctx.owner + '/' + ctx.repo;
      var n = ctx.number;
      var hintPR = !!ctx.isPR;
      host.innerHTML = '<div class="card flat" style="border:0">' + UI.skeleton(4) + '</div>';
      // 渲染纪元：详情类页面都是「发一个请求、回来写整页」，响应比返回键慢时
      // 页面已经换了人 —— 整份丢弃（含错误框）。回调里还会改顶栏标题，一并护住。
      var epoch = window.Router.viewEpoch;
      var load = hintPR
        ? window.API.get('/repos/' + full + '/pulls/' + n, null, { accept: FULL })
        : window.API.get('/repos/' + full + '/issues/' + n, null, { accept: FULL });
      return load.then(function (r) {
        if (epoch !== window.Router.viewEpoch) return;
        var it = r.data;
        var isPR = hintPR || !!it.pull_request;
        window.App.title('#' + n, full);
        host.innerHTML =
          '<div class="detail-head">' +
          '<div class="detail-title">' + U.esc(it.title) + ' <span class="detail-number">#' + n + '</span></div>' +
          '<div class="detail-sub">' + UI.stateBadge(it, isPR) +
          '<span>' + U.esc((it.user && it.user.login) || '') + ' 创建于 ' + U.timeAgo(it.created_at) + '</span>' +
          '<span>' + it.comments + ' 条评论</span></div>' +
          (it.labels && it.labels.length ? '<div class="rowflex wrap mt12">' + it.labels.map(function (l) {
            return '<span class="label" style="' + U.labelStyle(l.color) + '">' + U.esc(l.name) + '</span>';
          }).join('') + '</div>' : '') +
          '<div class="rowflex wrap mt12">' +
          (it.assignees && it.assignees.length ? '<span class="chip">' + window.icon('person', 13) + U.esc(it.assignees.map(function (a) { return a.login; }).join('、')) + '</span>' : '') +
          (it.milestone ? '<span class="chip">' + window.icon('milestone', 13) + U.esc(it.milestone.title) + '</span>' : '') +
          (it.head ? '<span class="chip mono">' + U.esc(it.head.ref) + ' → ' + U.esc(it.base.ref) + '</span>' : '') +
          '</div></div>' +
          (isPR ? '<div class="tabs" id="dtabs">' +
            ['conversation', 'files', 'commits', 'checks'].map(function (t, i) {
              var label = { conversation: '会话', files: '文件改动', commits: '提交', checks: '检查' }[t];
              return '<button data-t="' + t + '" class="' + (i === 0 ? 'active' : '') + '">' + label +
                (t === 'files' && it.changed_files ? '<span class="cnt">' + it.changed_files + '</span>' : '') + '</button>';
            }).join('') + '</div>' : '') +
          '<div id="dbody"></div>';

        var dbody = UI.$('#dbody', host);
        UI.$$('#dtabs button', host).forEach(function (b) {
          b.onclick = function () {
            UI.$$('#dtabs button', host).forEach(function (x) { x.classList.remove('active'); });
            b.classList.add('active');
            renderPRTab(b.getAttribute('data-t'), full, n, it, dbody);
          };
        });
        if (isPR) renderPRTab('conversation', full, n, it, dbody);
        else renderConversation(full, n, it, dbody);

        setupIssueActions(full, n, it, isPR);
      }).catch(function (e) {
        if (epoch !== window.Router.viewEpoch) return;
        host.innerHTML = UI.errorBox(e);
      });
    }
  };

  function setupIssueActions(full, n, it, isPR) {
    var acts = [];
    if (window.Session.isLogin) {
      acts.push({ icon: it.state === 'open' ? 'issue-closed' : 'issue-opened', label: it.state === 'open' ? '关闭' : '重新打开', key: 'state' });
      acts.push({ icon: 'tag', label: '标签', key: 'labels' });
      acts.push({ icon: 'person', label: '指派', key: 'assign' });
      if (isPR && it.state === 'open') {
        acts.push({ icon: 'eye', label: '评审', key: 'review' });
        acts.push({ icon: 'git-merge', label: '合并', key: 'merge' });
      }
      acts.push({ icon: 'link-external', label: '在浏览器打开', key: 'web' });
    } else {
      acts.push({ icon: 'link-external', label: '在浏览器打开', key: 'web' });
    }
    window.App.setActions([{ icon: 'kebab-horizontal', onClick: function () {
      UI.menu('操作', acts).then(function (k) {
        if (!k) return;
        if (k === 'web') { var u = it.html_url; return window.NativeBridge && NativeBridge.openExternal ? NativeBridge.openExternal(u) : window.open(u, '_blank'); }
        if (k === 'state') return toggleState(full, n, it, isPR);
        if (k === 'labels') return pickLabels(full, n, it);
        if (k === 'assign') return pickAssignees(full, n);
        if (k === 'review') return reviewPR(full, n, it);
        if (k === 'merge') return mergePR(full, n, it);
      });
    } }]);
    document.getElementById('fab').hidden = false;
    document.getElementById('fab').innerHTML = window.icon('comment', 22);
    document.getElementById('fab').onclick = function () { commentBox(full, n); };
  }

  function toggleState(full, n, it, isPR) {
    var next = it.state === 'open' ? 'closed' : 'open';
    /*
     * 拉取请求必须走 /pulls 端点。
     *
     * GitHub 里 PR 确实也是一种 issue，所以 /issues/{n} 能读到它，但
     * 「改状态」这件事在 PR 上只认 /pulls/{n} —— 用 /issues 端点去改，
     * 服务端一律回 422 Validation Failed（而且 errors 是空的，什么都看不出来），
     * 用户看到的就是一句不明所以的英文报错。
     */
    var path = '/repos/' + full + (isPR ? '/pulls/' : '/issues/') + n;
    window.API.patch(path, { state: next }).then(function () {
      UI.toast(next === 'closed' ? '已关闭' : '已重新打开');
      window.Router.reload();
    }).catch(function (e) {
      var m = String((e && e.message) || '未知错误');
      /*
       * 「重新打开」还有一种注定失败的情况：PR 的源分支已经被删掉了。
       * GitHub 不允许重新打开这种 PR，同样回一个空的 422。
       * 这时候再显示英文没有意义 —— 直接说清楚为什么打不开、怎么办。
       */
      if (m.indexOf('Validation Failed') >= 0 && next === 'open') {
        m = isPR
          ? '这个拉取请求重新打开不了：它的源分支多半已被删除（GitHub 不允许重新打开）'
          : '这个议题重新打开不了：GitHub 拒绝了这次修改';
      }
      UI.toast('操作失败：' + m);
    });
  }

  function pickLabels(full, n, it) {
    window.API.get('/repos/' + full + '/labels', { per_page: 100 }, { cache: 60000 }).then(function (r) {
      var ls = r.data || [];
      if (!ls.length) return UI.toast('该仓库没有标签');
      var root = document.getElementById('sheet-root');
      var cur = (it.labels || []).map(function (l) { return l.name; });
      UI.sheet({
        title: '编辑标签',
        body: '<div class="list">' + ls.map(function (l) {
          var on = cur.indexOf(l.name) >= 0;
          return '<button class="list-row" data-l="' + U.esc(l.name) + '" data-on="' + (on ? 1 : 0) + '">' +
            '<span class="label" style="' + U.labelStyle(l.color) + '">' + U.esc(l.name) + '</span>' +
            '<span class="row-side" data-ck style="color:var(--accent)">' + (on ? window.icon('check', 18) : '') + '</span></button>';
        }).join('') + '</div>',
        onMount: function () {
          UI.$$('.list-row', root).forEach(function (b) {
            b.onclick = function () {
              var name = b.getAttribute('data-l'), on = b.getAttribute('data-on') === '1';
              var ck = b.querySelector('[data-ck]');
              var call = on ? window.API.del('/repos/' + full + '/issues/' + n + '/labels/' + encodeURIComponent(name))
                : window.API.post('/repos/' + full + '/issues/' + n + '/labels', { labels: [name] });
              call.then(function () {
                b.setAttribute('data-on', on ? '0' : '1');
                ck.innerHTML = on ? '' : window.icon('check', 18);
              }).catch(function (e) { UI.toast('操作失败：' + e.message); });
            };
          });
        },
        onClose: function () { window.Router.reload(); }
      });
    });
  }

  function pickAssignees(full, n) {
    window.API.get('/repos/' + full + '/assignees', { per_page: 100 }, { cache: 60000 }).then(function (r) {
      var users = r.data || [];
      if (!users.length) return UI.toast('没有可指派的协作者');
      UI.menu('指派给', users.map(function (u) { return { icon: 'person', label: u.login, key: u.login }; })).then(function (k) {
        if (!k) return;
        window.API.post('/repos/' + full + '/issues/' + n + '/assignees', { assignees: [k] }).then(function () {
          UI.toast('已指派给 ' + k); window.Router.reload();
        }).catch(function (e) { UI.toast('操作失败：' + e.message); });
      });
    });
  }

  /** 分支删除：删的是 git ref，路径里的分支名要逐段编码，含 / 的分支名才不会撞车 */
  function deleteBranch(full, ref) {
    return window.API.del('/repos/' + full + '/git/refs/' + String(ref).split('/').map(encodeURIComponent).join('/'));
  }

  function mergePR(full, n, it) {
    window.API.get('/repos/' + full + '/pulls/' + n).then(function (r) {
      var pr = r.data;
      if (pr.merged) return UI.toast('该 PR 已合并');
      if (pr.state === 'closed') return UI.toast('该 PR 已关闭，无法合并');
      if (pr.draft) return UI.toast('草稿状态的 PR 不能合并，请先标记为可评审');

      var st = pr.mergeable_state || '';
      var warn = '';
      if (st === 'dirty') warn = '<div class="fnote" style="color:var(--danger)">' + window.icon('alert', 12) + ' 该分支与目标分支存在冲突，需要先解决冲突</div>';
      else if (st === 'blocked') warn = '<div class="fnote" style="color:var(--danger)">' + window.icon('alert', 12) + ' 被分支保护规则阻止（缺少必需的检查或评审）</div>';
      else if (st === 'behind') warn = '<div class="fnote">' + window.icon('alert', 12) + ' 分支落后于目标分支，建议先更新</div>';
      else if (st === 'unstable') warn = '<div class="fnote">' + window.icon('alert', 12) + ' 有检查未通过，仍可合并</div>';
      else if (pr.mergeable === false) warn = '<div class="fnote">' + window.icon('alert', 12) + ' GitHub 正在计算合并状态，请稍后再试</div>';

      // 待提交的评审意见不能随合并一起发出，先提醒，别让人白写
      var pc = pendingCount(full, n);
      if (pc) warn += '<div class="fnote">' + window.icon('comment', 12) + ' 还有 ' + pc + ' 条评审意见未提交，合并后这些行号就失效了</div>';

      var canDel = !!(pr.head && pr.head.ref) && pr.head.repo && pr.base.repo &&
        pr.head.repo.full_name === pr.base.repo.full_name && pr.head.ref !== (pr.base.repo.default_branch || '');
      var body = warn +
        '<div class="field"><label>合并方式</label>' +
        UI.seg('mseg', [
          { key: 'merge', label: '创建合并提交' }, { key: 'squash', label: '压缩合并' }, { key: 'rebase', label: '变基合并' }], 'squash') +
        '</div><div class="field"><label>提交标题</label><input class="input" id="mt" value="' + U.esc(pr.title) + '"></div>' +
        '<div class="field"><label>提交描述</label><textarea class="textarea" id="mm" style="min-height:80px"></textarea></div>' +
        (canDel ? '<div class="field"><label class="rowflex" style="gap:8px;align-items:center">' +
          '<input type="checkbox" id="mdel" checked style="width:18px;height:18px">' +
          '<span>合并后删除分支 <span class="mono">' + U.esc(pr.head.ref) + '</span></span></label></div>' : '') +
        '<div class="muted tiny">合并后该拉取请求会自动关闭。</div>';
      var root = document.getElementById('sheet-root');
      UI.sheet({
        title: '合并拉取请求', body: body,
        foot: '<button class="btn" data-no>取消</button><button class="btn primary" data-yes>确认合并</button>',
        onMount: function () {
          var method = 'squash';
          UI.$$('#mseg button', root).forEach(function (b) {
            b.onclick = function () {
              method = b.getAttribute('data-v');
              UI.$$('#mseg button', root).forEach(function (x) { x.classList.remove('active'); });
              b.classList.add('active');
            };
          });
          root.querySelector('[data-yes]').onclick = function () {
            if (st === 'dirty' || st === 'blocked') {
              return UI.confirm('仍要继续？', '当前状态为「' + mergeableText(st) + '」，GitHub 很可能拒绝这次合并。是否仍要尝试？', '继续', true)
                .then(function (ok) { if (ok) doMerge(); });
            }
            doMerge();
          };
          function doMerge() {
            UI.loading(true);
            var ref = pr.head && pr.head.ref;
            var wantDel = canDel && root.querySelector('#mdel') && root.querySelector('#mdel').checked;
            window.API.put('/repos/' + full + '/pulls/' + n + '/merge', {
              commit_title: root.querySelector('#mt').value,
              commit_message: root.querySelector('#mm').value,
              merge_method: method
            }).then(function () {
              pending.list = [];
              if (!wantDel) { UI.loading(false); UI.closeSheet(); UI.toast('合并成功'); return window.Router.reload(); }
              // 删分支失败不算合并失败 —— 分支可能已被删或受保护，单独提示即可
              return deleteBranch(full, ref).then(function () {
                UI.loading(false); UI.closeSheet(); UI.toast('合并成功，分支已删除'); window.Router.reload();
              }).catch(function () {
                UI.loading(false); UI.closeSheet(); UI.toast('合并成功，但删除分支失败'); window.Router.reload();
              });
            }).catch(function (e) {
              UI.loading(false);
              UI.toast('合并失败：' + (e.status === 405 ? '不允许合并（可能冲突或未满足保护规则）' : e.message));
            });
          }
          root.querySelector('[data-no]').onclick = function () { UI.closeSheet(); };
        }
      });
    }).catch(function (e) { UI.toast('读取 PR 失败：' + e.message); });
  }
  function mergeableText(s) {
    return ({ dirty: '存在冲突', blocked: '被分支保护规则阻止', behind: '分支落后', unstable: '检查未通过', draft: '草稿状态', clean: '可合并' })[s] || s;
  }

  /* ---- 会话（正文 + 时间线） ---- */
  function renderConversation(full, n, it, box) {
    var isPR = !!it.head;
    box.innerHTML = '<div id="rvsum"></div><div class="comment">' + UI.avatar(it.user && it.user.login, it.user && it.user.avatar_url, 40) +
      '<div class="bubble"><div class="bubble-head"><b>' + U.esc((it.user && it.user.login) || 'ghost') + '</b>' +
      '<span class="muted">评论于 ' + U.timeAgo(it.created_at) + '</span>' +
      (it.author_association ? '<span class="chip" style="padding:0 6px">' + assocText(it.author_association) + '</span>' : '') + '</div>' +
      '<div class="bubble-body" id="main-body"></div></div></div>' +
      '<div id="tl"><div style="padding:16px"><div class="spinner"></div></div></div>';
    mountBody(UI.$('#main-body', box), it, full);
    /* 正文跟 README 一样是「骨架先到、内容后填」的，翻译的第一轮看不见它。
     * 打一声招呼，让翻译按整篇模式接上（详情见 ui.js 的 noticeRefresh）。 */
    if (window.UI) UI.noticeRefresh(UI.$('#main-body', box));

    Promise.all([
      window.API.get('/repos/' + full + '/issues/' + n + '/comments', { per_page: 100 }, { accept: FULL }),
      window.API.get('/repos/' + full + '/issues/' + n + '/timeline', { per_page: 100 }).catch(function () { return { data: [] }; })
    ]).then(function (rs) {
      var comments = rs[0].data || [];
      var events = (rs[1].data || []).filter(function (e) {
        return ['labeled', 'unlabeled', 'closed', 'reopened', 'assigned', 'unassigned', 'referenced', 'renamed', 'review_requested', 'reviewed', 'head_ref_force_pushed', 'merged', 'cross-referenced', 'milestoned'].indexOf(e.event) >= 0;
      });
      var all = comments.map(function (c) { return { t: 'c', d: c, at: c.created_at }; })
        .concat(events.map(function (e) { return { t: 'e', d: e, at: e.created_at }; }))
        .sort(function (a, b) { return Date.parse(a.at) - Date.parse(b.at); });
      var tl = UI.$('#tl', box); if (!tl) return;
      tl.innerHTML = all.length ? all.map(function (x) {
        return x.t === 'c' ? commentHtml(x.d) : eventHtml(x.d);
      }).join('') : '<div style="height:1px;background:var(--border)"></div>';
      // 填充分条评论的 Markdown 内容
      var bodies = UI.$$('.bubble-body', tl);
      var ci = 0;
      all.forEach(function (x) {
        if (x.t !== 'c') return;
        var box = bodies[ci];
        ci++;
        if (!box) return;
        /* 一条评论渲染失败不能连累后面所有评论 —— 以前 mountBody 抛异常会
           直接冲出这个 forEach，从出错那一条起，后面全部停在「空白气泡」上，
           看起来就像评论凭空消失了。 */
        try { mountBody(box, x.d, full); }
        catch (e) { box.textContent = (x.d && x.d.body) || ''; }
      });
      window.bindHashLinks(tl);
      /* 用与 postMount 同一个入口绑（点 = 查看大图，长按 = 打开链接页）。
       * 以前这里直接 img.onclick 覆盖一遍，把 md.js 绑好的处理冲掉了。 */
      UI.$$('.md img', tl).forEach(function (img) { window.MD.bindImageTap(img); });
      UI.$$('[data-quote]', tl).forEach(function (b) {
        b.onclick = function () { commentBox(full, n, b.getAttribute('data-quote')); };
      });
      bindCommentOps(tl, full, n);
    }).catch(function () {
      var tl = UI.$('#tl', box); if (tl) tl.innerHTML = '';
    });

    // PR 才有的评审区：谁批准了 / 谁要求改，以及还没提交的行内意见
    if (isPR) {
      reviewSummary(full, n).then(function (h) {
        var s = UI.$('#rvsum', box); if (!s) return;
        var pc = pendingCount(full, n);
        s.innerHTML = h + (pc ? '<div class="fnote">' + window.icon('comment', 12) +
          '有 <b>' + pc + '</b> 条行内评论待提交' +
          '　<button class="btn sm" id="rv-sub">提交评审</button>' +
          '　<button class="btn sm" id="rv-clr">清空</button></div>' : '');
        var sb = UI.$('#rv-sub', s);
        if (sb) sb.onclick = function () { reviewPR(full, n, it); };
        var cb = UI.$('#rv-clr', s);
        if (cb) cb.onclick = function () {
          UI.confirm('清空未提交的评论？', '这 ' + pc + ' 条意见还没发给任何人，清空后需要重新写。', '清空', true)
            .then(function (ok) { if (ok) { pending.list = []; UI.toast('已清空'); window.Router.reload(); } });
        };
      });
    }
  }

  function assocText(a) {
    return ({ OWNER: '作者', MEMBER: '成员', COLLABORATOR: '协作者', CONTRIBUTOR: '贡献者', NONE: '用户', MANNEQUIN: '马甲' })[a] || a;
  }

  function commentHtml(c) {
    /* 只有自己发的评论才给「更多」：别人的评论最多能引用，
       改和删的接口就算硬调也会被 GitHub 挡回来，摆个按钮反而是骗人。 */
    var mine = !!(window.Session.user && c.user && c.user.login === window.Session.user.login);
    return '<div class="comment" data-cid="' + c.id + '" data-cmine="' + (mine ? 1 : 0) +
      '" data-cbody="' + U.esc(encodeURIComponent(c.body || '')) + '">' + UI.avatar(c.user && c.user.login, c.user && c.user.avatar_url, 40) +
      '<div class="bubble"><div class="bubble-head"><b>' + U.esc((c.user && c.user.login) || 'ghost') + '</b>' +
      '<span class="muted">' + U.timeAgo(c.created_at) + '</span>' +
      (c.author_association ? '<span class="chip" style="padding:0 6px">' + assocText(c.author_association) + '</span>' : '') +
      '<span style="margin-left:auto;display:flex;align-items:center;gap:6px">' +
      '<button class="btn sm" data-quote="' + U.esc((c.body || '').substring(0, 400)) + '">引用</button>' +
      (mine ? '<button class="btn sm" data-cops="' + c.id + '" data-cbody="' +
        U.esc(encodeURIComponent(c.body || '')) + '" aria-label="评论操作">' +
        window.icon('kebab-horizontal', 13) + '</button>' : '') +
      '</span>' +
      '</div><div class="bubble-body md"></div></div></div>';
  }

  /* ---- 评论的编辑与删除（只对自己的评论开放） ----
   * 改走 PATCH、删走 DELETE，地址都是 /repos/:owner/:repo/issues/comments/:id。
   * 注意这套 id 是「会话评论」的：PR 里对着某一行发的那些 inline 评论走的是
   * 另一套 /pulls/comments 接口，时间线里根本不吐它们的 id，所以不在这里处理。 */
  function bindCommentOps(scope, full, n) {
    /* 「…」按钮：只在自己的评论上渲染（见 commentHtml） */
    UI.$$('[data-cops]', scope).forEach(function (b) {
      b.onclick = function () {
        var id = b.getAttribute('data-cops');
        var raw = b.getAttribute('data-cbody') || '';
        var old = '';
        try { old = decodeURIComponent(raw); } catch (e) { old = raw; }
        commentMenu(full, n, id, old, true);
      };
    });

    /* 长按整条评论（气泡/头像任意位置）550ms 出同一个菜单：
       跟通知、发布列表的长按一致。自己的评论可编辑/删除，
       别人的评论只给引用 —— 删除按钮摆出来也是骗 GitHub。 */
    UI.$$('[data-cid]', scope).forEach(function (el) {
      var wasLong = UI.bindLongPress(el, function () {
        var id = el.getAttribute('data-cid');
        var raw = el.getAttribute('data-cbody') || '';
        var old = '';
        try { old = decodeURIComponent(raw); } catch (e) { old = raw; }
        var mine = el.getAttribute('data-cmine') === '1';
        commentMenu(full, n, id, old, mine);
      }, 550);
      /* 长按松手带出的合成 click：吞掉，避免误触评论里的链接 */
      el.addEventListener('click', function (e) {
        if (wasLong()) { e.stopPropagation(); }
      });
    });
  }

  /** 评论操作菜单（「…」按钮与长按共用同一份） */
  function commentMenu(full, n, id, old, mine) {
    var items = [{ icon: 'quote', label: '引用回复', key: 'quote' }];
    if (mine) {
      items = [
        { icon: 'pencil', label: '编辑评论', key: 'edit' },
        { icon: 'quote', label: '引用回复', key: 'quote' },
        '-',
        { icon: 'trash', label: '删除评论', key: 'del' }
      ];
    }
    UI.menu('评论操作', items).then(function (k) {
      if (!k) return;
      if (k === 'edit') return editComment(full, id, old);
      if (k === 'quote') return commentBox(full, n, old.substring(0, 400));
      if (k === 'del') return deleteComment(full, id);
    });
  }

  function editComment(full, id, old) {
    var root = document.getElementById('sheet-root');
    UI.sheet({
      title: '编辑评论', full: true,
      body: '<div class="field"><label>评论内容</label>' +
        '<textarea class="textarea" id="ce" style="min-height:180px">' + U.esc(old) + '</textarea></div>' +
        '<div class="muted tiny">改动会留痕：GitHub 会在评论上标记已被编辑。</div>',
      foot: '<button class="btn" data-no>取消</button><button class="btn primary" data-yes>保存</button>',
      onMount: function () {
        root.querySelector('[data-no]').onclick = function () { UI.closeSheet(); };
        root.querySelector('[data-yes]').onclick = function () {
          var v = root.querySelector('#ce').value.trim();
          if (!v) return UI.toast('评论不能为空');
          if (v === old.trim()) return UI.toast('内容没有变化');
          UI.loading(true);
          window.API.patch('/repos/' + full + '/issues/comments/' + id, { body: v })
            .then(function () {
              UI.loading(false); UI.closeSheet(); UI.toast('评论已更新');
              window.Router.reload();
            })
            .catch(function (e) {
              UI.loading(false);
              UI.toast('保存失败：' + (e.status === 403 ? '没有权限修改这条评论' : e.message));
            });
        };
      }
    });
  }

  function deleteComment(full, id) {
    UI.confirm('删除评论？', '删除后无法恢复。如果是误发的内容，编辑一下通常比删除更好。', '删除', true)
      .then(function (ok) {
        if (!ok) return;
        UI.loading(true);
        window.API.del('/repos/' + full + '/issues/comments/' + id)
          .then(function () {
            UI.loading(false); UI.toast('评论已删除');
            window.Router.reload();
          })
          .catch(function (e) {
            UI.loading(false);
            UI.toast('删除失败：' + (e.status === 403 ? '没有权限删除这条评论' : e.message));
          });
      });
  }

  function eventHtml(e) {
    var actor = e.actor && e.actor.login;
    var ico = 'dot-fill', text = '';
    switch (e.event) {
      case 'labeled': ico = 'tag'; text = '添加了标签 <span class="label" style="' + U.labelStyle(e.label.color) + '">' + U.esc(e.label.name) + '</span>'; break;
      case 'unlabeled': ico = 'tag'; text = '移除了标签 ' + U.esc(e.label.name); break;
      case 'closed': ico = 'issue-closed'; text = '关闭了该议题'; break;
      case 'reopened': ico = 'issue-opened'; text = '重新打开'; break;
      case 'merged': ico = 'git-merge'; text = '合并了提交 <span class="mono">' + U.esc((e.commit_id || '').substring(0, 7)) + '</span>'; break;
      case 'assigned': ico = 'person'; text = '指派给 <a href="#/' + U.esc(e.assignee.login) + '">' + U.esc(e.assignee.login) + '</a>'; break;
      case 'unassigned': ico = 'person'; text = '取消指派 ' + U.esc(e.assignee ? e.assignee.login : ''); break;
      case 'referenced': ico = 'cross-reference'; text = '引用了该议题'; break;
      case 'cross-referenced': ico = 'cross-reference'; text = '被引用'; break;
      case 'renamed': ico = 'pencil'; text = '修改标题：' + U.esc(e.rename.from) + ' → ' + U.esc(e.rename.to); break;
      case 'review_requested': ico = 'eye'; text = '请求 ' + U.esc(e.requested_reviewer ? e.requested_reviewer.login : '') + ' 评审'; break;
      case 'reviewed':
        // timeline 里的是小写状态；具体意见在上方「评审」区展示，这里只记一笔动作
        if (e.state === 'approved') { ico = 'check-circle-fill'; text = '批准了这些改动'; }
        else if (e.state === 'changes_requested') { ico = 'x-circle-fill'; text = '请求修改'; }
        else { ico = 'comment'; text = '发表了评审意见'; }
        break;
      case 'head_ref_force_pushed': ico = 'git-commit'; text = '强制推送了分支'; break;
      case 'milestoned': ico = 'milestone'; text = '加入了里程碑 ' + U.esc(e.milestone.title); break;
      default: text = U.esc(e.event);
    }
    return '<div class="event"><div class="event-ico">' + window.icon(ico, 16) + '</div>' +
      '<div class="event-body"><div><b>' + U.esc(actor || '') + '</b> <span class="what">' + text + '</span></div>' +
      '<div class="when">' + U.timeAgo(e.created_at) + '</div></div></div>';
  }

  /**
   * 把文本插到光标处（没有焦点就追加到末尾）。
   * 插图/插视频后光标要落到插入内容之后，方便接着往下写。
   */
  function insertAtCursor(ta, text) {
    var s = ta.selectionStart, e = ta.selectionEnd;
    if (s == null || s < 0) s = e = ta.value.length;
    ta.value = ta.value.substring(0, s) + text + ta.value.substring(e);
    var pos = s + text.length;
    ta.focus();
    try { ta.setSelectionRange(pos, pos); } catch (err) { }
  }

  /* ---- 评论输入 ---- */
  function commentBox(full, n, quote) {
    if (!window.Session.isLogin) return UI.toast('请先登录');
    var root = document.getElementById('sheet-root');
    var text = quote ? quote.split('\n').map(function (l) { return '> ' + l; }).join('\n') + '\n\n' : '';
    UI.sheet({
      title: '发表评论',
      body: '<div class="rowflex" style="gap:4px;margin-bottom:8px">' + ['bold', 'italic', 'quote', 'code', 'link', 'list-unordered'].map(function (i) {
        var t = i === 'link' ? ' title="上传附件"' : '';
        return '<button class="btn sm" data-md="' + i + '"' + t + '>' + window.icon(i, 14) + '</button>';
      }).join('') +
        '<button class="btn sm" data-md="attach" title="插入图片或视频">' + window.icon('image', 14) + '</button>' +
        '<button class="btn sm" data-md="preview" style="margin-left:auto">预览</button></div>' +
        '<textarea class="textarea" id="cb" style="min-height:160px" placeholder="支持 Markdown，可使用 @ 提及他人">' + U.esc(text) + '</textarea>' +
        '<div id="prev" class="card" hidden style="padding:12px;margin-top:10px"></div>',
      foot: '<button class="btn" data-no>取消</button><button class="btn primary" data-yes>提交评论</button>',
      onMount: function () {
        var ta = root.querySelector('#cb');
        setTimeout(function () { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 150);

        /* 统一走 upload-attach.js 的共用方法：选文件 → 上传 → 插入光标处。
         * accept 决定文件选择器放什么：图片/视频按钮给 image 与 video，
         * 链条（附件）按钮放行全部类型 —— 图片渲染成 img、视频裸链渲染播放器、
         * 其他文件（zip/log/txt/pdf…）生成可点击的下载链接。 */
        function doUpload(b, accept, hint) {
          window.Attach.pickInsert(b, ta,
            { repoFull: full, accept: accept, hint: hint });
        }

        UI.$$('[data-md]', root).forEach(function (b) {
          b.onclick = function () {
            var k = b.getAttribute('data-md');
            if (k === 'attach') {
              // 图片按钮：选图片/视频 → 传上去 → 把 Markdown 链接贴到光标处
              doUpload(b, 'image/*,video/*', '请选择图片或视频');
              return;
            }
            if (k === 'link') {
              // 链条按钮：上传任意附件（不再是插入空的 [](链接) 语法）
              doUpload(b, '*/*', '请选择要上传的文件');
              return;
            }
            if (k === 'preview') {
              var pv = root.querySelector('#prev'); pv.hidden = !pv.hidden;
              if (!pv.hidden) window.MD.mount(pv, ta.value || '（无内容）', { repo: full });
              return;
            }
            window.wrapSelection(ta, k);
          };
        });
        root.querySelector('[data-yes]').onclick = function () {
          var v = ta.value.trim();
          if (!v) return UI.toast('请输入内容');
          UI.loading(true);
          window.API.post('/repos/' + full + '/issues/' + n + '/comments', { body: v }).then(function () {
            UI.loading(false); UI.closeSheet(); UI.toast('评论已发布'); window.Router.reload();
          }).catch(function (e) { UI.loading(false); UI.toast('发布失败：' + e.message); });
        };
        root.querySelector('[data-no]').onclick = function () { UI.closeSheet(); };
      }
    });
  }
  window.commentBox = commentBox;

  /* ---- PR 各 Tab ---- */
  function renderPRTab(tab, full, n, it, box) {
    if (tab === 'conversation') return renderConversation(full, n, it, box);
    if (tab === 'files') {
      box.innerHTML = '<div id="fl">' + UI.skeleton(4) + '</div>';
      return window.API.get('/repos/' + full + '/pulls/' + n + '/files', { per_page: 100 }).then(function (r) {
        var files = r.data || [];
        var b = UI.$('#fl', box); if (!b) return;
        var reviewable = window.Session.isLogin && !!it.head && !!it.head.sha;
        var pc = pendingCount(full, n);
        b.innerHTML =
          (reviewable ? '<div class="fnote">' + window.icon('comment', 12) +
            '点任意一行可写行内评论' + (pc ? '，已攒 <b>' + pc + '</b> 条' : '') +
            (pc ? '　<button class="btn sm" id="sub-rv">去提交评审</button>' : '') + '</div>' : '') +
          (files.length ? files.map(function (f) { return diffFile(f, { reviewable: reviewable }); }).join('')
            : UI.empty('file-diff', '没有文件改动', ''));
        if (!reviewable) return;
        UI.$$('.diff-body [data-cl]', b).forEach(function (row) {
          row.onclick = function () { inlineComment(full, n, row); };
        });
        var sb = UI.$('#sub-rv', b);
        if (sb) sb.onclick = function () { reviewPR(full, n, it); };
      }).catch(function (e) { UI.$('#fl', box).innerHTML = UI.errorBox(e); });
    }
    if (tab === 'commits') {
      box.innerHTML = '<div id="cl">' + UI.skeleton(4) + '</div>';
      return window.API.get('/repos/' + full + '/pulls/' + n + '/commits', { per_page: 100 }).then(function (r) {
        var cs = r.data || [];
        var b = UI.$('#cl', box); if (!b) return;
        b.innerHTML = cs.length ? '<div class="list">' + cs.map(function (c) {
          return '<button class="list-row" data-go="/' + U.esc(full) + '/commit/' + c.sha + '">' +
            (c.author && c.author.avatar_url ? UI.avatar(c.author.login, c.author.avatar_url, 24) : '') +
            '<span class="row-main"><span class="row-title">' + U.esc((c.commit.message || '').split('\n')[0]) + '</span>' +
            '<span class="row-desc">' + U.esc(c.commit.author.name) + ' · ' + U.timeAgo(c.commit.author.date) + '</span></span>' +
            '<span class="row-side mono tiny">' + U.esc(c.sha.substring(0, 7)) + '</span></button>';
        }).join('') + '</div>' : UI.empty('git-commit', '暂无提交', '');
        window.bindRepoCards(b);
      }).catch(function (e) { UI.$('#cl', box).innerHTML = UI.errorBox(e); });
    }
    if (tab === 'checks') {
      box.innerHTML = '<div id="ck">' + UI.skeleton(3) + '</div>';
      return window.API.get('/repos/' + full + '/pulls/' + n).then(function (r) {
        /* head 在极少数情况下会缺（PR 来自已删除的 fork），
         * 以前直接 r.data.head.sha 会把整个 checks 页带崩。 */
        var head = r.data && r.data.head;
        var sha = head && head.sha;
        if (!sha) throw new Error('取不到这次提交的校验值，可能分支已被删除');
        return Promise.all([
          window.API.get('/repos/' + full + '/commits/' + sha + '/check-runs', { per_page: 100 }).catch(function () { return { data: { check_runs: [] } }; }),
          window.API.get('/repos/' + full + '/commits/' + sha + '/status', {}).catch(function () { return { data: { statuses: [] } }; })
        ]).then(function (rs) {
          var runs = (rs[0].data && rs[0].data.check_runs) || [];
          var sts = (rs[1].data && rs[1].data.statuses) || [];
          var b = UI.$('#ck', box); if (!b) return;
          var html = '';
          if (sts.length) {
            html += '<div class="section-title">' + window.icon('check-circle-fill', 14) + ' 状态</div><div class="list">' +
              sts.map(function (s) {
                var ok = s.state === 'success';
                return '<div class="list-row static"><span style="color:' + (ok ? 'var(--success)' : s.state === 'pending' ? 'var(--attention)' : 'var(--danger)') + '">' +
                  window.icon(ok ? 'check-circle-fill' : s.state === 'pending' ? 'dot-fill' : 'x-circle-fill', 16) + '</span>' +
                  '<span class="row-main"><span class="row-title tiny">' + U.esc(s.context) + '</span>' +
                  '<span class="row-desc">' + U.esc(s.description || s.state) + '</span></span></div>';
              }).join('') + '</div>';
          }
          html += runs.length ? '<div class="section-title">' + window.icon('workflow', 14) + ' 检查（' + runs.length + '）</div><div class="list">' +
            runs.map(function (r2) {
              var c = r2.conclusion || r2.status;
              var ok = c === 'success';
              return '<div class="list-row static"><span style="color:' + (ok ? 'var(--success)' : c === 'failure' ? 'var(--danger)' : 'var(--attention)') + '">' +
                window.icon(ok ? 'check-circle-fill' : c === 'failure' ? 'x-circle-fill' : 'dot-fill', 16) + '</span>' +
                '<span class="row-main"><span class="row-title tiny">' + U.esc(r2.name) + '</span>' +
                '<span class="row-desc">' + U.esc((r2.output && r2.output.title) || c) + '</span></span>' +
                (r2.html_url ? '<button class="btn sm" data-web="' + U.esc(r2.html_url || '') + '">查看</button>' : '') + '</div>';
            }).join('') + '</div>' : (html ? '' : UI.empty('check', '没有检查记录', '该提交未触发任何 CI 检查'));
          b.innerHTML = html;
          UI.$$('[data-web]', b).forEach(function (x) {
            x.onclick = function () { NativeBridge.openExternal ? NativeBridge.openExternal(x.getAttribute('data-web')) : window.open(x.getAttribute('data-web'), '_blank'); };
          });
        });
      }).catch(function (e) { UI.$('#ck', box).innerHTML = UI.errorBox(e); });
    }
  }

  /**
   * 渲染单个文件的 diff。
   *
   * opts.reviewable = true 时给每一行标上「属于哪一侧、第几行」（data-p / data-l / data-s），
   * 供「点一行写评审意见」用。行号从 hunk 头 @@ -a,b +c,d @@ 推算：
   *   - 新增行和上下文行算新文件（RIGHT），删除行算旧文件（LEFT）
   *   - 上下文行两侧行号都要 +1，新增只加右侧，删除只加左侧
   * 算错行号评论就会挂到别的行上，所以这里宁可多写几行也不能想当然。
   */
  function diffFile(f, opts) {
    opts = opts || {};
    var reviewable = !!opts.reviewable;
    var patch = f.patch || '';
    var oldNo = 0, newNo = 0;
    var lines = patch.split('\n').map(function (l) {
      var cls = '', side = '', no = 0;
      if (/^@@/.test(l)) {
        var m = l.match(/^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/);
        if (m) { oldNo = +m[1]; newNo = +m[2]; }
        cls = 'hunk';
      } else if (/^\+/.test(l)) {
        cls = 'add'; side = 'RIGHT'; no = newNo++;
      } else if (/^-/.test(l)) {
        cls = 'del'; side = 'LEFT'; no = oldNo++;
      } else {
        side = 'RIGHT'; no = newNo++; oldNo++;
      }
      if (!reviewable || !no) return '<div class="' + cls + '">' + U.esc(l) + '</div>';
      // data-t 存该行原文，写评论时贴进去当引用，省得用户手动敲
      return '<div class="' + cls + '" data-cl="1" data-p="' + U.esc(f.filename) + '" data-l="' + no +
        '" data-s="' + side + '" data-t="' + U.esc(l.substring(0, 300)) + '">' + U.esc(l) + '</div>';
    }).join('');
    var ico = f.status === 'added' ? 'file-diff' : f.status === 'removed' ? 'trash' : f.status === 'renamed' ? 'pencil' : 'file-diff';
    var mine = reviewable ? pendingHere(f.filename).length : 0;
    return '<div class="diff-file" data-f="' + U.esc(f.filename) + '"><div class="diff-file-head">' + window.icon(ico, 14) +
      '<span class="mono" style="flex:1">' + U.esc(f.filename) + '</span>' +
      (mine ? '<span class="chip">' + window.icon('comment', 11) + mine + '</span>' : '') +
      '<span class="diff-stat"><span class="diff-add">+' + f.additions + '</span> <span class="diff-del">-' + f.deletions + '</span></span></div>' +
      (lines ? '<div class="diff-body">' + lines + '</div>' : '<div class="muted tiny" style="padding:10px">二进制文件或内容过大</div>') + '</div>';
  }

  /* =================== 评审：待提交的行内评论 ===================
   * 行内评论不能单独发出去 —— GitHub 要求它们挂在一次「评审」里提交。
   * 所以先在前端攒着，等用户在评审面板里点提交时一起带上。
   * 换了 PR（或退出登录）就清空，免得上个仓库的评论串到这个仓库。
   */
  var pending = { key: '', list: [] };
  function pendingKey(full, n) { return full + '#' + n; }
  function ensurePending(full, n) {
    var k = pendingKey(full, n);
    if (pending.key !== k) { pending.key = k; pending.list = []; }
    return pending.list;
  }
  function pendingHere(path) {
    return pending.list.filter(function (c) { return c.path === path; });
  }
  function pendingCount(full, n) { return ensurePending(full, n).length; }
  window.__pendingReviewCount = function (full, n) { return pendingCount(full, n); };

  /** 点某一行 → 写一条行内评论 */
  function inlineComment(full, n, row) {
    if (!window.Session.isLogin) return UI.toast('请先登录');
    var path = row.getAttribute('data-p'), line = +row.getAttribute('data-l'), side = row.getAttribute('data-s');
    var text = row.getAttribute('data-t') || '';
    var list = ensurePending(full, n);
    var idx = -1;
    list.forEach(function (c, i) { if (c.path === path && c.line === line && c.side === side) idx = i; });
    var old = idx >= 0 ? list[idx].body : '';
    var root = document.getElementById('sheet-root');
    UI.sheet({
      title: '评论 ' + path + ' 第 ' + line + ' 行',
      body: '<div class="mono tiny" style="padding:6px 8px;background:var(--diff-hunk-bg);border-radius:6px;white-space:pre-wrap;word-break:break-all">' +
        U.esc(text) + '</div>' +
        '<div class="field"><textarea class="textarea" id="ic" style="min-height:110px" placeholder="写下你的意见">' + U.esc(old) + '</textarea></div>' +
        '<div class="muted tiny">提交后会随本次评审一起发出（现在还不会发给对方）。</div>' +
        (idx >= 0 ? '<button class="btn danger" id="icdel" style="margin-top:8px">删除这条评论</button>' : ''),
      foot: '<button class="btn" data-no>取消</button><button class="btn primary" data-yes>加入评审</button>',
      onMount: function () {
        var ta = root.querySelector('#ic');
        setTimeout(function () { ta.focus(); }, 150);
        if (root.querySelector('#icdel')) root.querySelector('#icdel').onclick = function () {
          list.splice(idx, 1); UI.closeSheet(); UI.toast('已删除'); window.Router.reload();
        };
        root.querySelector('[data-yes]').onclick = function () {
          var v = ta.value.trim();
          if (!v) return UI.toast('请输入内容');
          var item = { path: path, line: line, side: side, body: v };
          if (idx >= 0) list[idx] = item; else list.push(item);
          UI.closeSheet();
          UI.toast('已加入评审，共 ' + list.length + ' 条');
          window.Router.reload();
        };
        root.querySelector('[data-no]').onclick = function () { UI.closeSheet(); };
      }
    });
  }

  /** 列出已有评审（谁批准了、谁要求改） */
  function reviewSummary(full, n) {
    return window.API.get('/repos/' + full + '/pulls/' + n + '/reviews', { per_page: 100 })
      .then(function (r) {
        var rs = (r.data || []).filter(function (v) { return v.state !== 'COMMENTED' || v.body; });
        if (!rs.length) return '';
        // 同一个人多次评审只留最后一次（GitHub 也是这么展示的）
        var last = Object.create(null);
        rs.forEach(function (v) { if (v.user) last[v.user.login] = v; });
        var arr = [];
        for (var k in last) arr.push(last[k]);
        arr.sort(function (a, b) { return Date.parse(a.submitted_at || 0) - Date.parse(b.submitted_at || 0); });
        return '<div class="card"><div class="section-title">' + window.icon('eye', 14) + ' 评审</div><div class="list">' +
          arr.map(function (v) {
            var st = v.state;
            var ico = st === 'APPROVED' ? 'check-circle-fill' : st === 'CHANGES_REQUESTED' ? 'x-circle-fill' : 'comment';
            var col = st === 'APPROVED' ? 'var(--success)' : st === 'CHANGES_REQUESTED' ? 'var(--danger)' : 'var(--fg-muted)';
            var txt = st === 'APPROVED' ? '批准了这些改动' : st === 'CHANGES_REQUESTED' ? '请求修改' : '发表了评审意见';
            return '<div class="list-row static">' +
              (v.user ? UI.avatar(v.user.login, v.user.avatar_url, 24) : '') +
              '<span class="row-main"><span class="row-title tiny"><span style="color:' + col + '">' + window.icon(ico, 13) + '</span> ' +
              U.esc((v.user && v.user.login) || 'ghost') + ' ' + txt + '</span>' +
              (v.body ? '<span class="row-desc">' + U.esc(String(v.body).substring(0, 120)) + '</span>' : '') + '</span>' +
              '<span class="row-side muted tiny">' + U.timeAgo(v.submitted_at) + '</span></div>';
          }).join('') + '</div></div>';
      }).catch(function () { return ''; });
  }

  /** 评审面板：批准 / 请求修改 / 仅评论（可带行内评论一起提交） */
  function reviewPR(full, n, it) {
    if (!window.Session.isLogin) return UI.toast('请先登录');
    var root = document.getElementById('sheet-root');
    var list = ensurePending(full, n);
    var ev = 'COMMENT';
    var body = '<div class="field"><label>评审结论</label>' +
      UI.seg('rseg', [
        { key: 'COMMENT', label: '仅评论' },
        { key: 'APPROVE', label: '批准' },
        { key: 'REQUEST_CHANGES', label: '请求修改' }
      ], 'COMMENT') +
      '</div><div class="field"><label>总体说明</label><textarea class="textarea" id="rb" style="min-height:110px" placeholder="可选。仅评论时建议填写具体意见"></textarea></div>' +
      (list.length ? '<div class="card"><div class="section-title">' + window.icon('comment', 14) + ' 随本次评审提交的 ' + list.length + ' 条行内评论</div>' +
        '<div class="list">' + list.map(function (c, i) {
          return '<div class="list-row static"><span class="row-main"><span class="row-title mono tiny">' +
            U.esc(c.path) + ':' + c.line + ' (' + (c.side === 'LEFT' ? '旧' : '新') + ')</span>' +
            '<span class="row-desc">' + U.esc(String(c.body).substring(0, 100)) + '</span></span>' +
            '<button class="btn sm" data-rm="' + i + '">移除</button></div>';
        }).join('') + '</div></div>' : '<div class="muted tiny">没有行内评论。可在「文件改动」里点任意一行添加。</div>') +
      '<div class="muted tiny" style="margin-top:8px">' +
      (ev === 'COMMENT' ? '仅评论不会改变该 PR 的评审状态。' : '') + '</div>';
    UI.sheet({
      title: '评审拉取请求', body: body,
      foot: '<button class="btn" data-no>取消</button><button class="btn primary" data-yes>提交评审</button>',
      onMount: function () {
        UI.$$('#rseg button', root).forEach(function (b) {
          b.onclick = function () {
            ev = b.getAttribute('data-v');
            UI.$$('#rseg button', root).forEach(function (x) { x.classList.remove('active'); });
            b.classList.add('active');
          };
        });
        UI.$$('[data-rm]', root).forEach(function (b) {
          b.onclick = function () {
            list.splice(+b.getAttribute('data-rm'), 1);
            UI.closeSheet();
            UI.toast('已移除，剩 ' + list.length + ' 条');
            reviewPR(full, n, it);   // 重开面板刷新列表
          };
        });
        root.querySelector('[data-yes]').onclick = function () {
          var txt = root.querySelector('#rb').value.trim();
          if (ev === 'COMMENT' && !txt && !list.length) return UI.toast('写点什么再提交，或先去文件改动里加行内评论');
          UI.loading(true);
          // commit_id 必填：把意见钉在某个提交上，之后强制推送也不会错位
          var payload = { body: txt || '', event: ev };
          if (it.head && it.head.sha) payload.commit_id = it.head.sha;
          if (list.length) payload.comments = list.map(function (c) {
            return { path: c.path, line: c.line, side: c.side, body: c.body };
          });
          window.API.post('/repos/' + full + '/pulls/' + n + '/reviews', payload).then(function () {
            pending.list = [];
            UI.loading(false); UI.closeSheet();
            UI.toast(ev === 'APPROVE' ? '已批准' : ev === 'REQUEST_CHANGES' ? '已请求修改' : '评审已提交');
            window.Router.reload();
          }).catch(function (e) {
            UI.loading(false);
            // 行内评论最常见的坑：行号不在本次 diff 范围内
            if (list.length && /line|position|diff/i.test(e.message || '')) {
              UI.toast('行内评论提交失败（' + e.message + '），可能该行已变更：请删掉后重新添加');
            } else UI.toast('提交失败：' + e.message);
          });
        };
        root.querySelector('[data-no]').onclick = function () { UI.closeSheet(); };
      }
    });
  }
  window.reviewPR = reviewPR;

  /* =================== 提交详情 =================== */
  P.commit = {
    title: function (ctx) { return '提交 ' + String(ctx.sha).substring(0, 7); },
    render: function (ctx, host) {
      var full = ctx.owner + '/' + ctx.repo;
      host.innerHTML = '<div class="card flat" style="border:0">' + UI.skeleton(4) + '</div>';
      // 渲染纪元：响应比返回键慢时页面已换人，整份丢弃（见 Router.render 注释）
      var epoch = window.Router.viewEpoch;
      return window.API.get('/repos/' + full + '/commits/' + ctx.sha).then(function (r) {
        if (epoch !== window.Router.viewEpoch) return;
        var c = r.data;
        host.innerHTML =
          '<div class="detail-head">' +
          '<div class="detail-title" style="font-size:17px">' + U.esc((c.commit.message || '').split('\n')[0]) + '</div>' +
          '<div class="detail-sub">' +
          (c.author && c.author.avatar_url ? UI.avatar(c.author.login, c.author.avatar_url, 20) : '') +
          '<span><b>' + U.esc((c.author && c.author.login) || c.commit.author.name) + '</b> 提交于 ' + U.timeAgo(c.commit.author.date) + '</span>' +
          '<span class="mono">' + U.esc(c.sha) + '</span></div>' +
          '<div class="row-meta">' +
          '<span>' + window.icon('file-diff', 13) + (c.files ? c.files.length : 0) + ' 个文件</span>' +
          '<span class="diff-add">+' + (c.stats ? c.stats.additions : 0) + '</span>' +
          '<span class="diff-del">-' + (c.stats ? c.stats.deletions : 0) + '</span>' +
          '<span>' + window.icon('git-commit', 13) + (c.parents ? c.parents.length : 0) + ' 个父提交</span>' +
          '</div></div>' +
          ((c.commit.message || '').split('\n').length > 1 ? '<div class="card" style="margin:12px"><div class="md" style="padding:12px">' +
            U.esc((c.commit.message || '').split('\n').slice(1).join('\n').trim()) + '</div></div>' : '') +
          '<div id="cbody"></div>';
        var b = UI.$('#cbody', host);
        if (c.files && c.files.length) {
          b.innerHTML = '<div class="section-title">变更文件</div>' + c.files.map(diffFile).join('');
        } else b.innerHTML = UI.empty('file', '没有文件变更', '');
        window.App.setActions([{
          icon: 'kebab-horizontal', onClick: function () {
            UI.menu('操作', [
              { icon: 'copy', label: '复制 SHA', key: 'sha' },
              { icon: 'link-external', label: '在浏览器打开', key: 'web' },
              { icon: 'git-commit', label: '浏览此版本的文件', key: 'tree' }
            ]).then(function (k) {
              if (k === 'sha') UI.copy(c.sha, '已复制');
              if (k === 'web') NativeBridge.openExternal ? NativeBridge.openExternal(c.html_url) : window.open(c.html_url, '_blank');
              if (k === 'tree') window.Router.go('/' + full + '/tree/' + c.sha);
            });
          }
        }]);
      }).catch(function (e) {
        if (epoch !== window.Router.viewEpoch) return;
        host.innerHTML = UI.errorBox(e);
      });
    }
  };

  /* =================== 发布详情 =================== */
  P.release = {
    title: '发布详情',
    render: function (ctx, host) {
      var full = ctx.owner + '/' + ctx.repo;
      /* tag 可能来自 ?tag=（解析 GitHub 链接那条路走这个），也可能来自路径第 4 段。
         两种都认，前者优先 —— 只有 ?tag= 能承载带斜杠的标签名。 */
      var tag = (ctx.query && ctx.query.tag) ? ctx.query.tag : ctx.tag;
      host.innerHTML = '<div class="card flat" style="border:0">' + UI.skeleton(4) + '</div>';
      // 渲染纪元：响应比返回键慢时页面已换人，整份丢弃（见 Router.render 注释）
      var epoch = window.Router.viewEpoch;
      /* latest 是「最新版」的意思，不是某个名叫 latest 的标签 ——
         /releases/tag/latest 查下去只有 404，得换成另一条端点。 */
      var req = tag === 'latest'
        ? window.API.get('/repos/' + full + '/releases/latest')
        : window.API.get('/repos/' + full + '/releases/tags/' + encodeURIComponent(tag));
      return req.then(function (r) {
        if (epoch !== window.Router.viewEpoch) return;
        var rel = r.data;
        host.innerHTML =
          '<div class="detail-head">' +
          '<div class="detail-title">' + U.esc(rel.name || rel.tag_name) + '</div>' +
          '<div class="detail-sub">' +
          (rel.author ? UI.avatar(rel.author.login, rel.author.avatar_url, 20) + '<span>' + U.esc(rel.author.login) + '</span>' : '') +
          '<span>发布于 ' + U.date(rel.published_at) + '</span>' +
          '<span class="chip mono">' + window.icon('tag', 12) + U.esc(rel.tag_name) + '</span>' +
          (rel.prerelease ? '<span class="chip">预览版</span>' : '') + '</div></div>' +
          '<div class="card"><div class="md" style="padding:14px" id="rbody"></div></div>' +
          (rel.assets && rel.assets.length ? '<div class="section-title">' + window.icon('package', 14) + ' 附件（' + rel.assets.length + '）</div><div class="list">' +
            rel.assets.map(function (a) {
              return '<button class="list-row" data-dl="' + U.esc(a.browser_download_url) + '" data-n="' + U.esc(a.name) + '">' +
                window.icon('package', 16) +
                '<span class="row-main"><span class="row-title mono tiny">' + U.esc(a.name) + '</span>' +
                '<span class="row-desc">' + U.bytes(a.size) + ' · 下载 ' + U.num(a.download_count) + ' 次</span></span></button>';
            }).join('') + '</div>' : '');
        window.MD.mount(UI.$('#rbody', host), rel.body || '', { repo: full });
        if (window.UI) UI.noticeRefresh(UI.$('#rbody', host));
        UI.$$('[data-dl]', host).forEach(function (b) {
          b.onclick = function () {
            var url = b.getAttribute('data-dl'), name = b.getAttribute('data-n');
            // 带认证头：私有仓库的资产、以及 API 返回的下载链接都需要 Authorization
            // Release 附件统一落 githup/release
            var ok = window.Native.download(url, name, window.Native.authHeaders(), 'release');
            if (ok) UI.toast('开始下载 ' + name);
          };
        });
        window.App.setActions([{
          icon: 'download', onClick: function () {
            if (!rel.tarball_url) return;
            // 源码包同样来自 Release → githup/release
            var ok = window.Native.download(rel.tarball_url, rel.tag_name + '.tar.gz',
                  window.Native.authHeaders(), 'release');
            if (!ok) window.open(rel.tarball_url, '_blank');
          }
        }]);
      }).catch(function (e) {
        if (epoch !== window.Router.viewEpoch) return;
        host.innerHTML = UI.errorBox(e);
      });
    }
  };

  /* =================== Actions 运行详情 =================== */
  P.run = {
    title: '运行详情',
    render: function (ctx, host) {
      var full = ctx.owner + '/' + ctx.repo;
      host.innerHTML = '<div class="card flat" style="border:0">' + UI.skeleton(4) + '</div>';
      // 渲染纪元：响应比返回键慢时页面已换人，整份丢弃（见 Router.render 注释）
      var epoch = window.Router.viewEpoch;
      Promise.all([
        window.API.get('/repos/' + full + '/actions/runs/' + ctx.id),
        window.API.get('/repos/' + full + '/actions/runs/' + ctx.id + '/jobs', { per_page: 100 }).catch(function () { return { data: { jobs: [] } }; }),
        // 构建产物（APK 等）——官网在这个区域提供下载
        window.API.get('/repos/' + full + '/actions/runs/' + ctx.id + '/artifacts', { per_page: 100 })
          .catch(function () { return { data: { artifacts: [] } }; })
      ]).then(function (rs) {
        if (epoch !== window.Router.viewEpoch) return;
        var run = rs[0].data, jobs = (rs[1].data && rs[1].data.jobs) || [];
        var artifacts = (rs[2].data && rs[2].data.artifacts) || [];
        var st = run.conclusion || run.status;
        var color = st === 'success' ? 'var(--success)' : st === 'failure' ? 'var(--danger)' : 'var(--attention)';
        host.innerHTML =
          '<div class="detail-head">' +
          '<div class="detail-title" style="font-size:17px">' + U.esc(run.display_title || run.name) + '</div>' +
          '<div class="detail-sub"><span style="color:' + color + '">' + window.icon(st === 'success' ? 'check-circle-fill' : st === 'failure' ? 'x-circle-fill' : 'play', 15) + '</span>' +
          '<span>' + U.esc(st) + '</span><span>' + U.esc(run.name) + '</span>' +
          '<span class="mono">' + U.esc((run.head_sha || '').substring(0, 7)) + '</span></div>' +
          '<div class="row-meta"><span>' + window.icon('git-branch', 13) + U.esc(run.head_branch) + '</span>' +
          '<span>' + window.icon('clock', 13) + U.timeAgo(run.created_at) + '</span>' +
          '<span>#' + run.run_number + '</span></div></div>' +
          (jobs.length ? '<div class="section-title">' + window.icon('workflow', 14) + ' 作业</div><div class="list">' +
            jobs.map(function (j) {
              var s = j.conclusion || j.status;
              var c = s === 'success' ? 'var(--success)' : s === 'failure' ? 'var(--danger)' : 'var(--attention)';
              return '<div class="list-row static" style="flex-direction:column;align-items:stretch">' +
                '<div class="rowflex"><span style="color:' + c + '">' + window.icon(s === 'success' ? 'check-circle-fill' : s === 'failure' ? 'x-circle-fill' : 'play', 15) + '</span>' +
                '<span class="grow" style="font-weight:600">' + U.esc(j.name) + '</span>' +
                '<span class="muted tiny">' + U.esc(dur(j.started_at, j.completed_at)) + '</span></div>' +
                ((j.steps || []).length ? '<div style="margin-top:8px">' + j.steps.map(function (s2) {
                  var sc = s2.conclusion || s2.status;
                  var cc = sc === 'success' ? 'var(--success)' : sc === 'failure' ? 'var(--danger)' : sc === 'skipped' ? 'var(--fg-subtle)' : 'var(--attention)';
                  return '<div class="rowflex" style="padding:5px 0;gap:6px"><span style="color:' + cc + '">' + window.icon(sc === 'success' ? 'check' : sc === 'failure' ? 'x' : 'dot-fill', 13) + '</span>' +
                    '<span class="grow tiny">' + U.esc(s2.name) + '</span><span class="muted tiny">' + U.esc(s2.number ? '#' + s2.number : '') + '</span></div>';
                }).join('') + '</div>' : '') +
                '<div class="rowflex mt8" style="gap:6px">' +
                '<button class="btn sm" data-web="' + U.esc(j.html_url || run.html_url) + '">' + window.icon('link-external', 13) + ' 查看日志</button>' +
                (s === 'failure' || s === 'in_progress' ? '<button class="btn sm" data-rerun="' + j.id + '">重新运行</button>' : '') +
                '</div></div>';
            }).join('') + '</div>' : UI.empty('workflow', '暂无作业', '')) +

          /* ---- 构建产物（artifacts）：APK 就是从这里下载的 ---- */
          artifactsBlock(artifacts);
        bindArtifacts(host);
        UI.$$('[data-web]', host).forEach(function (b) {
          b.onclick = function () { var u = b.getAttribute('data-web'); NativeBridge.openExternal ? NativeBridge.openExternal(u) : window.open(u, '_blank'); };
        });
        UI.$$('[data-rerun]', host).forEach(function (b) {
          b.onclick = function () {
            window.API.post('/repos/' + full + '/actions/jobs/' + b.getAttribute('data-rerun') + '/rerun', {}).then(function () {
              UI.toast('已触发重新运行');
            }).catch(function (e) { UI.toast('操作失败：' + e.message); });
          };
        });
        window.App.setActions([{
          icon: 'kebab-horizontal', onClick: function () {
            UI.menu('操作', [
              { icon: 'sync', label: '重新运行全部作业', key: 'rerun' },
              { icon: 'stop', label: '取消运行', key: 'cancel' },
              { icon: 'link-external', label: '在浏览器打开', key: 'web' },
              '-',
              { icon: 'trash', label: '删除运行记录', key: 'del' }
            ]).then(function (k) {
              if (k === 'rerun') window.API.post('/repos/' + full + '/actions/runs/' + ctx.id + '/rerun', {}).then(function () { UI.toast('已触发'); }).catch(function (e) { UI.toast(e.message); });
              if (k === 'cancel') window.API.post('/repos/' + full + '/actions/runs/' + ctx.id + '/cancel', {}).then(function () { UI.toast('已取消'); window.Router.reload(); }).catch(function (e) { UI.toast(e.message); });
              if (k === 'web') NativeBridge.openExternal ? NativeBridge.openExternal(run.html_url) : window.open(run.html_url, '_blank');
              if (k === 'del') {
                /* 删除逻辑写在 page-repo.js 里（那边行尾的 ⋮ 也要用同一个函数）。
                   正常两个文件是一起加载的，这里防御的是"详情页先于仓库页就绪"
                   这类极端情况——不判断的话点了就是毫无反应，看起来像卡死。 */
                if (typeof window.actionsDeleteRun !== 'function') {
                  UI.toast('删除功能暂不可用，请回到仓库的 Actions 页再试');
                  return;
                }
                window.actionsDeleteRun(full, ctx.id, function () { window.Router.go('/' + full + '/actions'); });
              }
            });
          }
        }]);
      }).catch(function (e) {
        if (epoch !== window.Router.viewEpoch) return;
        host.innerHTML = UI.errorBox(e);
      });
    }
  };

  /* =================== 构建产物（Artifacts） =================== */

  /**
   * 构建产物区块。Actions 跑完后产出的 APK / AAB / ZIP 都列在这里，
   * 与官网 workflow 运行页底部的 Artifacts 区域一致。
   *
   * 注意：archive_download_url 必须带 Authorization 才能下载（否则 403），
   * 所以走 Native.download 带认证头，而不是简单地丢给浏览器。
   */
  function artifactsBlock(artifacts) {
    if (!artifacts.length) return '';
    return '<div class="section-title">' + window.icon('package', 14) + ' 构建产物（' + artifacts.length + '）</div>' +
      '<div class="list">' + artifacts.map(function (a) {
        var expired = !!a.expired;
        var name = (a.name || 'artifact') + '.zip';
        var size = a.size_in_bytes ? U.bytes(a.size_in_bytes) : '';
        // 点整行 = 解压并安装（用户点这里就是要装 APK）；右侧图标可只下 ZIP
        return '<button class="list-row" data-art="' + U.esc(a.archive_download_url || '') + '"' +
          ' data-n="' + U.esc(name) + '" data-mode="install"' + (expired ? ' disabled' : '') + '>' +
          '<span style="color:' + (expired ? 'var(--fg-subtle)' : 'var(--accent)') + '">' +
          window.icon('package', 16) + '</span>' +
          '<span class="row-main"><span class="row-title mono tiny">' + U.esc(name) + '</span>' +
          '<span class="row-desc">' + U.esc(size) + (expired ? ' · 已过期' : '') + '</span></span>' +
          (expired ? '' : '<span class="row-acts">' +
            '<span class="row-act" data-art="' + U.esc(a.archive_download_url || '') + '"' +
            ' data-n="' + U.esc(name) + '" data-mode="install" title="解压并安装 APK">' +
            window.icon('device-desktop', 16) + '</span>' +
            '<span class="row-act" data-art="' + U.esc(a.archive_download_url || '') + '"' +
            ' data-n="' + U.esc(name) + '" data-mode="zip" title="下载 ZIP">' +
            window.icon('download', 16) + '</span></span>') + '</button>';
      }).join('') + '</div>' +
      '<div class="set-note" style="padding:8px 12px">' +
      '点整行或第一个图标：下载后自动解压出 APK 并直接安装；' +
      '点第二个图标：只下载 ZIP 原包。</div>';
  }

  /** 绑定构建产物的下载事件 */
  function bindArtifacts(host) {
    UI.$$('[data-art]', host).forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();
        var url = b.getAttribute('data-art');
        var name = b.getAttribute('data-n') || 'artifact.zip';
        var mode = b.getAttribute('data-mode') || 'zip';
        if (!url) return UI.toast('该产物已过期，无法下载');
        if (!window.Session.isLogin) return UI.toast('下载构建产物需要登录');
        if (mode === 'install') {
          window.Native.installApk(url, name, window.Native.authHeaders());
          UI.toast('开始下载，完成后会自动解压安装');
        } else {
          window.Native.download(url, name, window.Native.authHeaders());
          UI.toast('开始下载 ' + name);
        }
      };
    });
  }

  function dur(a, b) {
    if (!a) return '';
    var s = Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000);
    if (s < 60) return s + 's';
    return Math.floor(s / 60) + 'm' + (s % 60) + 's';
  }
})();
