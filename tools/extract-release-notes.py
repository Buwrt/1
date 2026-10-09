#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从累积式的 RELEASE_NOTES.md 里抽出「指定版本的那一节」。

为什么需要它：
  RELEASE_NOTES.md 按设计是**累积**的 —— 每个版本一节，新的加在最上面，
  历史留着备查。但 Release 页面的正文必须是「这一个版本」的内容，
  把整个文件贴上去，v1.1.4 的 Release 里会跟着 1.1.3、1.1.2 一整串旧记录。

所以发布时把「抽出的那一节」作为 Release 正文，文件本身保持完整。

用法：
  python3 tools/extract-release-notes.py RELEASE_NOTES.md 1.1.4 > /tmp/body.md
  不传版本号则取文件里的第一节（最上面那节）—— 发布时用这个最省心。
"""
import re
import sys


def split_sections(text):
    """
    按 `## githup vX.Y.Z...` 一级小节切分。

    返回 [(版本号, 整段文本), ...]，顺序与文件一致（新的在前）。
    标题里没写版本号的行不算小节开头 —— 免得把正文里的 `##` 误当成新一节。
    """
    lines = text.split('\n')
    cuts = []
    for i, ln in enumerate(lines):
        # 版本小节标题在 RELEASE_NOTES.md 里用的是一级标题 `# githup vX.Y.Z`；
        # 这里也兼容 `##`，免得哪天改了层级就抽不出来（v1.2.14 踩过：只认 ##，
        # 结果整节抽不到，Release 正文得手工切）。
        m = re.match(r'^#{1,2}\s+githup\s+v?([0-9][0-9.]*[0-9])', ln.strip())
        if m:
            cuts.append((i, m.group(1)))
    out = []
    for idx, (start, ver) in enumerate(cuts):
        end = cuts[idx + 1][0] if idx + 1 < len(cuts) else len(lines)
        out.append((ver, '\n'.join(lines[start:end]).strip() + '\n'))
    return out


def pick(text, want=None):
    """want 为 None 时取第一节（最新版本）"""
    secs = split_sections(text)
    if not secs:
        return None
    if want is None:
        return secs[0][1]
    want = want.lstrip('vV')
    for ver, body in secs:
        if ver == want:
            return body
    return None


def main():
    if len(sys.argv) < 2:
        sys.exit('用法: extract-release-notes.py <RELEASE_NOTES.md> [版本号]')
    path = sys.argv[1]
    want = sys.argv[2] if len(sys.argv) > 2 else None
    text = open(path, encoding='utf-8').read()
    body = pick(text, want)
    if body is None:
        sys.exit('在 %s 里找不到版本 %s 的小节' % (path, want or '(第一节)'))
    sys.stdout.write(body)


if __name__ == '__main__':
    main()
