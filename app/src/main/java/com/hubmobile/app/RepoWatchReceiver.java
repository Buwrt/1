package com.hubmobile.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 「作者仓库更新」提醒 —— **只在真有更新时才发一条通知**。
 *
 * 干什么 ——
 *   用户给作者仓库（Buwrt/githup）点过 Star，就说明他在关注这个项目。
 *   之后该仓库发布新版本时，在**手机系统通知栏**弹出一条通知，点进去直达仓库页。
 *   没点 Star 就不打扰 —— 关注是用户自己表达的。
 *
 * ════ 这一版最大的变化：不再常驻任何通知 ════
 *
 *   上一版用的是前台服务（RepoWatchService）。而 Android 规定：
 *   **前台服务必须挂一条常驻通知**。即便把渠道设成 IMPORTANCE_MIN，
 *   它依然会在通知栏底部占一行（用户看到的就是「关注更新随时待命」）。
 *
 *   用户要的是「需要的时候再出现」，所以这里彻底放弃前台服务，
 *   改用 **BroadcastReceiver + goAsync()**：
 *
 *     · 平时**没有任何通知**，通知栏干干净净；
 *     · 检查在 Receiver 的异步宽限期里跑完（约 10 秒，够发两个请求）；
 *     · 只有真的发现新版本，才发那一条通知。
 *
 *   定时用 AlarmManager 的**非精确重复**闹钟（setInexactRepeating）：
 *   系统会把多个应用的闹钟合并唤醒，比自己死守一个前台服务省电得多，
 *   也更不容易被系统判成后台偷跑。代价是时间不精确 —— 但「关注的项目
 *   发新版」晚个十几分钟知道，完全无所谓。
 *
 * 三道不打扰的闸 ——
 *   1. 没登录（没有令牌）→ 查不了 Star 状态，直接不检查；
 *   2. 没点 Star → 一条通知都不发；
 *   3. 同一个版本只通知一次（落盘记下已通知的 tag）。
 *
 * 另外：第一次跑只记下当前版本号、不发通知 —— 否则刚装上就被
 * 「几个月前的旧版本」通知一次，那是打扰不是提醒。
 */
public class RepoWatchReceiver extends BroadcastReceiver {

    /** 更新提醒渠道：DEFAULT —— 状态栏有图标、通知栏看得见，但不出声、不振动 */
    private static final String CHANNEL_UPDATE = "githup_repo_update";

    private static final int NOTIFY_UPDATE = 7402;

    private static final String PREFS = "hub_prefs";
    /** 已经通知过的版本号（tag_name） */
    private static final String KEY_LAST_TAG = "watch_last_tag";
    /** 上一次真正打接口的时间戳 */
    private static final String KEY_LAST_CHECK = "watch_last_check";

    /** 关注的仓库 —— 作者自己的项目 */
    private static final String WATCH_OWNER = "Buwrt";
    private static final String WATCH_REPO = "githup";

    /** 轮询间隔：30 分钟。系统会自动对齐、合并唤醒 */
    private static final long CHECK_INTERVAL_MS = 30 * 60 * 1000L;
    /** 「回到前台立刻查」的最小间隔：10 分钟，避免来回切 App 打掉一堆接口 */
    private static final long FORCE_GAP_MS = 10 * 60 * 1000L;

    static final String ACTION_CHECK = "com.hubmobile.watch.CHECK";

    private static final ExecutorService POOL = Executors.newSingleThreadExecutor();

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /* ---------------- 外部入口 ---------------- */

    /**
     * App 回到前台时调用（MainActivity.onResume）：确保闹钟已排上，
     * 并顺手立刻查一次（内部有节流）。
     */
    static void attach(Context ctx) {
        if (ctx == null) return;
        schedule(ctx);
        try {
            ctx.sendBroadcast(new Intent(ACTION_CHECK).setPackage(ctx.getPackageName()));
        } catch (Throwable ignored) { }
    }

    /** 开机 / 覆盖安装后由 BootReceiver 调用：把闹钟重新排上 */
    static void schedule(Context ctx) {
        if (ctx == null) return;
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            PendingIntent pi = pending(ctx);
            /* 已存在就先取消再排 —— 避免重复排多个闹钟 */
            am.cancel(pi);
            am.setInexactRepeating(AlarmManager.ELAPSED_REALTIME_WAKEUP,
                    android.os.SystemClock.elapsedRealtime() + CHECK_INTERVAL_MS,
                    CHECK_INTERVAL_MS, pi);
        } catch (Throwable ignored) { }
    }

    private static PendingIntent pending(Context ctx) {
        Intent i = new Intent(ACTION_CHECK).setPackage(ctx.getPackageName());
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(ctx, 0, i, flags);
    }

    /* ---------------- 收到广播 ---------------- */

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (ctx == null) return;
        String action = intent != null ? intent.getAction() : null;
        if (action != null && !ACTION_CHECK.equals(action)
                && !Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }

        // BOOT / 覆盖安装：只把闹钟重新排上，不当场检查（那时网络多半还没好）
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            schedule(ctx);
            return;
        }

        /* goAsync()：给这次广播一段异步宽限期（约 10 秒），
           让我们能在里面发网络请求。不用它就得开服务，而开服务
           （前台服务）就必须挂常驻通知 —— 那正是要避免的东西。 */
        final PendingResult result = goAsync();
        final Context app = ctx.getApplicationContext();
        POOL.execute(() -> {
            try {
                doCheck(app);
            } catch (Throwable ignored) {
            } finally {
                try { result.finish(); } catch (Throwable ignored) { }
            }
        });
    }

    /** 真正打接口。跑在后台线程，阻塞是安全的。 */
    private void doCheck(Context ctx) {
        long last = prefs(ctx).getLong(KEY_LAST_CHECK, 0);
        long now = System.currentTimeMillis();
        if (now - last < FORCE_GAP_MS) return;
        prefs(ctx).edit().putLong(KEY_LAST_CHECK, now).apply();

        String token = SecurePrefs.get(ctx, "gh_token", "");
        if (token == null || token.isEmpty()) return;   // 没登录：查不了 Star，也不该打扰

        Map<String, String> headers = new HashMap<>();
        headers.put("Authorization", "Bearer " + token);
        headers.put("Accept", "application/vnd.github+json");
        headers.put("User-Agent", "githup/1.0");
        headers.put("X-GitHub-Api-Version", "2022-11-28");

        /*
         * 第一道闸：他给作者仓库点过 Star 吗？
         *
         * 这个接口只问状态不给内容 —— 2xx（实际是 204）= 点过，404 = 没点。
         * 401/403/网络不通一律当「没点」，宁可漏提醒也不误打扰。
         */
        Http.Response starred;
        try {
            starred = Http.request("GET",
                    "https://api.github.com/user/starred/" + WATCH_OWNER + "/" + WATCH_REPO,
                    null, headers);
        } catch (Throwable ignored) {
            return;
        }
        if (starred == null || starred.code < 200 || starred.code >= 300) return;

        /* 第二道闸：仓库有没有发新版本 */
        Http.Response rel;
        try {
            rel = Http.request("GET",
                    "https://api.github.com/repos/" + WATCH_OWNER + "/" + WATCH_REPO
                            + "/releases/latest", null, headers);
        } catch (Throwable ignored) {
            return;
        }
        if (rel == null || rel.code < 200 || rel.code >= 300 || rel.body == null) return;

        String tag, name, body, url;
        try {
            JSONObject o = new JSONObject(rel.body);
            if (o.optBoolean("draft", false) || o.optBoolean("prerelease", false)) return;
            tag = o.optString("tag_name", "");
            name = o.optString("name", "");
            body = o.optString("body", "");
            url = o.optString("html_url",
                    "https://github.com/" + WATCH_OWNER + "/" + WATCH_REPO);
        } catch (Throwable t) {
            return;
        }
        if (tag == null || tag.isEmpty()) return;

        /* 第三道闸：这个版本通知过没有 */
        SharedPreferences sp = prefs(ctx);
        String seen = sp.getString(KEY_LAST_TAG, "");
        if (seen == null || seen.isEmpty()) {
            // 第一次跑：只记下当前版本，不发通知 ——
            // 否则刚装上就被一条几个月前的旧版本通知迎面砸中
            sp.edit().putString(KEY_LAST_TAG, tag).apply();
            return;
        }
        if (seen.equals(tag)) return;

        sp.edit().putString(KEY_LAST_TAG, tag).apply();
        postUpdateNotification(ctx, tag, name, body, url);
    }

    /* ---------------- 发通知 ---------------- */

    /**
     * 只有走到这里才会出现通知 —— 平时通知栏里根本没有本应用的东西。
     */
    private void postUpdateNotification(Context ctx, String tag, String name,
                                        String body, String url) {
        try {
            NotificationManager nm =
                    (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            ensureChannel(nm);
            nm.notify(NOTIFY_UPDATE, buildUpdateNotification(ctx, tag, name, body, url));
        } catch (Throwable ignored) { }
    }

    private Notification buildUpdateNotification(Context ctx, String tag, String name,
                                                 String body, String url) {
        String title = WATCH_OWNER + "/" + WATCH_REPO + " 发布了 " + tag;
        String text = (name == null || name.isEmpty()) ? "你关注的项目有新版本" : name;

        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        // 直接落到该仓库页面：点通知就是想看看更新了什么
        open.putExtra("route", "/" + WATCH_OWNER + "/" + WATCH_REPO);

        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, piFlags);

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b = new Notification.Builder(ctx, CHANNEL_UPDATE);
        } else {
            b = new Notification.Builder(ctx);
            b.setPriority(Notification.PRIORITY_DEFAULT);
        }

        b.setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(pi)
                .setAutoCancel(true)          // 点了就消失，不留残影
                .setOnlyAlertOnce(true)
                .setShowWhen(true)
                .setCategory(Notification.CATEGORY_STATUS);

        if (body != null && !body.isEmpty()
                && Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
            Notification.BigTextStyle style = new Notification.BigTextStyle();
            style.setBigContentTitle(title);
            style.setSummaryText("点击查看完整更新内容");
            String excerpt = body.trim();
            if (excerpt.length() > 300) excerpt = excerpt.substring(0, 300) + "…";
            style.bigText(excerpt);
            b.setStyle(style);
        }
        return b.build();
    }

    /**
     * 唯一的通知渠道，IMPORTANCE_DEFAULT —— 这是「能显示在手机自带通知栏上」
     * 的关键：状态栏有图标、通知栏正常占位。
     * 声音与振动都关掉：「关注的项目发新版」看见就够了，不该像来电话一样响。
     */
    private void ensureChannel(NotificationManager nm) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        if (nm.getNotificationChannel(CHANNEL_UPDATE) == null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_UPDATE, "关注的项目更新", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("你点过 Star 的项目发布新版本时，在通知栏提醒你（不响铃、不振动）");
            ch.enableVibration(false);
            ch.setSound(null, null);
            ch.setShowBadge(true);
            nm.createNotificationChannel(ch);
        }
    }
}
