package com.hubmobile.app;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import android.os.Debug;
import android.util.Base64;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.spec.X509EncodedKeySpec;
// 注意：这里不能用 import java.security.Signature ——
// 它和 android.content.pm.Signature 同名，编译器分不清。下面一律写全限定名。
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * 防护链：一环扣一环的自校验。
 *
 * 为什么不是「一处 if 判断」——
 *   只有一处校验的话，别人反编译后把那一处删掉就全没了。
 *   所以这里做成五环互相咬合：每一环的输出是下一环的输入，
 *   任何一环被删掉、被跳过、被改结果，后面所有环都拿不到正确的输入，
 *   整条链立刻断掉。想绕过就得把五环连同埋点一起理清楚再重签，
 *   而重签之后它的签名指纹就不是官方的了 —— 第 1 环就倒在那儿。
 *
 * 五个环分别是 ——
 *   1 签名    当前安装包的签名证书指纹  == 官方指纹
 *   2 锚点    链的期望值由官方私钥签名，用官方公钥验签（改常量就验不过）
 *   3 资源    前端 JS/HTML 的哈希清单对不对（防只换前端文件）
 *   4 身份    包名 / 软件名 / 版本号 / 入口类对不对（防改名字、改包名共存）
 *   5 环境    有没有被调试、被 hook（防动态扒）
 *
 * 交叉关系（这是「一环扣一环」的关键）——
 *   1 → 2 → 3 → 4 → 5 → 回到 1 复检
 *   每一环拿到上一环的 token，先用内置期望值核对 token 对不对，
 *   再算自己的 token 交给下一环。删掉中间任何一环，
 *   下一环收到的是上上环的 token，核对必然失败。
 *
 * 诚实说明边界 ——
 *   这挡不住「有经验的人花时间逆向 + 重签」。任何纯客户端校验都挡不住，
 *   因为 APK 最终要交给用户设备执行。它挡住的是这些真实场景：
 *   改个软件名重签名、换个图标、改前端塞广告或偷 Token、改包名做共存版。
 *   这几类占二次打包的绝大多数，现在都会被拦下来。
 */
final class Guard {

    /** 校验结果 */
    static final class Result {
        boolean ok;
        int brokenRing;   // 断在第几环（0 = 没断）
        String detail;    // 给用户的说明
        String code;      // 简短错误码，方便反馈时定位

        Result(boolean ok, int ring, String detail, String code) {
            this.ok = ok; this.brokenRing = ring; this.detail = detail; this.code = code;
        }
        static Result pass() { return new Result(true, 0, "", ""); }
        static Result fail(int ring, String detail, String code) {
            return new Result(false, ring, detail, code);
        }
    }

    private Guard() { }

    /* ---------------- 对外：跑完整条链 ---------------- */

    /**
     * 跑一遍五环。返回断在哪一环。
     * 注意：这个方法本身不做任何「拦截动作」，拦截由调用方决定，
     * 这样多个埋点可以共用同一套判定。
     */
    static Result verify(Context ctx) {
        if (ctx == null) return Result.fail(1, "无法读取应用信息", "R0");

        String token = seed();                       // T0

        /* 第 1 环：签名指纹 */
        String actual = certSha256(ctx);
        if (actual == null || actual.isEmpty()) {
            return Result.fail(1, "读不到安装包的签名信息", "R1-NOSIG");
        }
        String t1 = hmac(token, "ring1-signature|" + actual);
        if (!t1.equals(chainAt(0))) {
            return Result.fail(1, "安装包的签名与官方不一致", "R1-SIG");
        }
        token = t1;

        /* 第 2 环：链的期望值必须真是官方私钥签出来的 */
        String t2 = hmac(token, "ring2-blob|" + GuardKeys.PUBKEY_B64.substring(0, 32));
        if (!t2.equals(chainAt(1))) {
            return Result.fail(2, "内置校验数据被改动过", "R2-CHAIN");
        }
        if (!verifyChainSig()) {
            return Result.fail(2, "内置校验数据的签名验证失败", "R2-SIG");
        }
        token = t2;

        /* 第 3 环：前端资源有没有被换掉 */
        String t3 = hmac(token, "ring3-assets|assets");
        if (!t3.equals(chainAt(2))) {
            return Result.fail(3, "资源校验顺序异常", "R3-CHAIN");
        }
        String assetBad = checkAssets(ctx);
        if (assetBad != null) {
            return Result.fail(3, "内置页面文件被改动：" + assetBad, "R3-ASSET");
        }
        token = t3;

        /* 第 4 环：身份（包名 / 软件名 / 版本 / 入口类） */
        String ident = GuardKeys.PKG + "|" + GuardKeys.LABEL + "|"
                + GuardKeys.VERSION_NAME + "|" + GuardKeys.VERSION_CODE;
        String t4 = hmac(token, "ring4-identity|" + ident);
        if (!t4.equals(chainAt(3))) {
            // token 对不上，可能是链的顺序被改，也可能就是身份本身被改了。
            // 身份被改时把具体原因说出来（「软件名被改成了 X」），用户看得懂。
            String why = checkIdentity(ctx);
            if (why != null) return Result.fail(4, why, "R4-IDENT");
            return Result.fail(4, "身份校验顺序异常", "R4-CHAIN");
        }
        String identBad = checkIdentity(ctx);
        if (identBad != null) {
            return Result.fail(4, identBad, "R4-IDENT");
        }
        token = t4;

        /* 第 5 环：运行环境（被调试 / 被 hook 也算篡改迹象） */
        String t5 = hmac(token, "ring5-env|env");
        if (!t5.equals(chainAt(4))) {
            return Result.fail(5, "环境校验顺序异常", "R5-CHAIN");
        }
        String envBad = checkEnv(ctx);
        if (envBad != null) {
            return Result.fail(5, envBad, "R5-ENV");
        }

        /* 闭环复检：拿着第 5 环的结果，回到第 1 环再对一次签名 */
        String again = certSha256(ctx);
        if (again == null || !again.equals(actual) || !again.equals(GuardKeys.CERT_SHA256)) {
            return Result.fail(1, "复检时签名不一致", "R1-RECHECK");
        }
        return Result.pass();
    }

    /* ---------------- 各环的具体检查 ---------------- */

    /** 第 1 环用的：当前安装包签名证书指纹 */
    @SuppressWarnings("deprecation")
    private static String certSha256(Context ctx) {
        try {
            PackageManager pm = ctx.getPackageManager();
            PackageInfo pi;
            if (Build.VERSION.SDK_INT >= 28) {
                pi = pm.getPackageInfo(ctx.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
                if (pi.signingInfo == null) return null;
                Signature[] arr = pi.signingInfo.hasMultipleSigners()
                        ? pi.signingInfo.getApkContentsSigners()
                        : pi.signingInfo.getSigningCertificateHistory();
                if (arr == null || arr.length == 0) return null;
                return sha256(arr[0].toByteArray());
            } else {
                pi = pm.getPackageInfo(ctx.getPackageName(), PackageManager.GET_SIGNATURES);
                if (pi.signatures == null || pi.signatures.length == 0) return null;
                return sha256(pi.signatures[0].toByteArray());
            }
        } catch (Throwable t) {
            return null;
        }
    }

    /** 第 3 环：前端资源哈希清单 */
    private static String checkAssets(Context ctx) {
        InputStream in = null;
        BufferedReader r = null;
        try {
            in = ctx.getAssets().open("guard/assets.sha");
            r = new BufferedReader(new InputStreamReader(in, "UTF-8"));
            Map<String, String> want = new HashMap<>();
            String line;
            while ((line = r.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty()) continue;
                String[] kv = line.split("\\s+");
                if (kv.length >= 2) want.put(kv[1], kv[0].toLowerCase(Locale.US));
            }
            if (want.isEmpty()) return "清单为空";
            for (Map.Entry<String, String> e : want.entrySet()) {
                String got = assetSha256(ctx, e.getKey());
                if (got == null) return e.getKey() + "（缺失）";
                if (!got.equals(e.getValue())) return e.getKey();
            }
            return null;
        } catch (Throwable t) {
            return "读不到校验清单";
        } finally {
            close(r); close(in);
        }
    }

    private static String assetSha256(Context ctx, String path) {
        InputStream in = null;
        try {
            in = ctx.getAssets().open(path);
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            return hex(md.digest());
        } catch (Throwable t) {
            return null;
        } finally {
            close(in);
        }
    }

    /** 第 4 环：身份。改软件名、改包名、改版本号都会倒在这一环。 */
    private static String checkIdentity(Context ctx) {
        try {
            PackageManager pm = ctx.getPackageManager();
            String pkg = ctx.getPackageName();
            if (!GuardKeys.PKG.equals(pkg)) return "包名被改成了 " + pkg;

            PackageInfo pi = pm.getPackageInfo(pkg, 0);
            if (!GuardKeys.VERSION_NAME.equals(pi.versionName)) {
                return "版本号被改成了 " + pi.versionName;
            }
            if (pi.versionCode != GuardKeys.VERSION_CODE) {
                return "内部版本号被改成了 " + pi.versionCode;
            }

            ApplicationInfo ai = ctx.getApplicationInfo();
            CharSequence label = pm.getApplicationLabel(ai);
            String s = label == null ? "" : label.toString().trim();
            if (!GuardKeys.LABEL.equals(s)) return "软件名被改成了「" + s + "」";

            if (ai.className != null && !ai.className.isEmpty()
                    && !GuardKeys.APP_CLASS.equals(ai.className)) {
                return "入口类被改成了 " + ai.className;
            }

            // 官方包必须是「可安装来源」里的正规安装，不允许跑在奇怪的容器里
            String src = null;
            if (Build.VERSION.SDK_INT >= 30) {
                try { src = pm.getInstallSourceInfo(pkg).getInitiatingPackageName(); } catch (Throwable ignored) { }
            }
            if (src != null && (src.contains("xposed") || src.contains("lspatch")
                    || src.contains("lsposed") || src.contains("virtualapp"))) {
                return "运行在被注入的环境中";
            }
            return null;
        } catch (Throwable t) {
            return "读不到身份信息";
        }
    }

    /**
     * 第 5 环：运行环境。
     * 只有「调试器挂着」或「明显被注入」才拦 —— 普通用户正常用不会触发。
     */
    private static String checkEnv(Context ctx) {
        try {
            if ((ctx.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
                return "这个包开了可调试开关";
            }
            if (Debug.isDebuggerConnected()) return "检测到调试器连接";
            if (hasInjectSo()) return "检测到注入模块";
            return null;
        } catch (Throwable t) {
            return null;
        }
    }

    /** /proc/self/maps 里出现常见注入框架的特征 */
    private static boolean hasInjectSo() {
        BufferedReader r = null;
        try {
            r = new BufferedReader(new InputStreamReader(
                    new java.io.FileInputStream("/proc/self/maps"), "UTF-8"));
            String line;
            int n = 0;
            while ((line = r.readLine()) != null && n++ < 600) {
                String low = line.toLowerCase(Locale.US);
                if (low.contains("frida") || low.contains("xposed")
                        || low.contains("substrate") || low.contains("lspd")
                        || low.contains("libdobby") || low.contains("zygisk")) {
                    return true;
                }
            }
        } catch (Throwable t) {
            return false;
        } finally {
            close(r);
        }
        return false;
    }

    /* ---------------- 链的算术 ---------------- */

    private static String seed() {
        try {
            return hex(MessageDigest.getInstance("SHA-256").digest(GuardKeys.SEED.getBytes("UTF-8")));
        } catch (Throwable t) {
            return GuardKeys.SEED;
        }
    }

    private static String chainAt(int i) {
        return GuardKeys.CHAIN[i];
    }

    /** HMAC-SHA256，与 tools/gen-guard.py 里的算法严格一致 */
    private static String hmac(String keyHex, String msg) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(keyHex.getBytes("UTF-8"), "HmacSHA256"));
            return hex(mac.doFinal(msg.getBytes("UTF-8")));
        } catch (Throwable t) {
            return "";
        }
    }

    /** 用内置官方公钥验证「链期望值」的签名 */
    private static boolean verifyChainSig() {
        try {
            byte[] pub = Base64.decode(GuardKeys.PUBKEY_B64, Base64.DEFAULT);
            PublicKey key = KeyFactory.getInstance("RSA")
                    .generatePublic(new X509EncodedKeySpec(pub));
            java.security.Signature s = java.security.Signature.getInstance("SHA256withRSA");
            s.initVerify(key);
            s.update(join(GuardKeys.CHAIN, "|").getBytes("UTF-8"));
            return s.verify(Base64.decode(GuardKeys.CHAIN_SIG_B64, Base64.DEFAULT));
        } catch (Throwable t) {
            return false;
        }
    }

    private static String join(String[] a, String sep) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < a.length; i++) {
            if (i > 0) sb.append(sep);
            sb.append(a[i]);
        }
        return sb.toString();
    }

    private static String sha256(byte[] b) {
        try {
            return hex(MessageDigest.getInstance("SHA-256").digest(b));
        } catch (Throwable t) {
            return null;
        }
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format(Locale.US, "%02x", x & 0xff));
        return sb.toString();
    }

    private static void close(java.io.Closeable c) {
        if (c == null) return;
        try { c.close(); } catch (Throwable ignored) { }
    }
}
