package com.hubmobile.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 后台常驻的「动态码」通知。
 *
 * 干什么 ——
 *   用户把 App 退到后台之后，在通知栏留一条常驻通知，上面是两步验证器
 *   里各账户的当前动态码，每 30 秒自动换码、每秒刷新倒计时。这样在别的
 *   应用里要填验证码时，拉一下通知栏就能看到，不用切回 githup。
 *
 * 核心架构（两次闪退修复之后定型）——
 *
 *   1.2.15 初版：onPause → startForegroundService，onResume → stopService。
 *   在国产 ROM（一加 / OPPO / 努比亚）上必崩：
 *
 *   · Android 12+ 有「后台启动前台服务限制」。onPause 发起
 *     startForegroundService 时，系统可能已经把本应用判定为「后台」，
 *     服务里的 startForeground 会抛 ForegroundServiceStartNotAllowedException。
 *   · 第一版修复把 startForeground 提前到 onCreate 并用 try-catch 兜底，
 *     但异常被吞掉之后，ServiceRecord 上「必须进前台」的标记仍挂着，
 *     系统看门狗在 10 秒后照样抛出 ForegroundServiceDidNotStartInTimeException
 *     杀进程——异常投递到主线程，表现为「重新打开 App 后 1 秒闪退」。
 *
 *   现在的做法：
 *
 *   · onResume（App 必定在前台）就把服务拉起来，服务立刻进入前台状态，
 *     但挂的是 IMPORTANCE_MIN 的「安静通知」——状态栏没有图标，只在
 *     通知栏最底下缩成一条，使用 App 时完全无感。
 *   · onPause 时服务【已经是前台服务】了，只需把通知内容换成动态码，
 *     不发生任何新的「后台启动」，从根上绕开限制。
 *   · onResume 时再换回安静通知，服务保持存活，随时待命。
 *   · startForeground 真的失败（被系统拒绝）时，立刻 stopSelf 尽快移除
 *     ServiceRecord，绝不留着等看门狗来杀。
 *   · 用户从最近任务列表划掉 App（onTaskRemoved）时停掉服务，不永久空跑。
 *
 * 关于自启动 ——
 *   开机广播（见 BootReceiver）负责在重启后把通知恢复出来，BOOT_COMPLETED
 *   属于系统豁免的启动场景。部分国产 ROM 仍需用户在系统设置里额外允许
 *   「自启动」，App 不会反复弹窗纠缠。
 */
public class TotpService extends Service {

    /** 动态码渠道：LOW，退到后台时真正展示内容的通知 */
    private static final String CHANNEL_CODES = "githup_totp";
    /** 安静渠道：MIN，App 在前台时服务保命用，状态栏无图标、通知栏底部折叠 */
    private static final String CHANNEL_QUIET = "githup_totp_quiet";
    private static final int NOTIFY_ID = 7301;
    private static final String PREFS = "hub_prefs";
    private static final String KEY_ENABLED = "totp_bg_enabled";

    /** App 退到后台 / 开机恢复：展示动态码 */
    private static final String ACTION_SHOW = "com.hubmobile.totp.SHOW";
    /** App 回到前台：收回动态码、换安静通知，服务保持存活 */
    private static final String ACTION_HIDE = "com.hubmobile.totp.HIDE";

    /** 刷新间隔：动态码默认 30 秒一轮，1 秒刷一次足够跟上倒计时 */
    private static final long TICK_MS = 1000;

    private Handler handler;
    private Runnable ticker;
    /** 已解析的账户（每次刷新时重新读，免得前端改了列表这里还是旧的） */
    private List<JSONObject> accounts = new ArrayList<>();
    /** 上一次画出来的标题，内容没变就不重复 notify，省电 */
    private String lastText = "";
    /** startForeground 是否真正成功过；只有成功过系统的超时看门狗才不会咬人 */
    private boolean foregroundReady = false;

    /* ---------------- 外部开关 ---------------- */

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean isEnabled(Context ctx) {
        /*
         * 默认 true —— 设置页里那个「后台显示动态码」开关已经按用户要求删掉了，
         * 这个值不再由用户翻，所以不能停在 false 上，否则通知栏动态码
         * 永远出不来（第一步就是要它在通知里显示）。
         *
         * 默认开启不会造成骚扰，因为挂通知还有几道前置条件：
         *   · accounts.isEmpty() → stopSelf()，没有账户时一条通知都不留；
         *   · App 在前台时只挂 MIN 级安静通知，状态栏没有图标；
         *   · Android 13+ 没给通知权限时通知不显示，不影响 App 本身。
         * 也就是说用户没加过任何两步验证账户的话，这个 true 什么都不做。
         */
        return prefs(ctx).getBoolean(KEY_ENABLED, true);
    }

    /**
     * 申请通知权限（Android 13+），只在「还没授权」时静默发起一次。
     *
     * 以前这件事是在用户点设置页那个开关时做的。开关删掉之后，
     * 改成 App 启动 / 回到前台时顺手要一次 —— 不给也不纠缠，
     * 用户只是看不到通知栏里的动态码，App 其余功能一切照常。
     * 通过 JsBridge 走同一条权限申请路径（结果由 MainActivity 转回来）。
     */
    static void ensureNotificationPermission(MainActivity activity) {
        if (activity == null) return;
        if (Build.VERSION.SDK_INT < 33) return;
        try {
            if (activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED) {
                return;
            }
            activity.requestPermissions(
                    new String[]{android.Manifest.permission.POST_NOTIFICATIONS},
                    JsBridge.REQ_NOTIFY_PERM);
        } catch (Throwable ignored) {
            // 申请失败（比如没有 Activity 窗口）就当没这回事，不打断启动流程
        }
    }

    /**
     * 开 / 关后台通知。
     *
     * 设置页的开关删掉之后，前端已经不再调用这里 —— 保留是因为它仍然是
     * 「强制关掉」最干净的一条路（停服务 + 撤通知 + 落一个 false 的值），
     * 日后若要加回开关不必重写。当前默认值走 isEnabled 里的 true。
     */
    static void setEnabled(Context ctx, boolean on) {
        prefs(ctx).edit().putBoolean(KEY_ENABLED, on).apply();
        if (on) {
            send(ctx, null);
        } else {
            try { ctx.stopService(new Intent(ctx, TotpService.class)); } catch (Throwable ignored) { }
            cancel(ctx);
        }
    }

    /**
     * 账户列表变了：让服务换一副新内容。
     * 服务没在跑就顺手拉起来（调用方在前台 UI 里，启动合法）。
     */
    static void refresh(Context ctx) {
        if (!isEnabled(ctx)) return;
        send(ctx, null);
    }

    /**
     * 开机 / 覆盖安装后由 BootReceiver 调用：直接恢复成「展示动态码」状态。
     * BOOT_COMPLETED / MY_PACKAGE_REPLACED 属于系统豁免的前台服务启动场景。
     */
    static void sync(Context ctx) {
        if (!isEnabled(ctx)) {
            cancel(ctx);
            return;
        }
        send(ctx, ACTION_SHOW);
    }

    /**
     * App 退到后台时调用（MainActivity.onPause）：把动态码通知挂出来。
     *
     * 正常情况下服务在 onResume 时已经启动、已经是前台服务，这里只是
     * 让它把通知内容换成动态码（ACTION_SHOW → 仅更新通知，不触发任何
     * 新的前台启动）。万一服务没活着（被系统回收等极端情况），send
     * 内部对 startForegroundService 的异常也做了兜底，入口处被拒绝时
     * 最多是这次看不到通知，绝不会闪退。
     */
    static void showNotification(Context ctx) {
        if (ctx == null) return;
        if (!isEnabled(ctx)) return;
        send(ctx, ACTION_SHOW);
    }

    /**
     * App 回到前台时调用（MainActivity.onResume）。
     *
     * 注意：这里【不再停服务】，而是发 ACTION_HIDE ——
     * 服务保持存活，通知换成 MIN 级安静通知。这样下一次 onPause 时
     * 服务已经是前台状态，彻底避开 Android 12+ 的「后台启动前台服务」
     * 限制（1.2.15 两次闪退的根因）。
     * 服务若还没启动（冷启动后第一次 onResume），这里就以【前台身份】
     * 合法地把它拉起来。
     */
    static void hideNotification(Context ctx) {
        if (ctx == null) return;
        if (!isEnabled(ctx)) {
            try { ctx.stopService(new Intent(ctx, TotpService.class)); } catch (Throwable ignored) { }
            cancel(ctx);
            return;
        }
        send(ctx, ACTION_HIDE);
    }

    /**
     * 统一的服务启动入口。
     * 系统在入口处就拒绝（后台限制，抛 ForegroundServiceStartNotAllowedException
     * 或 IllegalStateException）时，结果只是「这次不显示通知」，绝不能让它崩。
     */
    private static void send(Context ctx, String action) {
        try {
            Intent i = new Intent(ctx, TotpService.class);
            if (action != null) i.setAction(action);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
            else ctx.startService(i);
        } catch (Throwable ignored) { }
    }

    private static void cancel(Context ctx) {
        try {
            NotificationManager nm = (NotificationManager)
                    ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIFY_ID);
        } catch (Throwable ignored) { }
    }

    /* ---------------- 服务生命周期 ---------------- */

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        ensureChannels();

        /*
         * 服务一旦创建，立刻尝试进入前台状态（先用安静通知）。
         *
         * 注意：这里绝不能像上一版修复那样「try-catch 吞掉异常继续跑」——
         * startForeground 抛 ForegroundServiceStartNotAllowedException
         * 意味着 ServiceRecord 上「必须进前台」的标记会一直挂着，
         * 10 秒后系统看门狗照样抛 ForegroundServiceDidNotStartInTimeException。
         *
         * 策略：安静通知失败 → 最简通知再试一次 → 还失败立刻 stopSelf，
         * 尽快让系统移除 ServiceRecord（服务销毁会取消挂起的超时消息）。
         */
        if (!promote(buildQuietNotification())) {
            if (!promote(buildBareNotification())) {
                stopSelf();
            }
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;

        // 再确保一次前台状态。正常情况下 onCreate 已成功，重复调用无副作用。
        if (!foregroundReady && !promote(buildQuietNotification())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        if (!isEnabled(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }

        reload();
        boolean empty = accounts.isEmpty();

        if (ACTION_SHOW.equals(action)) {
            // App 退到后台 / 开机恢复：展示动态码并开始每秒刷新
            stopTicker();
            if (empty) {
                stopSelf();
                return START_NOT_STICKY;
            }
            drawCodes();
            startTicker();
        } else {
            // ACTION_HIDE（onResume）或无 action（refresh / setEnabled）：
            // App 在前台，停掉刷新、换安静通知，服务保持存活待命。
            stopTicker();
            if (empty) {
                stopSelf();
                return START_NOT_STICKY;
            }
            showQuiet();
        }

        // START_STICKY：被系统回收后自动重建，通知不会莫名其妙消失
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 用户从最近任务列表划掉了 App：服务不必再留着，收摊。
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        stopTicker();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;   // 不需要绑定
    }

    /* ---------------- 前台状态 ---------------- */

    /**
     * 尝试真正进入前台状态。只有成功返回，系统的超时看门狗才不会咬人。
     *
     * @return true 表示 startForeground 成功；false 表示被系统拒绝
     *         （最典型：Android 12+ 后台启动限制），调用方必须立刻停服务。
     */
    private boolean promote(Notification n) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                // 显式带上 dataSync 类型（与 Manifest 声明一致），
                // 个别国产 ROM 对无类型 startForeground 处理不稳定。
                startForeground(NOTIFY_ID, n,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFY_ID, n);
            }
            foregroundReady = true;
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 换成安静通知（App 在前台时） */
    private void showQuiet() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIFY_ID, buildQuietNotification());
        } catch (Throwable ignored) { }
    }

    /* ---------------- 动态码刷新 ---------------- */

    private void startTicker() {
        stopTicker();
        ticker = new Runnable() {
            @Override
            public void run() {
                try {
                    update();
                } catch (Throwable ignored) { }
                // 每秒自查一次：账户被删空、或开关被关掉，就自行收摊
                if (!isEnabled(TotpService.this) || accounts.isEmpty()) {
                    stopSelf();
                    return;
                }
                handler.postDelayed(this, TICK_MS);
            }
        };
        handler.post(ticker);
    }

    private void stopTicker() {
        if (handler != null && ticker != null) handler.removeCallbacks(ticker);
        ticker = null;
    }

    /** 重新读一遍账户清单 */
    private void reload() {
        accounts = new ArrayList<>();
        /*
         * 去重：同一个账户被存了两份（换过 issuer / name、导入时重复写、
         * 旧版本缓存没清干净）时，通知里就会并排出现两行一模一样的码。
         * 这里按「规整后的密钥 + 发行方 + 账户名」判重，只留第一条。
         */
        java.util.HashSet<String> seen = new java.util.HashSet<>();
        try {
            String raw = prefs(this).getString("totp_accounts_cache", "[]");
            JSONArray arr = new JSONArray(raw == null ? "[]" : raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                String secret = o.optString("secret", "");
                if (secret.isEmpty()) continue;
                if (!"totp".equals(o.optString("type", "totp"))) continue;   // HOTP 没有时间概念，不在这展示
                String key = normKey(secret)
                        + "|" + o.optString("issuer", "")
                        + "|" + o.optString("name", "");
                if (!seen.add(key)) continue;   // 重复账户，丢掉
                accounts.add(o);
            }
        } catch (Throwable ignored) { }
    }

    /** 密钥规整：去掉空格 / 连字符 / 补位，统一大写 —— 判定「是不是同一个账户」用 */
    private static String normKey(String secret) {
        if (secret == null) return "";
        return secret.toUpperCase().replaceAll("[\\s\\-_]", "").replaceAll("=+$", "");
    }

    /** 立刻画一版动态码（不等第一拍 tick） */
    private void drawCodes() {
        lastText = "";
        update();
    }

    /** 算每个账户当前的码并重画通知 */
    private void update() {
        /*
         * 每一轮都重读一遍账户清单 —— 前端那边增删改账户之后，下一拍
         * 通知就要跟上。SharedPreferences 读的是进程内缓存，每秒一次的
         * 开销可忽略。
         */
        reload();
        if (accounts.isEmpty()) return;

        /*
         * 逐账户算码，坏账户跳过。
         * 谁算得出来就显示谁，一个坏账户（secret 损坏、原生端不认）
         * 不再拖垮整条通知。
         */
        List<String> lines = new ArrayList<>();
        String title = null;
        long left = 0;
        int period = 30;
        for (JSONObject acct : accounts) {
            String code = Totp.compute(acct);
            if (code == null || code.isEmpty()) continue;
            String name = acct.optString("issuer", "");
            if (name.isEmpty()) name = acct.optString("name", "");
            if (name.isEmpty()) name = "两步验证";
            String line = name + "  " + Totp.group(code);
            if (title == null) {
                // 第一个账户进标题行；它不再重复出现在展开列表里，
                // 否则单账户时收起 / 展开会看到两行一模一样的码。
                title = line;
                left = Totp.remaining(acct);
                int p = acct.optInt("period", 30);
                period = p > 0 ? p : 30;
                continue;
            }
            lines.add(line);
        }
        if (title == null) return;

        /*
         * 倒计时 —— 这一版的核心改动。
         *
         * 以前只有「还剩 N 秒」一句话，秒数藏在副标题里、一眼扫不到；
         * 现在同时给三种形态，用户随便哪种习惯都能看到：
         *   1) 系统原生进度条（setProgress）：从左退到右，剩余时间一眼可见；
         *   2) 副标题里的「剩余 Ns」大字；
         *   3) 展开视图里的一条方块进度条 + 秒数。
         */
        if (left < 0) left = 0;
        if (left > period) left = period;
        int elapsed = (int) (period - left);

        String text = "剩余 " + left + "s · " + period + " 秒一轮";
        if (accounts.size() > 1) text += " · 共 " + accounts.size() + " 个账户";

        // 内容没变（同一秒内重复触发）就不重复推，省电
        String stamp = title + "|" + text;
        if (stamp.equals(lastText)) return;
        lastText = stamp;

        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm == null) return;
            nm.notify(NOTIFY_ID, buildCodesNotification(title, text, lines, left, period, elapsed));
        } catch (Throwable ignored) { }
    }

    /**
     * 文字进度条：用方块画一条会走的倒计时。
     * 例：[██████░░░░░░] 18s
     */
    private static String bar(long left, int period) {
        int total = 10;
        int filled = (int) Math.round((left * 1.0 / period) * total);
        if (filled < 0) filled = 0;
        if (filled > total) filled = total;
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < filled; i++) sb.append('█');
        for (int i = filled; i < total; i++) sb.append('░');
        sb.append("] ").append(left).append('s');
        return sb.toString();
    }

    /* ---------------- 通知构建 ---------------- */

    private Notification.Builder newBuilder(String channelId) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return new Notification.Builder(this, channelId);
        }
        return new Notification.Builder(this);
    }

    /**
     * 安静通知：服务保命用。
     * 渠道 IMPORTANCE_MIN：状态栏无图标、无声，只在通知栏最底部折叠成一条。
     */
    private Notification buildQuietNotification() {
        Notification.Builder b = newBuilder(CHANNEL_QUIET);
        b.setSmallIcon(android.R.drawable.ic_lock_lock)
                .setContentTitle("githup")
                .setContentText("动态码随时待命")
                .setOngoing(true)
                .setShowWhen(false)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_SERVICE);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            b.setPriority(Notification.PRIORITY_MIN);
        }
        return b.build();
    }

    /**
     * 最简通知：安静通知都构建失败时的兜底，不带任何 PendingIntent /
     * 样式，只求 startForeground 能成功，不触发超时崩溃。
     */
    private Notification buildBareNotification() {
        Notification.Builder b = newBuilder(CHANNEL_QUIET);
        b.setSmallIcon(android.R.drawable.ic_lock_lock)
                .setContentTitle("githup")
                .setOngoing(true)
                .setShowWhen(false);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            b.setPriority(Notification.PRIORITY_MIN);
        }
        return b.build();
    }

    /**
     * 动态码通知：退到后台时真正展示的内容。
     *
     * @param title   标题行：第一个账户的「名字 + 分组后的码」
     * @param text    副标题：倒计时秒数 + 周期
     * @param lines   【除第一个之外】其余账户的行（第一个已在标题里，不再重复）
     * @param left    本轮剩余秒数
     * @param period  本轮总秒数
     * @param elapsed 已经过去的秒数（给系统进度条用）
     */
    private Notification buildCodesNotification(String title, String text, List<String> lines,
                                                long left, int period, int elapsed) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        // 直接落到验证器页面：从通知点进来就是要看码，不该让人再找一遍
        open.putExtra("route", "/totp");

        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, piFlags);

        Notification.Builder b = newBuilder(CHANNEL_CODES);
        b.setSmallIcon(android.R.drawable.ic_lock_lock)
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(pi)
                .setOngoing(true)              // 常驻：不能左右滑掉，否则用户以为坏了
                .setShowWhen(false)
                .setOnlyAlertOnce(true)        // 每秒刷新不能每秒响一声
                .setCategory(Notification.CATEGORY_STATUS);

        /*
         * 倒计时进度条（系统原生）：max = 本轮总秒数，progress = 已过秒数，
         * 于是条子会随秒数一格格填满，填满即换码。
         * 这是「看得见的倒计时」最直观的一种形态。
         */
        b.setProgress(period, elapsed, false);

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // 老系统没有渠道，用低优先级避免响铃与悬浮
            b.setPriority(Notification.PRIORITY_LOW);
        }

        // 展开了能一眼看清码，不用眯眼找。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
            Notification.InboxStyle style = new Notification.InboxStyle();
            /*
             * 大标题只放账户名与码。
             *
             * 以前这里会把每个账户再 addLine 一遍 —— 只有一个账户时，
             * 大标题是「GitHub 794 407」，下面又是一行「GitHub 794 407」，
             * 看起来就是「两排一模一样的数字」。现在第一个账户不再进列表，
             * 展开后标题 + 其余账户 + 倒计时行，绝不重复。
             */
            style.setBigContentTitle(title);
            // 展开视图的第一行就是倒计时：方块进度条 + 剩余秒数
            style.addLine(bar(left, period) + " 后刷新");
            if (lines != null && !lines.isEmpty()) {
                for (String l : lines) style.addLine(l);
            }
            style.addLine("打开 githup 可复制或管理账户");
            b.setStyle(style);
        }
        return b.build();
    }

    /**
     * Android 8+ 必须先建渠道才会有通知。
     *
     * 两个渠道：
     *   · githup_totp       IMPORTANCE_LOW —— 动态码，退后台时展示
     *   · githup_totp_quiet IMPORTANCE_MIN —— 服务保命，App 在前台时无感
     * 都不响铃、不震动、不弹角标。
     */
    private void ensureChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (nm.getNotificationChannel(CHANNEL_CODES) == null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_CODES, "两步验证动态码", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("在通知栏显示两步验证器的动态码（仅在你离开 App 时出现）");
            ch.setShowBadge(false);
            ch.enableVibration(false);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }

        if (nm.getNotificationChannel(CHANNEL_QUIET) == null) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_QUIET, "动态码后台服务", NotificationManager.IMPORTANCE_MIN);
            ch.setDescription("githup 随时准备在通知栏显示动态码（状态栏不显示图标）");
            ch.setShowBadge(false);
            ch.enableVibration(false);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }
    }
}
