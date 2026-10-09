#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本轮改动的探针：iOS 风格下选中项**只剩外圈**。

原来指示器是两层：内圆（.tab-ind 本体的 background）+ 外玻璃环（::before）。
用户要「只要外面那圈透明的，不要中间那个圈」，所以内圆置 transparent。

这个探针量四件事：
  1) 内圆确实是透明了（computed backgroundColor = rgba(0,0,0,0)）
  2) 外环还在，半径/外扩量/底色都没变 → 视觉尺寸和原来那圈一模一样
  3) 五个页签的落位仍然 = idx * step（几何一点没动）
  4) 朴素模式（classic）不受牵连：两边都还是透明的
顺带出浅色/深色两张底栏放大图。
"""
import os, re, threading, functools, http.server, socketserver
from playwright.sync_api import sync_playwright

WEB = '/tmp/work/rel/app/src/main/assets/web'
OUT = '/workspace'
PORT = 8797

Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=WEB)
class Q(socketserver.TCPServer):
    allow_reuse_address = True
httpd = Q(('127.0.0.1', PORT), Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
URL = 'http://127.0.0.1:%d/index.html' % PORT

PROBE = """() => {
  var ind = document.getElementById('tab-ind');
  var cs = getComputedStyle(ind), bs = getComputedStyle(ind, '::before');
  return {
    innerBg: cs.backgroundColor,
    innerEdge: cs.boxShadow,
    radius: cs.borderRadius,
    ringBg: bs.backgroundColor,
    ringInset: bs.inset,
    ringEdge: bs.boxShadow.slice(0, 80),
    ringRadius: bs.borderRadius
  };
}"""

with sync_playwright() as p:
    b = p.chromium.launch()
    for theme in ('light', 'dark'):
        ctx = b.new_context(viewport={'width': 393, 'height': 852}, device_scale_factor=3)
        pg = ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(URL); pg.wait_for_timeout(1300)
        pg.evaluate("window.Onboarding.quit()"); pg.wait_for_timeout(300)
        if theme == 'dark':
            pg.evaluate("window.Store.set('theme','dark'); window.App.applyTheme()")
            pg.wait_for_timeout(600)
        pg.evaluate("window.App.setTab('search')"); pg.wait_for_timeout(700)

        r = pg.evaluate(PROBE)
        print('===== %s =====' % ('浅色' if theme == 'light' else '深色'))
        print('  内圆底色      :', r['innerBg'], '（要 rgba(0, 0, 0, 0) 才算去掉）')
        print('  内圆阴影      :', r['innerEdge'], '（要 none）')
        print('  外环底色      :', r['ringBg'])
        print('  外环外扩      :', r['ringInset'], '（保持 -6px，视觉尺寸不变）')
        print('  外环圆角      :', r['ringRadius'])
        print('  页面错误      :', errs[:2] if errs else '无')
        print('  判断：只留外圈 =', r['innerBg'] == 'rgba(0, 0, 0, 0)' and r['innerEdge'] == 'none'
              and r['ringInset'] == '-6px')

        # 落位几何
        step = pg.evaluate("window.App._tabStep()")
        print('  --- 五个页签落位（step=%.2f）---' % step)
        ok = True
        for i, t in enumerate(['home', 'notifications', 'explore', 'search', 'profile']):
            pg.evaluate("window.App.setTab('%s')" % t); pg.wait_for_timeout(300)
            tr = pg.evaluate("document.getElementById('tab-ind').style.transform")
            got = float(re.search(r'translateX\(([-\d.]+)px\)', tr).group(1))
            exp = i * step
            good = abs(got - exp) < 0.6
            ok = ok and good
            print('    %-14s 期望 %7.1f  实际 %7.1f  %s' % (t, exp, got, '✓' if good else '✗'))
        print('  几何未被改动 :', ok)

        # 截图
        bar = pg.evaluate("()=>{var b=document.getElementById('tabbar').getBoundingClientRect();return [b.left,b.top,b.width,b.height]}")
        clip = {'x': max(0, bar[0] - 30), 'y': bar[1] - 26, 'width': bar[2] + 60, 'height': bar[3] + 52}
        pg.screenshot(path=os.path.join(OUT, '底栏-只留外圈-%s.png' % ('浅色' if theme == 'light' else '深色')), clip=clip)
        # 整页一张，看真实观感
        if theme == 'light':
            pg.screenshot(path=os.path.join(OUT, '底栏-只留外圈-整页.png'), full_page=True)
        ctx.close()

    # 朴素模式不该受影响
    print('\n===== 朴素模式（classic）=====')
    ctx = b.new_context(viewport={'width': 393, 'height': 852}, device_scale_factor=3)
    pg = ctx.new_page()
    pg.goto(URL); pg.wait_for_timeout(1300)
    pg.evaluate("window.Onboarding.quit()"); pg.wait_for_timeout(300)
    pg.evaluate("window.App.setNavGlass(false)"); pg.wait_for_timeout(700)
    pg.evaluate("window.App.setTab('search')"); pg.wait_for_timeout(600)
    r = pg.evaluate(PROBE)
    print('  data-nav      :', pg.evaluate("document.documentElement.getAttribute('data-nav')"))
    print('  内圆底色      :', r['innerBg'])
    print('  外环外扩      :', r['ringInset'], '（保持 0px）')
    print('  外环底色      :', r['ringBg'], '（应透明）')
    pg.screenshot(path=os.path.join(OUT, '底栏-只留外圈-朴素模式.png'),
                  clip={'x': 0, 'y': 852 - 120, 'width': 393, 'height': 110})
    ctx.close()
    b.close()
print('\n完成，图已写到', OUT)
