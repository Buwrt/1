package com.hubmobile.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.DownloadListener;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

/**
 * 主界面：以 WebView 承载前端单页应用，并通过 JsBridge 提供原生能力。
 */
public class MainActivity extends Activity {

    /** 首页地址：渲染进程崩溃后重建时也要回到这里 */
    private static final String HOME_URL = "file:///android_asset/web/index.html";

    /**
     * App 当前是否在前台。
     *
     * 两步验证器的「后台常驻动态码」只在**后台**出现：
     * 用户正看着屏幕时页面上就有码，通知栏再挂一条纯属打扰 ——
     * 拉下通知栏还得先关掉它。所以前台一律撤掉、后台才挂出来。
     *
     * 标记放在 App 上而不是本类：后台常驻服务、JsBridge 都要读它，
     * 这两者都不该依赖某个具体的界面实例。（和加固版保持一致。）
     */

    private WebView webView;
    private JsBridge bridge;
    /** README 图片代理：只造一次，渲染进程重建时它和里面的缓存都还在 */
    private ImageProxy imageProxy;
    /** WebView 挂在这一层上。留成字段是为了渲染进程没了之后能换一个新的上去 */
    private FrameLayout contentRoot;
    private long lastBackPressed = 0;
    // 视频全屏时挂在窗口上的自定义视图（见 enterFullscreen / exitFullscreen）
    private View customView;
    private WebChromeClient.CustomViewCallback customCb;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        /* 先把底板铺上，再干别的。
         *
         * 之前是「防护链 → 预热 → 建底板」，意味着这中间任何一步抛异常，
         * 窗口里连个能显示字的东西都没有 —— 用户看到的就是「闪一下就没了」。
         * 现在底板第一个建，后面无论哪一步出事，都能把原因写到屏幕上；
         * 加上 CrashLog 落盘，闪退这件事终于有据可查。 */
        try {
            contentRoot = new FrameLayout(this);
            contentRoot.setBackgroundColor(Color.WHITE);
            contentRoot.setLayoutParams(new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            setContentView(contentRoot);
        } catch (Throwable ignored) { }

        try {
            boot(savedInstanceState);
        } catch (Throwable e) {
            /* 走到这里就说明启动流程炸了。
             * 把堆栈同时做两件事：落盘（CrashLog 已经在 App 里装好写了，
             * 这里再兜一次）＋ 直接画到屏幕上，让用户看得见、截得下来。 */
            showFatal(e);
        }
    }

    /** 真正的启动流程。外层 onCreate 负责兜底，这里专注干活 */
    private void boot(Bundle savedInstanceState) throws Throwable {
        // 补记会话起点：Application.onCreate 只有冷启动才跑，
        // 覆盖安装后多为热启动，不补这一条的话导出报告的时间线会是空的。
        try { LogBook.markSession(this, "MainActivity"); } catch (Throwable ignored) { }

        // 埋点一：进主界面前跑一遍防护链。
        // 不通过就直接跳到「强制下载官方版」的页面，这里一行都不往下走。
        if (!guardPassed()) return;

        /* 过了卡点再预热 DNS。
         *
         * 首屏那几个请求都要先解析 api.github.com，运营商 DNS 动辄上百毫秒，
         * 几个域名串起来够呛。这里在后台线程先解析一轮，
         * 等用户点开列表时基本都是白捡的。失败无所谓，该解析时还会解析。
         *
         * 这一行曾经没能跟着过到这个库来（加固埋点那段把它顶掉了），
         * 于是同一个版本比另一边的库慢一截 —— DNS 全靠现等。
         * 「加载特别慢」有一部分就出在这儿。 */
        Http.warmUp();

        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }

        if (contentRoot == null) {
            contentRoot = new FrameLayout(this);
            contentRoot.setBackgroundColor(Color.WHITE);
            contentRoot.setLayoutParams(new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            setContentView(contentRoot);
        }

        attachWebView();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
            // 从通知点进来时，恢复完状态也要把路由带过去
            applyNotifRoute();
            applyExternalUrl();
        } else {
            webView.loadUrl(HOME_URL);
            applyNotifRoute();
            applyExternalUrl();
        }

        /* 通知栏动态码（两步验证器）现在是默认开启的 —— 设置页里那个
           开关已经删掉了，所以通知权限得在这里主动要一次。Android 13+
           不给这个权限的话，后台的动态码通知发不出去。只申请不放权限框
           之外的任何东西，用户拒绝也照常用。 */
        TotpService.ensureNotificationPermission(this);

        /* 上次如果崩过，把记录亮出来。
         * 放在最后：启动流程都走完了才提示，免得和首屏抢注意力。 */
        reportLastCrash();
    }

    /**
     * 有上次崩溃记录就提示一下：Toast 亮前几行，完整内容另存到
     * 私有外部目录，方便用户直接用文件管理器取出来。
     *
     * 不碰前端、不碰防护链清单 —— 只读一个自己写的私有文件，
     * 把「闪一下就没了、什么都看不到」变成「至少能看到崩在哪」。
     */
    private void reportLastCrash() {
        final String rec;
        try {
            rec = CrashLog.readLast(this);
        } catch (Throwable t) {
            return;
        }
        if (rec == null || rec.isEmpty()) return;

        // 1) Toast 亮前几行
        try {
            String[] lines = rec.split("\n");
            StringBuilder head = new StringBuilder("上次启动失败：");
            for (int i = 0; i < lines.length && i < 4; i++) {
                head.append("\n").append(lines[i]);
            }
            Toast.makeText(this, head.toString(), Toast.LENGTH_LONG).show();
        } catch (Throwable ignored) { }

        // 2) 完整记录另存一份，方便导出
        try {
            java.io.File dir = getExternalFilesDir(null);
            if (dir != null) {
                java.io.File out = new java.io.File(dir, "githup-crash.txt");
                java.io.FileWriter fw = new java.io.FileWriter(out, false);
                try {
                    fw.write(rec);
                    fw.flush();
                } finally {
                    try { fw.close(); } catch (Throwable ignored) { }
                }
            }
        } catch (Throwable ignored) { }

        // 3) 提示过就清掉，避免每次启动都弹
        try { CrashLog.clear(this); } catch (Throwable ignored) { }
    }

    /**
     * 启动流程炸了：把原因画到屏幕上，不让它变成「闪一下就没了」。
     *
     * 用最原始的方式 —— 一个 TextView 塞进底板，白底黑字，能滚。
     * 不走 WebView、不走任何我们自己的封装，越简单越不容易二次出错。
     */
    private void showFatal(Throwable e) {
        try { CrashLog.install(getApplicationContext()); } catch (Throwable ignored) { }
        try {
            java.io.StringWriter sw = new java.io.StringWriter();
            e.printStackTrace(new java.io.PrintWriter(sw));
            String msg = "启动失败\n\n" + sw.toString();

            android.widget.ScrollView sv = new android.widget.ScrollView(this);
            android.widget.TextView tv = new android.widget.TextView(this);
            tv.setText(msg);
            tv.setTextSize(13);
            tv.setTextColor(Color.parseColor("#111111"));
            tv.setPadding(36, 48, 36, 48);
            sv.addView(tv);
            sv.setBackgroundColor(Color.WHITE);
            setContentView(sv);
        } catch (Throwable ignored) {
            // 连报错都画不出来，那就只剩 CrashLog 那条路了
        }
    }

    /**
     * 从「动态码通知」点进来时要落到两步验证器页面。
     *
     * 通知里带了 route 参数，但 WebView 加载完成前跳路由是无效的 ——
     * 所以这里等页面加载完再执行。用 onPageFinished 会跟点通知进来
     * 的时序打架（那条路 WebView 可能早就加载好了），
     * 所以统一在页面加载后延迟一小段执行，两种情况都能覆盖。
     */
    private void applyNotifRoute() {
        if (getIntent() == null) return;
        final String route = getIntent().getStringExtra("route");
        if (route == null || route.isEmpty()) return;
        // 消费掉，避免横竖屏重建时又跳一次
        getIntent().removeExtra("route");
        if (webView == null) return;
        webView.postDelayed(() -> {
            try {
                String js = "(function(){try{window.Router.go("
                        + org.json.JSONObject.quote(route) + ");}catch(e){}})()";
                webView.evaluateJavascript(js, null);
            } catch (Throwable ignored) { }
        }, 400);
    }

    /**
     * 从外部 App（浏览器/微信/系统分享面板）点「用 githup 打开」进来时，
     * 把 GitHub 链接转成内部路由并跳过去。
     *
     * 例：https://github.com/owner/repo/issues/123 → #/owner/repo/issues/123
     *     https://raw.githubusercontent.com/o/r/main/x.png → #/o/r/blob/main/x.png
     *     https://gist.github.com/o/abc123 → #/gist/abc123
     */
    private void applyExternalUrl() {
        Intent intent = getIntent();
        if (intent == null) return;
        String action = intent.getAction();

        android.net.Uri uri = null;
        if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            /* 分享面板进来的：文本里可能是「标题 + 链接」，也可能就是纯链接。
             * 不能整段当 URL 解析，要从文本里把 GitHub 链接抠出来。 */
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (text != null) {
                uri = findGithubUrlInText(text.toString());
            }
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            /* 多选分享：取第一条能解析出 GitHub 链接的文本 */
            java.util.ArrayList<CharSequence> items =
                    intent.getCharSequenceArrayListExtra(Intent.EXTRA_TEXT);
            if (items != null) {
                for (CharSequence cs : items) {
                    if (cs == null) continue;
                    uri = findGithubUrlInText(cs.toString());
                    if (uri != null) break;
                }
            }
        }

        if (uri == null) return;
        String route = githubUrlToRoute(uri);
        if (route == null) return;
        /* githubUrlToRoute 返回带 # 前缀的 hash（如 #/owner/repo），
         * 但前端 Router.go() 要的是不带 # 的路径（如 /owner/repo）——
         * 带 # 传进去会被当成路径第一段，解析出 owner='#' 导致 404。
         * 这里把开头的 # 剥掉，和通知路由 /totp 保持一致。 */
        if (route.startsWith("#")) route = route.substring(1);
        // 消费掉：singleTask 复用 Activity 时，不清理会反复跳
        intent.setData(null);
        intent.setAction(null);
        intent.removeExtra(Intent.EXTRA_TEXT);
        if (webView == null) return;
        final String finalRoute = route;
        webView.postDelayed(() -> {
            try {
                String js = "(function(){try{window.Router.go("
                        + org.json.JSONObject.quote(finalRoute) + ");}catch(e){}})()";
                webView.evaluateJavascript(js, null);
            } catch (Throwable ignored) { }
        }, 500);
    }

    /**
     * 从一段分享文本里找出第一个能跳转到 githup 内部页面的 GitHub 链接。
     *
     * 分享内容经常是「标题 + 链接」或者「一段话 + https://github.com/...」，
     * 不能整段当 URL 解析。用正则把所有 http(s):// 开头的串抠出来，
     * 再逐个喂给 githubUrlToRoute，第一个能转成路由的就是目标。
     * 返回 null 说明这段文本里没有可识别的 GitHub 链接。
     */
    private android.net.Uri findGithubUrlInText(String text) {
        if (text == null || text.isEmpty()) return null;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile(
                "https?://[^\\s<>\"'\\]\\)]+").matcher(text);
        while (m.find()) {
            String url = m.group();
            try {
                android.net.Uri u = android.net.Uri.parse(url);
                if (githubUrlToRoute(u) != null) return u;
            } catch (Throwable ignored) { }
        }
        return null;
    }

    /**
     * 把 GitHub URL 转成内部 hash 路由。
     * 转换不了的（非 GitHub 域名、格式异常）返回 null，
     * 调用方应该什么都不做 —— 别把用户扔到一个 404 页面。
     */
    private String githubUrlToRoute(android.net.Uri uri) {
        if (uri == null) return null;
        String host = uri.getHost();
        if (host == null) return null;
        String path = uri.getPath();
        if (path == null) path = "";
        // 去掉开头的斜杠，结尾不留
        path = path.replaceAll("^/+", "").replaceAll("/+$", "");
        // 克隆地址带 .git 后缀：https://github.com/owner/repo.git → /owner/repo
        // 只在末尾出现时才剥，避免误伤路径中间包含 .git 的情况
        if (path.endsWith(".git")) {
            path = path.substring(0, path.length() - 4);
        }

        String route;
        switch (host) {
            case "github.com":
            case "www.github.com":
                if (path.isEmpty()) return "#/";
                route = "/" + path;
                break;
            case "gist.github.com": {
                /* gist.github.com/owner/id 或 gist.github.com/id */
                String[] segs = path.split("/");
                if (segs.length >= 1 && !segs[0].isEmpty()) {
                    String id = segs[segs.length - 1];
                    route = "/gist/" + id;
                } else {
                    route = "/gists";
                }
                break;
            }
            case "raw.githubusercontent.com": {
                /* raw.githubusercontent.com/owner/repo/ref/path → /owner/repo/blob/ref/path */
                String[] segs = path.split("/");
                if (segs.length < 3) return null;
                StringBuilder sb = new StringBuilder();
                sb.append('/').append(segs[0]).append('/').append(segs[1])
                        .append("/blob/").append(segs[2]);
                for (int i = 3; i < segs.length; i++) sb.append('/').append(segs[i]);
                route = sb.toString();
                break;
            }
            case "codeload.github.com": {
                /* codeload.github.com/owner/repo/zip/refs/heads/main → /owner/repo */
                String[] segs = path.split("/");
                if (segs.length < 2) return null;
                route = "/" + segs[0] + "/" + segs[1];
                break;
            }
            default:
                /* user-images.githubusercontent.com / avatars.githubusercontent.com 等
                   没有内部页面可对应，返回 null 不处理 */
                return null;
        }

        // 保留查询参数（?ref=main、?q=xxx 等），前端 parseHash 会解析
        String query = uri.getQuery();
        if (query != null && !query.isEmpty()) {
            route += "?" + query;
        }
        return "#" + route;
    }

    /**
     * 造一个 WebView 挂到底层上 —— 首次进入和渲染进程崩溃后的重建都走这里。
     *
     * 为什么不直接 `new WebView()` 完事：配置项、三个 Client、JsBridge 这套东西
     * 加起来几十行，写两遍必然某一边漏掉一样，而那种漏法只有在崩溃恢复之后
     * 才看得出差别，最难复查。所以只能有一条「装一个完整的 WebView」的路。
     */
    /**
     * 取图片代理（顺手创建）。
     *
     * 令牌是延迟取值的：用户可能先进 App 随便逛逛，之后再登录 ——
     * 要是构造时把令牌抄成字符串存起来，之后代理拿到的永远是空。
     */
    private ImageProxy imageProxy() {
        if (imageProxy == null) {
            imageProxy = new ImageProxy(getApplicationContext(),
                    () -> bridge == null ? "" : bridge.getToken());
        }
        return imageProxy;
    }

    private void attachWebView() {
        WebView dead = webView;
        WebView v = new WebView(this);
        v.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        applySettings(v.getSettings());

        if (bridge == null) bridge = new JsBridge(this, v);
        else bridge.reattach(v);          // 别再造一个：那等于再泄漏一份线程池
        bridge.setImageProxy(imageProxy());
        v.addJavascriptInterface(bridge, "NativeBridge");

        v.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                /* file:// 只放行 SPA 入口本身。README 里漏网的相对链接会被
                 * WebView 拿页面地址解析成 file:///android_asset/web/README.zh-CN.md
                 * 之类 —— 那个文件不存在，导航过去唯一能等来的就是
                 * onReceivedError 里那趟整页重载，用户看到的正是
                 * 「点一下 README 里的语言切换，整个软件重启」。
                 * JS 层（md.js 的 normalizeLink）负责从源头堵；这里是最后
                 * 一道闸：真漏进来了，吃掉这一次导航就好，别让它翻车。 */
                if (url.startsWith("file://")) {
                    return !url.startsWith(HOME_URL);
                }
                if (url.startsWith("about:") || url.startsWith("data:") || url.startsWith("blob:")) return false;
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    openExternal(url);
                    return true;
                }
                if (url.startsWith("mailto:") || url.startsWith("tel:")) {
                    openExternal(url);
                    return true;
                }
                return false;
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                /* 只有 SPA 入口自己加载失败才值得整页重载。这个老签名对
                 * 每个子资源都会回调一次 —— README 里一张裂图、一个漏网的
                 * file:// 链接都算 —— 以前只要 failingUrl 落在 android_asset
                 * 下就重载首页，正好把「点坏链接」放大成「整个软件重启」。
                 * 子资源失败交给各自的兜底链（裂图样式、base64 重试），不动全局。 */
                if (failingUrl != null && failingUrl.startsWith(HOME_URL)) {
                    view.postDelayed(() -> view.loadUrl(HOME_URL), 500);
                }
            }

            /**
             * 渲染进程没了。
             *
             * WebView 的内容跑在一个独立的进程里，内存吃紧时被系统直接回收
             * 是很正常的事 —— 偏偏这个 App 的搜索结果缓存以往会一路涨，
             * 正好把渲染堆喂到那条线上（见 page-home.js 里 SEARCH_STATE 的注释）。
             * 进程一死，画面就停在**最后一帧**：排版、颜色、内容全都在，
             * 就是点什么都没反应、也不再重绘 —— 用户讲的「软件变成图片的样子」
             * 就是它。
             *
             * 不接这个回调的话，Java 层对此一无所知：Activity 活着、各个
             * 变量也都正常，于是它就那么一直卡在那儿，只能强杀重开。
             * 这里换成一个新的 WebView 重新加载首页 —— 前端的令牌、主题、
             * 路由本来就存在 localStorage 里，重载之后照样回到原来的地方。
             */
            /**
             * README 图片的快车道（详见 ImageProxy 的类注释）。
             *
             * WebView 每次要取一张网络图片都会先问这里一句。答得上来，
             * 字节就直接递过去 —— 不用跑那趟「base64 → Binder → JS → data URI」
             * 的冤枉路；答不上来（拿不到、不是图、出了岔子）就返回 null，
             * WebView 会照原样自己去取，用户的观感毫无变化。
             */
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                ImageProxy p = imageProxy();
                if (p == null) return null;
                return p.intercept(request);
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                return onRendererGone(view, detail);
            }
        });

        v.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                // 前端自行管理加载指示
            }

            /* 视频全屏：不接这两个回调的话，点 <video> 右下角的全屏按钮
             * 会没反应（或者黑屏一片），因为没人把自定义视图挂到窗口上。 */
            @Override
            public void onShowCustomView(View view, CustomViewCallback cb) {
                enterFullscreen(view, cb);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }

            /* 扫一扫：页面里 getUserMedia 要开后置摄像头读二维码。
             * 前提是 App 已持有 CAMERA 权限（js 侧先调 Native.requestCamera 要），
             * 这里只负责把「页面想用摄像头」批给渲染进程 —— 不接这个回调的话，
             * getUserMedia 会被直接拒绝，取景框永远黑屏。 */
            @Override
            public void onPermissionRequest(final android.webkit.PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean wantCam = false;
                    try {
                        for (String r : request.getResources()) {
                            if (android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) {
                                wantCam = true;
                                break;
                            }
                        }
                        if (wantCam && checkSelfPermission(android.Manifest.permission.CAMERA)
                                == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                            request.grant(new String[]{
                                    android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                        } else {
                            request.deny();
                        }
                    } catch (Throwable t) {
                        try { request.deny(); } catch (Throwable ignored) { }
                    }
                });
            }
        });

        v.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            String name = "download";
            try {
                if (contentDisposition != null && contentDisposition.contains("filename=")) {
                    name = contentDisposition.split("filename=")[1].replace("\"", "").trim();
                } else {
                    name = Uri.parse(url).getLastPathSegment();
                }
            } catch (Exception ignored) {
            }
            try {
                    /* 统一交给 JsBridge：加速通道、卡住/失败自动换道、落盘位置
                     * （Download/githup/）、进度条登记全在那边一份实现，
                     * 跟前端主动调的下载走的是同一条路。 */
                if (bridge != null) bridge.enqueueWebViewDownload(url, userAgent, name);
                else openExternal(url);
            } catch (Exception e) {
                openExternal(url);
            }
        });

        // 新的先挂上去，死掉的那个再摘下来销毁 —— 中间不留空白
        contentRoot.addView(v);
        if (dead != null) {
            try {
                contentRoot.removeView(dead);
                dead.destroy();
            } catch (Throwable ignored) {
            }
        }
        webView = v;
    }

    /**
     * 渲染进程没了之后的收尾。返回 true 表示「这事我处理了」，
     * 系统就不会再按自己的方式去弹那套崩溃提示。
     */
    private boolean onRendererGone(WebView dead, RenderProcessGoneDetail detail) {
        try {
            Log.w("githup", "WebView 渲染进程退出（crash=" +
                    (detail != null && detail.didCrash()) + "），正在重建");
        } catch (Throwable ignored) {
        }
        try {
            attachWebView();
            webView.loadUrl(HOME_URL);
            Toast.makeText(this, "页面被系统回收了，正在重新加载", Toast.LENGTH_SHORT).show();
        } catch (Throwable t) {
            finish();       // 实在起不来：干脆收掉，别留一张不会动的图
        }
        return true;
    }

    /** WebView 的一整套设置（新装的、重建的都用这套，不能有第二份） */
    private void applySettings(WebSettings s) {
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        s.setSupportZoom(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        // 视频：README / issue 里上传的 mp4 现在会内嵌成 <video> 播放。
        // 关掉「必须用户手势才允许播放」，否则部分机型上点了播放键也没反应。
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setLoadsImagesAutomatically(true);
        s.setBlockNetworkImage(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportMultipleWindows(false);
        s.setDefaultTextEncodingName("UTF-8");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(false);
        }
        /* 关掉 WebView 的「算法深色化」。
           这个开关是真机反馈「系统跟随的是浅色，底栏却渲染成深色」的根因：
           WebView 会在系统处于深色时，把整个页面**自动反色**（不是读我们的 CSS，
           而是自己算一套深色），于是我们的浅色玻璃面被强行改成深色，
           而页面里已经渲染好的浅色文字/卡片又不会同步变 —— 结果就是错乱。
           前端本身就是「自己管深色」的：applyTheme() 会按系统深浅给
           <html data-theme> 赋值，深浅两套变量都是手写的。
           所以正确做法是让 WebView 别插手，完全交给 CSS。
           33 起用 setAlgorithmicDarkeningAllowed，更早的版本用 setForceDark。 */
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                s.setAlgorithmicDarkeningAllowed(false);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                s.setForceDark(WebSettings.FORCE_DARK_OFF);
            }
        } catch (Throwable ignored) {
        }
    }

    /**
     * 签名不对时的收场：弹一句人话，然后退出。
     *
     * 不写「检测到破解」这种对抗性文案 —— 用户是无辜的，他可能只是
     * 从某个第三方渠道下到了被改过的包。告诉他去哪儿拿正版就行。
     */
    /**
     * 校验安装包是不是官方签的。不是就把用户送到「只能下载官方版」的提示，
     * 并且不加载任何内容。
     *
     * 本库是未加固版本，没有另一边的五环防护链，只做签名指纹这一道
     * （这也是最要紧的一道：改任何字节重签名都会露馅）。
     */
    private boolean guardPassed() {
        if (SignCheck.isOfficial(this)) return true;
        showUnofficialBuild();
        return false;
    }

    /**
     * 签名对不上时的收尾：说清楚发生了什么，给出官方下载地址，然后停住。
     *
     * 用对话框而不是跳一个新 Activity —— 本库是未加固版，不想为这一条分支
     * 再引入一个界面类。效果一样：不加载任何内容，也不给「继续用」的余地
     * （点遮罩和返回键都退不掉，只有「去下载官方版」这一条路）。
     */
    private void showUnofficialBuild() {
        String actual = SignCheck.signingSha256(this);
        String shortActual = (actual == null || actual.length() < 16)
                ? "（读不到）" : actual.substring(0, 16) + "…";
        try {
            android.app.AlertDialog d = new android.app.AlertDialog.Builder(this)
                    .setTitle("不是官方版本")
                    .setMessage("这个安装包的签名与官方不一致，可能是被别人改过之后重新打包的。\n\n"
                            + "为了保护你的 GitHub 令牌和账号数据，应用不会继续运行。\n\n"
                            + "当前签名：" + shortActual + "\n"
                            + "官方签名：" + SignCheck.officialCertSha256().substring(0, 16) + "…")
                    .setCancelable(false)
                    .setPositiveButton("去下载官方版", (dlg, which) -> {
                        openExternal("https://github.com/Buwrt/githup/releases/latest");
                        finish();
                    })
                    .setNegativeButton("退出", (dlg, which) -> finish())
                    .create();
            d.setCanceledOnTouchOutside(false);
            d.show();
        } catch (Throwable t) {
            finish();
        }
    }

    /**
     * 进入视频全屏。不接 WebChromeClient 那两个回调的话，点 <video> 的
     * 全屏按钮会毫无反应 —— 因为没人把这块视图挂到窗口上。
     */
    private void enterFullscreen(View view, WebChromeClient.CustomViewCallback cb) {
        if (customView != null) { cb.onCustomViewHidden(); return; }
        customView = view;
        customCb = cb;
        getWindow().addContentView(view, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // 看视频时别中途熄屏
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    private void exitFullscreen() {
        if (customView == null) return;
        View v = customView;
        customView = null;
        if (v.getParent() instanceof ViewGroup) ((ViewGroup) v.getParent()).removeView(v);
        if (customCb != null) customCb.onCustomViewHidden();
        customCb = null;
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    /**
     * 打开外链（页面内的 http/https 跳转、mailto:、tel: 都会走到这里）。
     *
     * CATEGORY_BROWSABLE 只对 http/https 加：它是「浏览器可安全打开的网页」
     * 这一层过滤，加在自定义 scheme 上会让系统匹配不到任何 Activity，
     * 直接抛 ActivityNotFoundException（表现就是点了没反应 / 「无法打开链接」）。
     * mailto:、tel: 这类非网页 scheme 同样不能带。
     */
    private void openExternal(String url) {
        if (url == null || url.trim().isEmpty()) return;
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            if (isWebUrl(url)) i.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(i);
        } catch (Exception e) {
            try {
                if (!isWebUrl(url)) {
                    Intent web = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    web.addCategory(Intent.CATEGORY_BROWSABLE);
                    startActivity(web);
                    return;
                }
            } catch (Exception ignored) {}
            Toast.makeText(this, "无法打开链接", Toast.LENGTH_SHORT).show();
        }
    }

    /** 是不是 http/https 链接（只有这类才该带 CATEGORY_BROWSABLE） */
    private static boolean isWebUrl(String url) {
        try {
            String s = Uri.parse(url).getScheme();
            return s != null && (s.equalsIgnoreCase("http") || s.equalsIgnoreCase("https"));
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FilePick.REQ_PICK && bridge != null) {
            if (resultCode == RESULT_OK) bridge.onPickResult(resultCode, data);
            else bridge.onPickCancel();
        } else if (requestCode == FilePick.REQ_PICK_FOLDER && bridge != null) {
            /* 文件夹选择：tree URI 在 data.getData() 里，取消时兜底回执 */
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                bridge.onPickFolderResult(data);
            } else {
                bridge.onPickCancel();
            }
        }
    }

    /**
     * 媒体权限申请结果：不管给没给，都把文件选择器打开。
     * 给了 —— 系统相册 / 照片选择器能看到全部照片；
     * 没给 —— ACTION_OPEN_DOCUMENT 也能逐张挑，只是相册预览可能是空的。
     * 绝不能因为「用户拒绝权限」就什么都不发生，那样等于点了没反应。
     */
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == JsBridge.REQ_MEDIA_PERM && bridge != null) {
            bridge.onMediaPermissionResult();
        } else if (requestCode == JsBridge.REQ_CAMERA_PERM && bridge != null) {
            boolean ok = grantResults != null && grantResults.length > 0
                    && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED;
            bridge.onCameraPermissionResult(ok);
        }
        /* REQ_NOTIFY_PERM（通知栏动态码）不需要回调 —— 给不给权限都不影响
           App 本身，后台通知发不出去就是用户选择的结果，不提示、不追问。 */
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        /* singleTask 复用：从外部再点一个 GitHub 链接 / 分享进来时，
           不创建新 Activity（后台不会出现两个 githup），走这里。
           setIntent 让后续 applyExternalUrl 能拿到新链接。 */
        setIntent(intent);
        applyExternalUrl();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 埋点二：从后台切回来再验一次（防运行中被注入替换）
        if (!SignCheck.isOfficial(this)) {
            showUnofficialBuild();
            return;
        }
        /* 回到前台：把动态码通知收起来 —— 页面上就能看到码，
           通知栏不必再占一行。 */
        App.sForeground = true;
        TotpService.hideNotification(this);

        /* 顺手补一次通知权限。用户第一次可能点了「不允许」（那时还没有
           账户、不理解要通知干嘛），之后加完账户回到 App 时再给一次机会。
           已授权时这个方法直接返回，不会重复弹框。 */
        TotpService.ensureNotificationPermission(this);

        /* 排上「关注的项目更新」检查的闹钟，并顺手立刻查一次。
           检查本身不发任何常驻通知 —— 只有真发现新版本才会弹一条。 */
        RepoWatchReceiver.attach(this);

        if (webView != null) {
            webView.evaluateJavascript(
                    "(function(){try{if(window.AppOnResume)window.AppOnResume();}catch(e){}})()", null);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        /* 退到后台：动态码通知默认就挂出来（设置页的开关已删）。
           放在 onPause 而不是 onStop —— onStop 在部分机型上要等好几秒，
           用户切出去想马上看到码时会等不到。 */
        App.sForeground = false;
        TotpService.showNotification(this);

        if (webView != null) webView.evaluateJavascript(
                "(function(){try{window.__paused=true;}catch(e){}})()", null);
    }

    @Override
    public void onBackPressed() {
        /*
          统一交给前端处理：关弹层 -> 关图片查看器 -> 路由回退。
          前端返回 handled=true 表示这一层已被消费，不需要再走原生的回退；
          返回 false 说明已经在栈底，此时按「再按一次退出」处理。

          用 evaluateJavascript 的异步回调而不是同步返回值，因为
          JavascriptInterface 只能用 @JavascriptInterface 方法，
          拿不到即时的布尔结果。
        */
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        // 视频全屏中：返回键先退出全屏，而不是把整个页面退掉
        if (customView != null) {
            exitFullscreen();
            return;
        }
        webView.evaluateJavascript(
                "(function(){try{return !!(window.App&&App.handleBack&&App.handleBack());}"
                        + "catch(e){return false;}})()",
                value -> {
                    boolean handled = "true".equals(value);
                    if (handled) return;
                    confirmExit();
                });
    }

    /** 已在最底层：两次返回键间隔 2 秒内才真正退出，避免误触。 */
    private void confirmExit() {
        long now = System.currentTimeMillis();
        if (now - lastBackPressed < 2000) {
            super.onBackPressed();
            return;
        }
        lastBackPressed = now;
        Toast.makeText(this, "再按一次退出 githup", Toast.LENGTH_SHORT).show();
    }

    /*
      不再重写 onKeyDown 去转发 KEYCODE_BACK。
      系统在按下返回键时本来就会调用 onBackPressed()，如果 onKeyDown 里
      再手动调一次，返回逻辑会被触发两遍（弹层关掉的同时又回退了一层路由）。
      统一交给 onBackPressed 处理即可。
    */
}
