package com.hubmobile.app;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;

import java.security.MessageDigest;
import java.util.Locale;

/**
 * 签名自校验：确保跑起来的是「你自己签的那个包」。
 *
 * 为什么需要它 ——
 *   别人把你开源出来的代码重新打个包、改掉几个字、甚至塞点广告或偷令牌的代码，
 *   再用他自己的密钥签名，就得到一个「看起来一样」的 APP。如果他能骗用户装上，
 *   损失的是你的口碑，用户丢的是数据。
 *
 * 它是怎么拦住的 ——
 *   签名是 APK 的一部分，改了包内容签名就对不上，重签又必然换密钥。
 *   所以只要在运行时比对「当前安装包的签名指纹」与「写死在代码里的那个指纹」，
 *   不一致就说明这个包不是你发的 —— 这时直接拒绝继续运行。
 *
 * 诚实说明它的边界 ——
 *   这不是不可破解的：懂行的人可以反编译、把这段校验删掉、再重新签名。
 *   它挡的是「拿源码随手改一改就发个盗版」这类低成本抄袭，
 *   以及「官方包被二次打包后重签」的常见路径。真正的恶意逆向挡不住，
 *   任何客户端都挡不住 —— 这是加密学上的限制，不是实现问题。
 */
final class SignCheck {

    /**
     * 正式签名的证书 SHA-256 指纹（小写、无冒号）。
     * 换密钥时这里必须同步更新，否则 App 会拒绝运行。
     */
    private static final String EXPECTED_SHA256 =
            "863dd1cd3752e59165e152bc4ab35fde478fcd296d724a6bc58cec0368184927";

    private SignCheck() { }

    /** 官方签名证书的 SHA-256，供更新安装时校验下载到的包 */
    static String officialCertSha256() {
        return EXPECTED_SHA256;
    }

    /**
     * 当前安装包的签名是否为官方签名。
     * 调试构建（debug 签名）一律放行 —— 那是开发时自己用的。
     */
    static boolean isOfficial(Context ctx) {
        if (BuildConfig.DEBUG_BUILD) return true;
        String actual = signingSha256(ctx);
        if (actual == null || actual.isEmpty()) {
            // 读不到签名信息：宁可当成异常，也不放行
            return false;
        }
        return actual.equals(EXPECTED_SHA256);
    }

    /**
     * 取当前安装包签名证书的 SHA-256（小写十六进制，无分隔符）。
     *
     * 包级可见（不是 private）：JsBridge 要用它给「设置 → 关于」显示签名指纹。
     */
    @SuppressWarnings("deprecation")
    static String signingSha256(Context ctx) {
        try {
            PackageManager pm = ctx.getPackageManager();
            String pkg = ctx.getPackageName();
            PackageInfo pi;
            if (android.os.Build.VERSION.SDK_INT >= 28) {
                pi = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES);
                if (pi.signingInfo == null) return null;
                Signature[] arr = pi.signingInfo.hasMultipleSigners()
                        ? pi.signingInfo.getApkContentsSigners()
                        : pi.signingInfo.getSigningCertificateHistory();
                return arr != null && arr.length > 0 ? sha256(arr[0]) : null;
            } else {
                pi = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES);
                if (pi.signatures == null || pi.signatures.length == 0) return null;
                return sha256(pi.signatures[0]);
            }
        } catch (Throwable t) {
            return null;
        }
    }

    /** 把证书编码算成 SHA-256 并转成小写十六进制字符串 */
    private static String sha256(Signature sig) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(sig.toByteArray());
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) sb.append(String.format(Locale.US, "%02x", b & 0xff));
            return sb.toString();
        } catch (Throwable t) {
            return null;
        }
    }
}
