package com.hubmobile.app;

import android.content.Context;
import android.os.Build;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 崩溃自记：让「闪一下就退回桌面」不再是个死局。
 *
 * 为什么需要它 ——
 *   真机上出的问题，用户手上没有 logcat，也接不上电脑。
 *   现象只剩「点图标闪一下就没了」。没有堆栈，排查全靠猜。
 *
 *   这里在最外层装一个未捕获异常处理器：进程无论因为什么崩，
 *   先把堆栈写进 App 私有目录的一个小文件，再放行给系统默认处理器
 *   （该崩还是崩，只是崩得有据可查）。
 *
 * 存在哪 ——
 *   /data/data/<包名>/files/last_crash.txt
 *   覆盖式写「最近一次」，不做轮转：排查时只关心最后一次。
 *   文件里的内容包含：时间、包名、版本、Android 版本、机型，
 *   以及完整的异常堆栈。
 *
 * 怎么用 ——
 *   App 启动时调 CrashLog.install()，并把上次的记录读出来
 *   （CrashLog.readLast），挂到通知栏 / 通过 JsBridge 给前端看。
 */
final class CrashLog {

    private CrashLog() { }

    private static final String FILE_NAME = "last_crash.txt";
    private static volatile boolean installed = false;

    /** 只装一次：装在 Application.onCreate 的最前面 */
    static void install(final Context ctx) {
        if (installed) return;
        installed = true;

        final Thread.UncaughtExceptionHandler prev =
                Thread.getDefaultUncaughtExceptionHandler();

        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread t, Throwable e) {
                try {
                    write(ctx, t, e);
                } catch (Throwable ignored) {
                    // 记日志本身再出事就只能放弃了，不能再往外抛
                }
                if (prev != null) prev.uncaughtException(t, e);
            }
        });
    }

    private static void write(Context ctx, Thread t, Throwable e) {
        StringWriter sw = new StringWriter();
        PrintWriter pw = new PrintWriter(sw);
        pw.println("时间   : " + now());
        pw.println("包名   : " + safe(ctx.getPackageName()));
        pw.println("版本   : " + versionOf(ctx));
        pw.println("Android: " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")");
        pw.println("机型   : " + Build.MANUFACTURER + " " + Build.MODEL);
        pw.println("线程   : " + (t == null ? "?" : t.getName()));
        pw.println("---- 堆栈 ----");
        if (e != null) e.printStackTrace(pw);
        pw.flush();

        File f = new File(ctx.getFilesDir(), FILE_NAME);
        FileOutputStream fos = null;
        try {
            fos = new FileOutputStream(f, false);
            fos.write(sw.toString().getBytes("UTF-8"));
            fos.flush();
        } catch (Throwable ignored) {
            // 落盘失败（磁盘满 / 无权限）就放弃，不能让记日志本身把进程再搞崩一次
        } finally {
            close(fos);
        }

        /* 转交给错误日志：在当天小本子里留一条大白话记录 + 完整堆栈。
         * 崩溃全文仍以本文件为准；这里再记一份，是为了让用户下载的
         * 那个「错误日志」能独立看懂，不必再去找 last_crash.txt。 */
        try {
            LogBook.crash(ctx, crashBrief(e), sw.toString());
        } catch (Throwable ignored) { }
    }

    /** 从异常里提炼一句人话摘要，给普通用户看 */
    private static String crashBrief(Throwable e) {
        if (e == null) return "程序异常退出";
        String cls = e.getClass().getSimpleName();
        String msg = e.getMessage();
        if (msg != null && !msg.isEmpty()) {
            if (msg.length() > 80) msg = msg.substring(0, 80) + "…";
            return cls + "：" + msg;
        }
        return cls;
    }

    /** 读上次崩溃记录；没有就返回 null */
    static String readLast(Context ctx) {
        try {
            File f = new File(ctx.getFilesDir(), FILE_NAME);
            if (!f.exists() || f.length() == 0) return null;
            java.io.FileInputStream in = new java.io.FileInputStream(f);
            try {
                byte[] buf = new byte[(int) f.length()];
                int off = 0, n;
                while (off < buf.length && (n = in.read(buf, off, buf.length - off)) > 0) {
                    off += n;
                }
                String s = new String(buf, 0, off, "UTF-8");
                return s.isEmpty() ? null : s;
            } finally {
                close(in);
            }
        } catch (Throwable t) {
            return null;
        }
    }

    /** 用户看过之后清掉，免得下次启动又弹一遍 */
    static void clear(Context ctx) {
        try {
            File f = new File(ctx.getFilesDir(), FILE_NAME);
            if (f.exists()) f.delete();
        } catch (Throwable ignored) { }
    }

    private static String now() {
        return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date());
    }

    private static String safe(String s) { return s == null ? "" : s; }

    private static String versionOf(Context ctx) {
        try {
            android.content.pm.PackageInfo pi =
                    ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            return pi.versionName + " (" + pi.versionCode + ")";
        } catch (Throwable t) {
            return "?";
        }
    }

    private static void close(java.io.Closeable c) {
        if (c == null) return;
        try { c.close(); } catch (Throwable ignored) { }
    }
}
