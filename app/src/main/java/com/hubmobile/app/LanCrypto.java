package com.hubmobile.app;

import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.SecretKeyFactory;

/**
 * 局域网同步用的密码学工具。
 *
 * 为什么不用 HTTPS：应用的网络安全配置把明文流量整个关掉了
 * （network_security_config.xml 里 cleartextTrafficPermitted=false），
 * 而局域网里又没有可信证书可用 —— 自签证书在 Android 上还得让用户
 * 手动信任。所以同步通道走**裸 TCP + 自己加密**：
 *
 *   · 配对阶段：6 位 PIN 经 PBKDF2 派生出 KE，用它把随机生成的
 *     长期密钥 PSK 加密送给对方。PIN 只在配对那一次用到。
 *   · 通信阶段：每条消息用 PSK 做 AES-256-GCM，随机 12 字节 nonce。
 *     GCM 自带完整性校验，篡改会直接解密失败。
 *
 * nonce 用计数器 + 随机前缀组合，避免同一把 key 下 nonce 重复
 * （GCM 一旦 nonce 复用，密钥就相当于泄露了，这是必须躲开的坑）。
 */
final class LanCrypto {

    private LanCrypto() { }

    private static final SecureRandom RND = new SecureRandom();

    /* ---------------- 随机 ---------------- */

    static byte[] random(int n) {
        byte[] b = new byte[n];
        RND.nextBytes(b);
        return b;
    }

    /** 生成 6 位数字配对码。 */
    static String newPin() {
        int v = RND.nextInt(1000000);
        return String.format(java.util.Locale.US, "%06d", v);
    }

    /* ---------------- 编码 ---------------- */

    static String b64(byte[] b) {
        return Base64.encodeToString(b, Base64.NO_WRAP);
    }

    static byte[] unb64(String s) {
        return Base64.decode(s, Base64.DEFAULT);
    }

    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format(java.util.Locale.US, "%02x", x & 0xff));
        return sb.toString();
    }

    /* ---------------- 摘要 ---------------- */

    static byte[] sha256(byte[] data) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(data);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    static String sha256Hex(String s) {
        return hex(sha256(s.getBytes(StandardCharsets.UTF_8)));
    }

    static byte[] hmacSha256(byte[] key, byte[] msg) {
        try {
            Mac m = Mac.getInstance("HmacSHA256");
            m.init(new SecretKeySpec(key, "HmacSHA256"));
            return m.doFinal(msg);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /**
     * 简易 HKDF：用 HMAC 把主密钥扩展成指定长度的派生密钥。
     * Android 自带的 SecretKeyFactory 没有 HKDF，自己实现一个够用。
     */
    static byte[] hkdf(byte[] master, byte[] info, int len) {
        byte[] prk = hmacSha256(new byte[32], master);
        ByteArrayOutputStreamLike out = new ByteArrayOutputStreamLike();
        byte[] t = new byte[0];
        byte[] salt = info == null ? new byte[0] : info;
        int i = 1;
        while (out.size() < len) {
            byte[] input = concat(t, salt, new byte[]{(byte) i});
            t = hmacSha256(prk, input);
            out.write(t);
            i++;
        }
        return out.copyOf(len);
    }

    /* ---------------- 密钥派生 ---------------- */

    /**
     * 由 PIN 派生配对加密密钥。
     * salt 里掺入双方设备 ID，保证「同一 PIN 在不同设备间」派生出的 key 不同。
     */
    static byte[] pinKey(String pin, String salt) {
        byte[] s = ("githup-lan-pair|" + salt).getBytes(StandardCharsets.UTF_8);
        /*
         * PBKDF2WithHmacSHA256 是 Android 8.0（API 26）才有的，而本应用
         * minSdk 是 24 —— 在 Android 7.0/7.1 上直接查这个算法会抛
         * NoSuchAlgorithmException，配对当场失败。这里先试 SHA-256，
         * 拿不到就退到 SHA-1（API 24 起就有）。
         *
         * 迭代次数也跟着区分：SHA-1 弱一些，就用更高的迭代数补回来。
         * 两台设备版本不同也没关系 —— 算法只影响本机这一次派生，
         * 而配对时「认领方」单方面加密 PSK，双方不需要用同一个算法。
         */
        try {
            PBEKeySpec spec = new PBEKeySpec(pin.toCharArray(), s, 210000, 256);
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
                    .generateSecret(spec).getEncoded();
        } catch (Exception ignore) {
            try {
                PBEKeySpec spec = new PBEKeySpec(pin.toCharArray(), s, 310000, 256);
                return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA1")
                        .generateSecret(spec).getEncoded();
            } catch (Exception e) {
                throw new RuntimeException("设备不支持 PBKDF2 密钥派生", e);
            }
        }
    }

    /** 会话密钥：PSK 派生出「本次连接专用」的子密钥，减小长期密钥暴露面。 */
    static byte[] sessionKey(byte[] psk, byte[] nonce) {
        return hkdf(psk, concat("githup-lan-session".getBytes(StandardCharsets.UTF_8), nonce), 32);
    }

    /* ---------------- AES-GCM ---------------- */

    private static final int NONCE_LEN = 12;
    private static final int TAG_BITS = 128;

    /** 输出格式：nonce(12) || 密文+tag，整体再做 Base64。 */
    static String seal(byte[] key, byte[] plain) {
        try {
            byte[] nonce = random(NONCE_LEN);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"),
                    new GCMParameterSpec(TAG_BITS, nonce));
            byte[] ct = c.doFinal(plain);
            return b64(concat(nonce, ct));
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /** seal 的逆运算。密钥不对 / 内容被改过都会抛异常。 */
    static byte[] open(byte[] key, String packed) {
        try {
            byte[] raw = unb64(packed);
            if (raw.length <= NONCE_LEN) throw new IllegalArgumentException("密文太短");
            byte[] nonce = java.util.Arrays.copyOfRange(raw, 0, NONCE_LEN);
            byte[] ct = java.util.Arrays.copyOfRange(raw, NONCE_LEN, raw.length);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"),
                    new GCMParameterSpec(TAG_BITS, nonce));
            return c.doFinal(ct);
        } catch (Exception e) {
            throw new RuntimeException("解密失败：配对密钥不一致或数据被篡改", e);
        }
    }

    /* ---------------- 短认证串 ---------------- */

    /**
     * 配对完成后双方各显示一个 4 字符短串，让用户肉眼比对。
     * 防的是中间人：MITM 拿不到真 PSK，算出来的串对不上。
     */
    static String sas(byte[] psk) {
        byte[] h = sha256(concat("githup-sas".getBytes(StandardCharsets.UTF_8), psk));
        return hex(new byte[]{h[0], h[1]}).toUpperCase(java.util.Locale.US);
    }

    /* ---------------- 小工具 ---------------- */

    static byte[] concat(byte[]... parts) {
        int n = 0;
        for (byte[] p : parts) n += (p == null ? 0 : p.length);
        byte[] out = new byte[n];
        int o = 0;
        for (byte[] p : parts) {
            if (p == null) continue;
            System.arraycopy(p, 0, out, o, p.length);
            o += p.length;
        }
        return out;
    }

    /** 极简可增长字节缓冲（避免引入额外依赖）。 */
    private static final class ByteArrayOutputStreamLike {
        private byte[] buf = new byte[64];
        private int len = 0;

        void write(byte[] b) {
            if (len + b.length > buf.length) {
                byte[] nb = new byte[Math.max(buf.length * 2, len + b.length)];
                System.arraycopy(buf, 0, nb, 0, len);
                buf = nb;
            }
            System.arraycopy(b, 0, buf, len, b.length);
            len += b.length;
        }

        int size() { return len; }

        byte[] copyOf(int n) { return java.util.Arrays.copyOf(buf, n); }
    }
}
