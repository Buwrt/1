package com.hubmobile.app;

import android.app.Application;
import android.content.Intent;

/**
 * 最早的埋点：进程一起来就先把防护链跑一遍。
 *
 * 放在 Application 而不是 Activity 里，是为了让校验发生在任何界面出现之前 ——
 * 别人就算改了入口 Activity，这一层也还在。
 */
public class App extends Application {

    /** 最近一次校验断在哪一环（0 = 通过） */
    static int sBrokenRing = 0;
    static String sBrokenDetail = "";
    static String sBrokenCode = "";

    /**
     * App 当前是否在前台。
     *
     * 两步验证器的「后台常驻动态码」只在**后台**出现：
     * 用户正看着屏幕时页面上就有码，通知栏再挂一条纯属打扰 ——
     * 拉下通知栏还得先关掉它。所以前台一律撤掉、后台才挂出来。
     *
     * 放在 Application 上而不是某个 Activity：后台常驻服务、JsBridge
     * 都要读它，而这两者都不该依赖某个具体的界面实例。
     */
    static boolean sForeground = false;

    @Override
    public void onCreate() {
        super.onCreate();

        /* 第一件事：装崩溃自记。
         *
         * 必须排在 check() 前面 —— 防护链自己崩了、或者后面任何一环出事，
         * 都得先落盘留痕。真机上用户拿不到 logcat，「闪一下就没了」
         * 就是全部线索，没有这个文件就只能靠猜。 */
        try { CrashLog.install(this); } catch (Throwable ignored) { }

        /* 第二件事：起日志中心。
         * 它负责运行日志的落盘与「下载错误日志」报告的生成。
         * 顺序在 check() 之前 —— 防护链的判定结果也要记进日志。 */
        try { LogBook.install(this); } catch (Throwable ignored) { }

        check();
        /* 顺手把常用域名的 DNS 解析掉。
         *
         * 首屏那几个请求都要先解析 api.github.com，运营商 DNS 动辄上百毫秒，
         * 四个域名串起来够呛。这里在后台线程提前解析并进系统缓存，
         * 等用户点开页面时基本都是白捡的。
         * 预热失败无所谓，真正的请求该解析还是会解析。 */
        Http.warmUp();
    }

    /** 跑防护链，把结果记下来给各个界面用 */
    static void check() {
        App self = app();
        if (self == null) {
            /* Application 实例还没挂上 —— 常见于被注入框架代理了 Application
             * 创建的环境（真机日志已实锤：onCreate 时 app()==null，一秒后
             * onResume 里 verify 全过）。
             *
             * 这时候拿 null 去跑链只会得到一个假失败（R0），反而把
             * 调用方刚刚通过的判定覆盖掉 —— 公开版「闪退无字」就是它干的。
             * 所以这里直接让路：不跑链、不清状态，结果由调用方的
             * verify(真实 ctx) 说了算。 */
            return;
        }
        Guard.Result r = Guard.verify(self);
        sBrokenRing = r.ok ? 0 : r.brokenRing;
        sBrokenDetail = r.detail;
        sBrokenCode = r.code;

        /* 校验没过时，往当天的错误日志里记一条 —— 这是用户真正会碰到的
         * 「App 打不开 / 被拦下」场景，值得留下人话记录。
         * 通过就不必刷屏了，否则一天一次也没多大意思。
         * 两库差异点：私有库没有这段（它没有防护链）。 */
        try {
            if (!r.ok) {
                LogBook.error(self, "启动校验没通过，可能装到了被改过的包",
                        "第 " + r.brokenRing + " 环，" + r.detail + "（代码 " + r.code + "）");
            }
        } catch (Throwable ignored) { }
    }

    /** 当前这次运行是不是通过了防护链 */
    static boolean passed() {
        return sBrokenRing == 0;
    }

    private static App sInstance;
    static App app() { return sInstance; }

    public App() { sInstance = this; }

    /** 被判定为篡改时，跳到强制下载页（不返回、不可取消） */
    static void goBlocked(android.content.Context ctx) {
        try {
            Intent i = new Intent(ctx, BlockedActivity.class);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
            ctx.startActivity(i);
        } catch (Throwable ignored) { }
    }
}
