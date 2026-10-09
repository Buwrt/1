import java.io.File;
import java.lang.reflect.Field;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.*;

/**
 * 「明明在下，却弹速度太慢」—— 新旧两版判定对照模拟。
 *
 * 要点：两边**都不是手抄**的。
 *   · 阈值常量：分别从「改前」「改后」两份源码各自编译出的 JsBridge.class
 *     里反射读出，所以某一版的常量被改动会直接反映到结果上；
 *   · 判定流程：与各自 watchTick 里的真实顺序逐行对齐（见各自常量加载处注释）。
 *
 * 用法（见 tools/run-switch-sim.sh，它把下面三步串起来）：
 *   javac -d <新版class目录>  <新版 JsBridge.java>       # 需要 android.jar
 *   javac -d <旧版class目录>  <旧版 JsBridge.java>       # 从 git 历史里取
 *   java SwitchSim <新版class目录> <旧版class目录> [android.jar]
 *
 * 两个版本的 class 必须分别载荷 —— 所以这里用 parent=null 的 URLClassLoader，
 * 否则双亲委派会让 classpath 上的那一份把两边都解析成同一份，对照就没了。
 */
public class SwitchSim {

    static String AJ = "/opt/android-sdk/platforms/android-34/android.jar";
    static String NEW_DIR = null, OLD_DIR = null;

    /** 一组阈值 + 它们所属版本的判定实现 */
    static class Ver {
        String name;
        long watchMs, graceMs, stallLimit, connectLimit, minBps;
        int slowStrikes;
        boolean modern;

        Ver(String n, long w, long g, long s, long c, long m, int k, boolean modern) {
            name = n; this.watchMs = w; this.graceMs = g; this.stallLimit = s;
            this.connectLimit = c; this.minBps = m; this.slowStrikes = k; this.modern = modern;
        }
    }

    /** 任务状态：只保留参与判定的那几个字段 */
    static class T {
        long startedAt = 0, lastAt = 0, lastBytes = 0, firstDataAt = 0, stallAt = 0;
        int slowStrikes = 0;
    }

    static class R {
        long at = -1;
        String why = null;
    }

    /**
     * 跑一次下载直到换道（或跑完 ticks 拍都没切）。
     *
     * @param firstByteSec 首字节延迟：这段时间里一个字节都没有（先在建连）
     * @param kbps         出了数据之后的稳定速度，KB/s
     */
    static R run(Ver v, double firstByteSec, double stopSec, double kbps, int ticks) {
        T t = new T();
        R r = new R();
        // startedAt = 0（发车时刻），lastAt 初值 = startedAt（见 startTask）
        t.startedAt = 0;
        t.lastAt = 0;
        if (v.modern) t.lastAt = 0;   // 改后：lastAt 到首字节才定，但初值同是 0

        for (int i = 1; i <= ticks; i++) {
            long now = i * v.watchMs;
            // 分段：[0, firstByte) 建连，0 字节；[firstByte, stop) 按 kbps 跑；stop 之后彻底冻结
            double flowSec = now / 1000.0 - firstByteSec;
            if (stopSec >= 0) flowSec = Math.min(flowSec, stopSec - firstByteSec);
            long sofar = (long) (Math.max(0.0, flowSec) * kbps * 1024);

            if (v.modern) {
                /* ---------- 改后：与当前 watchTick 逐行对齐 ---------- */
                if (t.firstDataAt == 0) {
                    if (sofar <= 0) {
                        if (now - t.startedAt >= v.connectLimit) { r.at = now; r.why = "连接超时"; return r; }
                        continue;
                    }
                    t.firstDataAt = now;
                    t.lastAt = now;
                    t.lastBytes = sofar;
                    t.stallAt = now;
                    continue;
                }
                long dt = now - t.lastAt;
                long dB = sofar - t.lastBytes;
                t.lastAt = now;
                t.lastBytes = sofar;
                if (dt <= 0) continue;
                long speed = dB * 1000L / dt;
                if (dB <= 0) {
                    if (now - t.stallAt >= v.stallLimit) { r.at = now; r.why = "连接卡住"; return r; }
                    continue;
                }
                t.stallAt = now;
                if (speed >= v.minBps) { t.slowStrikes = 0; continue; }
                if (now - t.firstDataAt < v.graceMs) continue;
                if (++t.slowStrikes >= v.slowStrikes) { r.at = now; r.why = "速度太慢"; return r; }
            } else {
                /* ---------- 改前：见老源码 1072-1085 行 ---------- */
                long dt = now - t.lastAt;
                long dB = sofar - t.lastBytes;
                t.lastAt = now;
                t.lastBytes = sofar;
                if (dt <= 0) continue;
                long speed = dB * 1000L / dt;
                if (speed >= v.minBps) { t.slowStrikes = 0; continue; }
                if (now - t.startedAt < v.graceMs) continue;
                if (++t.slowStrikes >= v.slowStrikes) { r.at = now; r.why = "速度太慢"; return r; }
            }
        }
        return r;
    }

    /** 从指定 class 目录里反射读 JsBridge 的真实常量 */
    static Ver load(String tag, String classesDir, boolean modern) throws Exception {
        // parent 必须是 null：默认双亲委派会让应用 classpath 里的那份 JsBridge
        // 抢先把两个版本都解析成同一份，对照就失效了。
        URLClassLoader cl = new URLClassLoader(new URL[]{
                new File(classesDir).toURI().toURL(),
                new File(AJ).toURI().toURL()
        }, null);
        // initialize=false：静态常量是编译期内联的，没必要触发 <clinit>，
        // 免得拉起一堆 android.* 依赖。
        Class<?> c = Class.forName("com.hubmobile.app.JsBridge", false, cl);
        long watch = lng(c, "WATCH_MS");
        long grace = lng(c, "GRACE_MS");
        long min = lng(c, "MIN_SPEED_BPS");
        Field sf = c.getDeclaredField("SLOW_STRIKES");
        sf.setAccessible(true);
        int strikes = sf.getInt(null);
        long stall = 0, connect = 0;
        try { stall = lng(c, "STALL_LIMIT"); } catch (Throwable ignored) { }
        try { connect = lng(c, "CONNECT_LIMIT"); } catch (Throwable ignored) { }
        return new Ver(tag, watch, grace, stall, connect, min, strikes, modern);
    }

    static long lng(Class<?> c, String n) throws Exception {
        Field f = c.getDeclaredField(n);
        f.setAccessible(true);
        return f.getLong(null);
    }

    public static void main(String[] args) throws Exception {
        NEW_DIR = args.length > 0 ? args[0] : "/tmp/swsim/out";
        OLD_DIR = args.length > 1 ? args[1] : "/tmp/swsim/out_old";
        AJ = args.length > 2 ? args[2]
                : (System.getenv("ANDROID_HOME") != null
                   ? System.getenv("ANDROID_HOME") + "/platforms/android-34/android.jar"
                   : AJ);
        Ver old = load("改前", OLD_DIR, false);
        Ver neo = load("改后", NEW_DIR, true);

        System.out.println("阈值（分别反射读自两版各自编译出的 JsBridge，非手抄）");
        System.out.printf("  %-4s WATCH=%dms  GRACE=%dms  STRIKES=%d  MIN=%dKB/s  STALL=%s  CONNECT=%s%n",
                old.name, old.watchMs, old.graceMs, old.slowStrikes, old.minBps / 1024,
                old.stallLimit == 0 ? "无" : old.stallLimit + "ms",
                old.connectLimit == 0 ? "无" : old.connectLimit + "ms");
        System.out.printf("  %-4s WATCH=%dms  GRACE=%dms  STRIKES=%d  MIN=%dKB/s  STALL=%s  CONNECT=%s%n%n",
                neo.name, neo.watchMs, neo.graceMs, neo.slowStrikes, neo.minBps / 1024,
                neo.stallLimit == 0 ? "无" : neo.stallLimit + "ms",
                neo.connectLimit == 0 ? "无" : neo.connectLimit + "ms");

        // 场景：{名称, 首字节延迟(s), 冻结时刻(s)(-1=不冻), 速度KB/s, 期望改后是否换道}
        Object[][] scenes = {
                {"① 500KB/s 好通道，3.4s 才出首字节", 3.4, -1.0, 500.0, false},
                {"② 300KB/s 好通道，4.6s 出首字节（弱网握手）", 4.6, -1.0, 300.0, false},
                {"③ 120KB/s 中等通道，3.2s 出首字节", 3.2, -1.0, 120.0, false},
                {"④ 20KB/s 稳定跑（高于 15KB/s 阈值，不该切）", 1.0, -1.0, 20.0, false},
                {"⑤ 被限速 8KB/s，一直低于阈值", 1.0, -1.0, 8.0, true},
                {"⑥ 出了 30KB 之后彻底不动（半路卡死）", 1.0, 1.3, 100.0, true},
                {"⑦ 从头到尾一个字节都没有（连不通）", 99.0, -1.0, 100.0, true},
        };

        System.out.printf("%-40s %-22s %-22s %s%n", "场景", "改前", "改后", "结论");
        System.out.println("-".repeat(104));

        boolean pass = true;
        int caughtByOld = 0, goodScenes = 0;
        for (Object[] sc : scenes) {
            String name = (String) sc[0];
            double delay = (Double) sc[1], stop = (Double) sc[2], kbps = (Double) sc[3];
            boolean shouldSwitch = (Boolean) sc[4];
            R b = run(old, delay, stop, kbps, 60);
            R a = run(neo, delay, stop, kbps, 60);
            String bs = b.at < 0 ? "不切" : String.format("t=%.1fs %s", b.at / 1000.0, b.why);
            String as = a.at < 0 ? "不切" : String.format("t=%.1fs %s", a.at / 1000.0, a.why);

            boolean ok = (a.at >= 0) == shouldSwitch;
            if (!ok) pass = false;
            String verdict;
            if (shouldSwitch) {
                verdict = ok ? "仍被兜住 ✓" : "漏了 ✗";
            } else {
                boolean oldBad = b.at >= 0;
                if (oldBad) caughtByOld++;
                goodScenes++;
                verdict = (oldBad ? "旧版误切 → 已修" : "本来就不切") + (ok ? " ✓" : " ✗");
            }
            System.out.printf("%-40s %-22s %-22s %s%n", name, bs, as, verdict);
        }

        System.out.println();
        System.out.println(pass ? "✅ 改后行为全部符合预期" : "❌ 有场景不符合预期");
        System.out.printf("旧版被误切的好通道场景：%d / 3%n", caughtByOld);

        checkChannels();
    }

    /**
     * 通道清单的两条不变量：
     *   1) 加速通道不少于 10 条（用户明确要求的最低条数）；
     *   2) 不管「上次通的通道」传的是什么，直连都必须在**最后**一条。
     *
     * 这里直接反射调用编译好的 DownloadChannels.candidates()，不另写一版逻辑 ——
     * 重写的版本就算跟真实逻辑跑偏了也照样能跑绿，那就没有验证意义了。
     */
    static void checkChannels() throws Exception {
        Class<?> dc = Class.forName("com.hubmobile.app.DownloadChannels", false,
                new URLClassLoader(new URL[]{
                        new File(NEW_DIR).toURI().toURL(),
                        new File(AJ).toURI().toURL()
                }, null));
        Field mf = dc.getDeclaredField("MIRRORS");
        mf.setAccessible(true);
        String[] mirrors = (String[]) mf.get(null);

        System.out.printf("%n加速通道 %d 条 + 直连 1 条 = 共 %d 条路径%n", mirrors.length, mirrors.length + 1);
        for (int i = 0; i < mirrors.length; i++) {
            System.out.printf("  加速 %-2d → %s%n", i + 1, mirrors[i]);
        }

        java.lang.reflect.Method cand = dc.getDeclaredMethod(
                "candidates", String.class, boolean.class, String.class);
        cand.setAccessible(true);
        java.lang.reflect.Method keyOf = dc.getDeclaredMethod("channelKey", String.class);
        keyOf.setAccessible(true);
        Field df = dc.getDeclaredField("DIRECT");
        df.setAccessible(true);
        String direct = (String) df.get(null);

        String asset = "https://github.com/Buwrt/githup/releases/download/v1.1.5/githup-1.1.5.apk";
        String[] lastChannels = {null, "", direct, mirrors[mirrors.length - 1], mirrors[0]};

        boolean allOk = mirrors.length >= 10;
        System.out.println();
        for (String last : lastChannels) {
            @SuppressWarnings("unchecked")
            java.util.List<String> list = (java.util.List<String>) cand.invoke(null, asset, true, last);
            String shown = last == null ? "无记录" : last.isEmpty() ? "空串" : last;
            String tailKey = (String) keyOf.invoke(null, list.get(list.size() - 1));
            boolean ok = list.size() == mirrors.length + 1 && direct.equals(tailKey);
            if (!ok) allOk = false;
            System.out.printf("  上次=%-30s 共 %2d 条，末尾：%s %s%n",
                    shown, list.size(), direct.equals(tailKey) ? "直连" : tailKey, ok ? "✓" : "✗");
        }
        System.out.println();
        System.out.println(allOk
                ? "✅ 通道清单符合预期：加速 ≥10 条，且直连永远排最后"
                : "❌ 通道清单有不符合预期的地方");
    }
}
