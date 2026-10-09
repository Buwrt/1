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
    static final String[] MIRRORS = {
            "https://ghproxy.imciel.com/",
            "https://gh.xxooo.cf/",
            "https://gh-proxy.com/",
            "https://ghfast.top/",
            "https://ghproxy.net/",
            "https://github.boki.moe/",
            "https://gh.idayer.com/",
            "https://gh.ddlc.top/",
            "https://ghfile.geekertao.top/",
            "https://gh.noki.icu/",
    };

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

    /** 给进度条看的通道名，如「加速 1」/「直连」/「限速」 */
    static String channelName(String url) {
        if (isThrottled(url)) return "限速";
        if (url != null) {
            for (int i = 0; i < MIRRORS.length; i++) {
                if (url.startsWith(MIRRORS[i])) return "加速 " + (i + 1);
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
    static List<String> candidates(String url, boolean allowMirror, String lastChannel) {
        List<String> out = new ArrayList<>();
        if (allowMirror && isMirrorable(url)) {
            List<String> mirrors = new ArrayList<>();
            for (String m : MIRRORS) mirrors.add(m + url);
            if (lastChannel != null && !lastChannel.isEmpty() && !DIRECT.equals(lastChannel)) {
                for (int i = 0; i < mirrors.size(); i++) {
                    if (mirrors.get(i).startsWith(lastChannel)) {
                        out.add(mirrors.remove(i));
                        break;
                    }
                }
            }
            out.addAll(mirrors);
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
          永久改写全局顺序。
        */
        out.add(url);
        return out;
    }
}
