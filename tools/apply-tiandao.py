#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
apply-tiandao.py — 把「天道仙文」语言包接进 githup

用法（在仓库根目录跑）：
    python3 apply-tiandao.py /path/to/i18n-tiandao.js /path/to/githup-repo

做四件事：
  1. 复制 i18n-tiandao.js 到 app/src/main/assets/web/js/
  2. index.html：在 i18n.js 之前插入一行 <script>
  3. i18n.js：注册语言包 / 扁平表按语言取 / 选择弹层加项 / codes 加 'wx'
  4. 提示重跑 tools/gen-guard.py（防护链第 3 环，不跑会启动被拦）

每一步都是"精确字符串替换"，找不到原文就报错退出，绝不半途改坏文件。
改之前自动备份为 *.bak-tiandao。
"""
import sys, os, shutil, io

SRC_NAME = 'i18n-tiandao.js'
JS_DIR = os.path.join('app', 'src', 'main', 'assets', 'web', 'js')


def read(p):
    with io.open(p, 'r', encoding='utf-8') as f:
        return f.read()


def write(p, s):
    bak = p + '.bak-tiandao'
    if not os.path.exists(bak):
        shutil.copy2(p, bak)
    with io.open(p, 'w', encoding='utf-8') as f:
        f.write(s)


def sub(text, old, new, label):
    """精确替换一次；找不到就抛错，让脚本整条失败在原地。"""
    if old not in text:
        raise SystemExit('[失败] %s：没找到下面这段原文，文件可能已改过，请手工对照：\n%s'
                         % (label, old[:200]))
    if text.count(old) != 1:
        raise SystemExit('[失败] %s：原文出现 %d 次，不敢自动改，请手工处理。'
                         % (label, text.count(old)))
    return text.replace(old, new)


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    src, repo = sys.argv[1], sys.argv[2]
    if not os.path.isfile(src):
        raise SystemExit('[失败] 找不到语言包：%s' % src)
    if not os.path.isdir(repo):
        raise SystemExit('[失败] 仓库目录不存在：%s' % repo)

    # ---- 1. 复制语言包 ----
    dst_dir = os.path.join(repo, JS_DIR)
    if not os.path.isdir(dst_dir):
        raise SystemExit('[失败] 前端目录不存在：%s（是不是仓库路径给错了）' % dst_dir)
    dst = os.path.join(dst_dir, SRC_NAME)
    shutil.copy2(src, dst)
    print('[1/4] 已复制语言包 -> %s' % os.path.relpath(dst, repo))

    # ---- 2. index.html 插入 script ----
    idx = os.path.join(repo, 'app', 'src', 'main', 'assets', 'web', 'index.html')
    h = read(idx)
    tag = '<script src="js/%s"></script>' % SRC_NAME
    if tag in h:
        print('[2/4] index.html 已加载过，跳过')
    else:
        anchor = '<script src="js/i18n.js"></script>'
        h = sub(h, anchor, tag + '\n' + anchor, 'index.html 插入 script')
        write(idx, h)
        print('[2/4] index.html 已在 i18n.js 之前插入加载行')

    # ---- 3. i18n.js 四处改动 ----
    p = os.path.join(dst_dir, 'i18n.js')
    s = read(p)

    s = sub(s,
            "  var PACKS = { zh: ZH, en: EN };",
            "  /* wx = 天道仙文。包在 i18n-tiandao.js 里定义，本文件之前加载；\n"
            "     万一没加载就退化成空表，界面回落中文，不会白屏。 */\n"
            "  var PACKS = { zh: ZH, en: EN, wx: (window.I18N_WX || {}) };",
            'i18n.js 注册语言包')

    s = sub(s,
            "    if ((v === undefined || v === null || v === '') && lang() === 'en') {\n"
            "      try {\n"
            "        var flat = window.I18N_STRINGS;\n"
            "        if (flat && flat[key]) v = flat[key];\n"
            "      } catch (e) {}\n"
            "    }",
            "    if ((v === undefined || v === null || v === '') && lang() !== 'zh') {\n"
            "      try {\n"
            "        /* 中文模式下这张表不参与；英文走原来的 I18N_STRINGS。\n"
            "           天道仙文（wx）走 I18N_WX_T：它内部先查整句表，\n"
            "           未命中再按术语表做子串替换 —— 长句靠这一层才翻得动。\n"
            "           还是没命中则原样返回 key（即中文），由下面的回落接住。 */\n"
            "        if (lang() === 'wx' && window.I18N_WX_T) {\n"
            "          v = window.I18N_WX_T(key);\n"
            "        } else {\n"
            "          var flat = window.I18N_STRINGS;\n"
            "          if (flat && flat[key]) v = flat[key];\n"
            "        }\n"
            "      } catch (e) {}\n"
            "    }",
            'i18n.js 按语言取词（wx 走三层查词）')

    s = sub(s,
            "      { key: 'en', label: t('settings.lang.en'), icon: 'globe' }\n"
            "    ];",
            "      { key: 'en', label: t('settings.lang.en'), icon: 'globe' },\n"
            "      { key: 'wx', label: '天道仙文', icon: 'star' }\n"
            "    ];",
            'i18n.js 选择弹层加项')

    s = sub(s,
            "    codes: ['zh', 'en']",
            "    codes: ['zh', 'en', 'wx']",
            'i18n.js 导出语言码')

    # ⑤ setLang：wx 模式下装 DOM 层，切走时卸掉
    s = sub(s,
            "    applyDom(document);\n"
            "    /* 页面里那些由 JS 生成的文案（设置项、我的页列表）不在 [data-i18n] 上，\n"
            "     * 只能整页重画。Router.reload() 就是重跑当前路由的 render。 */\n"
            "    try { if (window.Router && window.Router.reload) window.Router.reload(); } catch (e) {}",
            "    applyDom(document);\n"
            "    /* 页面里那些由 JS 生成的文案（设置项、我的页列表）不在 [data-i18n] 上，\n"
            "     * 只能整页重画。Router.reload() 就是重跑当前路由的 render。 */\n"
            "    try { if (window.Router && window.Router.reload) window.Router.reload(); } catch (e) {}\n"
            "    /* 天道仙文的兜底层：大量中文直接写在 HTML 模板字符串里，不走 t()。\n"
            "       切到 wx 时对整个文档的文本节点再仙化一遍，并用 MutationObserver\n"
            "       接住之后动态插入的内容；切回别的语言就卸掉，避免残留。 */\n"
            "    try {\n"
            "      if (cur === 'wx' && window.I18N_WX_DOM) {\n"
            "        window.I18N_WX_DOM(document.body);\n"
            "        if (window.I18N_WX_INSTALL) window.I18N_WX_INSTALL();\n"
            "      } else if (window.I18N_WX_UNINSTALL) {\n"
            "        window.I18N_WX_UNINSTALL();\n"
            "      }\n"
            "    } catch (e) {}",
            'i18n.js setLang 装/卸 DOM 层')

    # ⑥ 启动时补装仙文兜底层 —— 这是「还是有些没变」的根因
    #
    # setLang() 只在用户点语言选择时才跑，而 DOM 兜底层（I18N_WX_INSTALL）
    # 是在 setLang() 内部装的。于是：
    #   选完天道仙文 —— 当次有效；
    #   App 一重启 —— lang() 解析出来仍是 'wx'，却没人调过 setLang，
    #                 兜底层根本没装，所有不走 t() 的硬编码中文
    #                 （page-*.js 模板字符串里那一大批）全变回中文。
    # 这里在启动时自检一次：当前是 wx 就补装。装多次无害（wxInstall 判空）。
    s = sub(s,
            "  window.t = t;",
            "  window.t = t;\n"
            "\n"
            "  /* 启动时补装天道仙文兜底层。\n"
            "   *\n"
            "   * setLang() 只在用户点语言选择时才跑，而它内部才会装\n"
            "   * I18N_WX_DOM / I18N_WX_INSTALL。于是选完仙文当次有效，\n"
            "   * App 一重启 —— lang() 仍是 'wx'，却没人调过 setLang，\n"
            "   * 兜底层根本没装，不走 t() 的硬编码中文（page-*.js 模板\n"
            "   * 字符串里那一大批）就全变回中文了。\n"
            "   *\n"
            "   * 这里在启动时自检一次：当前是 wx 就补装。装多次无害\n"
            "   * （wxInstall 内部有 wxObs 判空）。\n"
            "   */\n"
            "  (function bootWx() {\n"
            "    function arm() {\n"
            "      try {\n"
            "        if (lang() !== 'wx' || !window.I18N_WX_DOM) return;\n"
            "        var root = document.body || document.documentElement;\n"
            "        if (root) window.I18N_WX_DOM(root);\n"
            "        if (window.I18N_WX_INSTALL) window.I18N_WX_INSTALL();\n"
            "      } catch (e) {}\n"
            "    }\n"
            "    /* 脚本在 body 末尾，但路由首屏渲染可能更晚：\n"
            "       先等 DOMContentLoaded，再补两拍兜住异步渲染。 */\n"
            "    if (document.readyState === 'loading') {\n"
            "      try { document.addEventListener('DOMContentLoaded', arm); } catch (e) {}\n"
            "    } else {\n"
            "      arm();\n"
            "    }\n"
            "    try { setTimeout(arm, 0); setTimeout(arm, 400); } catch (e) {}\n"
            "  })();",
            'i18n.js 启动时补装仙文兜底层')

    write(p, s)
    print('[3/4] i18n.js 五处改动完成（原文件已备份为 i18n.js.bak-tiandao）')

    # ---- 4. 提醒后处理 ----
    print('[4/4] 待办：')
    print('      a) 重跑 python3 tools/gen-guard.py  —— 新增 js 后防护链第 3 环哈希会变，不跑会启动被拦')
    print('      b) bash build-apk.sh 1.2.19        —— 版本号按 version.lock 的规则改')
    print('      c) 真机上切到「设置 → 界面语言 → 天道仙文」验收')


if __name__ == '__main__':
    main()
