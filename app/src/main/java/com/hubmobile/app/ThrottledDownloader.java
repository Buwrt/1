package com.hubmobile.app;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
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
        Thread t = new Thread(() -> runWithRetry(url, target, headers, listener), "throttled-dl");
        Handle h = new Handle(t);
        t.start();
        return h;
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
                                     Listener listener) {
        File tmp = new File(target.getParentFile(), target.getName() + ".part");

        String lastReason = null;
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (Thread.currentThread().isInterrupted()) return;   // 用户取消了，别重试

            long already = tmp.length();   // 上次下到哪了
            AttemptResult r = runOnce(url, target, tmp, headers, listener, already, attempt);

            if (r == AttemptResult.OK) return;                    // 成了
            if (r == AttemptResult.CANCELLED) return;             // 用户取消，不算失败

            lastReason = r.reason;
            if (!r.retryable) break;                              // 地址本身有问题，重试也白搭

            /* 退避一下再重试：2s、4s、8s…。立刻重试多半还是撞上同一堵墙 */
            try {
                Thread.sleep(Math.min(2000L * attempt, 8000L));
            } catch (InterruptedException ie) {
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

        static AttemptResult retryable(String why) {
            AttemptResult r = RETRYABLE;
            r.reason = why;
            r.retryable = true;
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
    private static AttemptResult runOnce(String url, File target, File tmp, Map<String, String> headers,
                                         Listener listener, long already, int attempt) {
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
                resumed = true;
            } else if (code == HttpURLConnection.HTTP_OK) {
                resumed = false;
                already = 0;
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
                return AttemptResult.retryable(
                        "这一轮没下完（" + done + "/" + total + " 字节）");
            }

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
            return AttemptResult.retryable(
                    "下载出错" + (msg == null || msg.isEmpty() ? "" : "：" + msg));
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

    /** 彻底放弃时才调：连临时文件一起删掉 */
    private static void cleanup(File tmp) {
        try { if (tmp != null && tmp.exists()) tmp.delete(); } catch (Throwable ignored) { }
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

    /** 在 100~200KB/s 之间随机取一个目标速度 */
    private static long pickTargetBps() {
        return randomBetween(MIN_BYTES_PER_SEC, MAX_BYTES_PER_SEC);
    }

    private static long randomBetween(long min, long max) {
        if (max <= min) return min;
        return min + (long) (Math.random() * (max - min + 1));
    }
}
