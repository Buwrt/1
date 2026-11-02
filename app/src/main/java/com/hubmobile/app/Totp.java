package com.hubmobile.app;

import org.json.JSONObject;

import java.security.MessageDigest;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * TOTP/HOTP 的 Java 实现。
 *
 * 为什么前端已经有一份 JS 实现，这里还要再写一份 ——
 *   后台常驻通知（TotpService）跑在原生侧，App 退到后台后 WebView 会被
 *   系统冻结，JS 根本算不了。要在通知栏持续刷新码，原生必须自己能算。
 *
 * 两份实现必须给出完全一致的结果（算法是 RFC 6238，本来也只有一种解法）。
 * 前端优先走 JsBridge 的 hmacSha1/hmacSha256（同样是这套 Java 代码），
 * 拿不到原生桥时才用纯 JS 兜底 —— 三条路殊途同归。
 */
final class Totp {

    private Totp() { }

    private static final String B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

    /** Base32 解码（大小写不敏感，忽略空格与连字符） */
    static byte[] b32decode(String input) {
        if (input == null) return null;
        String s = input.toUpperCase().replaceAll("[\\s\\-_]", "").replaceAll("=+$", "");
        if (s.isEmpty()) return null;
        int bits = 0, value = 0, n = 0;
        byte[] tmp = new byte[s.length() * 5 / 8 + 1];
        for (int i = 0; i < s.length(); i++) {
            int idx = B32.indexOf(s.charAt(i));
            if (idx < 0) return null;
            value = (value << 5) | idx;
            bits += 5;
            if (bits >= 8) {
                bits -= 8;
                tmp[n++] = (byte) ((value >>> bits) & 0xff);
            }
        }
        if (n == 0) return null;
        byte[] out = new byte[n];
        System.arraycopy(tmp, 0, out, 0, n);
        return out;
    }

    /** 把密钥规整成「同一把钥匙就是同一个字符串」的形态：
        转大写、去掉空格 / 连字符 / 下划线、去掉尾部补位等号。
        去重时用它做指纹 —— 不然「JBSW Y3DP」和「jbswy3dp」会被当成两个账户。 */
    static String normalizeSecret(String input) {
        if (input == null) return "";
        return input.toUpperCase().replaceAll("[\\s\\-_]", "").replaceAll("=+$", "");
    }

    /** 算一个账户当前的动态码；失败返回 null */
    static String compute(JSONObject acct) {
        if (acct == null) return null;
        byte[] key = b32decode(acct.optString("secret", ""));
        if (key == null) return null;

        int period = acct.optInt("period", 30);
        if (period <= 0) period = 30;
        int digits = acct.optInt("digits", 6);
        if (digits != 8) digits = 6;
        String algo = acct.optString("algo", "SHA1");

        long counter = System.currentTimeMillis() / 1000L / period;
        return hotp(key, counter, digits, algo);
    }

    /** 当前这一轮还剩几秒 */
    static long remaining(JSONObject acct) {
        int period = acct == null ? 30 : acct.optInt("period", 30);
        if (period <= 0) period = 30;
        long t = System.currentTimeMillis() / 1000L;
        return period - (t % period);
    }

    /** 按「XXX XXX」分段，跟各家验证器显示一致，长串不容易看错位 */
    static String group(String code) {
        if (code == null || code.isEmpty()) return "";
        if (code.length() == 6) return code.substring(0, 3) + " " + code.substring(3);
        if (code.length() == 8) return code.substring(0, 4) + " " + code.substring(4);
        return code;
    }

    /** RFC 4226：HMAC → 动态截断 → 取模 */
    private static String hotp(byte[] key, long counter, int digits, String algo) {
        try {
            /*
             * 计数器写进 8 字节缓冲区的大端表示。
             *
             * 注意这里用 long 分高低两段写 —— 直接 i=7..0 循环右移在
             * Java 里对 long 是可行的，但一旦有人把 counter 改成 int
             * 就会踩到「>>> 32 等于不位移」的坑。分开写更不容易出错。
             */
            byte[] msg = new byte[8];
            long high = counter >>> 32;
            long low = counter & 0xffffffffL;
            for (int i = 3; i >= 0; i--) {
                msg[i] = (byte) (high & 0xff);
                high >>>= 8;
            }
            for (int i = 7; i >= 4; i--) {
                msg[i] = (byte) (low & 0xff);
                low >>>= 8;
            }

            String macAlgo;
            if ("SHA256".equalsIgnoreCase(algo)) macAlgo = "HmacSHA256";
            else if ("SHA512".equalsIgnoreCase(algo)) macAlgo = "HmacSHA512";
            else macAlgo = "HmacSHA1";

            Mac mac = Mac.getInstance(macAlgo);
            mac.init(new SecretKeySpec(key, macAlgo));
            byte[] hash = mac.doFinal(msg);

            int offset = hash[hash.length - 1] & 0x0f;
            int bin = ((hash[offset] & 0x7f) << 24)
                    | ((hash[offset + 1] & 0xff) << 16)
                    | ((hash[offset + 2] & 0xff) << 8)
                    | (hash[offset + 3] & 0xff);

            int mod = 1;
            for (int i = 0; i < digits; i++) mod *= 10;
            String s = String.valueOf(bin % mod);
            while (s.length() < digits) s = "0" + s;
            return s;
        } catch (Throwable t) {
            return null;
        }
    }

    /** SHA-256 十六进制（给「关于」页展示签名指纹之类的地方备用） */
    static String sha256Hex(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(data);
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) sb.append(String.format(java.util.Locale.US, "%02x", b & 0xff));
            return sb.toString();
        } catch (Throwable t) {
            return null;
        }
    }
}
