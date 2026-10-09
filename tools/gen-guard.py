#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
防护链常量生成器（打包前跑，在 gradle 之前）

它做两件事：

1. 生成 GuardKeys.java
   —— 把「防护链每一环的期望值」用官方私钥签名后内置。
      运行时用官方公钥验签：谁改了任何一个期望值，验签就失败。
      别人没有你的私钥，就签不出一份能通过验签的假常量。

2. 生成 assets/guard/assets.sha
   —— 前端 JS / HTML 的哈希清单，防止有人只替换前端文件
      （比如把更新检测改掉、往请求里塞点东西）。

用法：python3 tools/gen-guard.py <项目根目录>
"""
import base64
import hashlib
import hmac
import os
import re
import subprocess
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else '.'
KS = os.path.join(ROOT, 'keystore', 'githup-release.jks')
PASS_FILE = os.path.join(ROOT, 'keystore', 'pass.txt')
ALIAS = 'githup'

PKG = 'com.hubmobile.app'
APP_CLASS = 'com.hubmobile.app.App'
LABEL = 'githup'

# 链的种子：参与每一环 token 的计算（与 Java 端保持一致）
SEED = 'githup-guard-chain-v1'


def read_version(root):
    """
    从 app/build.gradle 里读 versionName / versionCode。

    这两个值【必须】与真正打进包里的值一致 —— 第 4 环校验的就是它们，
    一旦对不上，官方包自己会被判定成「版本号被改过」而拒绝启动。

    以前这两个值是手写死在这个文件里的，发版时忘了同步就会做出一个
    启动即自杀的包（1.1.4 就是这么炸的）。现在改成自动读取，
    只要 build.gradle 是对的，这里就一定是对的。
    """
    gradle = os.path.join(root, 'app', 'build.gradle')
    if not os.path.exists(gradle):
        sys.exit('找不到 %s，无法确定版本号' % gradle)
    src = open(gradle, encoding='utf-8').read()

    m = re.search(r"versionCode\s+(\d+)", src)
    if not m:
        sys.exit('app/build.gradle 里读不到 versionCode')
    code = int(m.group(1))

    m = re.search(r"versionName\s+['\"]([^'\"]+)['\"]", src)
    if not m:
        sys.exit('app/build.gradle 里读不到 versionName')
    name = m.group(1)

    # 只做「下限」检查：x.y.z -> x*1000000 + y*1000 + z
    #
    # 内部号【允许大于】这个换算值。版本号往回调时（比如 1.1.4 作废、改回 1.1.3），
    # 对外显示的 versionName 变小了，但 versionCode 只能继续变大 ——
    # 否则手机会以「降级」为由拒绝覆盖安装。Android 允许这两者不联动，
    # build-apk.sh 的第三个参数就是干这个用的。
    # 反过来（内部号小于换算值）是真错误：对外升版却装不上。
    parts = name.split('.')
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        floor = int(parts[0]) * 1000000 + int(parts[1]) * 1000 + int(parts[2])
        if code < floor:
            sys.exit('版本号自相矛盾：versionName=%s 要求 versionCode >= %d，'
                     '但 build.gradle 写的是 %d（这样手机会拒绝安装）'
                     % (name, floor, code))
    return name, code


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, check=True, **kw)


def main():
    if not os.path.exists(KS):
        sys.exit('找不到签名密钥：%s（密钥丢了就发不了更新，请先恢复 keystore/）' % KS)
    pw = open(PASS_FILE).read().strip()

    VERSION_NAME, VERSION_CODE = read_version(ROOT)

    tmp = '/tmp/guard-keys'
    os.makedirs(tmp, exist_ok=True)
    sh("openssl pkcs12 -in '%s' -nocerts -nodes -passin pass:'%s' -out %s/key.pem 2>/dev/null" % (KS, pw, tmp))
    sh("openssl pkcs12 -in '%s' -clcerts -nokeys -passin pass:'%s' -out %s/cert.pem 2>/dev/null" % (KS, pw, tmp))
    sh("openssl x509 -in %s/cert.pem -pubkey -noout > %s/pub.pem" % (tmp, tmp))

    # 官方证书指纹（小写十六进制，无冒号）
    fp = sh("openssl x509 -in %s/cert.pem -noout -fingerprint -sha256" % tmp).stdout.decode()
    fp = fp.split('=')[1].strip().replace(':', '').lower()

    # 官方公钥（SubjectPublicKeyInfo DER 的 base64，Java 用 X509EncodedKeySpec 还原）
    pub_der = sh("openssl rsa -pubin -in %s/pub.pem -outform DER 2>/dev/null" % tmp).stdout
    pub_b64 = base64.b64encode(pub_der).decode()

    # ---- 计算防护链每一环的期望 token ----
    # T0 是种子，T(n+1) = HMAC-SHA256(key=Tn, msg=本环标识 + 本环校验对象)
    # 官方包运行时每一步算出来的 Tn 是确定值，先在这里算好写进代码。
    def tok(prev, tag, payload):
        return hmac.new(prev.encode(), (tag + '|' + payload).encode(), hashlib.sha256).hexdigest()

    t0 = hashlib.sha256(SEED.encode()).hexdigest()
    t1 = tok(t0, 'ring1-signature', fp)
    t2 = tok(t1, 'ring2-blob', pub_b64[:32])
    t3 = tok(t2, 'ring3-assets', 'assets')
    t4 = tok(t3, 'ring4-identity', PKG + '|' + LABEL + '|' + VERSION_NAME + '|' + str(VERSION_CODE))
    t5 = tok(t4, 'ring5-env', 'env')
    chain = [t1, t2, t3, t4, t5]

    # ---- 用官方私钥给「整条链的期望值」签名 ----
    payload = '|'.join(chain)
    open('%s/payload.txt' % tmp, 'w').write(payload)
    sig = sh("openssl dgst -sha256 -sign %s/key.pem %s/payload.txt" % (tmp, tmp)).stdout
    sig_b64 = base64.b64encode(sig).decode()

    java = '''package com.hubmobile.app;

/* 自动生成，不要手改。由 tools/gen-guard.py 用官方私钥生成。 */
final class GuardKeys {
    private GuardKeys() { }

    /** 官方证书指纹（小写十六进制）。改它 → ring2 验签不过。 */
    static final String CERT_SHA256 = "%s";

    /** 官方公钥（SubjectPublicKeyInfo DER 的 base64）。用来验下面这份签名。 */
    static final String PUBKEY_B64 = "%s";

    /** 官方私钥对「整条链期望值」的签名。没有私钥就伪造不出来。 */
    static final String CHAIN_SIG_B64 = "%s";

    /** 链的种子（参与每一环 token 推导） */
    static final String SEED = "%s";

    /** 每一环的期望 token，顺序即 1→2→3→4→5 */
    static final String[] CHAIN = new String[] {
%s
    };

    static final String PKG = "%s";
    static final String APP_CLASS = "%s";
    static final String LABEL = "%s";
    static final String VERSION_NAME = "%s";
    static final int VERSION_CODE = %d;

    /** 官方下载地址（被认定篡改后，直接把用户送到这里） */
    static final String OFFICIAL_URL =
            "https://github.com/Buwrt/githup/releases/download/__VER_TAG__/githup-__VER__.apk";
    static final String OFFICIAL_HOME = "https://github.com/Buwrt/githup";
}
''' % (fp, pub_b64, sig_b64, SEED,
       '\n'.join('        "%s",' % t for t in chain),
       PKG, APP_CLASS, LABEL, VERSION_NAME, VERSION_CODE)

    # 官方下载地址跟着版本号走 —— 以前是手写死的，发版漏改就会把被拦下的
    # 用户送到上一个版本去。用占位符替换，版本号从 build.gradle 读出来的
    # 那一刻起就是对的。
    java = java.replace('__VER_TAG__', 'v' + VERSION_NAME).replace('__VER__', VERSION_NAME)

    out = os.path.join(ROOT, 'app/src/main/java/com/hubmobile/app/GuardKeys.java')
    open(out, 'w').write(java)

    # ---- 前端资源清单 ----
    assets_root = os.path.join(ROOT, 'app/src/main/assets/web')
    lines = []
    for dirpath, _, files in os.walk(assets_root):
        for f in sorted(files):
            p = os.path.join(dirpath, f)
            rel = os.path.relpath(p, os.path.join(ROOT, 'app/src/main/assets')).replace(os.sep, '/')
            # vendor 下的第三方库不参与（体积大且与校验目标无关）
            if rel.startswith('web/vendor/'):
                continue
            h = hashlib.sha256(open(p, 'rb').read()).hexdigest()
            lines.append('%s  %s' % (h, rel))
    guard_dir = os.path.join(ROOT, 'app/src/main/assets/guard')
    os.makedirs(guard_dir, exist_ok=True)
    open(os.path.join(guard_dir, 'assets.sha'), 'w').write('\n'.join(sorted(lines)) + '\n')

    print('证书指纹 : %s' % fp)
    print('防护链    : %d 环，已用官方私钥签名' % len(chain))
    print('资源清单  : %d 个文件' % len(lines))
    print('已生成    : %s' % out)


if __name__ == '__main__':
    main()
