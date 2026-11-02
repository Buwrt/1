package com.hubmobile.app;

import android.app.AlarmManager;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * GitHub 通知的后台轮询 —— 让「通知」也能像微信那样出现在系统通知栏。
 *
 * ═══ 为什么微信 / QQ / 钉钉能收到，而 githup 以前收不到 ═══
 *
 * 它们有**自己的服务器**。消息一到，服务器主动推给手机（走厂商推送通道
 * 或自己的长连接），手机收到推送就弹系统通知 —— 这是「推」。
 *
 * githup 的通知来自 GitHub。**GitHub 不会把通知推给第三方 App**，
 * 只有 App 主动去问才知道有没有新的 —— 这是「拉」。
 *
 * 而 App 退到后台后 WebView 会被冻结、JS 停摆，根本没人在问。
 * 于是通知永远只在「打开 App 那一刻」才看得到，平时通知栏一条都没有。
 *
 * 所以这里补上那个"问"的人：在原生侧定时轮询，发现新的未读通知就发
 * 一条系统通知。原生侧不受 WebView 冻结影响。
 *
 * ═══ 为什么不用前台服务 ═══
 *
 * 前台服务必须挂一条常驻通知 —— 用户明确反对过（「为什么通知栏里有个
 * 这个，我想让他需要的时候再出现」）。所以这里用：
 *
 *     AlarmManager（定时发广播） + BroadcastReceiver + goAsync()
 *
 * 平时不占任何通知栏位置，只有真有新通知时才出现。
 *
 * ═══ 几条硬规矩 ═══
 *
 *   1) 没登录就不问 —— 没有令牌这个请求本身会失败，也没意义
 *   2) 同一条通知只提醒一次 —— 记下已通知过的 id，否则半小时后同一条
 *      又弹一遍，那是骚扰不是通知
 *   3) 没给通知权限就静默返回 —— 不能崩，也不能偷偷弹
 *   4) goAsync() 拿到的窗口必须 finish()，且只能调一次
 */
public class NotifWatchReceiver extends BroadcastReceiver {

    private static final String TAG = "githup-notif";

    /** 定时任务的 action */
    public static final String ACTION_CHECK = "com.hubmobile.app.CHECK_NOTIFICATIONS";

    /**
     * 轮询间隔：15 分钟。
     *
     * 以前是 30 分钟 —— 配合下面那个 Doze bug，实际可能几小时才轮到一次，
     * 用户自然觉得「根本收不到」。
     */
    private static final long INTERVAL_MS = 15L * 60L * 1000L;

    /** 单次检查最多提醒几条 —— 攒了几百条时不能一次全糊上去 */
    private static final int MAX_SHOW = 5;

    /** 已通知过的 id 最多记多少个（环形淘汰，防止无限膨胀） */
    private static final int SEEN_MAX = 300;

    private static final String PREF = "notif_watch";
    private static final String KEY_SEEN = "seen_ids";
    private static final String KEY_LAST = "last_check";
    private static final String KEY_ENABLED = "enabled";

    public static final String CHANNEL_NOTIF = "githup_notifications";

    /* ==================================================================
     * 调度
     * ================================================================== */

    private static PendingIntent alarmPi(Context ctx) {
        Intent i = new Intent(ctx, NotifWatchReceiver.class);
        i.setAction(ACTION_CHECK);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(ctx, 2101, i, flags);
    }

    /**
     * 排下一次检查（链式调度）。
     *
     * ═══ 为什么不用 setInexactRepeating ═══
     *
     * 以前是：
     *
     *     am.setInexactRepeating(ELAPSED_REALTIME_WAKEUP, now + 30min, 30min, pi);
     *
     * 这是「收不到通知」的**主因**。Android 6+ 进入 Doze（灭屏静置一会儿
     * 就进）之后，普通 alarm 会被**推迟到维护窗口**才执行 —— 维护窗口
     * 一开始是几小时一次。手机放着不动一晚上，一轮都跑不到。
     * 于是白天用着 App 才有反应，晚上、锁屏期间一条都没有。
     *
     * setAndAllowWhileIdle 能在 idle 时也把设备叫醒干活（系统限制约
     * 9 分钟一次，15 分钟间隔绰绰有余）。但它**没有 repeating 版本** ——
     * 所以只能排单次，每次干完活自己再排下一次。
     *
     * 这就是链式调度。断链的唯一种类是进程被杀，而开机 / 覆盖安装 /
     * 回到前台（MainActivity.onResume）都会重新挂上，断不了多久。
     */
    public static void schedule(Context ctx) {
        scheduleAfter(ctx, INTERVAL_MS);
    }

    /** @param delayMs 多久之后触发 */
    private static void scheduleAfter(Context ctx, long delayMs) {
        if (ctx == null) return;
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            PendingIntent pi = alarmPi(ctx);
            long trigger = android.os.SystemClock.elapsedRealtime() + delayMs;
            if (Build.VERSION.SDK_INT >= 23) {
                /* AllowWhileIdle：Doze 期间也能触发。不加这个，锁屏后基本收不到。 */
                am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
            } else {
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi);
            }
            Log.d(TAG, "已排下一次通知检查，" + (delayMs / 1000) + " 秒后");
        } catch (Throwable t) {
            Log.w(TAG, "排轮询失败: " + t);
        }
    }

    /**
     * 刚登录 / 刚加完账户：先排一次「近期」检查。
     *
     * ═══ 为什么 ═══
     *
     * 以前登录后要等满 15 分钟才轮到第一次。而第一次（lastCheck == 0）
     * 按规矩是「只记不发」——它在建基线，把用户未读箱里已经攒着的那一堆
     * 历史通知标记为已通知，免得刚登录就被轰炸。
     *
     * 于是用户的真实体验是：登录 → 等 15 分钟建基线 → 再等 15 分钟 →
     * 期间还得恰巧有人回复他，才第一次看到通知。几乎等于「收不到」。
     *
     * 现在登录后 20 秒就先建一次基线，之后每 15 分钟的正常轮询里，
     * 只要真有新通知就立刻提醒。
     */
    public static void scheduleSoonAfterLogin(Context ctx) {
        scheduleAfter(ctx, 20L * 1000L);
    }

    /**
     * App 退到后台：排一次近期检查。
     *
     * 用户刚用完 App 离开，接下来一段时间最可能有新动静（别人回复你、
     * @你）。这时候把检查提前一点，比死等 15 分钟贴心得多。
     */
    public static void scheduleSoonAfterLeave(Context ctx) {
        scheduleAfter(ctx, 3L * 60L * 1000L);
    }

    /**
     * 立刻检查一次（不等待），给「通知页下拉刷新 / 刚登录」这类场景用。
     *
     * 异步执行，调用方不必切线程。
     */
    public static void checkNow(final Context ctx) {
        if (ctx == null) return;
        final Context app = ctx.getApplicationContext();
        new Thread(new Runnable() {
            @Override public void run() {
                try { checkOnce(app); } catch (Throwable t) { Log.w(TAG, "立即检查失败: " + t); }
            }
        }, "notif-now").start();
    }

    /** 取消定时检查（退出登录时调） */
    public static void cancel(Context ctx) {
        if (ctx == null) return;
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am != null) am.cancel(alarmPi(ctx));
        } catch (Throwable ignored) { }
    }

    /**
     * 后台通知提醒是否开启 —— **恒为 true**。
     *
     * ═══ 为什么不再读存档值 ═══
     *
     * 设置里的「通知栏提醒」开关已去掉。而那个开关的存档值（KEY_ENABLED）
     * 还在用户的 SharedPreferences 里 —— 谁当初顺手关过一次，存的就是
     * false。开关一去掉，就**再也没有入口能把它改回来**，后台提醒等于
     * 永久失效。
     *
     * 所以这里不再读那个值，直接返回 true：功能始终开着。
     *
     * 顺手把旧的 false 存档清掉，免得将来哪天又加回开关时，用户一进来
     * 发现它是关着的、却想不起自己什么时候关过。
     */
    public static boolean isEnabled(Context ctx) {
        if (ctx == null) return true;
        try {
            SharedPreferences sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
            if (sp.getBoolean(KEY_ENABLED, true)) return true;
            /* 存的是 false：清掉，让「默认开」重新成为事实 */
            sp.edit().remove(KEY_ENABLED).apply();
        } catch (Throwable ignored) { }
        return true;
    }

    /**
     * 保留这个入口只是为了兼容（原生接口还在），但它不再把「关」写进存档 ——
     * 写了就没有入口能改回来。关掉 = 不排下一次轮询，下一次打开 App
     * （MainActivity.onResume）仍会重新挂上。
     */
    public static void setEnabled(Context ctx, boolean on) {
        if (ctx == null) return;
        try {
            ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                    .edit().putBoolean(KEY_ENABLED, true).apply();
            if (on) schedule(ctx); else cancel(ctx);
        } catch (Throwable ignored) { }
    }

    /* ==================================================================
     * 收到广播
     * ================================================================== */

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null) return;
        String action = (intent == null) ? null : intent.getAction();
        if (action != null && !ACTION_CHECK.equals(action)
                && !Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }

        /* goAsync() 给这段工作续一条命 —— onReceive 返回后进程随时可能被回收。
         * 拿到的 PendingResult 必须 finish()，且只能调一次。 */
        final PendingResult result = goAsync();
        final Context app = context.getApplicationContext();

        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    checkOnce(app);
                } catch (Throwable t) {
                    Log.w(TAG, "检查通知失败: " + t);
                } finally {
                    try { result.finish(); } catch (Throwable ignored) { }
                }
            }
        }, "notif-check").start();
    }

    /**
     * 真正的一次检查。调用方保证不在主线程。
     *
     * 顺便拿个 WakeLock：AlarmManager 的 _WAKEUP 只保证唤醒到 onReceive
     * 结束，goAsync 期间 CPU 可能睡下去，请求会卡在半路。
     */
    private static void checkOnce(Context ctx) {
        if (!isEnabled(ctx)) return;

        String token = SecurePrefs.get(ctx, "gh_token", "");
        if (token == null || token.isEmpty()) {
            /* 没登录：这一轮没得问，但链还得续 —— 用户随时可能登录 */
            try { scheduleAfter(ctx, INTERVAL_MS); } catch (Throwable ignored) { }
            return;
        }

        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wl = null;
        if (pm != null) {
            try {
                wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "githup:notif");
                wl.acquire(60 * 1000L);
            } catch (Throwable ignored) { wl = null; }
        }

        try {
            Map<String, String> headers = new HashMap<>();
            headers.put("Authorization", "Bearer " + token);
            headers.put("Accept", "application/vnd.github+json");
            headers.put("User-Agent", "githup/1.0");

            Http.Response r = Http.request("GET",
                    "https://api.github.com/notifications?per_page=20", null, headers);

            if (r == null || r.code < 200 || r.code >= 300) {
                /* 401 = 令牌失效、403 = 限流。都不弹通知，静默等下一轮。 */
                Log.d(TAG, "拉取通知返回 " + (r == null ? "null" : r.code) + "，本轮跳过");
                return;
            }

            /* ═══ 首次只记不发 ═══

               第一次拉到通知时，用户的未读箱里往往已经攒了几十上百条
               （从来没清过）。如果照单全发，一登录就被历史通知砸晕 ——
               那不是提醒，是轰炸。

               所以：从没检查过（lastCheck == 0）时，这一轮只把 id 记进
               去重表，一条都不弹。之后新来的才提醒。 */
            boolean firstRun = lastCheck(ctx) == 0;

            List<Item> fresh = parseFresh(ctx, r.body);
            if (fresh.isEmpty() || firstRun) {
                Log.d(TAG, firstRun ? "首次检查，只记不弹（避免历史通知轰炸）" : "没有新通知");
                return;
            }

            /* 权限没给就到此为止 —— 记过 id 了，下一轮不会重复提醒 */
            if (!canNotify(ctx)) {
                Log.d(TAG, "没有通知权限，跳过弹窗");
                return;
            }
            notify(ctx, fresh);
        } catch (Throwable t) {
            Log.w(TAG, "检查通知异常: " + t);
        } finally {
            if (wl != null) { try { wl.release(); } catch (Throwable ignored) { } }
            /* 链式调度：干完这一轮，排下一轮。
               放在 finally 里 —— 就算这轮请求失败/抛异常，链也不能断。 */
            try { scheduleAfter(ctx, INTERVAL_MS); } catch (Throwable ignored) { }
        }
    }

    /* ==================================================================
     * 解析与去重
     * ================================================================== */

    private static final class Item {
        String id;
        String title;
        String repo;
        String reason;
    }

    /** 解析出「还没提醒过」的未读通知 */
    private static List<Item> parseFresh(Context ctx, String body) {
        List<Item> out = new ArrayList<>();
        if (body == null || body.isEmpty()) return out;
        SharedPreferences sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
        String seenRaw = sp.getString(KEY_SEEN, "");
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (String s : seenRaw.split(",")) {
            if (!s.isEmpty()) seen.add(s);
        }

        try {
            JSONArray arr = new JSONArray(body);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                if (o.optBoolean("unread", false) == false) continue;

                String id = o.optString("id", "");
                if (id.isEmpty() || seen.contains(id)) continue;

                Item it = new Item();
                it.id = id;
                JSONObject subj = o.optJSONObject("subject");
                it.title = (subj != null) ? subj.optString("title", "") : "";
                if (it.title.isEmpty()) it.title = "新通知";
                JSONObject repo = o.optJSONObject("repository");
                it.repo = (repo != null) ? repo.optString("full_name", "") : "";
                it.reason = o.optString("reason", "");

                out.add(it);
                seen.add(id);
            }
        } catch (Throwable t) {
            Log.w(TAG, "解析通知失败: " + t);
        }

        /* 去重表落盘（不管有没有新通知，只要拉成功了就更新，避免反复重试） */
        try {
            StringBuilder sb = new StringBuilder();
            int n = 0;
            for (String s : seen) {
                if (n > 0) sb.append(',');
                sb.append(s);
                if (++n >= SEEN_MAX) break;
            }
            sp.edit().putString(KEY_SEEN, sb.toString())
                    .putLong(KEY_LAST, System.currentTimeMillis()).apply();
        } catch (Throwable ignored) { }

        return out;
    }

    /* ==================================================================
     * 发通知
     * ================================================================== */

    private static boolean canNotify(Context ctx) {
        try {
            NotificationManager nm =
                    (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return false;
            if (Build.VERSION.SDK_INT >= 24 && !nm.areNotificationsEnabled()) return false;
            if (Build.VERSION.SDK_INT >= 33) {
                if (ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                        != android.content.pm.PackageManager.PERMISSION_GRANTED) return false;
            }
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** 建（或复用）通知渠道。IMPORTANCE_DEFAULT = 状态栏有图标、通知栏占位。 */
    private static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            NotificationManager nm =
                    (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null || nm.getNotificationChannel(CHANNEL_NOTIF) != null) return;
            android.app.NotificationChannel ch = new android.app.NotificationChannel(
                    CHANNEL_NOTIF, "GitHub 通知", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("有人回复你、@你、或你关注的仓库有新动静时提醒");
            ch.enableVibration(false);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        } catch (Throwable ignored) { }
    }

    private static void notify(Context ctx, List<Item> items) {
        try {
            ensureChannel(ctx);
            NotificationManager nm =
                    (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            /*
              点通知 → 打开 App 的通知页。

              用 "route" 这个 extra：MainActivity.applyNotifRoute() 已经实现了
              「把 route 交给前端 Router.go」这条路，复用它比另写一套稳。
              通知页的路由是 /notifications（见 app.js 的 RESERVED 与路由表）。
            */
            Intent open = new Intent(ctx, MainActivity.class);
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            open.putExtra("route", "/notifications");
            int pif = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) pif |= PendingIntent.FLAG_IMMUTABLE;
            PendingIntent pi = PendingIntent.getActivity(ctx, 2102, open, pif);

            android.app.Notification.Builder b;
            if (Build.VERSION.SDK_INT >= 26) {
                b = new android.app.Notification.Builder(ctx, CHANNEL_NOTIF);
            } else {
                b = new android.app.Notification.Builder(ctx);
            }

            Item first = items.get(0);
            int total = items.size();

            if (total == 1) {
                String sub = first.repo.isEmpty() ? reasonText(first.reason) : first.repo;
                b.setContentTitle(first.title)
                 .setContentText(sub)
                 .setStyle(new android.app.Notification.BigTextStyle().bigText(
                         first.title + "\n" + sub));
            } else {
                /* 多条：用 InboxStyle 列出前几条，末尾说明还有多少 */
                android.app.Notification.InboxStyle inbox =
                        new android.app.Notification.InboxStyle();
                int n = Math.min(total, MAX_SHOW);
                for (int i = 0; i < n; i++) {
                    Item it = items.get(i);
                    inbox.addLine(it.repo.isEmpty() ? it.title : it.repo + "：" + it.title);
                }
                if (total > n) inbox.addLine("还有 " + (total - n) + " 条…");
                inbox.setBigContentTitle(total + " 条新通知");
                inbox.setSummaryText("点开查看全部");
                b.setContentTitle(total + " 条新通知")
                 .setContentText(items.get(0).title)
                 .setStyle(inbox);
            }

            b.setSmallIcon(android.R.drawable.stat_notify_chat)
             .setContentIntent(pi)
             .setAutoCancel(true)
             .setOnlyAlertOnce(true);

            try {
                int ic = ctx.getResources().getIdentifier("ic_launcher", "mipmap", ctx.getPackageName());
                if (ic != 0) {
                    b.setLargeIcon(android.graphics.BitmapFactory.decodeResource(
                            ctx.getResources(), ic));
                }
            } catch (Throwable ignored) { }

            nm.notify(3101, b.build());
            Log.d(TAG, "已发出通知，共 " + total + " 条");
        } catch (Throwable t) {
            Log.w(TAG, "发通知失败: " + t);
        }
    }

    /** 把 GitHub 的 reason 字段翻成中文 */
    private static String reasonText(String r) {
        if (r == null) return "GitHub 通知";
        if ("mention".equals(r)) return "有人提到了你";
        if ("assign".equals(r)) return "有人把任务指派给你";
        if ("author".equals(r)) return "你参与的话题有更新";
        if ("comment".equals(r)) return "有人评论了你参与的内容";
        if ("review_requested".equals(r)) return "有人请你评审";
        if ("state_change".equals(r)) return "状态有变化";
        if ("subscribed".equals(r)) return "你关注的仓库有动静";
        if ("team_mention".equals(r)) return "你的团队被提到";
        return "GitHub 通知";
    }

    /** 给设置页显示上次检查时间用 */
    public static long lastCheck(Context ctx) {
        if (ctx == null) return 0;
        try {
            return ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getLong(KEY_LAST, 0);
        } catch (Throwable ignored) { return 0; }
    }

    /** 清掉去重表（退出登录时用，换账号后 id 不该继承） */
    public static void resetSeen(Context ctx) {
        if (ctx == null) return;
        try {
            ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                    .edit().remove(KEY_SEEN).remove(KEY_LAST).apply();
        } catch (Throwable ignored) { }
    }
}
