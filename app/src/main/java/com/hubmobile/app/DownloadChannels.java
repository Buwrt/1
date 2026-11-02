package com.hubmobile.app;

import java.util.ArrayList;
import java.util.List;

/**
 * 下载地址的候选通道：**直连 + 若干加速镜像**。
 *
 * 为什么需要：系统 DownloadManager 是自己直连 GitHub 的。Release 附件、源码包
 * 最终都会 302 到 objects.githubusercontent.com，这个域名在国内不少宽带
 * （广电 / 移动 / 长城…）下又慢又容易中途断，表现就是「几十 KB/s 慢慢爬」或者
 * 干脆「下载失败」。而 App 里的列表、README、图片是通的 —— 它们走的是原生
 * 网络栈 + 加速镜像。所以给下载也补上同样的多通道。
 *
 * 这里只放**纯逻辑**（不碰任何 Android API），这样能直接在 JVM 上跑单元测试，
 * 不用 Robolectric。真正发起下载的是 JsBridge。
 */
final class DownloadChannels {

    private DownloadChannels() { }

    /** 「直连」这条通道的稳定标识 */
    static final String DIRECT = "direct";

    /**
     * 「限速」这条通道的稳定标识。
     *
     * 这是一条**故意慢**的路：给「没有给仓库点 Star」的用户用。
     * 它和上面那些镜像完全不是一回事 —— 镜像拼出来的是「前缀 + 原 URL」，
     * 而限速走的是自研流式下载器（见 ThrottledDownloader），压根不是个 URL 前缀。
     * 所以它在候选链里是一个**占位标记**，由 JsBridge 认出来之后换条路走。
     *
     * 为什么不直接拼一个 URL：限速的关键是「按字节 sleep 控速 + 定时断流」，
     * 这只有自己拿着字节流才做得到。DownloadManager 给不了这个粒度
     * （它的 pause/resume 是分钟级的手感，精确到 KB/s 是妄想）。
     */
    static final String THROTTLED = "throttled";

    /**
     * 可用的加速镜像前缀（拼法：前缀 + 完整原 URL）。
     *
     * 扩容经过：3 条 → 5 条 → 现在 10 条。
     * 每次扩容的原因都一样：用户反馈「加速 1 2 3 全试完了还是失败」。
     * 加速镜像是第三方免费服务，**单条随时可能限速、挂掉、或回一个错误页**，
     * 所以真正有用的不是「有几个名字」，而是「有几条**拿得到文件本体**的独立的路」。
     *
     * 2026-09-21 实测（逐个用真实 Release 附件验证，取前 64KB 与本地原文件
     * **逐字节比对**，只有拿到的一字不差才算通过 —— 只看「域名能打开」会被
     * HTML 目录页和错误页骗过去）：
     *
     * | 镜像 | 内容 | 备注 |
     * |---|---|---|
     * | ghproxy.imciel.com | 一致 | 老成员，稳定且快 |
     * | gh.xxooo.cf        | 一致 | 老成员 |
     * | gh-proxy.com       | 一致 | 老成员，速度波动大 |
     * | ghfast.top         | 一致 | 老成员 |
     * | ghproxy.net        | 一致 | 老成员，偏慢，排第五 |
     * | github.boki.moe    | 一致 | 新增 |
     * | gh.idayer.com      | 一致 | 新增 |
     * | gh.ddlc.top        | 一致 | 新增；早期测过一次拿到的是目录页，本次复测通过 |
     * | ghfile.geekertao.top | 一致 | 新增 |
     * | gh.noki.icu        | 一致 | 新增，偏慢，排在最后一档 |
     *
     * 顺序大体按速度排。**别按「谁最知名」排** —— 老牌的那几个恰好不是最快的。
     *
     * 诚实的边界：这套顺序是在**当前测速环境**里跑出来的（每条取一次 64KB，
     * 环境本身的出口带宽有限，绝对速度仅供参考），更要紧的是可用性和内容正确性。
     * 真机上谁快谁慢会随运营商和时间变，所以别把顺序当成金科玉律 ——
     * 换道机制本来就是为了「排错了也能自己救回来」。
     *
     * 已排除（2026-09-21 实测，别再往回加）：
     *   gh-proxy.net / gitproxy.click
     *     —— 回的是 195~547 字节的 HTML 页面，拿不到文件；
     *   gh-proxy.monkeydev.icu / gh.jasonz.top / gh.2t.my / gh.psme.top /
     *   gh.noki.work / gh-proxy.linioi.cc / gh.sb0.top / ghfile.top /
     *   gh.lllzy.top / gh.gitmirror.top / ghproxy.click / raw.kgithub.com /
     *   gh.wuliya.xin / gh.fso.ink / gh.akass.top / gh-proxy.work / gh.d8.moe /
     *   hub.gitmirror.com / github.moeyy.xyz / gh.lliu.cc
     *     —— DNS 解析不了，或解析得到但握手超时（多数是服务已关停）；
     *   gh.h233.eu.org / github.moeyy.xyz / gh-proxy.ygxz.in / gh.1122.eu.org
     *     —— 解析得到但连不上；
     *   gh.lliu.cc      —— 回 502 的错误页（24KB HTML）；
     *   git.yylx.wiki   —— 回 404；
     *   ghproxy.homeboyc.cn / gh.con.sh —— 回 403 或一段几十字节的错误体；
     *   ghproxy.1888866.xyz —— 回 522（源站不可用）；
     *   ghps.cc / cdn.gh-proxy.com（历史记录）
     *     —— 后者下到 208KB 就断（774KB 的文件），是「下完却装不上」的典型来源。
     *
     * 维护提示：这些都是第三方免费服务，随时可能关停。加新镜像时**必须真的
     * 下载一个 Release 附件验证**（不能只看域名能不能打开），并且确认拿到的是
     * 文件本身。顺序也要按当时的实测速度重排。
     */
    /*
      ═══════ 加速通道清单（CI 实测后重排） ═══════

      验证方式：tools/probe-channels.py + .github/workflows/probe-channels.yml
      在 GitHub Actions 里跑，runner 是真实公网出口（打包环境有白名单策略，
      所有外部域名一律 403，在那里测的结果无效）。
      结果归档在 ci/channel-probe.{txt,json}。

      ── 第一组：CI 实测可用（8 条）──
      判据：状态码 200/206 + 真读到字节 + Content-Type 是 APK 而非 HTML。
      按实测速度从快到慢排，起步优先走前面的。

      ── 第二组：CI 测不出来，但**不应删除**的（8 条）──

      ⚠️ 这是本轮最需要说明的判断。

      它们在 CI 里报的是 429（Too Many Requests）/ 403 / 超时，看起来
      像「不可用」。但 GitHub Actions 的 runner 在**美国机房**，而这些
      是面向中国用户的加速镜像 —— 对海外 IP 限流或直接封禁非常常见。

      也就是说：CI 收到 429/403 **不等于国内用户用不了**。如果照着这份
      结果把它们删掉，很可能恰恰删掉了国内最好用的几条。

      所以按失败原因分类处理：
        · DNS 解析失败 → 域名真没了，全球都解析不了 → **删**
        · 返回 HTML    → 已不是文件代理            → **删**
        · SSL 证书失败 → App 里也会校验失败        → **删**
        · 429 / 403 / 超时 → 服务还活着，只是拒绝了 CI 的海外 IP
                           → **保留**，标「待观察」

      保留的这些在界面上会标「候选」，用户点一下测速就知道自己那边能不能用。

      ── 已删除（8 条，附实测失败原因）──
        gh.xxooo.cf           DNS 不存在
        mirror.ghproxy.com    DNS 不存在
        ghproxy.cfd           DNS 不存在
        gh.jiasu.in           DNS 不存在
        gh.xmly.dev           DNS 不存在
        hub.gitmirror.com     DNS 不存在
        mirror.houlang.cloud  返回 HTML 页面，不是文件
        dgithub.xyz           SSL 证书校验失败
    */
    /**
     * ═══ 云速通道（fastly.jsdelivr.net）═══
     *
     * 来自 komi-store 的内置镜像清单（BundledMirrors）。它和上面那些镜像
     * **不是同一种拼法**：普通镜像是「前缀 + 完整原 URL」，而 jsdelivr 要
     * 把地址拆开重组成 `/gh/{owner}/{repo}@{ref}/{path}`。
     *
     * 所以它在 MIRRORS 里是一个**占位标记**（就写域名前缀），真正拼 URL
     * 走 {@link #buildUrl} —— 不能拿它去 `前缀 + 原URL`，那样拼出来是
     * `fastly.jsdelivr.net/https://github.com/...`，必然 404。
     *
     * ═══ 只对 raw 文件生效 ═══
     *
     * jsdelivr 只代理**仓库里的文件**，不代理 Release 附件。komi-store 里
     * 也是这么标的（`trafficKinds = RAW_FILE_ONLY`）。所以：
     *   · raw.githubusercontent.com/...            → 走
     *   · github.com/o/r/blob|raw/ref/...          → 走
     *   · github.com/o/r/releases/download/...     → 不走（会返回 404）
     * 判不出来就整条跳过，绝不能拼一个必然失败的地址进去。
     *
     * ═══ CI 实测（真实公网出口）═══
     *
     *     fastly.jsdelivr.net  HTTP 200  ttfb 106ms  155590 KB/s  text/markdown
     *     cdn.gh-proxy.org     HTTP 200  ttfb 519ms    8162 KB/s  （云析对照）
     *
     * 比云析快约 19 倍 —— jsdelivr 是正规 CDN，不是第三方小代理，
     * 稳定性和速度都不是一个量级。这也是它值得单独做一套模板拼法的原因。
     *
     * 同批实测被淘汰的 komi-store 镜像（别再往回加）：
     *   gh.api.99988866.xyz  —— SSL 握手失败（SSLV3_ALERT_HANDSHAKE_FAILURE）
     *   github.moeyy.xyz     —— DNS 解析不了（和 githup 历史记录一致）
     *   ghps.cc              —— HTTP 403（和 githup 历史记录一致，当年是
     *                           「下到 208KB 就断」，现在直接拒）
     */
    static final String TEMPLATED = "https://fastly.jsdelivr.net/";

    /** 这条通道是不是「模板型」（不能用「前缀 + 原 URL」拼） */
    static boolean isTemplated(String m) {
        return m != null && m.startsWith(TEMPLATED);
    }

    /**
     * 把 raw 类地址改写成云速（jsdelivr）的地址。
     *
     * @return 拼好的地址；不是 raw 类地址（或抠不出字段）返回 null
     */
    static String templatedUrl(String url) {
        if (url == null || url.isEmpty()) return null;
        String h = hostOf(url);
        if (h == null) return null;
        if (!"raw.githubusercontent.com".equals(h) && !"github.com".equals(h)) return null;

        int scheme = url.indexOf("://");
        String rest = scheme < 0 ? url : url.substring(scheme + 3);
        int pathStart = rest.indexOf('/');
        if (pathStart < 0) return null;
        /* 去掉 query / fragment */
        int end = rest.length();
        for (int i = pathStart; i < rest.length(); i++) {
            char c = rest.charAt(i);
            if (c == '?' || c == '#') { end = i; break; }
        }
        String path = rest.substring(pathStart, end);

        java.util.List<String> sg = new ArrayList<>();
        for (String x : path.split("/")) if (!x.isEmpty()) sg.add(x);

        String owner, repo, ref, tail;
        if ("raw.githubusercontent.com".equals(h)) {
            /* /owner/repo/ref/path...  至少 4 段 */
            if (sg.size() < 4) return null;
            owner = sg.get(0); repo = sg.get(1); ref = sg.get(2);
            tail = String.join("/", sg.subList(3, sg.size()));
        } else {
            /* /owner/repo/blob|raw/ref/path...  至少 5 段 */
            if (sg.size() < 5) return null;
            String verb = sg.get(2);
            if (!"raw".equals(verb) && !"blob".equals(verb)) return null;
            owner = sg.get(0); repo = sg.get(1); ref = sg.get(3);
            tail = String.join("/", sg.subList(4, sg.size()));
        }
        if (owner.isEmpty() || repo.isEmpty() || ref.isEmpty() || tail.isEmpty()) return null;
        return TEMPLATED + "gh/" + owner + "/" + repo + "@" + ref + "/" + tail;
    }

    /**
     * 统一入口：把「通道 + 原地址」拼成真正要请求的 URL。
     *
     * 所有遍历 MIRRORS 的地方（下载候选链、取图换通道、测速）**都必须走这里**，
     * 不能自己写 `m + url` —— 云速是模板型，那样拼必然失败。
     *
     * @return 拼好的地址；这条通道不适用（比如云速遇到 Release 附件）返回 null，
     *         调用方应当跳过
     */
    static String buildUrl(String m, String url) {
        if (m == null || m.isEmpty() || url == null) return null;
        if (isTemplated(m)) return templatedUrl(url);
        return m + url;
    }

    /**
     * 这条通道的适用范围说明；空串 = 什么都能下。
     *
     * 为什么要标：云速（jsdelivr）只代理仓库里的文件，Release 附件它
     * 根本不认。以前面板上只写一个「不可用」，用户就以为这条坏了 ——
     * 实际上它是**这一类文件用不上**，不是坏了。写清楚省得误会。
     */
    static String scopeOf(String m) {
        if (isTemplated(m)) return "仅仓库文件";
        return "";
    }

    /** 这条通道对 url 适不适用（云速遇到 Release 附件就不适用） */
    static boolean appliesTo(String m, String url) {
        return buildUrl(m, url) != null;
    }

    static final String[] MIRRORS = {
            /* —— 第一组：CI 实测可用，按速度排序 —— */
            /*
              cdn.gh-proxy.org —— 云析（YunX）的默认 GitHub 镜像。

              从 CYQawa/YunX 的 UpdateChecker 里查到的：

                  const val MIRROR_PREFIX = "https://cdn.gh-proxy.org/"
                  fun mirrorUrl(url, prefix = MIRROR_PREFIX) = prefix + url

              跟这里的 MIRRORS 是同一种东西：URL 前缀镜像，拼上原地址就行。

              CI 实测（真实公网出口，目标 = 本仓库 v1.2.15 的 APK）：

                  cdn.gh-proxy.org  HTTP 200  ttfb 145ms  21709 KB/s
                  gh-proxy.com      HTTP 200  ttfb 107ms  12226 KB/s   （原加速 1）
                  直连               HTTP 200  ttfb  96ms 112622 KB/s  （runner 在美国）

              比原加速 1 快约 78%。放第一位。
            */
            "https://cdn.gh-proxy.org/",        /* 云析通道，21709 KB/s */
            TEMPLATED,                          /* 云速通道（jsdelivr），只对 raw 生效 */
            "https://gh-proxy.com/",            /* 1.2 MB/s */
            "https://gh.llkk.cc/",              /* 1.2 MB/s，TTFB 94ms 最快 */
            "https://cors.isteed.cc/",          /* 1.2 MB/s */
            "https://gh-proxy.at9.net/",        /* 1.2 MB/s */
            "https://gh.noki.icu/",             /* 1.2 MB/s */
            "https://ghfile.geekertao.top/",    /* 1.2 MB/s（限流，降速复核通过）*/
            "https://ghproxy.net/",             /* 432 KB/s */
            "https://ghfast.top/",              /* 130 KB/s，TTFB 8.9s 偏慢 */
            /* —— 第二组：CI 的海外 IP 被拒，国内可能正常，保留待观察 —— */
            "https://ghproxy.imciel.com/",      /* 429 限流 */
            "https://gh.idayer.com/",           /* 429 限流 */
            "https://gh.ddlc.top/",             /* 429 限流 */
            "https://github.boki.moe/",         /* 403 */
            "https://gh.h233.eu.org/",          /* 403 */
            "https://proxy.vvvv.ee/",           /* 403 */
            "https://ghproxy.homeboyc.cn/",     /* 403 */
            "https://gh.zwy.one/",              /* 连接超时 */
    };

    /** CI 实测可用的条数（第一组），界面上用来区分标注 */
    static final int VERIFIED_COUNT = 10;

    /** 只有这些域名的下载地址才允许走加速镜像（别把无关链接也送去代理） */
    static final String[] MIRRORABLE_HOSTS = {
            "github.com", "objects.githubusercontent.com",
            "raw.githubusercontent.com", "codeload.github.com",
    };

    /**
     * 要「劝」用户点 Star 的仓库 —— 也就是本软件自己的开源地址。
     *
     * 判定走 GitHub 官方接口 `GET /user/starred/{owner}/{repo}`。
     * 返回值的坑见 JsBridge.hasStarredSelf 的注释（**已 Star 是 204 不是 200**）。
     *
     * 未登录也算「没点过」：查不了就默认没有，这是刻意的选择 ——
     * 否则「退出登录」就成了绕过限速的口子，这个功能立刻失去意义。
     */
    static final String STAR_OWNER = "Buwrt";
    static final String STAR_REPO = "githup";

    /**
     * 这个地址是不是本软件自己仓库（Buwrt/githup）的东西。
     *
     * ⚠️ 现在**没有调用方** —— 限速不挑仓库，任何下载都查 Star
     * （见 JsBridge.enqueueDownload）。留着它是为了「以后想把限速
     * 收窄到只对自己的包」时能直接用，别把它当成当前的判定逻辑。
     */
    static boolean isSelfRepoDownload(String url) {
        if (url == null || url.isEmpty()) return false;
        String h = hostOf(url);
        if (h == null) return false;
        boolean ghHost = false;
        for (String m : MIRRORABLE_HOSTS) {
            if (h.equals(m) || h.endsWith("." + m)) { ghHost = true; break; }
        }
        if (!ghHost) return false;
        /* 路径里要出现 /Buwrt/githup/ 这一段（大小写不敏感）。
         * 用 contains 而不是 equals：地址可能是
         *   github.com/Buwrt/githup/releases/download/v1.2.15/xxx.apk
         *   raw.githubusercontent.com/Buwrt/githup/main/...
         *   codeload.github.com/Buwrt/githup/tar.gz/...
         * 只要仓库这一段对得上就算。 */
        String lower = url.toLowerCase();
        String needle = "/" + STAR_OWNER.toLowerCase() + "/" + STAR_REPO.toLowerCase() + "/";
        return lower.contains(needle);
    }

    /** 从 URL 里抠出主机名。不走 Uri.parse —— 那样就没法脱离 Android 单测了 */
    static String hostOf(String url) {
        if (url == null) return null;
        int scheme = url.indexOf("://");
        String rest = scheme < 0 ? url : url.substring(scheme + 3);
        int end = rest.length();
        for (int i = 0; i < rest.length(); i++) {
            char c = rest.charAt(i);
            if (c == '/' || c == '?' || c == '#') { end = i; break; }
        }
        String hostPort = rest.substring(0, end);
        int at = hostPort.lastIndexOf('@');
        if (at >= 0) hostPort = hostPort.substring(at + 1);
        int colon = hostPort.lastIndexOf(':');
        if (colon >= 0) hostPort = hostPort.substring(0, colon);
        return hostPort.isEmpty() ? null : hostPort.toLowerCase();
    }

    /** 这个地址能不能走加速镜像 */
    static boolean isMirrorable(String url) {
        String h = hostOf(url);
        if (h == null) return false;
        for (String m : MIRRORABLE_HOSTS) {
            if (h.equals(m) || h.endsWith("." + m)) return true;
        }
        return false;
    }

    /**
     * 请求里带了令牌。
     *
     * 注意语义在 2026-09-21 变过一次 —— 这里要写清楚，否则很容易被改回去。
     *
     * 旧做法：**带令牌就整条禁用镜像**（allowMirror = !hasAuthHeader）。
     * 当时的顾虑是对的 —— 把用户的私有仓库令牌发给第三方代理等于把账号交出去。
     * 但它带来一个很难查的副作用：前端下载 Release 附件时是无条件带认证头的
     * （`Native.authHeaders()` 只要登录了就返回 Authorization），于是**只要用户
     * 登录过，每一次下载都只剩直连一条路** —— 表现就是「开始下载 xxx（直连）」，
     * 加速、自动换道全线失效，谁也说不清为什么。
     *
     * 新做法：**照样走镜像，但走镜像时不转发凭据**（见 JsBridge.buildRequest
     * 里的 stripCredentials 判断），令牌只留给排在最后的那条直连。
     *
     *   · 公共资源的附件：镜像匿名就能取到 → 走加速，快；
     *   · 私有仓库的附件：镜像匿名取不到（GitHub 回 404）→ 立刻失败换道，
     *     最后落到带令牌的直连，照样能下载；
     *   · 令牌从头到尾没有离开本机，不存在「交给第三方代理」这件事。
     *
     * 唯一对外暴露的是 URL 本身。Release 附件的 `browser_download_url`
     * 形如 `github.com/owner/repo/releases/download/tag/xxx.apk`，里面没有
     * 凭据也没有签名，且无令牌时拿不到私有内容 —— 泄露面可以忽略。
     * 真正带签名的是 Actions 产物的 `archive_download_url`，它的域名是
     * api.github.com，本来就不在 MIRRORABLE_HOSTS 里，永远只会直连。
     */
    static boolean hasAuthHeader(String headersJson) {
        if (headersJson == null || headersJson.isEmpty()) return false;
        String s = headersJson.toLowerCase();
        return s.contains("authorization") || s.contains("bearer ") || s.contains("\"token\"");
    }

    /** 这条 URL 走的是哪条通道（稳定标识，用于记住「上次哪条通的」） */
    static String channelKey(String url) {
        if (isThrottled(url)) return THROTTLED;
        if (url != null) {
            for (String m : MIRRORS) {
                if (url.startsWith(m)) return m;
            }
        }
        return DIRECT;
    }

    /**
     * 通道的显示名。
     *
     * ═══ 第 1 条不叫「加速 1」，叫「云析通道」═══
     *
     * 它是云析（YunX）的默认 GitHub 镜像 cdn.gh-proxy.org，
     * 名字直接标出来历，用户一眼知道这条是哪来的。
     *
     * ═══ 其后依次叫「加速1」「加速2」「加速3」… ═══
     *
     * 第 3 条（gh-proxy.com）就是「加速1」，往后顺延。这样两条有名字的
     * 通道占前两位，「加速N」这批自己从 1 开始编号，读起来是连着的。
     */
    static String channelLabel(int index) {
        if (index == 0) return "云析通道";
        if (index == 1) return "云速通道";
        return "加速" + (index - 1);
    }

    /** 给进度条看的通道名，如「云析通道」/「云速通道」/「加速1」/「直连」/「限速」 */
    static String channelName(String url) {
        if (isThrottled(url)) return "限速";
        if (url != null) {
            for (int i = 0; i < MIRRORS.length; i++) {
                if (url.startsWith(MIRRORS[i])) return channelLabel(i);
            }
        }
        return "直连";
    }

    /**
     * 这是不是「限速」那条占位通道。
     *
     * 判断写在 channelKey / channelName 之外单独一个方法，是因为 JsBridge
     * 拿到候选链之后要逐条问「这条是不是限速」—— 它不认识 {@link #THROTTLED}
     * 这个常量还好，就怕有人哪天把常量值改了却漏改了判断，那样限速会
     * 悄悄退化成「一条拼不出来的 URL」，下载直接就失败了，还查不出原因。
     */
    static boolean isThrottled(String url) {
        return THROTTLED.equals(url);
    }

    /**
     * 生成「限速」候选链：只放一条，就是那个占位标记。
     *
     * 限速是**惩罚，不是兜底**：它不会跟 10 条加速 + 直连排在一起，
     * 而是完全独立的一条路 —— 判定为「没点 Star」时直接整条换掉，
     * 用户不会先试几条加速再落到限速（那样他早下完了，根本感觉不到）。
     *
     * ⚠️ 目前 JsBridge 走的不是这个方法：它拿到 starred=false 之后
     * 直接调 startThrottledDownload（自研下载器），压根不碰候选链。
     * 留着是为「以后想把它接回候选链」时用。
     */
    static List<String> throttledCandidates() {
        List<String> out = new ArrayList<>();
        out.add(THROTTLED);
        return out;
    }

    /**
     * 生成候选下载地址：加速镜像在前，直连兜底。
     *
     * @param url         原始下载地址
     * @param allowMirror 是否允许走镜像（带令牌时必须传 false）
     * @param lastChannel 上次成功走通的通道（{@link #DIRECT} 或某个镜像前缀），
     *                    传空串表示没有记录 —— 用户网络通常稳定，命中就能
     *                    省掉一轮「先慢后换」的等待
     */
    static List<String> candidates(String url, boolean allowMirror) {
        List<String> out = new ArrayList<>();
        if (allowMirror && isMirrorable(url)) {
            /*
              固定顺序，不再按「上次哪条通」重排。

              那套记忆已经被移除：它会让历史上某一次偶然的成功永久改写
              每一次下载的起步顺序 —— 用户看到的就是「一上来就是加速 3」，
              而那条通道此刻未必还快。固定顺序的行为可预期：慢了就走
              switchChannel 换道，不靠猜。
            */
            for (String m : MIRRORS) {
                String u = buildUrl(m, url);
                /* 云速对 Release 附件不适用，拼不出来就跳过 —— 放一条
                   必然 404 的地址进去只会白白浪费一轮换道。 */
                if (u != null) out.add(u);
            }
        }
        /*
          直连永远放在最后兜底。

          这里原来有一条「上次是直连通的就把直连排最前，别让海外用户白绕一圈
          代理」的优化 —— 想法没错，实测证明它是个坑：

          1) 这个偏好是**全局**的，不分文件也不分时间。某一次下载（哪怕是个
             小文件）恰好直连走通了，直连就被永久记成「优先通道」；
          2) 之后**每一次**下载都先试直连。国内网络下直连 GitHub 的 Release
             附件（会 302 到 objects.githubusercontent.com）正是最慢的那条；
          3) 更糟的是换道有代价：要熬过 GRACE_MS 宽限期才开始判慢，
             再连续 SLOW_STRIKES 轮才真的切走 —— 用户眼睁睁看着进度条
             卡在 0 B 十几秒，就是「下载突然变慢了」的真相。

          海外用户绕代理确实会慢一点，但「慢一点」远好过「先卡十几秒」。
          真要优化海外，应该按实际测速动态排序，而不是让一次偶然的成功
          永久改写全局顺序 —— 正是因为这个结论，「记住上次通道」那套机制
          在 1.2.15 被整个移除了。
        */
        out.add(url);
        return out;
    }
}
