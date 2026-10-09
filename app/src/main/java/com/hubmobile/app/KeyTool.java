package com.hubmobile.app;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.RSAKeyGenParameterSpec;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * 在 App 内部把「一串英文字母和数字」变成真正的 Android 签名密钥。
 *
 * 用户不想为了签名去电脑上敲 keytool，所以这里直接用 JDK/Android 自带的
 * 密码学 API 生成 RSA 密钥对与自签名证书，打包成 PKCS12 keystore。
 * 整个项目零第三方依赖，所以 X.509 证书是手写 ASN.1 DER 编码出来的。
 *
 * 关键点：**同一串输入一定得到同一把钥匙**。
 * 密钥生成用的随机数由输入派生（SHA-256 后作为种子），因此只要用户记得
 * 那串字符，就能在任何时候重建出完全一样的 keystore，打出来的包签名一致、
 * 可以覆盖安装——这正是「是否使用同一个签名」要的效果。
 */
public final class KeyTool {

    private static final String OID_RSA_ENCRYPTION = "1.2.840.113549.1.1.1";
    private static final String OID_SHA256_RSA = "1.2.840.113549.1.1.11";
    private static final int KEY_SIZE = 2048;
    /**
     * 有效期必须是固定值：一旦用当前时间，同一串输入每次生成的证书都不一样，
     * 签名也就跟着变，用户就拿不到「同一个签名」。
     * 起点固定在 2020-01-01（早于任何构建时间，不会出现"证书尚未生效"），
     * 终点 2049-12-31（UTCTime 最多能表示到 2049）。
     */
    private static final long VALID_FROM = 1577836800000L;
    private static final long VALID_UNTIL = 2524521600000L;

    private KeyTool() { }

    /**
     * 生成 keystore（PKCS12）。
     *
     * @param seed      用户输入的字母数字，决定钥匙本身
     * @param alias     密钥别名
     * @param storePass 密钥库密码
     * @param keyPass   密钥密码
     * @return PKCS12 二进制内容
     */
    public static byte[] makeKeystore(String seed, String alias, String storePass, String keyPass)
            throws Exception {
        KeyPair kp = generateKeyPair(seed);
        byte[] encoded = selfSignedCertificate(kp, serial(seed));
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        X509Certificate cert = (X509Certificate)
                cf.generateCertificate(new ByteArrayInputStream(encoded));

        KeyStore ks = KeyStore.getInstance("PKCS12");
        ks.load(null, storePass == null ? null : storePass.toCharArray());
        ks.setKeyEntry(alias, kp.getPrivate(),
                keyPass == null ? null : keyPass.toCharArray(),
                new Certificate[]{cert});
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ks.store(out, storePass == null ? null : storePass.toCharArray());
        return out.toByteArray();
    }

    /** 由输入派生确定性密钥对：同样的输入 → 同样的钥匙 */
    private static KeyPair generateKeyPair(String seed) throws Exception {
        SecureRandom rnd = SecureRandom.getInstance("SHA1PRNG");
        rnd.setSeed(sha256(seed));
        KeyPairGenerator kpg = KeyPairGenerator.getInstance("RSA");
        kpg.initialize(new RSAKeyGenParameterSpec(KEY_SIZE, RSAKeyGenParameterSpec.F4), rnd);
        return kpg.generateKeyPair();
    }

    /** 证书序列号也由输入派生，保证可复现 */
    private static BigInteger serial(String seed) {
        byte[] h = sha256("serial:" + seed);
        return new BigInteger(1, h).abs().add(BigInteger.ONE);
    }

    private static byte[] sha256(String s) {
        try {
            return java.security.MessageDigest.getInstance("SHA-256")
                    .digest(s.getBytes("UTF-8"));
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /* ---------------- X.509 手写 DER 编码 ---------------- */

    private static byte[] selfSignedCertificate(KeyPair kp, BigInteger serial) throws Exception {
        byte[] pubInfo = subjectPublicKeyInfo(kp);
        byte[] name = x500Name();

        ByteArrayOutputStream tbs = new ByteArrayOutputStream();
        tbs.write(tlv(0xA0, integer(BigInteger.valueOf(2))));      // version = v3
        tbs.write(integer(serial));                                 // serialNumber
        tbs.write(algorithmIdentifier(OID_SHA256_RSA));             // signature
        tbs.write(name);                                            // issuer
        tbs.write(validity());                                      // validity
        tbs.write(name);                                            // subject（自签名）
        tbs.write(pubInfo);                                         // subjectPublicKeyInfo

        byte[] tbsBytes = tlv(0x30, tbs.toByteArray());

        Signature sig = Signature.getInstance("SHA256withRSA");
        sig.initSign(kp.getPrivate());
        sig.update(tbsBytes);
        byte[] signed = sig.sign();

        ByteArrayOutputStream cert = new ByteArrayOutputStream();
        cert.write(tbsBytes);
        cert.write(algorithmIdentifier(OID_SHA256_RSA));
        cert.write(tlv(0x03, concat(new byte[]{0x00}, signed)));    // BIT STRING
        return tlv(0x30, cert.toByteArray());
    }

    private static byte[] subjectPublicKeyInfo(KeyPair kp) throws Exception {
        java.security.interfaces.RSAPublicKey pub =
                (java.security.interfaces.RSAPublicKey) kp.getPublic();
        ByteArrayOutputStream key = new ByteArrayOutputStream();
        key.write(integer(pub.getModulus()));
        key.write(integer(pub.getPublicExponent()));
        byte[] alg = algorithmIdentifier(OID_RSA_ENCRYPTION);
        return tlv(0x30, concat(alg, tlv(0x03, concat(new byte[]{0x00}, tlv(0x30, key.toByteArray())))));
    }

    private static byte[] x500Name() {
        byte[] cn = rdn("2.5.4.3", "githup");
        byte[] o = rdn("2.5.4.10", "githup");
        byte[] ou = rdn("2.5.4.11", "Mobile");
        byte[] c = rdn("2.5.4.6", "CN");
        return tlv(0x30, concat(c, o, ou, cn));
    }

    private static byte[] rdn(String oid, String value) {
        byte[] v = tlv(0x0C, utf8(value));
        return tlv(0x31, tlv(0x30, concat(tlv(0x06, oidBytes(oid)), v)));
    }

    private static byte[] validity() {
        SimpleDateFormat f = new SimpleDateFormat("yyMMddHHmmss'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        String nb = f.format(new Date(VALID_FROM));
        String na = f.format(new Date(VALID_UNTIL));
        return tlv(0x30, concat(tlv(0x17, utf8(nb)), tlv(0x17, utf8(na))));
    }

    private static byte[] algorithmIdentifier(String oid) {
        return tlv(0x30, concat(tlv(0x06, oidBytes(oid)), new byte[]{0x05, 0x00}));
    }

    private static byte[] integer(BigInteger v) {
        return tlv(0x02, v.toByteArray());
    }

    /** TLV：tag + 长度 + 内容 */
    private static byte[] tlv(int tag, byte[] value) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(tag);
        int n = value.length;
        if (n < 128) {
            o.write(n);
        } else if (n < 256) {
            o.write(0x81); o.write(n);
        } else if (n < 65536) {
            o.write(0x82); o.write(n >> 8); o.write(n);
        } else {
            o.write(0x83); o.write(n >> 16); o.write(n >> 8); o.write(n);
        }
        o.write(value, 0, value.length);
        return o.toByteArray();
    }

    private static byte[] oidBytes(String dotted) {
        String[] parts = dotted.split("\\.");
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        o.write(Integer.parseInt(parts[0]) * 40 + Integer.parseInt(parts[1]));
        for (int i = 2; i < parts.length; i++) {
            int v = Integer.parseInt(parts[i]);
            if (v < 128) {
                o.write(v);
            } else {
                // base-128：每字节低 7 位存数据，最高位置 1 表示还有后续
                int shift = 28;
                while (((v >>> shift) & 0x7F) == 0 && shift > 0) shift -= 7;
                while (shift > 0) {
                    o.write(((v >>> shift) & 0x7F) | 0x80);
                    shift -= 7;
                }
                o.write(v & 0x7F);
            }
        }
        return o.toByteArray();
    }

    private static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        for (byte[] p : parts) o.write(p, 0, p.length);
        return o.toByteArray();
    }

    private static byte[] utf8(String s) {
        try {
            return s.getBytes("UTF-8");
        } catch (Exception e) {
            return s.getBytes();
        }
    }
}
