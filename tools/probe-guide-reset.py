#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本轮改动的探针（真实应用，不是骨架）：
  1) 设置里那枚开关改名叫「iOS风格」，且还能正常切换
  2) 设置里多了「重置新手引导」这一行
  3) 点重置 → 抹掉已看过记录、行值刷新、下次打开自动重播
  4) 引导第 9 步的文案跟着改成「iOS风格」，高亮目标仍是 [data-s="glass"]
"""
import os, threading, functools, http.server, socketserver
from playwright.sync_api import sync_playwright

WEB = '/tmp/work/rel/app/src/main/assets/web'
PORT = 8757

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=WEB)
class Q(socketserver.TCPServer):
    allow_reuse_address = True
httpd = Q(('127.0.0.1', PORT), Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

URL = 'http://127.0.0.1:%d/index.html' % PORT

READ_ROWS = """() => {
  var out = [];
  document.querySelectorAll('#view [data-s]').forEach(function (b) {
    out.push({ s: b.getAttribute('data-s'),
               k: (b.querySelector('.k') ? b.querySelector('.k').textContent : '').trim(),
               v: (b.querySelector('.v') ? b.querySelector('.v').textContent : '').trim(),
               on: b.getAttribute('data-on') });
  });
  return out;
}"""

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 393, 'height': 852}, device_scale_factor=2.75)
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(URL)
    pg.wait_for_timeout(1200)

    print('=== 1. 首屏与自动引导 ===')
    print('  无页面错误        :', not errs, errs[:2])
    print('  Onboarding 存在   :', pg.evaluate("!!window.Onboarding"))
    print('  自动启动 isActive :', pg.evaluate("window.Onboarding.isActive && window.Onboarding.isActive()"))

    # 跳过引导，进设置
    pg.evaluate("window.Onboarding.quit()")
    pg.wait_for_timeout(300)
    pg.evaluate("location.hash = '#/settings'")
    pg.wait_for_timeout(900)

    print('\n=== 2. 设置页内容 ===')
    rows = pg.evaluate(READ_ROWS)
    for r in rows:
        print('   [%-10s] %s %s' % (r['s'], r['k'], ('→ ' + r['v']) if r['v'] else ('(开关 on=' + str(r['on']) + ')')))
    glass = [r for r in rows if r['s'] == 'glass']
    reset = [r for r in rows if r['s'] == 'guideReset']
    guide = [r for r in rows if r['s'] == 'guide']
    # .k 里还套了一行副标题（开启：底栏是悬浮的磨砂胶囊），所以判前缀
    print('  开关已改名 iOS风格 :', bool(glass) and glass[0]['k'].startswith('iOS风格'))
    print('  不再叫液态玻璃底栏 :', not any('液态玻璃' in r['k'] for r in rows))
    print('  有「重置新手引导」 :', bool(reset) and reset[0]['k'] == '重置新手引导')
    print('  有「新手指导」     :', bool(guide))
    print('  重置行当前值       :', reset[0]['v'] if reset else '(缺失)')
    print('  已看过 onboarded   :', pg.evaluate("window.Store.get('onboarded')"))

    print('\n=== 3. 点「重置新手引导」 ===')
    pg.click('[data-s="guideReset"]')
    pg.wait_for_timeout(600)
    print('  onboarded 已抹掉   :', pg.evaluate("window.Store.get('onboarded')"))
    print('  isDone             :', pg.evaluate("window.Onboarding.isDone()"))
    print('  toast              :', pg.evaluate("(document.querySelector('#toast-root')||{}).textContent || ''"))
    rows2 = pg.evaluate(READ_ROWS)
    r2 = [r for r in rows2 if r['s'] == 'guideReset']
    print('  刷新后重置行的值   :', r2[0]['v'] if r2 else '(缺失)')
    g2 = [r for r in rows2 if r['s'] == 'guide']
    print('  刷新后新手指导的值 :', g2[0]['v'] if g2 else '(缺失)')
    print('  引导没被立刻拉起   :', not pg.evaluate("window.Onboarding.isActive()"))

    print('\n=== 4. 重置后重新打开 → 自动重播 ===')
    pg.goto(URL)
    pg.wait_for_timeout(1500)
    print('  自动弹出 isActive  :', pg.evaluate("window.Onboarding.isActive && window.Onboarding.isActive()"))
    print('  首页标题           :', pg.evaluate("document.getElementById('ob-title').textContent"))

    # 走到第 9 步（设置页那一步）
    print('\n=== 5. 引导第 9 步：文案与高亮目标 ===')
    for _ in range(8):
        pg.click('#ob-next')
        pg.wait_for_timeout(320)
    print('  编号               :', pg.evaluate("document.getElementById('ob-step-num').textContent"))
    print('  标题               :', pg.evaluate("document.getElementById('ob-title').textContent"))
    body = pg.evaluate("document.getElementById('ob-body').textContent")
    print('  文案含 iOS风格     :', 'iOS风格' in body)
    print('  文案不含液态玻璃   :', '液态玻璃' not in body)
    print('  hash               :', pg.evaluate("location.hash"))
    box = pg.evaluate("""() => {
      var h = document.getElementById('ob-hole').getBoundingClientRect();
      var t = document.querySelector('#view [data-s="glass"]');
      var tb = t ? t.getBoundingClientRect() : null;
      return { hole: [Math.round(h.left), Math.round(h.top), Math.round(h.width), Math.round(h.height)],
               row: tb ? [Math.round(tb.left), Math.round(tb.top), Math.round(tb.width), Math.round(tb.height)] : null };
    }""")
    print('  洞                 :', box['hole'])
    print('  玻璃那一行         :', box['row'])
    if box['row']:
        d = [box['hole'][0] - box['row'][0], box['hole'][1] - box['row'][1]]
        print('  洞比行大出的 pad   :', d, '（应为负的一圈留白）')
    # 第 10 步收尾文案
    pg.click('#ob-next')
    pg.wait_for_timeout(350)
    print('  第10步文案含重置    :', '重置新手引导' in pg.evaluate("document.getElementById('ob-body').textContent"))

    print('\n=== 6. iOS风格 开关仍可切换 ===')
    pg.click('#ob-next')
    pg.wait_for_timeout(400)
    pg.evaluate("location.hash = '#/settings'")
    pg.wait_for_timeout(900)
    before = pg.evaluate("window.App.navGlass()")
    pg.click('[data-s="glass"]')
    pg.wait_for_timeout(600)
    after = pg.evaluate("window.App.navGlass()")
    print('  切换前 → 后        :', before, '→', after, '（应翻转）')
    print('  toast              :', pg.evaluate("(document.querySelector('#toast-root')||{}).textContent || ''"))
    print('  data-nav           :', pg.evaluate("document.documentElement.getAttribute('data-nav')"))
    # 切回去
    pg.evaluate("location.hash = '#/settings'")
    pg.wait_for_timeout(700)
    pg.click('[data-s="glass"]')
    pg.wait_for_timeout(500)
    print('  切回后 navGlass    :', pg.evaluate("window.App.navGlass()"))

    print('\n=== 7. 未看过时点重置（不该报错） ===')
    pg.evaluate("window.Store.set('onboarded', 0)")
    pg.evaluate("location.hash = '#/settings'")
    pg.wait_for_timeout(800)
    pg.click('[data-s="guideReset"]')
    pg.wait_for_timeout(500)
    print('  toast              :', pg.evaluate("(document.querySelector('#toast-root')||{}).textContent || ''"))
    print('  页面错误           :', errs[:3])

    ctx.close()
    b.close()
