package com.example.totp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import java.nio.ByteBuffer;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * 两步验证器前台服务。
 *
 * 修复「通知出现两排数字」的关键：
 *   1) 全程只使用固定 NOTIFICATION_ID = 1001，新通知覆盖旧通知，不会并排；
 *   2) 用 Handler 单线程定时刷新，避免 CountDownTimer 叠加导致重复 notify；
 *   3) 单一数据源 currentCode/currentSeconds，UI 与通知读同一份，不会出现两段不一致的数字。
 *
 * TOTP 参数与 GitHub 一致：HMAC-SHA1 / 6 位 / 30 秒。
 */
public class TOTPService extends Service {

    public static final String CHANNEL_ID = "totp_channel";
    public static final int NOTIFICATION_ID = 1001; // 固定 ID：保证只有一条通知
    public static final String ACTION_START = "com.example.totp.START";
    public static final String ACTION_STOP = "com.example.totp.STOP";
    public static final String EXTRA_SECRET = "secret";

    private static final int PERIOD = 30;   // 周期 30 秒
    private static final int DIGITS = 6;    // 6 位验证码
    private static final String ALGO = "HmacSHA1";

    /** 单一数据源：界面与通知都读这两个值，保证数字一致、只有一组 */
    public static volatile String currentCode = "------";
    public static volatile int currentSeconds = PERIOD;

    private NotificationManager nm;
    private Handler handler;
    private Runnable ticker;
    private volatile String secret;

    @Override
    public void onCreate() {
        super.onCreate();
        nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        createChannel();
        handler = new Handler(Looper.getMainLooper());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopTicker();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
            stopSelf();
            return START_NOT_STICKY;
        }

        if (intent != null && intent.getStringExtra(EXTRA_SECRET) != null) {
            secret = intent.getStringExtra(EXTRA_SECRET);
        }
        if (secret == null || secret.trim().isEmpty()) {
            secret = Prefs.getSecret(this);
        }

        refresh();
        startForeground(NOTIFICATION_ID, buildNotification());
        startTicker();
        return START_STICKY;
    }

    /** 每秒刷新一次：重算验证码与剩余秒数，并更新通知 */
    private void startTicker() {
        stopTicker();
        ticker = new Runnable() {
            @Override
            public void run() {
                refresh();
                nm.notify(NOTIFICATION_ID, buildNotification()); // 同一 ID → 覆盖，不叠加
                handler.postDelayed(this, 1000);
            }
        };
        handler.post(ticker);
    }

    private void stopTicker() {
        if (handler != null && ticker != null) {
            handler.removeCallbacks(ticker);
            ticker = null;
        }
    }

    /** 重算当前验证码与剩余秒数（单一数据源） */
    private void refresh() {
        currentSeconds = PERIOD - (int) ((System.currentTimeMillis() / 1000) % PERIOD);
        currentCode = generateTOTP(secret);
    }

    private Notification buildNotification() {
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }
        builder.setSmallIcon(android.R.drawable.ic_lock_lock)
                .setContentTitle("GitHub 两步验证")
                .setContentText(currentCode + "   ·   " + currentSeconds + "s 后刷新")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setProgress(PERIOD, PERIOD - currentSeconds, false); // 倒计时进度条
        return builder.build();
    }

    /** 生成 TOTP 验证码（RFC 6238） */
    public static String generateTOTP(String base32Secret) {
        try {
            if (base32Secret == null || base32Secret.trim().isEmpty()) return "------";
            byte[] key = decodeBase32(base32Secret.trim());
            long counter = System.currentTimeMillis() / 1000 / PERIOD;
            ByteBuffer buf = ByteBuffer.allocate(8);
            buf.putLong(counter);
            Mac mac = Mac.getInstance(ALGO);
            mac.init(new SecretKeySpec(key, ALGO));
            byte[] hash = mac.doFinal(buf.array());
            int offset = hash[hash.length - 1] & 0x0F;
            int binary = ((hash[offset] & 0x7F) << 24)
                    | ((hash[offset + 1] & 0xFF) << 16)
                    | ((hash[offset + 2] & 0xFF) << 8)
                    | (hash[offset + 3] & 0xFF);
            int otp = binary % (int) Math.pow(10, DIGITS);
            return String.format("%0" + DIGITS + "d", otp);
        } catch (Exception e) {
            return "------";
        }
    }

    /** Base32 解码 */
    static byte[] decodeBase32(String base32) {
        String alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        String s = base32.replace("=", "").replace(" ", "").toUpperCase();
        int bits = 0, value = 0, index = 0;
        byte[] out = new byte[s.length() * 5 / 8 + 1];
        for (char c : s.toCharArray()) {
            int idx = alphabet.indexOf(c);
            if (idx < 0) continue;
            value = (value << 5) | idx;
            bits += 5;
            if (bits >= 8) {
                out[index++] = (byte) (value >>> (bits - 8));
                bits -= 8;
            }
        }
        byte[] res = new byte[index];
        System.arraycopy(out, 0, res, 0, index);
        return res;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "两步验证器", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("显示 GitHub 两步验证码与倒计时");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
    }

    @Override
    public void onDestroy() {
        stopTicker();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
