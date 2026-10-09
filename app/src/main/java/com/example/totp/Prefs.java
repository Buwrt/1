package com.example.totp;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 密钥本地存储。
 * 注意：这里为演示使用 SharedPreferences 明文保存。
 * 生产环境请改用 AndroidKeyStore + AES 加密（与 githup 的 SecurePrefs 思路一致）。
 */
public class Prefs {
    private static final String NAME = "totp";
    private static final String KEY_SECRET = "secret";
    private static final String KEY_DEFAULT = "JBSWY3DPEHPK3PXP"; // 示例密钥

    public static String getSecret(Context c) {
        return c.getSharedPreferences(NAME, Context.MODE_PRIVATE)
                .getString(KEY_SECRET, KEY_DEFAULT);
    }

    public static void setSecret(Context c, String secret) {
        c.getSharedPreferences(NAME, Context.MODE_PRIVATE)
                .edit().putString(KEY_SECRET, secret.trim()).apply();
    }
}
