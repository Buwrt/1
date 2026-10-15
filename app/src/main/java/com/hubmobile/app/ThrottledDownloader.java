package com.hubmobile.app;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Map;

/**
 * 限速下载器 —— **故意慢**的那条路。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 它是什么
 * ═══════════════════════════════════════════════════════════════════
 *
 * 给「没有给本软件仓库点 Star」的用户用的下载通道。和其余通道
 * （10 条加速镜像 + 直连，都交给系统 DownloadManager）最大的不同：
 * **这里是自己拿着字节流在写文件**。
 *
 * 为什么必须自己写：限速的关键是「按已下字节数算该花多久，多快就 sleep 补齐」，
 * 以及「每隔一会儿主动断一下」。这两件事都要求能看到**每一个字节**。
 * DownloadManager 是系统服务，它只肯给你「排队的进度百分比」，
 * 想让它精确跑 150KB/s 是做不到的 —— 它的 pause/resume 是分钟级的手感。
 *
 * ═══════════════════════════════════════════════════════════════════
 * ⚠️ 铁律：限速可以，但**绝不能让用户下不到**
 * ═══════════════════════════════════════════════════════════════════
 *
 * 限速是「提醒」，不是「惩罚到死」。用户点了下载，最后必须拿到文件。
 * 所以这个类里有三层保命设计，改代码时一条都不许删：
 *
 *   1. **落盘走应用私有目录中转**（见 JsBridge.startThrottledDownload）——
 *      Android 10+ 分区存储下，App 自己 new FileOutputStream 写公共
 *      Download/ 会被系统拒绝（EACCES），那样限速通道就是 100% 失败。
 *      所以这里只管写私有目录，下完再由上层搬到公共目录。
 *   2. **可重试**：网络抖一下就整包报废是不能接受的（见 JsBridge 的重试）。
 *   3. **兜底直链**：限速通道自己重试完还是不成，上层直接切**直链**——
 *      注意是直链，不是加速、更不是在限速里死磕（见 JsBridge 的策略注释）。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 它的边界（诚实说明，别指望它办到做不到的事）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 它**不是**在封用户的带宽。用户的宽带该多快还是多快，别的 App 该跑满还跑满。
 * 它做的只是：**这条下载走一条慢路**。
 *
 * ═══════════════════════════════════════════════════════════════════
 * 参数
 * ═══════════════════════════════════════════════════════════════════
 *
 *   · 目标速度     100~200 KB/s 之间浮动（取区间内的一个值，不是恒定死数）
 *   · 断流节奏     每 15 秒断一次
 *   · 单次断流     5~8 秒
 *   · 断流硬上限   60 秒 —— 这是**红线**，宁可失败也不能超过
 *   · 总断流预算   120 秒 —— 超过就不再断流，老实把剩余部分下完
 */
final class ThrottledDownloader {

    private ThrottledDownloader() { }

    /* ─────────────── 限速参数 ─────────────── */

    /**
     * 目标速度区间：100~200 KB/s。
     *
     * 为什么给个区间而不是一个死数：恒定速度看起来太"机械"，而且用户拿
     * 秒表一掐就能算出规律。在区间内每轮随机取一个，观感上更像"这条通道
     * 本来就不稳"，而不是"软件在整我"。
     *
     * 为什么定在 100KB/s 以上：再低就不是"提醒"而是"没法用"了。
     * 一个 10MB 的包，150KB/s 大约 70 秒能下完 —— 慢得让人注意到，
     * 但等得起。压到 30KB/s 的话要 5 分钟，用户直接卸了，Star 也就不用谈了。
     */
    private static final long MIN_BYTES_PER_SEC = 100L * 1024L;
    private static final long MAX_BYTES_PER_SEC = 200L * 1024L;

    /** 每下这么多时间，断一次 */
    private static final long STALL_EVERY_MS = 15_000L;

    /** 单次断流时长区间 */
    private static final long STALL_MIN_MS = 5_000L;
    private static final long STALL_MAX_MS = 8_000L;

    /**
     * 单次断流的硬上限 —— **60 秒，不许超**。
     *
     * 这是需求里明确划的红线。代码里所有算出来的断流时长都必须过一遍
     * {@link Math#min}，宁可短不可长：断流只是"烦人"，卡死就是"坏了"，
     * 两者的用户观感天差地别。
     */
    static final long STALL_HARD_CAP_MS = 60_000L;

    /** 读缓冲，64KB —— 比默认的 8KB 少一半系统调用，又不至于让 sleep 粒度太粗 */
    private static final int BUF_SIZE = 64 * 1024;

    /** 进度回调的最小间隔：太密了刷 UI 反而卡 */
    private static final long PROGRESS_EVERY_MS = 500L;

    /**
     * 整个下载过程中累计的断流时长，也得有个总上限。
     *
     * 单次 60 秒是红线，但要是断 20 次呢？那就是 20 分钟 —— 用户早以为
     * 软件死了。所以总断流预算也给一个：超过就**不再断流**，老老实实
     * 用限速的速度把剩余部分下完。断流是为了提醒，不是为了折磨。
     */
    private static final long STALL_TOTAL_BUDGET_MS = 120_000L;

    /**
     * 最多重试几轮（含第一轮）。
     *
     * 3 轮是权衡的结果：
     *   · 太少（1 轮）→ 网络抖一下就失败，这是用户最不能接受的；
     *   · 太多 → 地址本身有问题时（比如 404），用户要干等好几轮才看到失败。
     *
     * 每一轮都是**接着上次的进度**下（Range 续传），所以多来一轮的代价
     * 只是几秒钟，不会重下已经下好的部分。
     */
    private static final int MAX_ATTEMPTS = 3;

    /* ─────────────── 回调 ─────────────── */

    /** 进度/状态回调。实现方负责切回主线程（本类跑在后台线程上）。 */
    interface Listener {
        /**
         * @param done  已下载字节
         * @param total 总字节，<=0 表示未知
         * @param bps   当前速度（字节/秒）
         */
        void onProgress(long done, long total, long bps);

        /** 下完了（文件已完整落盘） */
        void onDone(File file, long bytes);

        /**
         * 失败了。失败原因已经是可以直接给用户看的白话。
         *
         * @param retryable true = 换条通道再试还可能有戏（网络抖动之类）；
         *                  false = 换了也白搭（地址本身就不对）
         */
        void onFail(String reason, boolean retryable);
    }

    /* ─────────────── 控制句柄 ─────────────── */

    /**
     * 一个正在跑的限速下载。外面拿着它可以取消。
     *
     * 为什么要有这个类而不是直接给个 Thread：取消得是**可中断**的。
     * 线程可能正卡在 sleep（断流那段）或者 read 上，光设个 flag 它不知道，
     * 得靠 interrupt 把它从阻塞里捅出来。
     */
    static final class Handle {
        private final Thread thread;
        private volatile boolean cancelled = false;

        Handle(Thread thread) { this.thread = thread; }

        void cancel() {
            cancelled = true;
            thread.interrupt();
        }

        boolean isCancelled() { return cancelled; }
    }

    /**
     * 起一个限速下载。
     *
     * 调用方负责：把文件放到临时位置、下完再改名（避免用户看到一个半成品
     * 就点开）。这里只管把字节从网上搬到文件里。
     *
     * @param url       原始下载地址（不走镜像 —— 限速通道就是要老实直连）
     * @param target    最终落盘位置
     * @param headers   要带的请求头（如 Authorization）；可为 null
     * @param listener  进度回调
     * @return 控制句柄，可用来取消
     */
    static Handle start(String url, File target, Map<String, String> headers, Listener listener) {
        return start(url, target, headers, listener, true, 0L, 0L);
    }

    /**
     * 续传接管 —— **不限速**地从 alreadyBytes 往后接着下。
     *
     * ═══ 它解决什么问题 ═══
     *
     * 换道（加速 N → 加速 N+1）时，系统 DownloadManager **无法续传**：
     * 每次 enqueue 都是一个独立任务、写进一个独立文件，带 Range 头只会让
     * 服务端返回「剩余那一段」，而 DownloadManager 会把这**一段**写成新文件
     * （Android 10+ 下 MediaStore 遇同名还会自动改名成 xxx(1).apk）。
     * 它绝不会追加到我们已经下了一半的那个文件上。
     * 于是上层按磁盘真实大小一验就发现不对，只好整份重下 ——
     * 用户看到的就是「换个通道，进度条回到 0，白等半天」。
     *
     * 所以换道续传必须交给**自己拿着字节流写文件**的这条路：它能以 append
     * 模式打开已有的 .part，从指定偏移接着写。这就是本方法的用途。
     *
     * ═══ 为什么不限速 ═══
     *
     * 这个类的默认行为是「故意慢」（给没点 Star 的用户）。但换道续传是
     * **所有用户都会碰到的正常路径** —— 不能因为换了次通道就把人家从
     * 满速打成 100~200KB/s，那比从头下还糟。
     * 所以这里 throttle=false：不控速、不主动断流。
     *
     * @param alreadyBytes 调用方已经写进 .part 的字节数（前缀长度）
     */
    static Handle resume(String url, File target, Map<String, String> headers,
                         Listener listener, long alreadyBytes) {
        return resume(url, target, headers, listener, alreadyBytes, 0L);
    }

    /**
     * @param expectedTotal 预期总长（>0 时校验远端是不是同一个文件）。
     *
     * 为什么要有这个参数 ——
     *
     * 换道接管时，前缀是从 DownloadManager 那儿复制过来的，而新通道是**另一个
     * 域名**（镜像换了）。要是新通道返回的其实是别的东西（错误页、另一个版本），
     * 拼上去就是个坏包。所以必须拿远端报的总长跟预期对一下。
     *
     * 这个校验**并进正式的续传请求里做**，不再单独发一次探测 —— 见 runOnce
     * 的说明：多一次往返正是「换个通道白等半天」的一部分。
     */
    static Handle resume(String url, File target, Map<String, String> headers,
                         Listener listener, long alreadyBytes, long expectedTotal) {
        return start(url, target, headers, listener, false, alreadyBytes, expectedTotal);
    }

    /**
     * @param throttle     true = 限速（含断流）；false = 全速
     * @param seedBytes    > 0 表示 .part 里已有这么多字节的前缀，直接接着下，
     *                     跳过远端的 .part.meta 校验（那是给"上次没下完"用的，
     *                     接管场景的前缀来源是 DownloadManager，本来就没有 meta，
     *                     拿它比只会误判成"版本变了"然后把前缀丢掉）。
     */
    private static Handle start(String url, File target, Map<String, String> headers,
                                Listener listener, boolean throttle, long seedBytes,
                                long expectedTotal) {
        Thread t = new Thread(
                () -> runWithRetry(url, target, headers, listener, throttle, seedBytes,
                        expectedTotal),
                throttle ? "throttled-dl" : "resume-dl");
        Handle h = new Handle(t);
        t.start();
        return h;
    }

    /**
     * 给接管场景用：算出这个 url 对应的 .part 临时文件在哪。
     *
     * 调用方把 DownloadManager 已经下到的字节写进这个文件，再调 resume()，
     * 两边必须用**同一个**路径 —— 写错地方就等于什么都没接管。
     */
    static File partFileFor(File target, String url) {
        return tmpFile(target.getParentFile(), url, target.getName());
    }

    /* ─────────────── .part 的命名、档案读写、远端校验 ─────────────── */

    /**
     * 临时文件按 **URL 的哈希** 命名，不再只按附件文件名。
     *
     * 同名不同仓库的附件（app-release.apk 满地都是）以前会共用同一个
     * .part，A 仓库下的一半被 B 仓库接着用 —— 光靠文件名根本分不开。
     *
     * 名字里保留原文件名是为了排查问题时人还能看出下的是什么。
     */
    private static File tmpFile(File dir, String url, String name) {
        String h = shortHash(url == null ? "" : url);
        String safe = name == null ? "file" : name.replaceAll("[^A-Za-z0-9._-]", "_");
        if (safe.length() > 40) safe = safe.substring(0, 40);
        return new File(dir, safe + "." + h + ".part");
    }

    /** .part 旁边的档案文件 */
    private static File metaFile(File tmp) {
        return new File(tmp.getParentFile(), tmp.getName() + ".meta");
    }

    private static String shortHash(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] d = md.digest(s.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 8; i++) {
                sb.append(Integer.toHexString((d[i] & 0xff) | 0x100).substring(1));
            }
            return sb.toString();
        } catch (Throwable ignored) {
            return Integer.toHexString(s.hashCode());
        }
    }

    /** 远端此刻的身份：ETag / Last-Modified / 长度 */
    private static final class Remote {
        String etag;
        String lastModified;
        long length = -1;
        boolean reached = false;   // 连得上才算数；连不上时不做判断
    }

    /**
     * 问远端一句"你现在是什么版本"。
     *
     * 只发 HEAD，代价很小。拿不到（服务器不支持 HEAD / 网络不通）时
     * reached=false，调用方就不据此丢弃本地进度 —— 宁可保守续传，
     * 也不能因为探测失败就把用户下了一半的东西删掉。
     */
    private static Remote probeRemote(String url, Map<String, String> headers) {
        Remote r = new Remote();
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod("HEAD");
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(10_000);
            c.setReadTimeout(10_000);
            c.setRequestProperty("User-Agent", "githup-android");
            c.setRequestProperty("Accept-Encoding", "identity");
            if (headers != null) {
                for (Map.Entry<String, String> e : headers.entrySet()) {
                    if (e.getKey() != null && e.getValue() != null) {
                        c.setRequestProperty(e.getKey(), e.getValue());
                    }
                }
            }
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) return r;
            r.etag = c.getHeaderField("ETag");
            r.lastModified = c.getHeaderField("Last-Modified");
            r.length = c.getHeaderFieldLong("Content-Length", -1);
            r.reached = true;
            return r;
        } catch (Throwable ignored) {
            return r;
        } finally {
            if (c != null) { try { c.disconnect(); } catch (Throwable ignored) { } }
        }
    }

    /** 写档案 */
    private static void writeMeta(File tmp, String url, Remote r, long bytes) {
        try {
            StringBuilder sb = new StringBuilder();
            sb.append(url == null ? "" : url).append('\n');
            sb.append(r.etag == null ? "" : r.etag).append('\n');
            sb.append(r.lastModified == null ? "" : r.lastModified).append('\n');
            sb.append(r.length < 0 ? "" : String.valueOf(r.length)).append('\n');
            sb.append(bytes).append('\n');
            FileOutputStream o = new FileOutputStream(metaFile(tmp), false);
            try {
                o.write(sb.toString().getBytes("UTF-8"));
            } finally {
                try { o.close(); } catch (Throwable ignored) { }
            }
        } catch (Throwable ignored) { }
    }

    /**
     * 本地 .part 还能不能接着用。
     *
     * @return 可续传的字节数；**0 = 丢掉从头来**
     *
     * 判据（档案读不出、远端问不到时一律保守：只拿长度做个常识性检查）：
     *   1. 档案里记的 URL 跟现在要下的不是同一个 → 丢
     *   2. 远端 ETag 变了 → 丢（这是最可靠的一票否决）
     *   3. 本地已下字节 > 远端总长度 → 丢（不合常理，多半是旧版残留）
     *   4. 档案里记的"应下总长"跟远端现在的不一致 → 丢
     */
    private static long validatePart(File tmp, String url, Remote r) {
        long local = tmp.exists() ? tmp.length() : 0;
        if (local <= 0) return 0;

        File mf = metaFile(tmp);
        if (!mf.exists()) return 0;          // 没档案 → 来历不明，丢

        String[] lines;
        try {
            byte[] b = new byte[(int) Math.min(mf.length(), 8192)];
            InputStream in = new FileInputStream(mf);
            int n = 0;
            try { n = in.read(b); } finally { try { in.close(); } catch (Throwable ignored) { } }
            if (n <= 0) return 0;
            lines = new String(b, 0, n, "UTF-8").split("\n");
        } catch (Throwable ignored) {
            return 0;
        }
        if (lines.length < 4) return 0;

        String savedUrl = lines[0].trim();
        String savedEtag = lines[1].trim();
        String savedLast = lines[2].trim();
        long savedLen = -1;
        try { savedLen = Long.parseLong(lines[3].trim()); } catch (Throwable ignored) { }

        if (url != null && !url.equals(savedUrl)) return 0;                    // 判据 1

        if (r.reached) {
            if (r.etag != null && !r.etag.isEmpty()
                    && savedEtag != null && !savedEtag.isEmpty()
                    && !r.etag.equals(savedEtag)) return 0;                    // 判据 2
            if (r.length > 0 && local > r.length) return 0;                    // 判据 3
            if (r.length > 0 && savedLen > 0 && r.length != savedLen) return 0; // 判据 4
        }

        /* 保守兜底：远端问不到时，只要本地不超过档案记的总长，就接着下 */
        if (savedLen > 0 && local > savedLen) return 0;
        return local;
    }

    /** 连 .part 带档案一起删 */
    private static void discardPart(File tmp) {
        try { if (tmp != null && tmp.exists()) tmp.delete(); } catch (Throwable ignored) { }
        try {
            File mf = metaFile(tmp);
            if (mf != null && mf.exists()) mf.delete();
        } catch (Throwable ignored) { }
    }

    /**
     * 带重试的外壳。
     *
     * 为什么要重试：限速通道下的是大文件（几十 MB 的包很常见），整个过程要
     * 好几分钟。这么长的时间里网络抖一下、GitHub 那头断一次连接，都是常事。
     * 要是抖一下就整包报废，用户会看到「等了三分钟，然后下载失败」——
     * 这比不限速还让人恼火。**限速可以慢，但不能因为慢而失败。**
     *
     * 重试是**接着上次的进度继续**（HTTP Range），不是从头再来 ——
     * 否则一个 50MB 的包每抖一次就重下前 30MB，永远下不完。
     *
     * 每次都断流重连也会把「限速」的手感做得更真 —— 本来就是要慢。
     */
    private static void runWithRetry(String url, File target, Map<String, String> headers,
                                     Listener listener, boolean throttle, long seedBytes,
                                     long expectedTotal) {
        File tmp = tmpFile(target.getParentFile(), url, target.getName());

        /*
          开工前先做两件事：
            1. 问远端一句"你现在是什么版本"
            2. 拿本地 .part 的档案跟它比 —— 对不上就整个丢掉从头下

          这就是「限速通道下到旧包」的修复点。以前直接拿 tmp.length()
          当进度，从不知道远端换了没换。
        */
        Remote remote = probeRemote(url, headers);
        long already;
        if (seedBytes > 0 && tmp.length() >= seedBytes) {
            /* 接管：前缀是调用方（从 DownloadManager 那儿）写好的，
               直接认这个长度，不做 meta 比对。 */
            already = seedBytes;
        } else {
            already = validatePart(tmp, url, remote);
        }
        if (seedBytes <= 0 && tmp.exists() && already == 0 && tmp.length() > 0) {
            /* 档案对不上：这份残骸是别的版本留下的，没有保留价值 */
            discardPart(tmp);
        }

        String lastReason = null;
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (Thread.currentThread().isInterrupted()) {         // 用户取消了，别重试
                cleanup(tmp);
                return;
            }

            AttemptResult r = runOnce(url, target, tmp, headers, listener, already, attempt,
                    remote, throttle, expectedTotal);

            if (r == AttemptResult.OK) {
                /* 下完了，档案没用了，连残骸一起清干净（含 .part 已改名的情况） */
                try { File mf = metaFile(tmp); if (mf.exists()) mf.delete(); } catch (Throwable ignored) { }
                return;
            }
            if (r == AttemptResult.CANCELLED) {
                /* 取消：残骸留着没意义 —— 它只会在下次下载时成为污染源。
                   以前这里直接 return，把半个 .part 永久留在私有目录里，
                   下次下同名附件就可能被接着用。 */
                cleanup(tmp);
                return;
            }

            lastReason = r.reason;

            /* 被要求"丢掉重来"：清掉残骸，下一轮从 0 开始 */
            if (r.restart) {
                discardPart(tmp);
                already = 0;
            } else if (r.doneBytes > 0) {
                already = r.doneBytes;
            }

            if (!r.retryable) break;                              // 地址本身有问题，重试也白搭

            /* 退避一下再重试：2s、4s、8s…。立刻重试多半还是撞上同一堵墙 */
            try {
                Thread.sleep(Math.min(2000L * attempt, 8000L));
            } catch (InterruptedException ie) {
                cleanup(tmp);
                return;                                           // 等待期间被取消
            }
        }

        cleanup(tmp);
        listener.onFail(lastReason == null ? "下载失败" : lastReason, true);
    }

    /** runOnce 的结果 */
    private enum AttemptResult {
        OK, CANCELLED, RETRYABLE, FATAL;

        String reason = "";
        boolean retryable = true;
        /** true = 本地残骸不能用了，下一轮必须从 0 开始 */
        boolean restart = false;
        /** 这一轮实际写进 .part 的字节数（供外层决定下一轮从哪续） */
        long doneBytes = 0;

        static AttemptResult retryable(String why) {
            AttemptResult r = RETRYABLE;
            r.reason = why;
            r.retryable = true;
            return r;
        }

        /** 可重试，且要丢掉本地残骸从头来 */
        static AttemptResult restart(String why) {
            AttemptResult r = RETRYABLE;
            r.reason = why;
            r.retryable = true;
            r.restart = true;
            return r;
        }

        static AttemptResult fatal(String why) {
            AttemptResult r = FATAL;
            r.reason = why;
            r.retryable = false;
            return r;
        }
    }

    /**
     * 跑一轮（可能只下了一部分）。
     *
     * @param already 已经下好的字节数；>0 时用 Range 续传
     */
    /**
     * @param expectedTotal 预期总长；>0 时用它校验远端（见 206 分支）。
     *
     * ═══ 为什么不单独发一次探测请求 ═══
     *
     * 以前换道前要先 probeResume() 探一次：发一个 Range 请求、确认拿到 206
     * 且总长对得上，才敢接管。问题是**这次探测本身要花一个完整往返**
     * （跨国镜像常常 1~3 秒，超时上限 8 秒）—— 用户已经因为慢等了一轮，
     * 换道时又要干等一次探测，探测期间一个字节都没在下。
     *
     * 而且探测读完几个字节就把连接丢了，那些字节也白拿。
     *
     * 现在把校验并进正式请求：206 的响应头里本来就带着总长，顺手一比就行。
     * 省掉一整次往返，换道后立刻开始出数据。
     */
    private static AttemptResult runOnce(String url, File target, File tmp,
                                     Map<String, String> headers,
                                     Listener listener, long already, int attempt,
                                     Remote remote, boolean throttle,
                                     long expectedTotal) {
        HttpURLConnection conn = null;
        InputStream in = null;
        OutputStream out = null;

        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(15_000);
            conn.setReadTimeout(30_000);
            conn.setRequestProperty("User-Agent", "githup-android");
            conn.setRequestProperty("Accept-Encoding", "identity"); // 别压缩，压缩会把字节数算歪
            if (headers != null) {
                for (Map.Entry<String, String> e : headers.entrySet()) {
                    if (e.getKey() != null && e.getValue() != null) {
                        conn.setRequestProperty(e.getKey(), e.getValue());
                    }
                }
            }

            /* 续传：告诉服务器"我从第 already 字节接着要" */
            if (already > 0) {
                conn.setRequestProperty("Range", "bytes=" + already + "-");
            }

            int code = conn.getResponseCode();

            /*
              206 = 服务器同意续传，从 already 处接着给。
              200 = 服务器不支持续传，从头给 —— 那本地那份就不能要了，
                    必须把临时文件截断重写，否则会把新数据追加到旧数据后面，
                    拼出一个大小对得上、内容却错乱的文件（最阴的一种坏包）。
            */
            final boolean resumed;
            if (code == HttpURLConnection.HTTP_PARTIAL) {
                /*
                  服务端同意续传。但"同意"不等于"给的是同一个文件" ——
                  换道接管时前缀来自另一个域名，必须比对总长。

                  对不上就丢掉前缀从头下：拼两个不同文件比重新下还糟。
                */
                if (expectedTotal > 0) {
                    String cr = conn.getHeaderField("Content-Range");
                    long remoteTotal = -1;
                    if (cr != null) {
                        int slash = cr.lastIndexOf('/');
                        if (slash >= 0) {
                            try {
                                remoteTotal = Long.parseLong(cr.substring(slash + 1).trim());
                            } catch (Exception ignored) { }
                        }
                    }
                    if (remoteTotal > 0 && remoteTotal != expectedTotal) {
                        return AttemptResult.restart("新通道给的是另一个文件，已从头重新下载");
                    }
                }
                resumed = true;
            } else if (code == HttpURLConnection.HTTP_OK) {
                /*
                  服务器不支持续传，从头给 —— 本地那份就不能要了，
                  必须把临时文件截断重写，否则会把新数据追加到旧数据后面，
                  拼出一个大小对得上、内容却错乱的文件（最阴的一种坏包）。
                */
                resumed = false;
                already = 0;
            } else if (code == 416) {
                /*
                  416 Range Not Satisfiable：本地 .part 比远端文件还长。
                  这只能是**旧版本留下的残骸**（旧包比新包大），
                  接着下绝无可能 —— 丢掉从头来。
                */
                return AttemptResult.restart(
                        "本地残留比服务器上的文件还长，已丢弃重新下载");
            } else {
                return AttemptResult.fatal("服务器返回 " + code);
            }

            long contentLen = conn.getContentLengthLong();   // -1 = 未知
            long total = contentLen < 0 ? -1 : (resumed ? already + contentLen : contentLen);

            File parent = tmp.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) {
                return AttemptResult.fatal("无法创建目录");
            }

            in = conn.getInputStream();
            /* resumed → 追加；否则 → 截断重写（别让旧数据污染） */
            out = new FileOutputStream(tmp, resumed);

            /*
              档案要在**一开始**就落盘：哪怕中途崩了、进程被杀了，
              下次也能知道这份 .part 是从哪个 URL、哪个版本下来的。
              只写在最后的话，异常退出时留下的就是一份来历不明的残骸 ——
              那正是要防的污染源。
            */
            remote.etag = remote.etag != null ? remote.etag
                    : conn.getHeaderField("ETag");
            remote.lastModified = remote.lastModified != null ? remote.lastModified
                    : conn.getHeaderField("Last-Modified");
            if (remote.length < 0) {
                remote.length = conn.getHeaderFieldLong("Content-Length", -1);
            }
            writeMeta(tmp, url, remote, resumed ? already : 0);

            byte[] buf = new byte[BUF_SIZE];
            /* done 是**总**进度，从头到尾只增不减 —— 它是给 UI 和完整性校验用的。
               控速要的"本段已下多少"另用一个 baseBytes 记，两者不能混。 */
            long done = already;
            long baseBytes = already;                        // 本段控速的起点字节数
            long baseAt = System.currentTimeMillis();        // 本段控速的起点时刻
            long lastProgress = 0;
            long totalStalled = 0;
            long speedSampleStart = baseAt;
            long speedSampleBytes = 0;
            long currentBps = 0;

            while (true) {
                if (Thread.currentThread().isInterrupted()) throw new InterruptedException();

                int n = in.read(buf);
                if (n < 0) break;

                out.write(buf, 0, n);
                done += n;
                speedSampleBytes += n;

                /* ── 测速（纯给 UI 看） ── */
                long now = System.currentTimeMillis();
                long sampleMs = now - speedSampleStart;
                if (sampleMs >= 500) {
                    currentBps = speedSampleBytes * 1000L / sampleMs;
                    speedSampleStart = now;
                    speedSampleBytes = 0;
                }

                /*
                  控速：算「本段这些字节，按目标速度应该花多久」，多出来的就睡掉。

                  基准是**本段**（baseBytes / baseAt）而不是全程：
                  断流会把时间轴切一刀，之后用全新的基准重新起算，
                  这样断流那几秒就彻底不参与控速的账，不会出现
                  「断完之后为了追回进度猛睡一觉」。
                */
                /*
                  控速与断流 —— 只在限速模式下做。

                  换道续传（throttle=false）绝不能限速：换通道是正常路径，
                  不能因为换了一次就把用户从满速打成 100~200KB/s。
                */
                if (throttle) {
                    long targetBps = pickTargetBps();
                    long shouldTakeMs = ((done - baseBytes) * 1000L) / targetBps;
                    long actualMs = now - baseAt;
                    long sleepMs = shouldTakeMs - actualMs;
                    if (sleepMs > 0) {
                        // 一次最多睡 200ms，好让取消/断流判断能及时响应
                        sleepQuietly(Math.min(sleepMs, 200L));
                    }

                    /* ── 断流：每 15 秒来一下 ── */
                    long sinceStall = System.currentTimeMillis() - baseAt;
                    boolean budgetLeft = totalStalled < STALL_TOTAL_BUDGET_MS;
                    if (sinceStall >= STALL_EVERY_MS && budgetLeft) {
                        long stallMs = randomBetween(STALL_MIN_MS, STALL_MAX_MS);
                        // 红线：单次绝不超 60 秒
                        stallMs = Math.min(stallMs, STALL_HARD_CAP_MS);
                        // 总预算也不能超
                        stallMs = Math.min(stallMs, STALL_TOTAL_BUDGET_MS - totalStalled);

                        if (stallMs > 0) {
                            sleepQuietly(stallMs);
                            totalStalled += stallMs;
                        }
                        /*
                          断流结束，把"本段"重置到当前：

                            · baseAt 从"现在"重新起算 → 下一轮 sinceStall 是 0，
                              不会立刻又满足 >= 15s 变成连续断流；
                            · baseBytes 对齐到已下总量 → 控速从头算，断流这段
                              时间不进账。

                          注意**不能**动 done —— 那是总进度，一归零用户看到的
                          进度条就会突然跳回 0%，完整性校验也跟着错。
                        */
                        baseAt = System.currentTimeMillis();
                        baseBytes = done;
                        speedSampleStart = baseAt;
                        speedSampleBytes = 0;
                    }
                }

                /* ── 进度回调 ── */
                long nowMs = System.currentTimeMillis();
                if (nowMs - lastProgress >= PROGRESS_EVERY_MS) {
                    lastProgress = nowMs;
                    listener.onProgress(done, total, currentBps);
                }
            }

            out.flush();
            out.close();
            out = null;
            in.close();
            in = null;

            /*
              ── 完整性校验 ──

              这里**不删临时文件** —— 大小对不上很可能是这一轮被截断了
              （网络断、GitHub 主动断流都会这样），下一轮用 Range 接着下
              就行。删了就得从 0 开始，大文件永远下不完。

              注意 total 可能是 -1（服务端没给长度，分块传输）。那种情况
              没法判断"下全了没有"，只能认了 —— 但至少 sha 校验（如果调用方
              给了）还能兜底。
            */
            if (total > 0 && done != total) {
                AttemptResult r = AttemptResult.retryable(
                        "这一轮没下完（" + done + "/" + total + " 字节）");
                r.doneBytes = done;
                return r;
            }
            /*
              长度兜底：服务端没给 Content-Length（分块传输）时 total 是 -1，
              上面那一句判不了。这时没法证明"下全了"，只能在档案里记下
              实际字节数，让调用方那边的 sha / 长度校验去兜底 ——
              至少不能假装成功。
            */
            writeMeta(tmp, url, remote, done);

            /* ── 改名：原子操作，用户要么看到完整的，要么看不到 ── */
            if (target.exists()) {
                //noinspection ResultOfMethodCallIgnored
                target.delete();
            }
            if (!tmp.renameTo(target)) {
                return AttemptResult.retryable("文件保存失败");
            }

            listener.onProgress(done, total > 0 ? total : done, currentBps);
            listener.onDone(target, done);
            return AttemptResult.OK;

        } catch (InterruptedException ie) {
            closeQuietly(in, out, conn);
            return AttemptResult.CANCELLED;
        } catch (Throwable e) {
            closeQuietly(in, out, conn);
            String msg = e.getMessage();
            AttemptResult r = AttemptResult.retryable(
                    "下载出错" + (msg == null || msg.isEmpty() ? "" : "：" + msg));
            r.doneBytes = tmp.exists() ? tmp.length() : 0;
            return r;
        }
    }

    /**
     * 关掉连接相关的句柄，但**保留临时文件** —— 它是续传的底子。
     * 异常都吞掉：清理时再抛异常没有意义。
     */
    private static void closeQuietly(InputStream in, OutputStream out, HttpURLConnection conn) {
        try { if (out != null) out.close(); } catch (Throwable ignored) { }
        try { if (in != null) in.close(); } catch (Throwable ignored) { }
        try { if (conn != null) conn.disconnect(); } catch (Throwable ignored) { }
    }

    /**
     * 彻底放弃时才调：连临时文件带它的档案一起删掉。
     *
     * 必须连档案一起删 —— 只删 .part 留下 .part.meta 的话，下次下载时
     * 档案还在但文件没了，validatePart 会读到 local=0 直接返回 0，
     * 虽然不会出错，但会留一地垃圾。
     */
    private static void cleanup(File tmp) {
        discardPart(tmp);
    }

    /**
     * 清掉目录里的过期残骸。
     *
     * 老版本的 .part 是按「附件文件名.part」命名的，改了命名规则后那些
     * 文件再也读不到，会永久躺在私有目录里。顺手清一下。
     *
     * 只删 .part / .part.meta，且只删超过 7 天没动过的 —— 正在下载的
     * 那一份别碰。
     */
    static void sweepStale(File dir) {
        if (dir == null || !dir.isDirectory()) return;
        long cutoff = System.currentTimeMillis() - 7L * 24 * 60 * 60 * 1000;
        try {
            File[] fs = dir.listFiles();
            if (fs == null) return;
            for (File f : fs) {
                if (!f.isFile()) continue;
                String n = f.getName();
                if (!n.endsWith(".part") && !n.endsWith(META_SUFFIX)) continue;
                if (f.lastModified() < cutoff) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                }
            }
        } catch (Throwable ignored) { }
    }

    /**
     * sleep，但保证被 interrupt 时立刻抛出 —— 取消要能秒响应。
     *
     * 用 Thread.sleep 而不是别的：它本来就是可中断的，也不用自己轮询。
     */
    private static void sleepQuietly(long ms) throws InterruptedException {
        if (ms <= 0) return;
        Thread.sleep(ms);
    }

    /* ─────────────── 临时文件的"身份档案" ─────────────── */

    /**
     * 每个 .part 旁边放一个 .part.meta，记下它**是从哪个 URL、哪个版本**
     * 下来的。续传前拿这份档案跟远端比对，对不上就把 .part 整个丢掉从头下。
     *
     * ── 为什么非做不可 ──
     *
     * 以前 .part 只按附件文件名命名，续传时直接 `tmp.length()` 当已下进度，
     * 从不知道远端是不是还同一个文件。于是只要附件同名（都叫
     * app-release.apk 太常见了），上一版留下的 .part 就会被下一版接着用：
     *
     *   · 旧版下了一半留 5MB → 新版发布 → Range: 5MB- 取回新版的后半段
     *     → 拼出「旧前半 + 新后半」的坏包；
     *   · 旧版已下完但改名失败 → .part 是完整的旧版 → 新版等长时
     *     Range 返回 0 字节 → done==total 判定完成 → **用户拿到完整的旧版**。
     *
     * 这就是「限速通道下到的不是最新的包」的根源。
     *
     * 正常通道不受影响：它走 DownloadManager，每次新建任务、落盘名还带
     * 查重（-2、-3），从不复用旧文件。只有这里自己管 .part。
     */
    private static final String META_SUFFIX = ".part.meta";

    /* ─────────────── 工具 ─────────────── */

    /** 在 100~200KB/s 之间随机取一个目标速度 */
    private static long pickTargetBps() {
        return randomBetween(MIN_BYTES_PER_SEC, MAX_BYTES_PER_SEC);
    }

    private static long randomBetween(long min, long max) {
        if (max <= min) return min;
        return min + (long) (Math.random() * (max - min + 1));
    }
}
