package com.hubmobile.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 使用 Android Keystore 中的 AES-GCM 密钥加密敏感数据（访问令牌），
 * 密文以 Base64 形式存放在私有 SharedPreferences 中。
 */
public final class SecurePrefs {

    private static final String KS = "AndroidKeyStore";
    private static final String ALIAS = "hubmobile_aes_key";
    private static final String PREF = "hub_secure";
    private static final String IV_SEP = "]";
    private static volatile boolean checked = false;

    private SecurePrefs() {}

    private static SecretKey getKey() {
        try {
            KeyStore ks = KeyStore.getInstance(KS);
            ks.load(null);
            if (ks.containsAlias(ALIAS)) {
                KeyStore.Entry entry = ks.getEntry(ALIAS, null);
                if (entry instanceof KeyStore.SecretKeyEntry) {
                    return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
                }
            }
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KS);
            KeyGenParameterSpec spec = new KeyGenParameterSpec.Builder(
                    ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setRandomizedEncryptionRequired(true)
                    .build();
            kg.init(spec);
            return kg.generateKey();
        } catch (Exception e) {
            return null;
        }
    }

    public static synchronized String get(Context ctx, String key, String def) {
        SharedPreferences sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
        String raw = sp.getString(key, null);
        if (raw == null) return def;
        if (!raw.contains(IV_SEP)) return raw; // 兼容早期明文
        try {
            SecretKey sk = getKey();
            if (sk == null) return def;
            String[] parts = raw.split("\\" + IV_SEP);
            byte[] iv = Base64.decode(parts[0], Base64.DEFAULT);
            byte[] data = Base64.decode(parts[1], Base64.DEFAULT);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, sk, new GCMParameterSpec(128, iv));
            return new String(c.doFinal(data), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return def;
        }
    }

    public static synchronized void put(Context ctx, String key, String value) {
        SharedPreferences sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
        if (value == null) {
            sp.edit().remove(key).apply();
            return;
        }
        try {
            SecretKey sk = getKey();
            if (sk != null) {
                byte[] iv = new byte[12];
                new SecureRandom().nextBytes(iv);
                Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                c.init(Cipher.ENCRYPT_MODE, sk, new GCMParameterSpec(128, iv));
                byte[] enc = c.doFinal(value.getBytes(StandardCharsets.UTF_8));
                String out = Base64.encodeToString(iv, Base64.DEFAULT) + IV_SEP
                        + Base64.encodeToString(enc, Base64.DEFAULT);
                sp.edit().putString(key, out.replace("\n", "")).apply();
                return;
            }
        } catch (Exception ignored) {
        }
        sp.edit().putString(key, value).apply();
    }

    public static void remove(Context ctx, String key) {
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit().remove(key).apply();
    }
}
