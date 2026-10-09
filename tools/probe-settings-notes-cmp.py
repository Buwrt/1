#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本轮改动的「改前 / 改后」对照：

把上一版（c8a26ed，还有那两段灰字说明）的 web 资源单独拷一份出来渲染，
和当前版本并排截图 + 量说明文字的高度差。
两个入口看到的都是真实页面，没有手绘也没有后期涂抹。
"""
import os, shutil, subprocess, threading, functools, http.server, socketserver, tempfile
from playwright.sync_api import sync_playwright

REPO = '/tmp/work/rel'
WEB = os.path.join(REPO, 'app/src/main/assets/web')
OLD_COMMIT = 'c8a26ed'
PORT_NEW, PORT_OLD = 8771, 8772
OUT = '/workspace/设置页-删掉冗余说明-前后对比.png'


def start(port, root):
    H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=root)
    class Q(socketserver.TCPServer):
        allow_reuse_address = True
    httpd = Q(('127.0.0.1', port), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()


def measure(root):
    """返回 (总高, 说明文字总高, 说明条数, 说明文案)"""
    pass


# 拷一份旧资源
tmp = tempfile.mkdtemp(prefix='webold-')
old = os.path.join(tmp, 'web')
shutil.copytree(WEB, old)
old_js = os.path.join(old, 'js/page-user.js')
with open(old_js, 'wb') as f:
    f.write(subprocess.check_output(['git', '-C', REPO, 'show', '%s:app/src/main/assets/web/js/page-user.js' % OLD_COMMIT]))

start(PORT_NEW, WEB)
start(PORT_OLD, old)

READ = """() => {
  var notes = [], h = 0;
  document.querySelectorAll('#view .set-note').forEach(function (n) {
    notes.push(n.textContent.trim().replace(/\\s+/g, ' '));
    h += Math.round(n.getBoundingClientRect().height);
  });
  return { n: notes.length, h: h, notes: notes,
           rows: document.querySelectorAll('#view .set-row').length,
           page: Math.round(document.querySelector('#view').scrollHeight) };
}"""

with sync_playwright() as p:
    b = p.chromium.launch()
    shots = {}
    info = {}
    for tag, port in (('改前', PORT_OLD), ('改后', PORT_NEW)):
        ctx = b.new_context(viewport={'width': 393, 'height': 852}, device_scale_factor=2.75)
        pg = ctx.new_page()
        pg.goto('http://127.0.0.1:%d/index.html' % port)
        pg.wait_for_timeout(1300)
        pg.evaluate("window.Onboarding && window.Onboarding.quit && window.Onboarding.quit()")
        pg.wait_for_timeout(300)
        pg.evaluate("location.hash = '#/settings'")
        pg.wait_for_timeout(900)
        info[tag] = pg.evaluate(READ)
        f = os.path.join(tmp, tag + '.png')
        pg.screenshot(path=f, full_page=True)
        shots[tag] = f
        ctx.close()
    b.close()

print('=== 量出来的 ===')
for tag in ('改前', '改后'):
    print('  %s：设置行数 %d，灰字说明 %d 条，说明区高 %dpx，整页高 %dpx' %
          (tag, info[tag]['rows'], info[tag]['n'], info[tag]['h'], info[tag]['page']))
saved = info['改前']['h'] - info['改后']['h']
print('  说明区少了 %dpx（灰字高度），整页少了 %dpx' % (saved, info['改前']['page'] - info['改后']['page']))
print('\n改前保留的说明：')
for n in info['改前']['notes']:
    print('   -', n[:60] + ('…' if len(n) > 60 else ''))
print('改后保留的说明：')
for n in info['改后']['notes']:
    print('   -', n[:60] + ('…' if len(n) > 60 else ''))

# 拼图
from PIL import Image, ImageDraw, ImageFont
ims = [Image.open(shots[t]).convert('RGB') for t in ('改前', '改后')]
W = max(i.width for i in ims)
H = max(i.height for i in ims)
pad = 60
canvas = Image.new('RGB', (W * 2 + pad * 3, H + pad * 2), (246, 248, 250))
d = ImageDraw.Draw(canvas)
try:
    ft = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 22)
    fs = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 16)
except Exception:
    ft = fs = None
for idx, (tag, im) in enumerate(zip(('改前', '改后'), ims)):
    x = pad + idx * (W + pad)
    canvas.paste(im, (x, pad))
    d.text((x + 4, 18), '%s：%d 条灰字说明 / %dpx 高' % (tag, info[tag]['n'], info[tag]['h']),
           fill=(31, 35, 40), font=ft)
d.text((pad + 4, H + pad + 8),
       '差别：两段把上面两行原话复述一遍的灰字说明删掉了，设置项仍是 %d 行；'
       '有信息量的两条（版本号更新规则、登录后解锁）保留' % info['改后']['rows'],
       fill=(89, 99, 110), font=fs)
canvas.save(OUT)
print('\n对比图 →', OUT, canvas.size)
shutil.rmtree(tmp, ignore_errors=True)
