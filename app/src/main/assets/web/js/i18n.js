/* ============================================================
 * i18n.js — 界面多语言
 *
 * 必须在所有业务脚本之前加载（icons.js 之前）。但它**不依赖**它们：
 * 定义时只读 navigator.language，Store 和 Router 都留到运行时再取 ——
 * 否则这一层会因为「api.js 还没定义 Store」直接抛错，整个 App 白屏。
 *
 * ══ 为什么是「查表」而不是「翻译」 ══
 * translate.js 翻的是**页面上从 GitHub 拉来的内容**（README、issue 正文）。
 * 这里管的是**界面自己的文案**（底栏、设置项）。两套互不干扰：
 * 开着整页翻译，界面仍是这套语言。
 *
 * ══ 缺词怎么办 ══
 * 查不到就回落中文，中文也查不到就返回 key 本身。
 * 刻意不做「缺失告警」：词条是渐进式补的，一次性铺完 6000 行风险太大，
 * 与其让一处漏改把界面炸成 undefined，不如退成中文 —— 至少还能用。
 * ============================================================ */
(function () {
  'use strict';

  var ZH = {
    /* ---- 底栏 ---- */
    'tab.home': '首页',
    'tab.notifications': '通知',
    'tab.explore': '探索',
    'tab.search': '搜索',
    'tab.profile': '我的',

    /* ---- 启动屏 ---- */
    'splash.sub': 'GitHub 客户端',

    /* ---- 通用 ---- */
    'common.cancel': '取消',
    'common.confirm': '确定',
    'common.ok': '好的',
    'common.loading': '加载中…',
    'common.retry': '重试',
    'common.copied': '已复制',
    'common.close': '关闭',
    'common.save': '保存',
    'common.delete': '删除',
    'common.more': '更多',
    'common.done': '完成',

    /* ---- 设置页 ---- */
    'settings.title': '设置',
    'settings.appearance': '主题外观',
    'settings.appearance.auto': '跟随系统',
    'settings.appearance.light': '浅色',
    'settings.appearance.dark': '深色',
    'settings.glass': 'iOS风格',
    'settings.glass.on': '开启：底栏是悬浮的磨砂胶囊',
    'settings.glass.off': '关闭：底栏是贴底的朴素样式',
    'settings.codeFont': '代码字号',
    'settings.startTab': '启动页',
    'settings.startTab.home': '首页',
    'settings.startTab.notifications': '通知',
    'settings.startTab.explore': '探索',
    'settings.startTab.profile': '我的',
    'settings.totp': '两步验证器',
    'settings.guide': '新手指导',
    'settings.guide.done': '已完成',
    'settings.guide.todo': '未开始',
    'settings.guideReset': '重置新手引导',
    'settings.guideReset.can': '可重置',
    'settings.guideReset.no': '已是初始状态',
    'settings.quota': 'API 配额',
    'settings.cache': '清除缓存',
    'settings.update': '检查更新',
    'settings.about': '关于 githup',
    'settings.lang': '界面语言',
    'settings.lang.auto': '跟随系统',
    'settings.lang.zh': '简体中文',
    'settings.lang.en': 'English',
    'settings.note.version': '第一位版本号变化时必须安装新版本才能继续使用，后两位可以选择是否更新。',
    'settings.login': '登录 GitHub',
    'settings.loginOwn': '登录自己的令牌',
    'settings.switchAccount': '切换账号',
    'settings.note.embedded': '当前使用内置令牌，打开即可用。点「切换账号」可换用你自己的令牌，或添加更多账号。',
    'settings.note.switch': '点「切换账号」可在已登录过的账号之间切换，也可退出当前账号。',
    'settings.note.login': '登录后可解锁通知、评论、Star 等完整能力。',

    /* ---- 我的 ---- */
    'me.edit': '编辑资料',
    'me.avatar': '更换头像',
    'me.newRepo': '新建仓库',
    'me.repos': '我的仓库',
    'me.stars': '我的 Star',
    'me.issues': '议题',
    'me.prs': '拉取请求',
    'me.orgs': '组织',
    'me.notifications': '通知',
    'me.settings': '设置',
    'me.appSettings': '应用设置',
    'me.gists': '我的 Gist',
    'me.avatarWeb': '需网页端',
    'me.notSet': '未设置',
    'me.overview': '数据概览',

    /* ---- 统计 ---- */
    'stats.repos': '仓库',
    'stats.followers': '粉丝',
    'stats.following': '关注',
    'stats.stars': 'Star',
    'stats.gists': 'Gist',

    /* ---- 语言切换弹层 ---- */
    'lang.title': '界面语言',
    'lang.note': '跟随系统时使用手机当前的语言；也可以在这里固定成某一种。',
    'lang.switched': '已切换为中文',
    'lang.switched.en': 'Language switched to English'
  };

  var EN = {
    /* ---- Tab bar ---- */
    'tab.home': 'Home',
    'tab.notifications': 'Inbox',
    'tab.explore': 'Explore',
    'tab.search': 'Search',
    'tab.profile': 'Me',

    /* ---- Splash ---- */
    'splash.sub': 'GitHub Client',

    /* ---- Common ---- */
    'common.cancel': 'Cancel',
    'common.confirm': 'Confirm',
    'common.ok': 'OK',
    'common.loading': 'Loading…',
    'common.retry': 'Retry',
    'common.copied': 'Copied',
    'common.close': 'Close',
    'common.save': 'Save',
    'common.delete': 'Delete',
    'common.more': 'More',
    'common.done': 'Done',

    /* ---- Settings ---- */
    'settings.title': 'Settings',
    'settings.appearance': 'Appearance',
    'settings.appearance.auto': 'System',
    'settings.appearance.light': 'Light',
    'settings.appearance.dark': 'Dark',
    'settings.glass': 'iOS Style',
    'settings.glass.on': 'On: floating frosted tab bar',
    'settings.glass.off': 'Off: plain docked tab bar',
    'settings.codeFont': 'Code Font Size',
    'settings.startTab': 'Start Page',
    'settings.startTab.home': 'Home',
    'settings.startTab.notifications': 'Inbox',
    'settings.startTab.explore': 'Explore',
    'settings.startTab.profile': 'Me',
    'settings.totp': 'Two-Factor Auth',
    'settings.guide': 'Onboarding',
    'settings.guide.done': 'Completed',
    'settings.guide.todo': 'Not started',
    'settings.guideReset': 'Reset Onboarding',
    'settings.guideReset.can': 'Resettable',
    'settings.guideReset.no': 'Already initial',
    'settings.quota': 'API Quota',
    'settings.cache': 'Clear Cache',
    'settings.update': 'Check for Updates',
    'settings.about': 'About githup',
    'settings.lang': 'Language',
    'settings.lang.auto': 'Follow System',
    'settings.lang.zh': '简体中文',
    'settings.lang.en': 'English',
    'settings.note.version': 'A change in the first version number requires updating; the other two are optional.',
    'settings.login': 'Sign in to GitHub',
    'settings.loginOwn': 'Sign in with your token',
    'settings.switchAccount': 'Switch Account',
    'settings.note.embedded': 'Using the built-in token. Tap "Switch Account" to use your own token, or add more accounts.',
    'settings.note.switch': 'Tap "Switch Account" to switch between signed-in accounts, or sign out of the current one.',
    'settings.note.login': 'Sign in to unlock notifications, comments, starring and more.',

    /* ---- Me ---- */
    'me.edit': 'Edit Profile',
    'me.avatar': 'Change Avatar',
    'me.newRepo': 'New Repository',
    'me.repos': 'My Repositories',
    'me.stars': 'Starred',
    'me.issues': 'Issues',
    'me.prs': 'Pull Requests',
    'me.orgs': 'Organizations',
    'me.notifications': 'Inbox',
    'me.settings': 'Settings',
    'me.appSettings': 'App Settings',
    'me.gists': 'My Gists',
    'me.avatarWeb': 'Web only',
    'me.notSet': 'Not set',
    'me.overview': 'Statistics',

    /* ---- Stats ---- */
    'stats.repos': 'Repositories',
    'stats.followers': 'Followers',
    'stats.following': 'Following',
    'stats.stars': 'Stars',
    'stats.gists': 'Gists',

    /* ---- Language sheet ---- */
    'lang.title': 'Language',
    'lang.note': 'Follow System uses your device language. You can also pin one here.',
    'lang.switched': '已切换为中文',
    'lang.switched.en': 'Language switched to English'
  };

  /* wx = 天道仙文。包在 i18n-tiandao.js 里定义，本文件之前加载；
     万一没加载就退化成空表，界面回落中文，不会白屏。 */
  var PACKS = { zh: ZH, en: EN, wx: (window.I18N_WX || {}) };
  var DEFAULT = 'zh';
  var cur = null;
  var manual = null;            // null = 还没读过存档
  var STORE_KEY = 'gh_lang';

  /* ---- 读存档：留到运行时，定义时 Store 还不存在 ---- */
  function getManual() {
    if (manual === null) {
      try {
        manual = (window.Store && window.Store.get)
          ? (window.Store.get(STORE_KEY, '') || '') : '';
      } catch (e) { manual = ''; }
    }
    return manual;
  }

  /**
   * 跟随系统：把 navigator.language 归到我们有的那一档。
   * 'zh-CN' / 'zh-TW' / 'zh' → zh；'en-US' / 'en-GB' → en；
   * 其余（日、德、法…）目前没有对应语言包，回落中文 ——
   * 宁可给一个能用的界面，也不要把整页变成 undefined。
   */
  function fromSystem() {
    var l = '';
    try { l = String(navigator.language || navigator.userLanguage || ''); } catch (e) {}
    l = l.toLowerCase();
    if (l.indexOf('zh') === 0) return 'zh';
    if (l.indexOf('en') === 0) return 'en';
    return DEFAULT;
  }

  function resolve() {
    var m = getManual();
    if (PACKS[m]) return m;          // 手动固定过
    return fromSystem();             // 跟随系统
  }

  /** 当前生效的语言码（'zh' / 'en'） */
  function lang() {
    if (!cur) cur = resolve();
    return cur;
  }

  /**
   * 查词条。
   * @param key      词条 key，如 'settings.title'
   * @param fallback 两个语言包都没有时返回的兜底（缺省返回 key 本身）
   */
  function t(key, fallback) {
    var pack = PACKS[lang()] || ZH;
    var v = pack[key];
    /* 界面里写死的中文是「以中文为键」批量转换过来的（见 i18n-strings.js）：
     * 业务代码里写 t('删除')，中文模式下这张表根本不参与，
     * 英文模式下才查它。好处是漏一个词也只是那一处退回中文，不会炸。 */
    if ((v === undefined || v === null || v === '') && lang() !== 'zh') {
      try {
        /* 中文模式下这张表不参与；英文走原来的 I18N_STRINGS。
           天道仙文（wx）走 I18N_WX_T：它内部先查整句表，
           未命中再按术语表做子串替换 —— 长句靠这一层才翻得动。
           还是没命中则原样返回 key（即中文），由下面的回落接住。 */
        if (lang() === 'wx' && window.I18N_WX_T) {
          v = window.I18N_WX_T(key);
        } else {
          var flat = window.I18N_STRINGS;
          if (flat && flat[key]) v = flat[key];
        }
      } catch (e) {}
    }
    if (v === undefined || v === null || v === '') v = ZH[key];   // 缺词回落中文
    if (v === undefined || v === null || v === '') return fallback === undefined ? key : fallback;
    return v;
  }

  /** 手动设置存的是什么（'' = 跟随系统） */
  function pref() { return getManual(); }

  /**
   * 把 [data-i18n] 元素填上当前语言的文案。
   * HTML 里那些写死的中文（底栏、启动屏）走这条路 —— 它们没有对应的
   * 生成代码，只能靠属性标记。
   */
  function applyDom(root) {
    var scope = root || document;
    var list = [];
    try { list = scope.querySelectorAll('[data-i18n]'); } catch (e) { return 0; }
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var k = el.getAttribute('data-i18n');
      if (!k) continue;
      var v = t(k);
      if (v) { el.textContent = v; n++; }
    }
    return n;
  }

  /**
   * 切换语言并重画界面。
   * @param code 'zh' / 'en' / ''（'' = 跟随系统）
   */
  function setLang(code) {
    code = PACKS[code] ? code : '';
    manual = code;
    try { if (window.Store && window.Store.set) window.Store.set(STORE_KEY, code); } catch (e) {}
    cur = resolve();
    /* <html lang> 跟着改：屏幕阅读器、系统字体回退都看它 */
    try { document.documentElement.setAttribute('lang', cur === 'en' ? 'en' : 'zh-CN'); } catch (e) {}
    applyDom(document);
    /* 页面里那些由 JS 生成的文案（设置项、我的页列表）不在 [data-i18n] 上，
     * 只能整页重画。Router.reload() 就是重跑当前路由的 render。 */
    try { if (window.Router && window.Router.reload) window.Router.reload(); } catch (e) {}
    /* 天道仙文的兜底层：大量中文直接写在 HTML 模板字符串里，不走 t()。
       切到 wx 时对整个文档的文本节点再仙化一遍，并用 MutationObserver
       接住之后动态插入的内容；切回别的语言就卸掉，避免残留。 */
    try {
      if (cur === 'wx' && window.I18N_WX_DOM) {
        window.I18N_WX_DOM(document.body);
        if (window.I18N_WX_INSTALL) window.I18N_WX_INSTALL();
      } else if (window.I18N_WX_UNINSTALL) {
        window.I18N_WX_UNINSTALL();
      }
    } catch (e) {}
    return cur;
  }

  /** 语言选择弹层：跟随系统 / 简体中文 / English */
  function chooseSheet() {
    var opts = [
      { key: '', label: t('settings.lang.auto'), icon: 'device-desktop' },
      { key: 'zh', label: t('settings.lang.zh'), icon: 'globe' },
      { key: 'en', label: t('settings.lang.en'), icon: 'globe' },
      { key: 'wx', label: '天道仙文', icon: 'star' }
    ];
    var now = pref();
    if (window.UI && typeof window.UI.choose === 'function') {
      /* 第三个参数是「当前选中项」——少了它，弹层里没有勾，
         用户看不出自己现在用的是哪一种。 */
      window.UI.choose(t('lang.title'), opts, now, function (k) {
        if (k === now) return;
        var got = setLang(k);
        if (window.UI && window.UI.toast) {
          window.UI.toast(got === 'en' ? t('lang.switched.en') : t('lang.switched'));
        }
      });
      return;
    }
    /* UI.choose 不可用时退化成直接切：有总比点了没反应强 */
    setLang(now === 'en' ? 'zh' : 'en');
  }

  window.I18n = {
    t: t,
    lang: lang,
    pref: pref,
    setLang: setLang,
    applyDom: applyDom,
    chooseSheet: chooseSheet,
    packs: PACKS,
    codes: ['zh', 'en', 'wx']
  };
  /* 快捷方式：业务代码里写 t('key') 比 I18n.t 短，也更像别的项目的习惯 */
  window.t = t;
})();
