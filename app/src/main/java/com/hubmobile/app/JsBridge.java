package com.hubmobile.app;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Resources;
import android.database.Cursor;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.DisplayMetrics;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import android.os.SystemClock;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.Executors;

/**
 * WebView 与前端之间的桥接层：
 * 网络请求、令牌安全存储、剪贴板、分享、下载、震动等原生能力。
 */
public class JsBridge {

    private final Activity activity;
    private WebView webView;
    /* 8 个线程：网络通道同时要伺候「页面数据请求」和「翻译引擎的请求/探测」。
     * 曾经只有 4 个：自动选择翻译引擎时并行探测 5 家（其中 Google/DeepL 在
     * 国内要挂满连接超时），瞬间把池子占满，页面自己的数据请求只能在后面
     * 排队 —— 表现就是打开了翻译之后，页面骨架屏转个不停。 */
    private final ExecutorService pool = Executors.newFixedThreadPool(8);
    private static final String TOKEN_KEY = "gh_token";

    /*
     * 「记住的令牌」—— 退出登录时不删的那一分。
     *
     * 为什么单独一个 key：退出登录要清掉**当前生效**的令牌（TOKEN_KEY），
     * 否则退了还是登录态；但登录页又要能把上次用过的令牌回填回来，
     * 不然每次退出都要重新去 GitHub 复制一遍 —— 9 段乱码手抄不现实。
     * 两件事对同一个 key 的要求是相反的，只能分开存。
     *
     * 一样走 SecurePrefs（AES-GCM + Keystore），不落明文。
     * 想彻底清除走「忘记此令牌」，那个会把这里也删掉。
     */
    private static final String TOKEN_SAVED_KEY = "gh_token_saved";

    /*
     * 账号串 —— 多账号切换的核心存储。
     *
     * 设计上刻意让 gh_token 的语义保持不变：它永远是「当前生效的那一份」。
     * 切换账号 = 从串里取出对应令牌，写进 gh_token。
     *
     * 这样 Http.java、通知轮询这些只读 gh_token 的地方一行都不用改 ——
     * 多账号只是在它之上加了一层索引，不去动底下那套已经跑稳的东西。
     * 每加一个账号就往串里塞一条，数量不限。
     */
    private static final String ACCOUNTS_KEY = "gh_accounts";
    /** 当前账号的 login。空串表示内置令牌 / 未登录 */
    private static final String CURRENT_KEY = "gh_current";

    /** README 图片代理：由 MainActivity 建好后交过来，详见 ImageProxy */
    private ImageProxy imageProxy;

    /* ---------------- 账号串（多账号切换） ---------------- */

    /**
     * 读出账号串。
     *
     * 存之前先套一层 Base64 —— 这不是为了保密（SecurePrefs 已经加密了），
     * 而是为了让内容**不含 ']'**。
     *
     * SecurePrefs 用 ']' 当「密文 / 明文」的分界：值里含 ']' 就当密文去解。
     * 而 JSON 数组天生带 ']'（[...]），一旦设备 Keystore 不可用走了明文
     * 兜底，下次读就会把明文 JSON 当密文解，解密失败返回空 ——
     * 表现就是「账号永远存不进去」。套一层 Base64（字符集不含 ']'）即可避开。
     */
    private JSONArray readAccounts() {
        String raw = SecurePrefs.get(activity, ACCOUNTS_KEY, "");
        if (raw == null || raw.isEmpty()) return new JSONArray();
        String json = raw;
        try {
            byte[] b = Base64.decode(raw, Base64.DEFAULT);
            /* 解出来必须是合法 JSON 才算数，否则当作老格式直接用 */
            String s2 = new String(b, StandardCharsets.UTF_8);
            if (s2.startsWith("[")) json = s2;
        } catch (Throwable ignored) { }
        try {
            return new JSONArray(json);
        } catch (Throwable ignored) {
            return new JSONArray();
        }
    }

    private void writeAccounts(JSONArray a) {
        try {
            SecurePrefs.put(activity, ACCOUNTS_KEY,
                Base64.encodeToString(a.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
        } catch (Throwable ignored) {
            SecurePrefs.put(activity, ACCOUNTS_KEY, a.toString());
        }
    }

    /**
     * 账号列表。返回 JSON 数组字符串，每项：
     *   {id, login, name, avatar, token, current}
     * token 也带出来：JS 侧要判断「这份是不是内置令牌」，
     * 光看 login 区分不出来（内置令牌的 login 就是普通用户名）。
     */
    @JavascriptInterface
    public String listAccounts() {
        try {
            JSONArray a = readAccounts();
            String cur = SecurePrefs.get(activity, CURRENT_KEY, "");
            if (cur == null) cur = "";
            String live = SecurePrefs.get(activity, TOKEN_KEY, "");
            if (live == null) live = "";
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.optJSONObject(i);
                if (o == null) continue;
                String lg = o.optString("login", "");
                /* 当前账号以 gh_token 实际值判定，比记 login 更准：
                   内置令牌、或外部改过令牌的情况都不会认错人。 */
                o.put("current", !lg.isEmpty() && lg.equals(cur) && live.equals(o.optString("token", "")));
            }
            return a.toString();
        } catch (Throwable ignored) {
            return "[]";
        }
    }

    /** 当前账号的 login；内置令牌或未登录返回空串 */
    @JavascriptInterface
    public String getCurrentLogin() {
        String v = SecurePrefs.get(activity, CURRENT_KEY, "");
        return v == null ? "" : v;
    }

    /**
     * 加入或更新一个账号。同一个 login 视为同一个账号，覆盖旧记录。
     * 不在这里切过去 —— 登录成功时调用方自己决定是否切换，
     * 分开更清楚，也避免「加账号」这个动作产生副作用。
     */
    @JavascriptInterface
    public void addAccount(String id, String login, String name, String avatar, String token) {
        if (login == null || login.isEmpty() || token == null || token.isEmpty()) return;
        try {
            JSONArray a = readAccounts();
            JSONObject hit = null;
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.optJSONObject(i);
                if (o != null && login.equals(o.optString("login", ""))) { hit = o; break; }
            }
            if (hit == null) { hit = new JSONObject(); a.put(hit); }
            hit.put("id", id == null ? "" : id);
            hit.put("login", login);
            hit.put("name", name == null ? "" : name);
            hit.put("avatar", avatar == null ? "" : avatar);
            hit.put("token", token);
            writeAccounts(a);
        } catch (Throwable ignored) { }
    }

    /**
     * 切换到某个账号：把它的令牌写进 gh_token（和 gh_token_saved）。
     * @return 切成功返回 true；串里没这个 login 返回 false
     */
    @JavascriptInterface
    public boolean switchAccount(String login) {
        /* 空 login 是合法的：内置令牌那条记录的 login 就是空串。
           只有 null 才算参数错误 —— 之前把空串也拒了，切回内置会失败。 */
        if (login == null) return false;
        try {
            JSONArray a = readAccounts();
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.optJSONObject(i);
                if (o == null || !login.equals(o.optString("login", ""))) continue;
                String tk = o.optString("token", "");
                if (tk.isEmpty()) return false;
                SecurePrefs.put(activity, TOKEN_KEY, tk);
                SecurePrefs.put(activity, TOKEN_SAVED_KEY, tk);
                SecurePrefs.put(activity, CURRENT_KEY, login);
                /* 换人了：通知去重表必须清。
                   不清的话新账号的未读会被当成「已经提醒过了」而漏掉 ——
                   因为 seen_ids 是按上个账号的通知 id 记的。 */
                try {
                    NotifWatchReceiver.resetSeen(activity);
                    NotifWatchReceiver.scheduleSoonAfterLogin(activity);
                } catch (Throwable ignored) { }
                return true;
            }
        } catch (Throwable ignored) { }
        return false;
    }

    /**
     * 按令牌切换（比按 login 稳）。
     *
     * 列表是 JS 那边刚读出来的，每项都带着 token，直接按它定位就不会
     * 认错行 —— 按 login 匹配时，一旦某个记录的 login 是空串（内置那份
     * 就是），或者列表发生过增删导致同名，点第一行可能切到第二行去。
     *
     * @return 切成功返回 true
     */
    @JavascriptInterface
    public boolean switchAccountByToken(String token) {
        if (token == null || token.isEmpty()) return false;
        try {
            JSONArray a = readAccounts();
            JSONObject rec = null;
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.optJSONObject(i);
                if (o == null) continue;
                if (token.equals(o.optString("token", ""))) { rec = o; break; }
            }
            if (rec == null) return false;
            SecurePrefs.put(activity, TOKEN_KEY, token);
            SecurePrefs.put(activity, TOKEN_SAVED_KEY, token);
            SecurePrefs.put(activity, CURRENT_KEY, rec.optString("login", ""));
            try {
                NotifWatchReceiver.resetSeen(activity);
                NotifWatchReceiver.scheduleSoonAfterLogin(activity);
            } catch (Throwable ignored) { }
            return true;
        } catch (Throwable ignored) { }
        return false;
    }

    /** 从串里删掉一个账号。删的是当前账号时，顺带结束登录态 */
    @JavascriptInterface
    public boolean removeAccount(String login) {
        if (login == null || login.isEmpty()) return false;
        try {
            JSONArray a = readAccounts();
            JSONArray out = new JSONArray();
            boolean removed = false;
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.optJSONObject(i);
                if (o == null) continue;
                if (login.equals(o.optString("login", ""))) { removed = true; continue; }
                out.put(o);
            }
            if (!removed) return false;
            writeAccounts(out);
            String cur = SecurePrefs.get(activity, CURRENT_KEY, "");
            if (login.equals(cur)) {
                SecurePrefs.put(activity, CURRENT_KEY, "");
                SecurePrefs.remove(activity, TOKEN_KEY);
                SecurePrefs.remove(activity, TOKEN_SAVED_KEY);
                try { NotifWatchReceiver.cancel(activity); } catch (Throwable ignored) { }
                try { NotifWatchReceiver.resetSeen(activity); } catch (Throwable ignored) { }
            }
            return true;
        } catch (Throwable ignored) { }
        return false;
    }

    /** 申请媒体权限的请求码（结果由 MainActivity 转发回来）。 */
    static final int REQ_MEDIA_PERM = 4712;

    /** 申请通知权限的请求码（Android 13+，后台动态码通知用） */
    static final int REQ_NOTIFY_PERM = 4713;

    /** 申请相机权限的请求码（两步验证器「扫一扫」用；结果由 MainActivity 转发回来） */
    static final int REQ_CAMERA_PERM = 4714;

    /** 扫一扫：正在等系统权限框结果的那次 JS 回调 id。 */
    private String pendingCameraId;

    JsBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        watchDownloads();
    }

    /**
     * WebView 的渲染进程被系统回收之后，MainActivity 会换一个新的 WebView
     * 上来 —— 这里把 JS 发射口指到新的那个。
     *
     * 为什么不干脆 new 一个 JsBridge：它手上攥着一个 8 线程的网络池，
     * 而线程池既没有 shutdown 也不会被 GC 掉（线程是 GC root），
     * 每崩一次就白白多留一份。下载完成那个广播倒是有 CAS 挡着不会重复注册。
     */
    void reattach(WebView v) {
        this.webView = v;
    }

    void setImageProxy(ImageProxy p) {
        this.imageProxy = p;
    }

    private void runJs(final String js) {
        activity.runOnUiThread(() -> {
            /*
              webView 可能已经没了：上传回调跑在后台线程，完成时用户可能
              已经退出页面（MainActivity 销毁、webView 置空）。不判空的话
              这里一个 NullPointerException 就把整个进程带走 —— 表现是
              「上传成功的那一瞬间 App 闪退」，特别冤。
            */
            try {
                if (webView == null) return;
                webView.evaluateJavascript(js, null);
            } catch (Throwable ignored) {
                // 页面正在销毁时的竞态，忽略即可 —— 回调本来就不必送达
            }
        });
    }

    /**
     * 告诉前端「这次自动更新没装成」。
     *
     * 为什么需要这条回执：
     *   前端在用户按下「立即更新」时会记一笔「我正在装这一份」，
     *   免得下载安装这段空窗期里反复弹同一个提示。但那一笔是在**按下时**
     *   就记下的 —— 下载失败、或校验不过被拦下时，更新其实没装成，
     *   而那条记录还挂着，用户接下来每次打开都不再收到提醒，
     *   干等也不知道为什么（真机反馈就是这个）。
     *
     *   前端侧已经给那条记录加了 30 分钟有效期兜底，但「立刻知道失败」
     *   显然比「等它过期」好，所以这里主动收回来。
     */
    private void notifyUpdateAborted(String why) {
        try {
            String q = why == null ? "" : why.replace("\\", "\\\\").replace("'", "\\'");
            runJs("try{if(window.Updater&&Updater.clearUpdating)Updater.clearUpdating('" + q + "');}catch(e){}");
        } catch (Throwable ignored) { }
    }

    /* ---------------- 网络 ---------------- */
    @JavascriptInterface
    public void http(String id, String method, String url, String body, String headersJson) {
        pool.execute(() -> {
            try {
                Map<String, String> headers = new HashMap<>();
                if (headersJson != null && !headersJson.isEmpty()) {
                    JSONObject jo = new JSONObject(headersJson);
                    Iterator<String> it = jo.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        headers.put(k, jo.optString(k, ""));
                    }
                }
                Http.Response r = Http.request(method, url, body, headers);
                String js = "window.Native._cb(" + JSONObject.quote(String.valueOf(id)) + ","
                        + r.code + "," + JSONObject.quote(r.body == null ? "" : r.body) + ","
                        + JSONObject.quote(r.headers == null ? "{}" : r.headers) + ")";
                runJs(js);
            } catch (Throwable t) {
                String msg = t.getMessage();
                if (msg == null) msg = t.getClass().getSimpleName();
                String js = "window.Native._cb(" + JSONObject.quote(String.valueOf(id)) + ",0,"
                        + JSONObject.quote("") + "," + JSONObject.quote("{\"error\":" + JSONObject.quote(msg) + "}") + ")";
                runJs(js);
            }
        });
    }

    /**
     * 以 Base64 拉取二进制资源（README 图片、头像等）。
     *
     * WebView 直连 raw.githubusercontent.com 在不少网络下不通，而同样的网络下
     * 仓库列表 / README 文本能正常加载 —— 因为它们走的是这里的原生网络栈。
     * 图片也走同一条路：原生按字节拉回来给 base64，前端转成 data URI 塞进 <img>。
     * 带什么头由前端决定（只有 GitHub 自家域名才带令牌，外链绝不带）。
     */
    @JavascriptInterface
    public void httpB64(String id, String url, String headersJson) {
        pool.execute(() -> {
            try {
                Map<String, String> headers = new HashMap<>();
                if (headersJson != null && !headersJson.isEmpty()) {
                    JSONObject jo = new JSONObject(headersJson);
                    Iterator<String> it = jo.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        String v = jo.optString(k, "");
                        if (!v.isEmpty()) headers.put(k, v);
                    }
                }
                Http.Response r = Http.requestB64("GET", url, null, headers);
                emitB64(id, r.code, r.body, r.headers == null ? "{}" : r.headers);
            } catch (Throwable t) {
                String msg = t.getMessage();
                if (msg == null) msg = t.getClass().getSimpleName();
                emitB64(id, 0, "", "{\"error\":" + JSONObject.quote(msg) + "}");
            }
        });
    }

    /**
     * 前端问一句：图片的快车道开着吗？
     *
     * 开着就意味着 App 会在 WebView 取图的时候直接把字节接过去（见
     * ImageProxy），前端于是**什么都不用做** —— <img src> 保持原样，
     * 让 WebView 自己去拉就是最快的那条路。
     * 关着（或者拼法变了拿不到这个方法）就退回老的 base64 通道，
     * 慢是慢点，图照样出得来。
     */
    @JavascriptInterface
    public boolean imageProxyReady() {
        return imageProxy != null;
    }

    /**
     * 预热：README 渲染完之后把前几张图的地址丢过来，后台先下到缓存里。
     *
     * 有了懒加载，图片是滑到眼前才发请求的 —— 用户看到的「每次滑到这儿
     * 都要等一下」就是这么来的。提前灌进缓存，滑到时是读本地文件。
     */
    @JavascriptInterface
    public void prefetchImages(String urlsJson) {
        final ImageProxy p = imageProxy;
        if (p == null || urlsJson == null || urlsJson.isEmpty()) return;
        try {
            org.json.JSONArray arr = new org.json.JSONArray(urlsJson);
            int n = Math.min(arr.length(), 12);
            List<String> urls = new ArrayList<>(n);
            for (int i = 0; i < n; i++) {
                String u = arr.optString(i, "");
                if (!u.isEmpty()) urls.add(u);
            }
            if (urls.isEmpty()) return;
            pool.execute(() -> p.prefetch(urls));
        } catch (Throwable ignored) {
            /* 预热失败不算失败：到时候会走常规路径，用户无感 */
        }
    }

    /* Base64 回传的单次上限（字符数）。
     *
     * evaluateJavascript 底层是 Binder IPC，单次事务上限约 1MB —— README 里
     * 一张 417KB 的赞赏码图，base64 之后就是 556KB 字符，再叠上 4 条并发，
     * 一次要塞 2MB 过 Binder，结果是一张都传不回来（表现就是「大图加载不出来，
     * 小图没事」）。所以超过阈值的响应切成小片依次下发，前端拼好再交付。
     *
     * 48KB 是留足余量的取值：连電普通 API 响应（几十 KB）根本不会走到分片
     * 这条路，只有真正的图片/大附件才会。 */
    private static final int B64_CHUNK = 48 * 1024;

    /**
     * 下发 base64 响应：小的一次给完，大的先 _begin 登记、再逐片 _chunk。
     * 全程走 runOnUiThread，同一线程的 post 是 FIFO，顺序不会乱。
     */
    private void emitB64(String id, int code, String body, String headers) {
        String b = body == null ? "" : body;
        String qid = JSONObject.quote(String.valueOf(id));
        String qh = JSONObject.quote(headers == null ? "{}" : headers);
        if (b.length() <= B64_CHUNK) {
            runJs("window.Native._cb(" + qid + "," + code + "," + JSONObject.quote(b) + "," + qh + ")");
            return;
        }
        int n = (b.length() + B64_CHUNK - 1) / B64_CHUNK;
        runJs("window.Native._begin(" + qid + "," + code + "," + n + "," + qh + ")");
        for (int i = 0; i < n; i++) {
            int end = Math.min(b.length(), (i + 1) * B64_CHUNK);
            runJs("window.Native._chunk(" + qid + "," + i + ","
                    + JSONObject.quote(b.substring(i * B64_CHUNK, end)) + ")");
        }
    }

    /* ---------------- 文件选择与上传 ---------------- */

    /** 当前挂起的文件选择回调 id（一次只允许一个）。 */
    private String pendingPickId;
    private String pendingUploadId;
    private Uri pendingUploadUri;
    private String pendingUploadUrl;
    private String pendingUploadHeaders;

    /*
     * 打开选择器；结果通过 window.Native._pick(id, json) 回调。
     *
     * accept 决定走哪种选择器：
     *   - 纯图片 / 纯视频 / 图片+视频  ->  系统「相册」（见 launchGallery）
     *   - 其它（APK、压缩包、任意文件）->  系统文件浏览器（见 launchFileBrowser）
     *
     * 为什么媒体要单独走相册：
     *   用户要的是「在相册里挑照片」，而不是在一个列着 DCIM、Download、
     *   Android 这些目录名的文件管理器里翻。ACTION_OPEN_DOCUMENT 虽然稳，
     *   但它是文件浏览器语义，对普通用户太绕。
     *
     * 为什么之前会看到「此应用只能访问您选择的照片 / 无照片或视频」：
     *   那是 Android 13+ 的系统「照片选择器」。它按【授权范围】显示内容 ——
     *   应用一个媒体权限都没被授予时，它就只剩那句提示。
     *   现在选之前先申请权限（READ_MEDIA_IMAGES / READ_MEDIA_VIDEO，
     *   旧系统是 READ_EXTERNAL_STORAGE），并且：
     *     · Android 14+ 额外申请 READ_MEDIA_VISUAL_USER_SELECTED ——
     *       这是「只选部分照片」权限，用户就算点了「仅允许选中的照片」，
     *       相册里也能看到内容，而不是空白
     *     · 被拒绝也照样打开选择器（不拦、不报错），最多是内容少一些
     */
    @JavascriptInterface
    public void pickFile(String id, String accept) {
        pendingPickId = id;
        final String raw = (accept == null || accept.isEmpty()) ? "*/*" : accept.trim();
        activity.runOnUiThread(() -> {
            if (isMediaAccept(raw)) {
                // 相册路径：先要权限，拿到（或拿不到）都继续开相册
                if (!ensureMediaPermission(raw)) {
                    pendingPickAccept = raw;   // 等权限回调，见 onMediaPermissionResult()
                    return;
                }
                launchGallery(raw);
            } else {
                launchFileBrowser(raw);
            }
        });
    }

    /** 权限回调未回来前暂存的 accept 参数。 */
    private String pendingPickAccept;

    /** 这个 accept 是不是「只要图片 / 视频」—— 是的话走相册，不走文件浏览器。 */
    private static boolean isMediaAccept(String accept) {
        if (accept == null) return false;
        String a = accept.trim();
        if (a.isEmpty() || "*/*".equals(a)) return false;   // 任意文件 -> 文件浏览器
        String[] types = splitTypes(a);
        for (String t : types) {
            // 只要出现非图片非视频的类型，就说明要的是「文件」，不能只给相册
            if (!t.startsWith("image/") && !t.startsWith("video/")) return false;
        }
        return types.length > 0;
    }

    /**
     * 打开系统相册（图片 / 视频）。
     *
     * 三级降级，按系统版本挑最新的可用方式：
     *   1. Android 13+：ACTION_PICK_IMAGES —— 系统照片选择器，就是相册那个界面。
     *      传 MediaStore.getPickImagesMaxLimit() 允许一次多选。
     *   2. Android 7~12：MediaStore.ACTION_PICK_IMAGES 不存在，用
     *      ACTION_PICK + MediaStore 的 images/video 集合 —— 同样是相册界面。
     *      图片+视频同时要时用 Intent.ACTION_PICK 配 EXTRA_MIME_TYPES。
     *   3. 都没有（极少见）：退回文件浏览器，至少能用。
     *
     * 拿到的是带读权限的 content:// URI，经 FilePick.query 读取元信息后
     * 交给前端上传，和文件浏览器路径完全一致。
     */
    private void launchGallery(String accept) {
        String[] types = splitTypes(accept);
        boolean wantImage = false, wantVideo = false;
        for (String t : types) {
            if (t.startsWith("image/")) wantImage = true;
            else if (t.startsWith("video/")) wantVideo = true;
            else { wantImage = true; wantVideo = true; }
        }

        // 1) Android 13+ 的系统照片选择器（就是「相册」那个界面）
        //
        //    图片和视频【可以同时选】：官方文档写明，不限定 MIME 类型时
        //    选择器会同时显示照片和视频；只有 setType("image/*") 才只给图片。
        //    上一版这里搞错了 —— 「两者都要」时主动跳过系统相册、退到
        //    ACTION_PICK + MediaStore.Files，而部分定制系统（如部分一加/OPPO）
        //    把它渲染成文件浏览器，于是用户要「去文件夹里翻视频」。
        //    现在两者都要时不设 type，让系统相册同时列出图片和视频。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            try {
                Intent i = new Intent("android.provider.action.PICK_IMAGES");
                if (wantImage && !wantVideo) {
                    i.setType("image/*");     // 只要图片
                } else if (wantVideo && !wantImage) {
                    i.setType("video/*");     // 只要视频
                }
                // 两者都要：不 setType —— 相册同时显示照片和视频
                try { i.putExtra("android.provider.extra.PICK_IMAGES_MAX", 100); } catch (Exception ignored) {}
                activity.startActivityForResult(i, FilePick.REQ_PICK);
                return;
            } catch (Exception ignored) {
                // 落到下一级
            }
        }

        // 2) Android 7~12：ACTION_PICK + MediaStore（也是相册界面）
        try {
            Intent i = new Intent(Intent.ACTION_PICK);
            if (wantImage && !wantVideo) {
                i.setDataAndType(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, "image/*");
            } else if (wantVideo && !wantImage) {
                i.setDataAndType(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, "video/*");
            } else {
                // 图片 + 视频：让用户在相册里挑，EXTRA_MIME_TYPES 声明两种类型
                i.setDataAndType(MediaStore.Files.getContentUri("external"), "*/*");
                i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "video/*"});
            }
            try { i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true); } catch (Exception ignored) {}
            try {
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {}
            activity.startActivityForResult(i, FilePick.REQ_PICK);
            return;
        } catch (Exception ignored) {
            // 落到下一级
        }

        // 3) 兜底：文件浏览器
        launchFileBrowser(accept);
    }

    /** 非媒体文件（APK / 压缩包 / 任意文件）走系统文件浏览器。 */
    private void launchFileBrowser(String accept) {
        try {
            String[] types = splitTypes(accept);
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            if (types.length == 1) {
                i.setType(types[0]);
            } else {
                i.setType("*/*");   // 通配 + EXTRA_MIME_TYPES：setType 只认一个类型串
                i.putExtra(Intent.EXTRA_MIME_TYPES, types);
            }
            try { i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true); } catch (Exception ignored) {}
            try {
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            } catch (Exception ignored) {}
            activity.startActivityForResult(i, FilePick.REQ_PICK);
        } catch (Exception e) {
            // 个别精简系统没有 DocumentsUI：退回老方式，至少给个选择器
            try {
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                String[] types = splitTypes(accept);
                if (types.length == 1) i.setType(types[0]);
                else { i.setType("*/*"); i.putExtra(Intent.EXTRA_MIME_TYPES, types); }
                activity.startActivityForResult(Intent.createChooser(i, "选择文件"), FilePick.REQ_PICK);
            } catch (Exception e2) {
                failPick(pendingPickId, "无法打开文件选择器");
            }
        }
    }

    /**
     * 按 accept 判断需要哪种媒体权限；不需要或已经有了就返回 true。
     * 需要但还没有：发起运行时申请并返回 false。
     */
    private boolean ensureMediaPermission(String accept) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        List<String> need = new ArrayList<>();
        boolean wantsImage = accept.contains("image") || accept.equals("*/*");
        boolean wantsVideo = accept.contains("video") || accept.equals("*/*");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Android 13+：分区媒体权限，只能按类型申请。
            // 申请前先看「已授予」——
            //   Android 14 上 READ_MEDIA_IMAGES 未授予，但
            //   READ_MEDIA_VISUAL_USER_SELECTED 已授予（用户选了「仅选中的照片」）时，
            //   相册是有内容的，不该再弹一次权限框骚扰用户。
            boolean imgOk = activity.checkSelfPermission(android.Manifest.permission.READ_MEDIA_IMAGES)
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
            boolean vidOk = activity.checkSelfPermission(android.Manifest.permission.READ_MEDIA_VIDEO)
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
            boolean partialOk = false;
            if (Build.VERSION.SDK_INT >= 34) {
                try {
                    partialOk = activity.checkSelfPermission(
                            android.Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
                            == android.content.pm.PackageManager.PERMISSION_GRANTED;
                } catch (Throwable ignored) { }
            }
            if (wantsImage && !imgOk && !partialOk) need.add(android.Manifest.permission.READ_MEDIA_IMAGES);
            if (wantsVideo && !vidOk && !partialOk) need.add(android.Manifest.permission.READ_MEDIA_VIDEO);
            if (need.isEmpty()) return true;
            // 已拿到「部分照片」权限时不再申请，直接开相册
            if (partialOk && (wantsImage || wantsVideo)) return true;
        } else {
            if ((wantsImage || wantsVideo)
                    && activity.checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                need.add(android.Manifest.permission.READ_EXTERNAL_STORAGE);
            }
        }
        if (need.isEmpty()) return true;
        try {
            activity.requestPermissions(need.toArray(new String[0]), REQ_MEDIA_PERM);
        } catch (Exception e) {
            return true;   // 申请失败也别把选择器堵死
        }
        return false;
    }

    /** 权限申请结果由 MainActivity 转发过来。无论如何都把选择器打开。 */
    void onMediaPermissionResult() {
        String accept = pendingPickAccept;
        pendingPickAccept = null;
        if (pendingPickId == null) return;
        launchGallery(accept == null || accept.isEmpty() ? "*/*" : accept);
    }

    /* 把 accept 拆成 MIME 数组： "image/*,video/*" -> ["image/*","video/*"]；
     * 空或通配按单元素处理。 */
    private static String[] splitTypes(String accept) {
        if (accept == null || accept.isEmpty() || "*/*".equals(accept.trim())) {
            return new String[]{"*/*"};
        }
        String[] parts = accept.split(",");
        List<String> out = new ArrayList<>();
        for (String p : parts) {
            String t = p.trim();
            if (!t.isEmpty()) out.add(t);
        }
        if (out.isEmpty()) out.add("*/*");
        return out.toArray(new String[0]);
    }

    private void failPick(String id, String msg) {
        runJs("window.Native._pick(" + JSONObject.quote(String.valueOf(id)) + ",null,"
                + JSONObject.quote(msg) + ")");
    }

    /** MainActivity 在 onActivityResult 中转发结果。 */
    void onPickResult(int resultCode, Intent data) {
        String id = pendingPickId;
        pendingPickId = null;
        if (id == null) return;
        if (resultCode != Activity.RESULT_OK || data == null) {
            runJs("window.Native._pick(" + JSONObject.quote(id) + ",null,\"\")");
            return;
        }

        // 多选：ClipData 里是一个列表；单选仍在 data.getData()。
        // 前端拿到数组后逐个上传。
        java.util.List<Uri> uris = new ArrayList<>();
        try {
            if (data.getClipData() != null) {
                ClipData cd = data.getClipData();
                for (int i = 0; i < cd.getItemCount(); i++) {
                    Uri u = cd.getItemAt(i).getUri();
                    if (u != null) uris.add(u);
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
        } catch (Exception ignored) { }

        if (uris.isEmpty()) {
            // 用户什么都没选（点返回 / 关掉选择器）
            runJs("window.Native._pick(" + JSONObject.quote(id) + ",null,\"\")");
            return;
        }

        try {
            JSONArray arr = new JSONArray();
            for (Uri uri : uris) {
                /*
                  持久化读权限 —— 但**只能对支持持久化的来源调**。

                  系统文件浏览器（ACTION_OPEN_DOCUMENT）返回的 URI 支持持久化；
                  而系统相册（ACTION_PICK / Android 13+ 的照片选择器）返回的
                  **明确不支持** —— 对它调 takePersistableUriPermission 必抛
                  SecurityException。

                  以前这行裸奔在循环里，相册选完一张图，这里一抛就把整个
                  try 块带崩，用户看到的是「读取文件信息失败」—— 上传功能
                  在相册路径上全军覆没。现在逐条尝试、失败只影响它自己：
                  相册 URI 拿的是系统授予的临时读权限，紧接着的上传在
                  本进程内读，完全够用。
                */
                try {
                    int flags = data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION;
                    activity.getContentResolver().takePersistableUriPermission(uri, flags);
                } catch (Exception ignored) {
                    // 不支持持久化（相册等来源）—— 临时权限足够本次上传
                }
                FilePick.Meta meta = FilePick.query(activity, uri);
                JSONObject jo = new JSONObject();
                jo.put("name", meta.name);
                jo.put("size", meta.size);
                jo.put("mime", meta.mime);
                jo.put("uri", uri.toString());
                arr.put(jo);
            }
            // 单个也包成数组，前端统一按数组处理（_pick 里再摊平回单对象）
            runJs("window.Native._pick(" + JSONObject.quote(id) + ","
                    + arr.toString() + ",\"\")");
        } catch (Exception e) {
            failPick(id, "读取文件信息失败");
        }
    }

    void onPickCancel() {
        String id = pendingPickId;
        pendingPickId = null;
        if (id != null) {
            runJs("window.Native._pick(" + JSONObject.quote(id) + ",null,\"\")");
        }
    }

    /**
     * 选择一个**文件夹**（对齐官网「拖整个文件夹上传」的能力）。
     *
     * 走 ACTION_OPEN_DOCUMENT_TREE：系统文件浏览器里选中目录本身，
     * 返回的是目录的 tree:// 授权，再由 {@link #listFolder} 展开成文件清单。
     * 结果通过 window.Native._pick(id, {folder:true, name, uri}) 回调，
     * 与选文件共用同一条回执通道 —— 前端按 meta.folder 区分。
     */
    @JavascriptInterface
    public void pickFolder(String id) {
        pendingPickId = id;
        activity.runOnUiThread(() -> {
            try {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
                activity.startActivityForResult(i, FilePick.REQ_PICK_FOLDER);
            } catch (Exception e) {
                failPick(pendingPickId, "无法打开文件夹选择器");
            }
        });
    }

    /** MainActivity 在 onActivityResult 中转发文件夹选择结果。 */
    void onPickFolderResult(Intent data) {
        String id = pendingPickId;
        pendingPickId = null;
        if (id == null) return;
        try {
            Uri tree = (data == null) ? null : data.getData();
            if (tree == null) {
                runJs("window.Native._pick(" + JSONObject.quote(id) + ",null,\"\")");
                return;
            }
            /* tree URI 支持持久化授权 —— take 成功后，之后 listFolder /
               逐个上传时（哪怕跨过一次 Activity 重建）读取权限都还在。
               相册 URI 才是 take 不了的（那边已单独兜住）。 */
            try {
                activity.getContentResolver().takePersistableUriPermission(tree,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) { }

            // 目录名：treeDocId 形如 "primary:Download/githup"，取最后一段
            String docId = android.provider.DocumentsContract.getTreeDocumentId(tree);
            String name = docId.substring(docId.lastIndexOf('/') + 1);
            if (name.isEmpty()) name = "folder";

            JSONObject jo = new JSONObject();
            jo.put("folder", true);
            jo.put("name", name);
            jo.put("uri", tree.toString());
            runJs("window.Native._pick(" + JSONObject.quote(id) + ","
                    + jo.toString() + ",\"\")");
        } catch (Exception e) {
            failPick(id, "读取文件夹信息失败");
        }
    }

    /**
     * 展开一个已授权的目录树：递归列出里面所有文件（含子目录），
     * 通过 window.Native._list(id, files, err) 回传。
     *
     * 每个元素是 {name, path, size, mime, uri}，其中 **path 是相对所选
     * 目录的路径**（保留子目录结构），上传时它就是 GitHub 仓库里的路径。
     */
    @JavascriptInterface
    public void listFolder(String id, String treeUriStr) {
        pool.execute(() -> {
            try {
                Uri tree = Uri.parse(treeUriStr);
                java.util.List<FilePick.TreeItem> items =
                        FilePick.listTree(activity, tree, FilePick.MAX_TREE_FILES);
                JSONArray arr = new JSONArray();
                for (FilePick.TreeItem it : items) {
                    JSONObject jo = new JSONObject();
                    jo.put("name", it.name);
                    jo.put("path", it.path);
                    jo.put("size", it.size);
                    jo.put("mime", it.mime);
                    jo.put("uri", it.uri);
                    arr.put(jo);
                }
                runJs("window.Native._list(" + JSONObject.quote(String.valueOf(id)) + ","
                        + arr.toString() + ",\"\")");
            } catch (Throwable t) {
                String msg = t.getMessage();
                if (msg == null) msg = t.getClass().getSimpleName();
                runJs("window.Native._list(" + JSONObject.quote(String.valueOf(id))
                        + ",null," + JSONObject.quote(msg) + ")");
            }
        });
    }

    /**
     * 读取选中文件的 Base64（用于小文件内嵌场景：TOTP 恢复码导入、
     * 二维码识别等）。
     *
     * ⚠️ 硬上限 READ_B64_MAX —— 这不是「建议」，是保命线。
     *
     * Base64 结果会拼进一行 JS 用 evaluateJavascript 灌给 WebView：
     * 一个 25MB 的文件就是 33MB 的字符串，中转链路（quote 转义副本、
     * 跨进程传给渲染进程、V8 解析）每一步都在堆内存的悬崖上 ——
     * 中低端机「一上传就闪退」的真身就是它。
     *
     * 大文件（仓库文件上传）绝不能再走这条路，一律用
     * {@link #uploadMultipartB64}：文件在原生侧边读边编、直接进网络，
     * 内存占用恒定几 KB。
     */
    private static final long READ_B64_MAX = 12L * 1024 * 1024;

    @JavascriptInterface
    public void readFileBase64(String id, String uriStr, long maxBytes) {
        pool.execute(() -> {
            try {
                Uri uri = Uri.parse(uriStr);
                /* 双上限：调用方给的小上限优先，但本方法自己的保命线
                   永远生效 —— 谁也拦不住前端哪天传个 100 进来 */
                long cap = (maxBytes > 0 && maxBytes < READ_B64_MAX) ? maxBytes : READ_B64_MAX;
                FilePick.Meta meta = FilePick.query(activity, uri);
                if (meta.size > cap) {
                    runJs("window.Native._read(" + JSONObject.quote(String.valueOf(id))
                            + ",null," + JSONObject.quote("文件过大（" + FilePick.human(meta.size)
                            + "），超过 " + FilePick.human(cap) + " 限制") + ")");
                    return;
                }
                byte[] bytes = FilePick.readAll(activity, uri, cap);
                String b64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP);
                runJs("window.Native._read(" + JSONObject.quote(String.valueOf(id)) + ","
                        + JSONObject.quote(b64) + ",\"\")");
            } catch (Throwable t) {
                String msg = t.getMessage();
                if (msg == null) msg = t.getClass().getSimpleName();
                runJs("window.Native._read(" + JSONObject.quote(String.valueOf(id)) + ",null,"
                        + JSONObject.quote(msg) + ")");
            }
        });
    }

    /**
     * 二进制上传到指定 URL（用于 Release 附件）。
     *
     * ⚠️ 走流式 —— 这里踩过真实的坑：
     *
     * 以前是「把整个文件 readAll 成 byte[] → 一次性 POST」。附件上限写的
     * 是 200MB，也就是说最大的合法文件要在内存里完整躺一份 ——
     * ByteArrayOutputStream 扩容的峰值还是文件大小的两倍多。
     * 低端机传个大附件，OutOfMemoryError 当场带走进程，用户看到的就是
     * 「一上传就闪退」。
     *
     * 现在改成和 uploadRaw 一样的边读边发：内存占用恒定 8KB，
     * 200MB 的附件也只占一杯水的内存。
     */
    @JavascriptInterface
    public void uploadBinary(String id, String url, String uriStr, String headersJson) {
        pool.execute(() -> {
            InputStream in = null;
            try {
                Map<String, String> headers = new HashMap<>();
                if (headersJson != null && !headersJson.isEmpty()) {
                    JSONObject jo = new JSONObject(headersJson);
                    Iterator<String> it = jo.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        headers.put(k, jo.optString(k, ""));
                    }
                }
                Uri uri = Uri.parse(uriStr);
                String ctype = headers.remove("Content-Type");
                if (ctype == null || ctype.isEmpty()) ctype = "application/octet-stream";

                long size = FilePick.sizeOf(activity, uri);
                if (size > FilePick.MAX_ASSET_BYTES) {
                    throw new Exception("文件过大（" + FilePick.human(size)
                            + "），附件不能超过 " + FilePick.human(FilePick.MAX_ASSET_BYTES));
                }

                in = FilePick.open(activity, uri);
                Http.Response r = Http.requestMultipart(url, in, size, ctype, headers);
                runJs("window.Native._cb(" + JSONObject.quote(String.valueOf(id)) + ","
                        + r.code + "," + JSONObject.quote(r.body == null ? "" : r.body) + ","
                        + JSONObject.quote(r.headers == null ? "{}" : r.headers) + ")");
            } catch (Throwable t) {
                String msg = t.getMessage();
                if (msg == null) msg = t.getClass().getSimpleName();
                runJs("window.Native._cb(" + JSONObject.quote(String.valueOf(id)) + ",0,"
                        + JSONObject.quote("") + "," + JSONObject.quote("{\"error\":" + JSONObject.quote(msg) + "}") + ")");
            } finally {
                try { if (in != null) in.close(); } catch (Throwable ignored) { }
            }
        });
    }

    /**
     * multipart/form-data 上传：用于往 GitHub 传图片 / 视频附件。
     *
     * 与 uploadBinary 的区别 ——
     *   uploadBinary 是一次性把整个文件读成 byte[]，适合几百 KB 的 APK；
     *   图片视频动辄十几 MB，必须流式，否则低端机直接 OOM。
     *   所以这里只传头尾字符串，文件由原生边读边发。
     *
     * @param head 文件之前的内容（含末尾空行）
     * @param tail 文件之后的内容（含结束边界）
     */
    @JavascriptInterface
    public void uploadMultipart(String id, String url, String uriStr, String headersJson,
                                String head, String tail) {
        pool.execute(() -> {
            InputStream in = null;
            try {
                Map<String, String> headers = new HashMap<>();
                if (headersJson != null && !headersJson.isEmpty()) {
                    JSONObject jo = new JSONObject(headersJson);
                    Iterator<String> it = jo.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        headers.put(k, jo.optString(k, ""));
                    }
                }

                Uri uri = Uri.parse(uriStr);
                String ctype = headers.remove("Content-Type");   // 由请求头单独带，别重复

                byte[] headBytes = head == null ? new byte[0] : head.getBytes("UTF-8");
                byte[] tailBytes = tail == null ? new byte[0] : tail.getBytes("UTF-8");
                long fileLen = FilePick.sizeOf(activity, uri);
                long total = headBytes.length + fileLen + tailBytes.length;

                // 头 + 文件 + 尾拼成一个流，交给底层流式发送
                in = new java.io.SequenceInputStream(
                        new java.io.ByteArrayInputStream(headBytes),
                        new java.io.SequenceInputStream(
                                FilePick.open(activity, uri),
                                new java.io.ByteArrayInputStream(tailBytes)));

                Http.Response r = Http.requestMultipart(url, in, total, ctype, headers);
                runJs("window.Native._cb(" + JSONObject.quote(String.valueOf(id)) + ","
                        + r.code + "," + JSONObject.quote(r.body == null ? "" : r.body) + ","
                        + JSONObject.quote(r.headers == null ? "{}" : r.headers) + ")");
            } catch (Throwable t) {
                String msg = t.getMessage();
                if (msg == null) msg = t.getClass().getSimpleName();
                runJs("window.Native._cb(" + JSONObject.quote(String.valueOf(id)) + ",0,"
                        + JSONObject.quote("") + ","
                        + JSONObject.quote("{\"error\":" + JSONObject.quote(msg) + "}") + ")");
            } finally {
                try { if (in != null) in.close(); } catch (Throwable ignored) { }
            }
        });
    }

    /**
     * 「JSON 里嵌 Base64 文件」的流式上传 —— 给仓库文件上传（Contents API）用。
     *
     * Contents API 的请求体长这样：
     *   {"message":"Add file","content":"<整个文件的 Base64>","branch":"main"}
     *
     * 以前的流程是前端先 readFileBase64 拿到 33MB 的字符串、自己拼 JSON、
     * 再整体 POST —— 中转的每一步（evaluateJavascript 巨串、JS 里字符串
     * 拼接、JSON.parse）都在堆内存的悬崖上，中低端机「一上传就闪退」。
     *
     * 现在文件内容**不再回前端**：原生把
     *   head（{"message":..,"content":"）
     *   → 文件流（边读边 Base64，见 FilePick.base64Encoding）
     *   → tail（","branch":..}）
     * 三段拼成一个流直接发出去。内存占用恒定几 KB，与文件大小无关。
     *
     * @param head 文件 Base64 之前的 JSON 前半段（含 content 的左引号）
     * @param tail Base64 之后的 JSON 余下部分（从右引号开始）
     */
    @JavascriptInterface
    public void uploadMultipartB64(String id, String url, String uriStr, String headersJson,
                                   String head, String tail) {
        pool.execute(() -> {
            InputStream in = null;
            try {
                Map<String, String> headers = new HashMap<>();
                if (headersJson != null && !headersJson.isEmpty()) {
                    JSONObject jo = new JSONObject(headersJson);
                    Iterator<String> it = jo.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        headers.put(k, jo.optString(k, ""));
                    }
                }

                Uri uri = Uri.parse(uriStr);
                String ctype = headers.remove("Content-Type");
                if (ctype == null || ctype.isEmpty()) ctype = "application/json";

                byte[] headBytes = head == null ? new byte[0] : head.getBytes("UTF-8");
                byte[] tailBytes = tail == null ? new byte[0] : tail.getBytes("UTF-8");
                long fileLen = FilePick.sizeOf(activity, uri);
                if (fileLen > FilePick.MAX_CONTENTS_BYTES) {
                    throw new Exception("文件过大（" + FilePick.human(fileLen)
                            + "），仓库文件不能超过 " + FilePick.human(FilePick.MAX_CONTENTS_BYTES));
                }
                long total = headBytes.length + FilePick.base64Length(fileLen) + tailBytes.length;

                // 头 + 文件(边读边编 Base64) + 尾 拼成一个流，底层流式发送。
                // Contents API 只认 PUT —— 别用默认的 POST 重载
                in = new java.io.SequenceInputStream(
                        new java.io.ByteArrayInputStream(headBytes),
                        new java.io.SequenceInputStream(
                                FilePick.base64Encoding(FilePick.open(activity, uri)),
                                new java.io.ByteArrayInputStream(tailBytes)));

                Http.Response r = Http.requestMultipart("PUT", url, in, total, ctype, headers);
                runJs("window.Native._cb(" + JSONObject.quote(String.valueOf(id)) + ","
                        + r.code + "," + JSONObject.quote(r.body == null ? "" : r.body) + ","
                        + JSONObject.quote(r.headers == null ? "{}" : r.headers) + ")");
            } catch (Throwable t) {
                String msg = t.getMessage();
                if (msg == null) msg = t.getClass().getSimpleName();
                runJs("window.Native._cb(" + JSONObject.quote(String.valueOf(id)) + ",0,"
                        + JSONObject.quote("") + ","
                        + JSONObject.quote("{\"error\":" + JSONObject.quote(msg) + "}") + ")");
            } finally {
                try { if (in != null) in.close(); } catch (Throwable ignored) { }
            }
        });
    }

    /**
     * 裸体二进制上传：请求体就是文件本身，没有 multipart 包装。
     *
     * GitHub 的附件直传端点（uploads.github.com/user-attachments/assets）
     * 要的就是这个形态 —— Content-Type 是文件的真实 mime，body 是原始字节，
     * 文件名和仓库 id 全部走 URL 查询参数。以前那种「先取策略、再传 S3」
     * 的老三步接口已经不在 api.github.com 上了（会 404），所以改成这条。
     *
     * 与 uploadBinary 的区别：uploadBinary 把整个文件读成 byte[]，
     * 十几 MB 的图片视频在低端机上很吃内存；这里跟 uploadMultipart 一样
     * 边读边发，内存占用与文件大小无关。
     */

    /**
     * 算一个文件的 **Git blob SHA-1**：{@code sha1("blob " + 长度 + "\0" + 内容)}。
     *
     * 仓库里已经有了、内容没变，根本不用再传一遍 —— 直接复用远程那个
     * sha 去建 tree。传一批文件时这一条能砍掉大半的请求数，而请求数
     * 正是「整批失败概率」的指数底数。
     *
     * 必须是 **Git 自己那种算法**（带 "blob 长度\0" 前缀），不是普通的
     * sha1(文件内容)，否则和 GitHub 返回的 tree 对不上。
     *
     * 流式算：文件不进内存，几百 MB 也是恒定几 KB 占用。
     */
    @JavascriptInterface
    public void gitBlobSha(String id, String uriStr) {
        pool.execute(() -> {
            String out = null;
            try {
                Uri uri = Uri.parse(uriStr);
                MessageDigest md = MessageDigest.getInstance("SHA-1");
                long len = FilePick.sizeOf(activity, uri);
                md.update(("blob " + len + "\0").getBytes("UTF-8"));
                try (InputStream in = FilePick.open(activity, uri)) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
                }
                StringBuilder sb = new StringBuilder();
                for (byte b : md.digest()) sb.append(String.format("%02x", b));
                out = sb.toString();
            } catch (Throwable t) {
                out = null;
            }
            runJs("window.Native._cb(" + JSONObject.quote(String.valueOf(id)) + ","
                    + (out == null ? 0 : 200) + ","
                    + JSONObject.quote(out == null ? "" : out) + ",\"{}\")");
        });
    }

    @JavascriptInterface
    public void uploadRaw(String id, String url, String uriStr, String headersJson) {
        pool.execute(() -> {
            InputStream in = null;
            try {
                Map<String, String> headers = new HashMap<>();
                if (headersJson != null && !headersJson.isEmpty()) {
                    JSONObject jo = new JSONObject(headersJson);
                    Iterator<String> it = jo.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        headers.put(k, jo.optString(k, ""));
                    }
                }

                Uri uri = Uri.parse(uriStr);
                String ctype = headers.remove("Content-Type");
                if (ctype == null || ctype.isEmpty()) ctype = "application/octet-stream";
                long total = FilePick.sizeOf(activity, uri);
                in = FilePick.open(activity, uri);

                Http.Response r = Http.requestMultipart(url, in, total, ctype, headers);
                runJs("window.Native._cb(" + JSONObject.quote(String.valueOf(id)) + ","
                        + r.code + "," + JSONObject.quote(r.body == null ? "" : r.body) + ","
                        + JSONObject.quote(r.headers == null ? "{}" : r.headers) + ")");
            } catch (Throwable t) {
                String msg = t.getMessage();
                if (msg == null) msg = t.getClass().getSimpleName();
                runJs("window.Native._cb(" + JSONObject.quote(String.valueOf(id)) + ",0,"
                        + JSONObject.quote("") + ","
                        + JSONObject.quote("{\"error\":" + JSONObject.quote(msg) + "}") + ")");
            } finally {
                try { if (in != null) in.close(); } catch (Throwable ignored) { }
            }
        });
    }

    /**
     * 在应用内把用户输入的字母数字变成签名密钥（PKCS12 的 Base64）。
     *
     * 用户不想为了签名去电脑上敲 keytool，所以钥匙由 App 自己生成。
     * 同一串输入会派生出同一把钥匙，因此换设备、换时间都能重建出
     * 完全相同的签名，打出来的包可以覆盖安装。
     * 计算 RSA 2048 需要几秒，所以走线程池，结果通过 window.Native._ks 回调。
     */
    @JavascriptInterface
    public void makeKeystore(String id, String seed, String alias, String storePass, String keyPass) {
        pool.execute(() -> {
            try {
                byte[] ks = KeyTool.makeKeystore(seed, alias, storePass, keyPass);
                String b64 = android.util.Base64.encodeToString(ks, android.util.Base64.NO_WRAP);
                runJs("window.Native._ks(" + JSONObject.quote(String.valueOf(id)) + ","
                        + JSONObject.quote(b64) + ",\"\")");
            } catch (Throwable t) {
                String msg = t.getMessage();
                if (msg == null) msg = t.getClass().getSimpleName();
                runJs("window.Native._ks(" + JSONObject.quote(String.valueOf(id)) + ",null,"
                        + JSONObject.quote(msg) + ")");
            }
        });
    }

    /** 应用版本号，供「设置 → 关于」显示。 */
    @JavascriptInterface
    public String appVersion() {
        try {
            return BuildConfig.VERSION_NAME;
        } catch (Throwable t) {
            return "";
        }
    }

    /**
     * 本机安装包的签名证书指纹（SHA-256，小写），供「设置 → 关于」显示。
     *
     * 让人能自己核对：这个包的签名是不是官方那个。读不到就返回空串 ——
     * 编一个假的比不显示更有害。
     */
    @JavascriptInterface
    public String certSha256() {
        try {
            String s = SignCheck.signingSha256(activity);
            return s == null ? "" : s;
        } catch (Throwable t) {
            return "";
        }
    }

    /**
     * 本机已安装 APK 的 SHA-256 指纹。
     *
     * 用途：版本号冻结不变、但包里内容已经换过的情况下，
     * 前端靠比对这个指纹来判断「有没有新内容」。
     * 读不到就返回空串（前端会跳过指纹比对，不当成异常）。
     */
    @JavascriptInterface
    public String apkSha256() {
        try {
            android.content.pm.ApplicationInfo ai =
                activity.getPackageManager().getApplicationInfo(activity.getPackageName(), 0);
            java.io.File apk = new java.io.File(ai.sourceDir);
            if (!apk.exists()) return "";
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[64 * 1024];
            try (java.io.FileInputStream in = new java.io.FileInputStream(apk)) {
                int n;
                while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            }
            byte[] digest = md.digest();
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) sb.append(String.format("%02x", b & 0xff));
            return sb.toString();
        } catch (Throwable t) {
            return "";
        }
    }

    /* ---------------- 错误日志 ---------------- */

    /* ---------------- GitHub 通知的后台轮询 ---------------- */

    /**
     * 后台通知提醒是否开启（默认开）。
     *
     * 为什么需要：GitHub 不会把通知推给第三方 App，只能 App 定时去问。
     * 这里把开关交给用户 —— 有人就是不想要系统通知。
     */
    @JavascriptInterface
    public boolean notifWatchEnabled() {
        try { return NotifWatchReceiver.isEnabled(activity); } catch (Throwable ignored) { return true; }
    }

    @JavascriptInterface
    public void setNotifWatch(boolean on) {
        try { NotifWatchReceiver.setEnabled(activity, on); } catch (Throwable ignored) { }
    }

    /**
     * 立刻检查一次 GitHub 通知（不等待下一轮）。
     *
     * 给「通知页下拉刷新」用 —— 让用户能当场验证后台提醒到底有没有在工作，
     * 而不是干等 15 分钟才知道。这不是开关，只是一个手动触发。
     */
    @JavascriptInterface
    public void checkNotificationsNow() {
        try { NotifWatchReceiver.checkNow(activity); } catch (Throwable ignored) { }
    }

    /** 上次后台检查的时间戳（0 = 从没检查过），给设置页显示 */
    @JavascriptInterface
    public long notifWatchLastCheck() {
        try { return NotifWatchReceiver.lastCheck(activity); } catch (Throwable ignored) { return 0; }
    }

    /**
     * 前端上报一条错误（功能出问题了）。
     *
     * 这是「翻译引擎全部不可用」这类业务错误的主要入口 ——
     * 前端在出错的地方调一次，这里就落一条大白话记录。
     *
     * @param what 大白话描述，如「翻译引擎全部不可用」
     * @param why  补充原因（可为空）
     */
    @JavascriptInterface
    public void logError(String what, String why) {
        try { LogBook.error(activity, what, why); } catch (Throwable ignored) { }
    }

    /**
     * 前端上报一条关键操作（不是错误，用来还原现场）。
     *
     * @param what 如「开始翻译本页」/「上传文件」
     */
    @JavascriptInterface
    public void logNote(String what) {
        try { LogBook.note(activity, what); } catch (Throwable ignored) { }
    }

    /**
     * 「保存到本地」：把今天的错误日志写进 Download/githup/错误日志/。
     * 写完回前端一个结果（ok / 失败），由前端决定提示什么。
     */
    @JavascriptInterface
    public void saveLog(final String cbId) {
        try {
            pool.execute(new Runnable() {
                @Override public void run() {
                    boolean ok = false;
                    try { ok = LogBook.save(activity); } catch (Throwable ignored) { }
                    if (cbId != null && !cbId.isEmpty()) {
                        runJs("window.Native&&Native.onLogSaved&&Native.onLogSaved('"
                                + cbId + "'," + ok + ")");
                    }
                }
            });
        } catch (Throwable t) { }
    }

    /**
     * 「分享」：把日志准备成一份可交给外部应用的副本，弹出系统分享面板。
     * 不想发直接关掉即可（这份副本是临时的，不影响已保存到 Download 的那份）。
     */
    @JavascriptInterface
    public void shareLog() {
        try {
            pool.execute(new Runnable() {
                @Override public void run() {
                    android.net.Uri share = null;
                    try { share = LogBook.share(activity); } catch (Throwable ignored) { }
                    if (share == null) return;   // 写不出副本：没有可分享的东西

                    try {
                        Intent send = new Intent(Intent.ACTION_SEND);
                        send.setType("text/plain");
                        send.putExtra(Intent.EXTRA_SUBJECT, "githup 错误日志");
                        send.putExtra(Intent.EXTRA_STREAM, share);
                        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        final Intent chooser = Intent.createChooser(send, "分享错误日志");
                        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                                | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        activity.runOnUiThread(new Runnable() {
                            @Override public void run() {
                                try { activity.startActivity(chooser); } catch (Throwable ignored) { }
                            }
                        });
                    } catch (Throwable ignored) { }
                }
            });
        } catch (Throwable ignored) { }
    }

    /**
     * 兼容旧调用：既保存又分享（当前前端已不用，留作后备）。
     */
    @JavascriptInterface
    public void exportLog() {
        saveLog("");
        shareLog();
    }

    /* ---------------- 令牌 ---------------- */

    /** 读取「记住的令牌」（退出登录后回填用）；没有返回空串 */
    @JavascriptInterface
    public String getSavedToken() {
        String t = SecurePrefs.get(activity, TOKEN_SAVED_KEY, "");
        return t == null ? "" : t;
    }

    /** 写入/清除「记住的令牌」。传空串即删除 */
    @JavascriptInterface
    public void setSavedToken(String token) {
        if (token == null || token.isEmpty()) {
            SecurePrefs.remove(activity, TOKEN_SAVED_KEY);
        } else {
            SecurePrefs.put(activity, TOKEN_SAVED_KEY, token);
        }
    }

    @JavascriptInterface
    public String getToken() {
        // 埋点四：令牌是最高价值的东西，读之前先过一遍防护链。
        // 非官方包直接拿不到令牌 —— 这是最后一道，也是最实在的一道。
        String t = SecurePrefs.get(activity, TOKEN_KEY, "");
        return t == null ? "" : t;
    }

    @JavascriptInterface
    public void setToken(String token) {
        if (token == null || token.isEmpty()) {
            SecurePrefs.remove(activity, TOKEN_KEY);
            /* 退出登录：撤掉轮询，并清掉去重表 —— 换账号后 id 不该继承，
             * 否则新账号的旧通知会被当成"已经提醒过了"而漏掉。 */
            try {
                NotifWatchReceiver.cancel(activity);
                NotifWatchReceiver.resetSeen(activity);
            } catch (Throwable ignored) { }
        } else {
            SecurePrefs.put(activity, TOKEN_KEY, token);
            /* 登录成功就顺手记一份。
               不在这里记的话，退出登录时 TOKEN_KEY 已经被清掉了，
               想「记住」也无从记起 —— 只能靠调用方先读后写，容易漏。 */
            SecurePrefs.put(activity, TOKEN_SAVED_KEY, token);
            /* 登录成功：把通知轮询挂上（已挂过不会重复） */
            try { NotifWatchReceiver.scheduleSoonAfterLogin(activity); } catch (Throwable ignored) { }
        }
    }

    /* ---------------- 键值存储 ---------------- */
    @JavascriptInterface
    public String getPref(String key) {
        return activity.getSharedPreferences("hub_prefs", Context.MODE_PRIVATE).getString(key, null);
    }

    @JavascriptInterface
    public void setPref(String key, String value) {
        activity.getSharedPreferences("hub_prefs", Context.MODE_PRIVATE).edit().putString(key, value).apply();
    }

    /* ---------------- 系统能力 ---------------- */
    @JavascriptInterface
    public void copy(String text) {
        activity.runOnUiThread(() -> {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("hub", text));
        });
    }

    /**
     * 读系统剪贴板。
     *
     * 用在「两步验证器」的导入上：很多网站只给一串密钥、给不了能扫的二维码，
     * 用户唯一的办法是复制过来粘进去。少一次「自己找地方粘贴」的折腾。
     *
     * Android 10+ 对剪贴板读取有隐私限制：仅当应用处于前台（有窗口焦点）时
     * 才拿得到内容，后台读会返回空 —— 这是系统行为，不是这里能绕过的。
     * 所以拿不到就返回空串，前端会退回到让用户手动粘贴，不会卡住。
     */
    @JavascriptInterface
    public String getClipboard() {
        try {
            ClipboardManager cm = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null || !cm.hasPrimaryClip()) return "";
            ClipData clip = cm.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) return "";
            CharSequence text = clip.getItemAt(0).coerceToText(activity);
            return text == null ? "" : text.toString();
        } catch (Throwable t) {
            return "";
        }
    }

    /**
     * 两步验证器的账户列表同步到原生侧。
     *
     * 后台常驻通知（TotpService）要在 App 不可见时也算出动态码，
     * 而它读不到 WebView 里的数据 —— 所以每次前端改动账户，就顺手
     * 推一份 JSON 过来存着。存的是 SharedPreferences 私有区，
     * 不进日志、不对外暴露。
     */
    @JavascriptInterface
    public void totpSync(String accountsJson) {
        try {
            /* 存之前先按「规整密钥 + issuer + name」去重。
               历史数据里同一账户可能被存两份（改过名字、重复导入），
               通知栏就会并排出现两行一模一样的码。 */
            String cleaned = accountsJson == null ? "[]" : accountsJson;
            try {
                org.json.JSONArray arr = new org.json.JSONArray(accountsJson == null ? "[]" : accountsJson);
                org.json.JSONArray out = new org.json.JSONArray();
                java.util.HashSet<String> seen = new java.util.HashSet<String>();
                for (int i = 0; i < arr.length(); i++) {
                    org.json.JSONObject o = arr.optJSONObject(i);
                    if (o == null) continue;
                    String type = o.optString("type", "totp");
                    String key = Totp.normalizeSecret(o.optString("secret", ""))
                            + "|" + type
                            + "|" + o.optInt("digits", 6)
                            + "|" + o.optInt("period", 30)
                            + "|" + o.optString("algo", "SHA1");
                    if ("hotp".equals(type)) key += "|" + o.optInt("counter", 0);
                    if (!seen.add(key)) continue; // 已存过同一账户，跳过
                    out.put(o);
                }
                cleaned = out.toString();
            } catch (Throwable inner) { /* 解析失败就原样存，不丢用户数据 */ }

            activity.getSharedPreferences("hub_prefs", Context.MODE_PRIVATE).edit()
                    .putString("totp_accounts_cache", cleaned)
                    .apply();
            // 顺手让通知服务按新清单重画一次（新增/删除账户后立刻生效）
            TotpService.refresh(activity);
        } catch (Throwable ignored) { }
    }

    /**
     * 开关「后台常驻动态码通知」。
     *
     * 关掉时要把已经挂着的通知撤掉，否则用户关了开关、通知栏还留着一条，
     * 会以为没关成功。
     *
     * 开启时会顺带申请通知权限 —— Android 13 起没这个权限就发不出通知，
     * 不在这里要，用户打开开关后会看到一个「什么都没发生」的界面。
     */
    @JavascriptInterface
    public void totpSetBackground(boolean on) {
        try {
            if (on) requestNotificationPermission();
            TotpService.setEnabled(activity, on);
        } catch (Throwable ignored) { }
    }

    /** 申请通知权限（Android 13+）。已授权或系统版本低就什么都不做。 */
    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        try {
            if (activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED) return;
            activity.runOnUiThread(() -> {
                try {
                    activity.requestPermissions(
                            new String[]{android.Manifest.permission.POST_NOTIFICATIONS},
                            REQ_NOTIFY_PERM);
                } catch (Throwable ignored) { }
            });
        } catch (Throwable ignored) { }
    }

    /** 查询后台常驻通知当前是不是开着（前端渲染开关状态用） */
    @JavascriptInterface
    public boolean totpBackgroundEnabled() {
        try {
            return TotpService.isEnabled(activity);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 当前 App 是否在前台（通知只在后台出现，前台不打扰） */
    @JavascriptInterface
    public boolean isAppForeground() {
        return App.sForeground;
    }

    /**
     * 扫一扫的前置：确认相机权限。回调 window.Native._camera(id, true/false)。
     *
     * 为什么要先走原生权限：WebView 里 getUserMedia 的授权链是
     * 「App 先持有 CAMERA 权限 → 页面发起请求 → onPermissionRequest 弹给
     * App → App 批给渲染进程」。App 自己没有 CAMERA 权限时，WebView
     * 连问都不会问、直接拒绝 —— 所以必须先把原生权限要到手，再开摄像头。
     *
     * 已授权：立刻回调 true，不弹框；
     * 没授权：弹一次系统权限框，用户选完（允许/拒绝）都把结果如实回调，
     * 绝不静默 —— 点了扫一扫却什么都没发生，比被拒绝更让人困惑。
     */
    @JavascriptInterface
    public void requestCamera(String id) {
        boolean granted = false;
        try {
            granted = activity.checkSelfPermission(android.Manifest.permission.CAMERA)
                    == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable ignored) { }
        if (granted) {
            cameraResult(id, true);
            return;
        }
        pendingCameraId = id;
        activity.runOnUiThread(() -> {
            try {
                activity.requestPermissions(
                        new String[]{android.Manifest.permission.CAMERA},
                        REQ_CAMERA_PERM);
            } catch (Throwable t) {
                onCameraPermissionResult(false);
            }
        });
    }

    /** MainActivity 在 onRequestPermissionsResult 里转发相机权限结果。 */
    void onCameraPermissionResult(boolean ok) {
        String id = pendingCameraId;
        pendingCameraId = null;
        if (id != null) cameraResult(id, ok);
    }

    private void cameraResult(String id, boolean ok) {
        runJs("window.Native._camera(" + JSONObject.quote(String.valueOf(id)) + ","
                + (ok ? "true" : "false") + ")");
    }

    /**
     * 生成密码学安全的随机字节，十六进制返回。
     *
     * 给「本机生成签名密钥」用（KeyTool），也用于两步验证器的
     * 密钥强度提示。用 SecureRandom 而不是 Math.random —— 后者
     * 是可预测的伪随机，拿来生成密钥等于没生成。
     */
    @JavascriptInterface
    public String randomHex(int bytes) {
        try {
            int n = Math.max(1, Math.min(bytes, 256));
            byte[] buf = new byte[n];
            new java.security.SecureRandom().nextBytes(buf);
            StringBuilder sb = new StringBuilder(n * 2);
            for (byte b : buf) sb.append(String.format(java.util.Locale.US, "%02x", b & 0xff));
            return sb.toString();
        } catch (Throwable t) {
            return "";
        }
    }

    /**
     * HMAC-SHA1 / HMAC-SHA256，输入输出都是十六进制。
     *
     * 两步验证器每秒都要算一次码。纯 JS 的 SHA 实现在低端机上是
     * 实打实的开销（一个账户一次哈希），交给系统 MessageDigest
     * 走原生实现，既快又不占主线程。
     *
     * 前端拿不到这个方法时会自动退回纯 JS 实现，功能不受影响。
     */
    @JavascriptInterface
    public String hmacSha1(String keyHex, String msgHex) {
        return hmac("HmacSHA1", keyHex, msgHex);
    }

    @JavascriptInterface
    public String hmacSha256(String keyHex, String msgHex) {
        return hmac("HmacSHA256", keyHex, msgHex);
    }

    private String hmac(String algo, String keyHex, String msgHex) {
        try {
            byte[] key = hexToBytes(keyHex);
            byte[] msg = hexToBytes(msgHex);
            if (key == null || msg == null) return "";
            javax.crypto.Mac mac = javax.crypto.Mac.getInstance(algo);
            mac.init(new javax.crypto.spec.SecretKeySpec(key, algo));
            byte[] out = mac.doFinal(msg);
            StringBuilder sb = new StringBuilder(out.length * 2);
            for (byte b : out) sb.append(String.format(java.util.Locale.US, "%02x", b & 0xff));
            return sb.toString();
        } catch (Throwable t) {
            return "";
        }
    }

    private static byte[] hexToBytes(String hex) {
        if (hex == null || hex.isEmpty() || hex.length() % 2 != 0) return null;
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int hi = Character.digit(hex.charAt(i * 2), 16);
            int lo = Character.digit(hex.charAt(i * 2 + 1), 16);
            if (hi < 0 || lo < 0) return null;
            out[i] = (byte) ((hi << 4) | lo);
        }
        return out;
    }

    @JavascriptInterface
    public void share(String url, String title) {
        activity.runOnUiThread(() -> {
            try {
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType("text/plain");
                i.putExtra(Intent.EXTRA_TEXT, url);
                i.putExtra(Intent.EXTRA_SUBJECT, title == null ? "" : title);
                activity.startActivity(Intent.createChooser(i, "分享"));
            } catch (Exception e) {
                Toast.makeText(activity, "无法分享", Toast.LENGTH_SHORT).show();
            }
        });
    }

    @SuppressWarnings("deprecation")
    /* ---------------- 应用内浏览器 ---------------- */

    /** 在应用内置浏览器中打开链接（共享 Cookie，可复用网页登录态）。 */
    @JavascriptInterface
    public void openInApp(String url, String title) {
        if (url == null || url.isEmpty()) return;
        activity.runOnUiThread(() -> {
            try {
                Intent i = new Intent(activity, WebViewActivity.class);
                i.putExtra(WebViewActivity.EXTRA_URL, url);
                i.putExtra(WebViewActivity.EXTRA_TITLE, title);
                activity.startActivity(i);
            } catch (Exception e) {
                Toast.makeText(activity, "无法打开页面", Toast.LENGTH_SHORT).show();
            }
        });
    }

    @JavascriptInterface
    /**
     * 用系统浏览器 / 对应的 App 打开一条外链。
     *
     * CATEGORY_BROWSABLE 只给 http/https 加，不能再无条件加：
     * 它是给「浏览器可安全打开的网页」用的过滤条件，加上它之后系统只会匹配
     * 声明了自己能处理 browsable 的 Activity。自定义 scheme（mqqapi://、
     * alipays://、weixin:// 之类）只有对应 App 的 Activity 能接，而这些
     * Activity 基本都不声明 browsable —— 于是匹配结果为空，startActivity 抛
     * ActivityNotFoundException，被 catch 成一句「无法打开链接」。
     * 「一键加群」点了没反应，根子就在这里。
     *
     * 自定义 scheme 走不带 category 的匹配；万一还是没人接（比如对应 App 没装），
     * 退化成用浏览器打开原链接，绝不留下「点了没反应」。
     */
    public void openExternal(String url) {
        activity.runOnUiThread(() -> {
            if (url == null || url.trim().isEmpty()) {
                Toast.makeText(activity, "链接为空", Toast.LENGTH_SHORT).show();
                return;
            }
            try {
                Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                if (isWebUrl(url)) i.addCategory(Intent.CATEGORY_BROWSABLE);
                activity.startActivity(i);
            } catch (Exception e) {
                // 没人接这条 scheme（多半是对应 App 没装）：退回浏览器打开
                try {
                    if (!isWebUrl(url)) {
                        Intent web = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                        web.addCategory(Intent.CATEGORY_BROWSABLE);
                        activity.startActivity(web);
                        return;
                    }
                } catch (Exception ignored) {}
                Toast.makeText(activity, "无法打开链接", Toast.LENGTH_SHORT).show();
            }
        });
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

    @JavascriptInterface
    public void download(String url, String filename) {
        downloadWithHeaders(url, filename, null);
    }

    /* ============================================================
     * 保存图片到系统相册
     *
     * 跟 download() 的区别：
     *   - download 走 DownloadManager，落到 Download/githup/，是「文件」
     *   - saveImage 走 MediaStore.Images，落到 Pictures/githup/，是「照片」，
     *     系统相册、微信、QQ 选图时都能直接看到
     *
     * 触发场景：议题正文里的截图、赞赏码、查看大图时点「保存」。
     * 长按弹菜单由前端负责，这里只做「拿到 URL → 落盘到相册」。
     * ============================================================ */
    @JavascriptInterface
    public void saveImage(final String url) {
        if (url == null || url.isEmpty()) {
            toast("图片地址为空");
            return;
        }
        pool.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    Http.RawResponse resp = null;
                    /* 1) 拿到图片字节。
                     *    分两种来源：
                     *      a) 本地 assets 资源（赞赏码 tips.png 这类）—— 直接读 assets
                     *      b) 网络图片（GitHub 附件、仓库图）—— 走 Http，带 token */
                    byte[] data;
                    /*
                      ═══ data: URI —— 字节就在串里，不必再发网络 ═══

                      README 里的图片为了让 raw.githubusercontent.com 这类
                      直连不通的地址也能出图，走了一条「原生取图」快车道：
                      拉回 base64 塞成 data: URI 再赋给 <img src>（见
                      md.js 的 pumpFetch，以及 ImageProxy 的转发通道）。
                      **于是 img.src 可能整串都是图片数据，而不是一个网址。**

                      浏览器当然能渲染它 —— 也正是它能「下载图片」的原因之一
                      （浏览器存的是已解码的那份，根本不用再按 URL 取一遍）。
                      而这里以前没有这个分支：data: 掉进下面的网络分支，
                      `new URL("data:…")` 直接抛 MalformedURLException，
                      报错写着「保存失败：no protocol: data:…」，看不懂。

                      没有这个分支，README 里凡是走了快车道的图都存不下来 ——
                      而那恰恰是绝大多数。
                    */
                    boolean isData = url != null && url.startsWith("data:");
                    String assetPath = null;
                    if (isData) {
                        data = decodeDataUri(url);
                        if (data == null || data.length == 0) {
                            toast("保存失败：图片数据读不出来");
                            return;
                        }
                    } else {
                    assetPath = assetPathOf(url);
                    if (assetPath != null) {
                        /* 本地 assets：file:///android_asset/web/img/tips.png
                         * 或相对路径 img/tips.png，都映射到 assets/web/... */
                        java.io.InputStream in = null;
                        try {
                            in = activity.getAssets().open(assetPath);
                            java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
                            byte[] buf = new byte[16384];
                            int n;
                            while ((n = in.read(buf)) > 0) baos.write(buf, 0, n);
                            data = baos.toByteArray();
                        } finally {
                            if (in != null) try { in.close(); } catch (Throwable ignored) {}
                        }
                    } else {
                        /*
                          ═══ 建连前先验一下地址 ═══

                          报错长这样：
                              failed to connect to localhost/127.0.0.1 (port 443)

                          443 这个数字是关键：Http 里端口是这么算的
                              secure = "https".equalsIgnoreCase(u.getProtocol())
                              port   = u.getPort()>0 ? u.getPort() : (secure?443:80)
                          能算出 443 说明 **protocol 是 https，而 host 是空的**
                          (空 host 经 InetAddress.getByName("") 解析成回环地址，
                          于是报错里写着 localhost/127.0.0.1)。

                          浏览器遇到这种地址是**认得出无效、直接失败**的，
                          绝不会去连本机；我们以前照建连不误。这里挡一道，
                          和浏览器对齐：解析不出主机就不连，并给一句人话。
                        */
                        /*
                          用 Http.hostUsable 而不是自己判「host 非空」——
                          后者会放行 localhost / 127.0.0.1 / 0.0.0.0 / [::1]，
                          照样连到本机，报错依旧是那句 localhost。
                        */
                        if (!Http.hostUsable(url)) {
                            toast("保存失败：图片地址不完整（" + briefUrl(url) + "）");
                            return;
                        }
                        java.util.Map<String, String> headers = new java.util.HashMap<>();
                        String token = getToken();
                        if (token != null && !token.isEmpty()) {
                            headers.put("Authorization", "Bearer " + token);
                        }
                        headers.put("Accept", "image/*,*/*;q=0.8");
                        /*
                          ═══ 直连取不到，就换加速通道 ═══

                          日志已经给出真相（用户导出）：地址完全正常 ——
                              https://raw.githubusercontent.com/Buwrt/githup/main/docs/tips.png
                          却连到了 localhost/127.0.0.1。

                          那串不是我们写死的地址，而是**解析结果**：
                          InetAddress.toString() 是「主机名/IP」，127.0.0.1 的
                          反查名恰好是 localhost。所以是这台手机上
                          raw.githubusercontent.com 被解析到了本机 ——
                          hosts 被改（各类 GitHub 加速/hosts 修改器都会写 127.0.0.1）
                          或 VPN 的 DNS 劫持。

                          同一个域名，加载却正常：图片是 **WebView 渲染的**，
                          Chromium 自带解析器、不读系统 hosts；保存走原生
                          InetAddress、会读。**两边问的不是同一个地方。**

                          跟 DNS 较劲不如换个域名：本 App 本来就有 17 条
                          加速通道（下载 Release 一直在用），把取图也接上去。
                          直连失败时依次换通道重试 —— 换的是主机，
                          本机那条 hosts 记录就管不着了。
                        */
                        resp = fetchImage(url, headers);
                        if (resp == null || resp.code < 200 || resp.code >= 300 || resp.body == null) {
                            toast("保存失败：图片下载不到"
                                    + (resp == null ? "（直连与加速通道都连不上）"
                                                     : "（HTTP " + resp.code + "）"));
                            return;
                        }
                        data = resp.body;
                    }
                    }
                    if (data == null || data.length == 0) {
                        toast("保存失败：图片是空的");
                        return;
                    }

                    /* 2) 推断 MIME 类型与扩展名。
                     *    网络图片优先看响应头 Content-Type，本地 assets 没有响应头，
                     *    从 URL 后缀猜，再不行按文件头魔数判（PNG/JPEG/GIF/WebP）。 */
                    String mime = null;
                    /*
                      data: URI 自己就带着类型（data:image/png;base64,…），
                      用它的 —— 而且**绝不能去读 resp**：data 分支下 resp 是 null，
                      读它会 NPE 被下面的 catch 悄悄吞掉，mime 恒为 null，
                      最后只能靠魔数猜，SVG 这类没有魔数的就全存成了 png。
                    */
                    if (isData) {
                        mime = mimeOfDataUri(url);
                    } else if (assetPath == null) {
                        try { mime = resp.header("Content-Type"); } catch (Throwable ignored) {}
                        if (mime != null) {
                            int sc = mime.indexOf(';');
                            if (sc > 0) mime = mime.substring(0, sc).trim();
                        }
                    }
                    String ext = extFromMime(mime);
                    if (ext == null) ext = extFromUrl(url);
                    if (ext == null) ext = extFromMagic(data);
                    if (ext == null) ext = "png";
                    if (mime == null) mime = mimeFromExt(ext);

                    /* 3) 用时间戳生成文件名，避免重名覆盖。 */
                    String name = "githup_" + System.currentTimeMillis() + "." + ext;

                    /* 4) 通过 MediaStore.Images 写进 Pictures/githup/。 */
                    android.content.ContentValues cv = new android.content.ContentValues();
                    cv.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                    cv.put(MediaStore.Images.Media.MIME_TYPE, mime);
                    if (Build.VERSION.SDK_INT >= 29) {
                        cv.put(MediaStore.Images.Media.RELATIVE_PATH,
                                Environment.DIRECTORY_PICTURES + "/githup");
                        cv.put(MediaStore.Images.Media.IS_PENDING, 1);
                    }
                    Uri item = activity.getContentResolver()
                            .insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
                    if (item == null) {
                        toast("保存失败：无法创建相册条目");
                        return;
                    }
                    java.io.OutputStream out = activity.getContentResolver().openOutputStream(item);
                    if (out == null) {
                        activity.getContentResolver().delete(item, null, null);
                        toast("保存失败：无法写入相册");
                        return;
                    }
                    out.write(data);
                    out.flush();
                    out.close();

                    if (Build.VERSION.SDK_INT >= 29) {
                        android.content.ContentValues done = new android.content.ContentValues();
                        done.put(MediaStore.Images.Media.IS_PENDING, 0);
                        activity.getContentResolver().update(item, done, null, null);
                    } else {
                        try {
                            android.content.Intent scan = new android.content.Intent(
                                    Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, item);
                            activity.sendBroadcast(scan);
                        } catch (Throwable ignored) { }
                    }

                    toast("已保存到相册");
                } catch (Throwable t) {
                    /*
                      记一笔：把**真实地址**和异常类型写进错误日志。

                      连续几轮我都在猜这个地址长什么样（data:? 相对路径?
                      空主机? loopback?），每次都猜错。与其继续猜，不如让
                      App 自己说出来 —— 去「关于 → 下载错误日志」导一份，
                      里面就有这里记的原文，一眼能定位。
                    */
                    try {
                        LogBook.error(activity, "保存图片失败",
                                briefUrl(url) + " | " + t.getClass().getSimpleName()
                                        + ": " + (t.getMessage() == null ? "" : t.getMessage()));
                    } catch (Throwable ignored) {}
                    toast("保存失败：" + (t.getMessage() == null ? "未知错误" : t.getMessage()));
                }
            }
        });
    }

    /**
     * 把前端传的 URL 转成 assets 内的相对路径。
     * 支持：file:///android_asset/web/img/foo.png、img/foo.png、./img/foo.png
     * 不是本地 assets 资源时返回 null。
     */
    private static String assetPathOf(String url) {
        if (url == null) return null;
        String s = url;
        String prefix = "file:///android_asset/";
        if (s.startsWith(prefix)) {
            s = s.substring(prefix.length());
        } else if (s.startsWith("http://") || s.startsWith("https://")
                || s.startsWith("data:")) {
            return null;
        } else {
            /* 相对路径：前端的图片都在 assets/web/ 下 */
            if (s.startsWith("./")) s = s.substring(2);
            if (s.startsWith("/")) s = s.substring(1);
            s = "web/" + s;
        }
        return s;
    }

    /**
     * 这个地址能拿去建连吗？
     *
     * <p>判据只有一条：**解析出来的主机不能为空**。
     * `https:///x`、`https:/x`、`https://` 这类「有协议没主机」的残缺串，
     * 拿去建连会被解析成回环地址 —— 也就是那句莫名其妙的
     * `failed to connect to localhost/127.0.0.1`。
     *
     * <p>用的是 java.net.URL，跟 Http 建连时那套解析**是同一个** ——
     * 判据天然一致。这正是不能用别的解析器替代的原因（实测
     * `https:///x` 在 Java 下 host=""，在 WHATWG 下却是 "docs"）。
     *
     * <p>data: / assets / 相对路径不走这条路，不必在这里管。
     */
    private static boolean hasHost(String url) {
        if (url == null) return false;
        try {
            String host = new java.net.URL(url).getHost();
            return host != null && host.length() > 0;
        } catch (Throwable ignored) {
            return false;   // 连解析都失败，更不该去连
        }
    }

    /**
     * 把可能很长的地址截成能进提示与日志的一小段。
     * data: URI 动辄几十上百 KB，整条塞进提示框会把屏幕撑爆。
     */
    private static String briefUrl(String url) {
        String s = String.valueOf(url);
        if (s.length() <= 80) return s;
        return s.substring(0, 80) + "…（共 " + s.length() + " 字符）";
    }

    /**
     * data: URI 自带的 MIME，如 `data:image/png;base64,xxx` → `image/png`。
     *
     * <p>data: 分支下没有 HTTP 响应头可用，只能从这里取；取不到就退给
     * 文件头魔数兜底。
     */
    private static String mimeOfDataUri(String u) {
        try {
            if (u == null || !u.startsWith("data:")) return null;
            int comma = u.indexOf(',');
            if (comma <= 0) return null;
            String head = u.substring(5, comma);
            int sc = head.indexOf(';');
            String mime = (sc >= 0 ? head.substring(0, sc) : head).trim();
            return mime.isEmpty() ? null : mime;
        } catch (Throwable ignored) {
            return null;
        }
    }

    /**
     * 把 data: URI 还原成字节。
     *
     * <p>字节本来就在字符串里 —— 这一步**不走网络**，所以「浏览器能存、
     * 我们存不了」的那批快车道图片，靠它就能存下来。
     *
     * @return 解码后的字节；失败返回 null
     */
    private static byte[] decodeDataUri(String u) {
        try {
            if (u == null || !u.startsWith("data:")) return null;
            int comma = u.indexOf(',');
            if (comma < 0) return null;
            String head = u.substring(5, comma);
            String payload = u.substring(comma + 1);
            boolean b64 = head.toLowerCase(java.util.Locale.US).indexOf("base64") >= 0;
            if (b64) {
                return android.util.Base64.decode(payload, android.util.Base64.DEFAULT);
            }
            /* 非 base64 的 data: 是百分号编码的文本（SVG 常见） */
            return java.net.URLDecoder.decode(payload, "UTF-8").getBytes("UTF-8");
        } catch (Throwable ignored) {
            return null;
        }
    }

    /**
     * 取图片字节：先直连，失败就换加速通道。
     *
     * <p><b>为什么不再跟 DNS 较劲</b>：域名在本机被解析成 127.0.0.1 时，
     * 直连必然失败（Http 里已加 DoH 兜底，但那要求 DoH 端点本身可达，
     * 在 hosts 被改得比较狠的机器上未必成立）。换通道是**换主机**，
     * 本机那条 hosts 记录就管不着了 —— 比修 DNS 可靠得多。
     *
     * <p><b>安全</b>：走镜像时**不带 Authorization**。GitHub token 只能发给
     * GitHub，发给第三方镜像等于把令牌交出去。图片是公开资源，不需要令牌。
     *
     * <p>直连走原 headers；镜像只保留 Accept。
     *
     * @return 成功返回响应；全部失败返回直连的那份（好让错误码有意义），
     *         连直连都抛异常时返回 null
     */
    private static Http.RawResponse fetchImage(String url, java.util.Map<String, String> headers) {
        Http.RawResponse direct = null;
        try {
            Http.RawResponse r = Http.requestRaw("GET", url, headers);
            if (ok200(r)) return r;
            direct = r;                       // 留着，全失败时报它的码
        } catch (Throwable ignored) {
            /* 直连抛异常（连不上/被解析到本机），下面换通道 */
        }

        int n = Math.min(DownloadChannels.MIRRORS.length, DownloadChannels.VERIFIED_COUNT);
        for (int i = 0; i < n; i++) {
            String mirror = DownloadChannels.MIRRORS[i];
            if (mirror == null || mirror.length() == 0) continue;
            /* 云速是模板型拼法，不能 `前缀 + 原URL`；拼不出来（不是 raw 类
               地址）就跳过这条 —— 图片几乎都是 raw 地址，通常是能拼出来的。 */
            String murl = DownloadChannels.buildUrl(mirror, url);
            if (murl == null) continue;
            try {
                java.util.Map<String, String> h = new java.util.HashMap<>();
                h.put("Accept", "image/*,*/*;q=0.8");     /* 不带令牌 */
                Http.RawResponse r = Http.requestRaw("GET", murl, h);
                if (ok200(r)) return r;
            } catch (Throwable ignored) {
            }
        }
        return direct;
    }

    private static boolean ok200(Http.RawResponse r) {
        return r != null && r.code >= 200 && r.code < 300 && r.body != null && r.body.length > 0;
    }

    private static String extFromMime(String mime) {
        if (mime == null) return null;
        String m = mime.toLowerCase(java.util.Locale.US);
        if (m.contains("png")) return "png";
        if (m.contains("jpeg") || m.contains("jpg")) return "jpg";
        if (m.contains("gif")) return "gif";
        if (m.contains("webp")) return "webp";
        if (m.contains("bmp")) return "bmp";
        return null;
    }

    private static String extFromUrl(String url) {
        if (url == null) return null;
        int q = url.indexOf('?');
        String path = q > 0 ? url.substring(0, q) : url;
        int dot = path.lastIndexOf('.');
        if (dot < 0 || dot < path.lastIndexOf('/')) return null;
        String e = path.substring(dot + 1).toLowerCase(java.util.Locale.US);
        if (e.length() > 5) return null;
        if (e.equals("jpeg")) return "jpg";
        if (e.equals("png") || e.equals("jpg") || e.equals("gif")
                || e.equals("webp") || e.equals("bmp")) return e;
        return null;
    }

    private static String extFromMagic(byte[] data) {
        if (data == null || data.length < 4) return null;
        if ((data[0] & 0xFF) == 0x89 && (data[1] & 0xFF) == 0x50
                && (data[2] & 0xFF) == 0x4E && (data[3] & 0xFF) == 0x47) return "png";
        if ((data[0] & 0xFF) == 0xFF && (data[1] & 0xFF) == 0xD8
                && (data[2] & 0xFF) == 0xFF) return "jpg";
        if ((data[0] & 0xFF) == 0x47 && (data[1] & 0xFF) == 0x49
                && (data[2] & 0xFF) == 0x46 && (data[3] & 0xFF) == 0x38) return "gif";
        if (data.length >= 12 && (data[0] & 0xFF) == 0x52 && (data[1] & 0xFF) == 0x49
                && (data[2] & 0xFF) == 0x46 && (data[3] & 0xFF) == 0x46
                && (data[8] & 0xFF) == 0x57 && (data[9] & 0xFF) == 0x45
                && (data[10] & 0xFF) == 0x42 && (data[11] & 0xFF) == 0x50) return "webp";
        return null;
    }

    private static String mimeFromExt(String ext) {
        if ("png".equals(ext)) return "image/png";
        if ("jpg".equals(ext)) return "image/jpeg";
        if ("gif".equals(ext)) return "image/gif";
        if ("webp".equals(ext)) return "image/webp";
        if ("bmp".equals(ext)) return "image/bmp";
        return "image/png";
    }


    /**
     * 带自定义请求头的下载。
     *
     * GitHub 的 Release 资产（私有仓库）与 Actions 构建产物（artifacts）的
     * 下载地址都要求携带 Authorization，否则返回 403。
     * 原生 Http 客户端是自己写的，不支持这些头，所以必须让 DownloadManager
     * 带上 Authorization 与 Accept 再请求。
     *
     * @param headersJson JSON 对象，如 {"Authorization":"Bearer ghp_xxx"}
     */
    /**
     * 下载构建产物（ZIP）并自动解压出 APK 安装。
     *
     * GitHub 的构建产物一定是 ZIP 包，官网只给「下载」，用户还得自己在手机上
     * 找文件管理器解压再点安装。这里一步做完：下载 → 解压 → 拉起安装器。
     */
    @JavascriptInterface
    public void installApk(String url, String filename, String headersJson) {
        enqueueDownload(url, filename, headersJson, true, null);
    }

    /** 带下载分类：构建产物（APK）也按来源分目录存放 */
    @JavascriptInterface
    public void installApk(String url, String filename, String headersJson, String category) {
        enqueueDownload(url, filename, headersJson, true, null, category);
    }

    /**
     * 带完整性校验的安装：下载完成后先算 SHA-256，跟 expectedSha 比对，
     * 一致才拉起安装器，不一致直接删掉并报错。
     *
     * 这是防「更新源被替换 / 中间人换包」的关键一道：
     * 光靠 HTTPS 只保证「传输过程没被改」，不保证「服务端给的包是对的」。
     * 校验和由客户端内置 + 仓库清单双来源提供，攻击者要同时改两处才行。
     *
     * @param expectedSha 期望的 SHA-256（小写十六进制）。传空则不校验。
     */
    @JavascriptInterface
    public void installApkChecked(String url, String filename, String headersJson, String expectedSha) {
        enqueueDownload(url, filename, headersJson, true, expectedSha);
    }

    /** 带下载分类的校验安装（App 自更新走这个，包来自 Release → release 目录） */
    @JavascriptInterface
    public void installApkChecked(String url, String filename, String headersJson,
                                  String expectedSha, String category) {
        enqueueDownload(url, filename, headersJson, true, expectedSha, category);
    }

    @JavascriptInterface
    public void downloadWithHeaders(String url, String filename, String headersJson) {
        enqueueDownload(url, filename, headersJson, false, null);
    }

    /** 带下载分类的版本：category 决定子目录（议题 / release） */
    @JavascriptInterface
    public void downloadWithHeaders(String url, String filename, String headersJson,
                                    String category) {
        enqueueDownload(url, filename, headersJson, false, null, category);
    }

    private void enqueueDownload(String url, String filename, String headersJson, boolean autoInstall) {
        enqueueDownload(url, filename, headersJson, autoInstall, null);
    }

    /* ============================================================
     * Actions 运行日志：下载 zip 并解压成文本交给前端
     * ------------------------------------------------------------
     * 为什么要原生来做 ——
     *   /actions/runs/{id}/logs 是一个 302 到签名地址的 zip，
     *   前端拿不到（跨域 + 没有令牌时是 403），而签名地址又不能带令牌。
     *   这两件事只有原生层能同时满足：带上令牌去要，跳走后摘掉令牌去取。
     *
     * 为什么不落盘再给路径 ——
     *   日志要的是「看一眼」，不是留一份文件。解压完直接把文本回灌给
     *   WebView，用户的 Download 目录不会被一堆临时 zip 弄脏。
     *
     * 上限 ——
     *   evaluateJavascript 走 Binder，单次事务约 1MB。日志包解压后常常
     *   几 MB，所以这里总量封顶，超了就如实告诉前端「太大，请用浏览器看」，
     *   而不是灌一半进去把界面卡死。
     * ============================================================ */
    /* 上限为什么这么小 ——
     * 文本最终要经 evaluateJavascript 灌进 WebView，而它底层是 Binder IPC，
     * 单次事务上限约 1MB（部分机型更低）。日志又是最容易膨胀的东西：
     * 一次失败的构建随随便便几 MB。这里留足余量，宁可截断并如实告知，
     * 也不让整次调用被 Binder 拒掉 —— 那种失败是静默的，
     * 界面会永远停在「正在读取日志…」。 */
    private static final int LOGS_TOTAL_CAP = 250 * 1024;    // 全部日志文本合计上限
    private static final int LOGS_FILE_CAP = 150 * 1024;     // 单个文件的文本上限

    @JavascriptInterface
    public void fetchRunLogs(String id, String url) {
        pool.execute(() -> {
            try {
                if (url == null || url.isEmpty()) throw new IOException("日志地址为空");
                if (!Http.hostUsable(url)) throw new IOException("日志地址无效");

                Map<String, String> h = new HashMap<>();
                String token = getToken();
                if (token != null && !token.isEmpty()) h.put("Authorization", "Bearer " + token);
                /* Accept 必须是 API 认得的媒体类型。
                 * 写成 application/zip 会被判成未知媒体类型，GitHub 直接回
                 * 415（响应头里 x-github-media-type: unknown）—— 实测过。
                 * 这里用官方的 vnd.github+json，拿到的同样是 zip 二进制。 */
                h.put("Accept", "application/vnd.github+json");
                h.put("X-GitHub-Api-Version", "2022-11-28");

                Http.RawResponse r = Http.requestLogs(url, h);
                if (r.code < 200 || r.code >= 300) {
                    throw new IOException("取日志失败（HTTP " + r.code + "）");
                }
                if (r.body == null || r.body.length == 0) {
                    throw new IOException("日志包是空的（可能已过期或被清理）");
                }

                org.json.JSONArray arr = new org.json.JSONArray();
                int total = 0;
                boolean truncated = false;

                java.util.zip.ZipInputStream zis = null;
                try {
                    zis = new java.util.zip.ZipInputStream(new ByteArrayInputStream(r.body));
                    java.util.zip.ZipEntry e;
                    byte[] buf = new byte[64 * 1024];
                    while ((e = zis.getNextEntry()) != null) {
                        if (e.isDirectory()) { zis.closeEntry(); continue; }
                        String name = e.getName();
                        if (name == null || name.isEmpty()) { zis.closeEntry(); continue; }
                        /* 目录条目一律跳过：zip 里常带 `build/` 这类占位，
                         * 读进去就是一个空步骤，界面上多一个没内容的分栏。 */
                        if (name.endsWith("/")) { zis.closeEntry(); continue; }

                        ByteArrayOutputStream out = new ByteArrayOutputStream();
                        boolean cut = false;
                        int n;
                        while ((n = zis.read(buf)) > 0) {
                            out.write(buf, 0, n);
                            // 单文件超限：停下并标记，剩下的丢弃
                            if (out.size() >= LOGS_FILE_CAP) { cut = true; truncated = true; break; }
                        }
                        zis.closeEntry();

                        String text = new String(out.toByteArray(), StandardCharsets.UTF_8);
                        // 用「本文件是否被截」标记，而不是全局 truncated：
                        // 全局那个一旦置上就再没清过，会让后面每个完好的步骤
                        // 都莫名挂上一句「已截断」。
                        if (cut) {
                            text += "\n\n……（本步日志过长，已截断，完整内容请在浏览器查看）";
                        }
                        total += text.length();
                        if (total > LOGS_TOTAL_CAP) {
                            truncated = true;
                            break;
                        }

                        org.json.JSONObject o = new org.json.JSONObject();
                        // 文件名形如 "0_build.txt"，去掉扩展名就是步骤名
                        o.put("name", name);
                        o.put("text", text);
                        arr.put(o);
                    }
                } finally {
                    if (zis != null) try { zis.close(); } catch (Throwable ignored) { }
                }

                if (arr.length() == 0) {
                    /* 以前这里一律说「可能已过期」，把读残、读错也一并盖住了，
                     * 排查时只能靠猜。现在把包的三件事如实回传：
                     * 大小、是不是 zip、包里到底有几个条目。
                     * 是 zip 却没条目 = 包坏了或真的空；不是 zip = 根本没拿到包。 */
                    int magic = r.body.length >= 4
                            ? ((r.body[0] & 0xff) | ((r.body[1] & 0xff) << 8)
                               | ((r.body[2] & 0xff) << 16) | ((r.body[3] & 0xff) << 24))
                            : 0;
                    boolean isZip = (magic == 0x04034b50) || (magic == 0x06054b50);
                    throw new IOException(isZip
                            ? "日志包是空的（" + r.body.length + " 字节，可能已过期）"
                            : "拿到的不是日志包（" + r.body.length + " 字节，可能是错误响应）");
                }

                org.json.JSONObject jo = new org.json.JSONObject();
                jo.put("ok", true);
                jo.put("files", arr);
                jo.put("truncated", truncated);
                runJs("window.Native._runlogs(" + JSONObject.quote(id) + ","
                        + JSONObject.quote(jo.toString()) + ",\"\")");
            } catch (Throwable t) {
                String msg = t.getMessage();
                if (msg == null || msg.isEmpty()) msg = "读取日志失败";
                runJs("window.Native._runlogs(" + JSONObject.quote(id) + ",null,"
                        + JSONObject.quote(msg) + ")");
            }
        });
    }

    /** 带下载分类：决定落在 githup/ 下的哪个子目录（议题 / release 等）。
     *  注意形状是 (S,S,S,b,S,S)，不能做成 5 个参数 —— 会与
     *  (…, autoInstall, expectedSha) 那个 5 参重载在 null 上产生歧义。 */
    private void enqueueDownload(String url, String filename, String headersJson,
                                 boolean autoInstall, String expectedSha, String category) {
        enqueueDownload(url, filename, headersJson, null, autoInstall, expectedSha, category);
    }

    /**
     * 下载统一落到 **Download/githup/** 这个子目录。
     *
     * 以前直接扔在 Download 根目录，跟浏览器、微信、QQ 下的东西混在一起，
     * 找个文件得翻半天。现在所有下载入口（前端调的 download / installApk、
     * WebView 里点下载链接）都走 downloadSubPath()，落盘位置只有一处定义。
     */
    public static final String DOWNLOAD_SUBDIR = "githup";

    /** 议题（Issue / PR）内触发的下载：落到 githup/议题/ */
    public static final String DL_CATEGORY_ISSUE = "议题";
    /** Release 相关下载：落到 githup/release/ */
    public static final String DL_CATEGORY_RELEASE = "release";

    /**
     * 清洗前端传来的下载分类（子目录名）。
     *
     * ═══ 为什么函数体曾经是 `return ""` ═══
     *
     * 还原 v1.2.14 时把它改成了恒返回空串 —— 那版是**单层目录**，
     * 所有下载平铺在 Download/githup/ 下，不按来源分子目录。
     *
     * 但用户要的是「Release 下下来的东西就该在 Download/githup/release/」。
     * 分类是前端明确传了的：
     *
     *   · Release 附件 / 源码包  → 'release'
     *   · 议题里的附件          → '议题'
     *   · 仓库文件              → 'file'
     *
     * 恒返回空串等于**把前端传的分类全丢掉**，文件自然都落在根目录。
     * 这就是「为什么 release 的文件不在 release 目录」的答案。
     *
     * ═══ 清洗策略 ═══
     *
     * 子目录名会被拼进落盘路径，绝不能含分隔符，否则就是路径穿越。
     * 这里不搞白名单（前端以后加分类还得改原生），改成**严格清洗**：
     * 去掉分隔符、控制字符、点，剩下的才是合法目录名；洗完为空就当没分类。
     */
    static String safeCategory(String c) {
        if (c == null) return "";
        String s = c.trim();
        if (s.isEmpty()) return "";
        /* 路径分隔符：子目录名里绝不能有，否则拼进路径就是穿越 */
        s = s.replaceAll("[\\/]+", "");
        /* 控制字符：文件名里出现会破坏 MediaStore 查询 */
        s = s.replaceAll("[\u0000-\u001f\u007f]", "");
        /* 点：挡掉 "." / ".." 这类相对路径 */
        s = s.replace(".", "");
        s = s.trim();
        if (s.isEmpty()) return "";
        /* 长度上限：目录名过长会被文件系统拒绝 */
        if (s.length() > 32) s = s.substring(0, 32);
        return s;
    }

    /** 下载文件在 Download/ 下的相对路径，如 githup/议题/foo.zip */
    public static String downloadSubPath(String name, String category) {
        String safeCat = safeCategory(category);
        return DOWNLOAD_SUBDIR + (safeCat.isEmpty() ? "" : "/" + safeCat)
                + "/" + safeName(name);
    }

    /**
     * 尽量先把 Download/githup 建出来。
     *
     * Android 9 及以下：App 自己有公共目录写权限，先 mkdirs 更保险。
     * Android 10 起是分区存储，App 建不了公共目录 —— 不用管，DownloadManager
     * 是系统组件，写的时候会自己把父目录建好。
     *
     * 注意这条守卫的反面：**读**的时候不能照着这个路径去读。
     * 这里 mkdirs 出来的目录在 Android 10+ 上是应用沙箱内的影子目录，
     * DownloadManager 写的真文件不在里面。所以一切「找已下载的文件」
     * 都得走 {@link DownloadProvider#resolve}，它会去问 DownloadManager。
     */
    @SuppressWarnings("deprecation")
    public static void ensureDownloadDir() {
        if (Build.VERSION.SDK_INT > 28) return;
        try {
            File dir = new File(Environment.getExternalStoragePublicDirectory(
                    Environment.DIRECTORY_DOWNLOADS), DOWNLOAD_SUBDIR);
            if (!dir.exists()) dir.mkdirs();
        } catch (Throwable ignored) { }
    }

    private void enqueueDownload(String url, String filename, String headersJson,
                                 boolean autoInstall, String expectedSha) {
        enqueueDownload(url, filename, headersJson, null, autoInstall, expectedSha);
    }

    /**
     * WebView 里点下载链接走这里 —— 跟前端主动调的下载走同一套通道逻辑，
     * 不然「点链接下载」享受不到加速和自动换道。
     */
    public void enqueueWebViewDownload(String url, String userAgent, String name) {
        enqueueDownload(url, name, null, userAgent, false, null);
    }

    private void enqueueDownload(String url, String filename, String headersJson,
                                 String userAgent, boolean autoInstall, String expectedSha) {
        enqueueDownload(url, filename, headersJson, userAgent, autoInstall, expectedSha, 0);
    }

    /** 带分类的 7 参入口：转发给 8 参 innermost（形状与上面 6 参的不同） */
    private void enqueueDownload(String url, String filename, String headersJson,
                                 String userAgent, boolean autoInstall, String expectedSha,
                                 String category) {
        enqueueDownload(url, filename, headersJson, userAgent, autoInstall, expectedSha,
                0, category);
    }

    private void enqueueDownload(String url, String filename, String headersJson,
                                 String userAgent, boolean autoInstall, String expectedSha,
                                 long expectedBytes) {
        enqueueDownload(url, filename, headersJson, userAgent, autoInstall, expectedSha,
                expectedBytes, null);
    }

    private void enqueueDownload(String url, String filename, String headersJson,
                                 String userAgent, boolean autoInstall, String expectedSha,
                                 long expectedBytes, String category) {
        if (url == null || url.isEmpty()) return;
        final String name = (filename == null || filename.isEmpty()) ? "download" : filename;
        final String dlCategory = safeCategory(category);

        /*
          单文件（仓库里的 yml / md / 源码）直接抓，别送进 DownloadManager。
          那条通道是给大文件（Release 附件、源码包）准备的，中间要绕第三方
          加速镜像 —— 那些镜像是免费的第三方服务，随时限流或关停。一个小文件
          绕这一圈，慢和失败都出在代理那头，用户换自己的网络当然没用。
          而 raw.githubusercontent.com 正是 App 自己读 README、代码用的域名，
          同一套原生栈本来就是通的。
          大文件（Release 附件 / 源码包）不在这里拦，照旧走镜像换道。
        */
        if (isRawFileUrl(url) && expectedBytes <= DIRECT_FETCH_MAX_BYTES) {
            startDirectFileFetch(url, name, headersJson, dlCategory);
            return;
        }

        /*
          ═══════════════ 先问一句「他给没给我点 Star」 ═══════════════

          没点的话，这次下载就走「限速」那条慢路，并且弹一句提醒。

          **每一次下载都要查，不管下的是哪个仓库** —— 包括用户下别人的
          开源项目。这是刻意的：Star 是「对整个软件的支持」，不是
          「对某一个包的通行费」，所以每次下载都重新确认一遍。

          为什么查询要**异步**（丢进线程池）而不是在这里同步等：
          这里跑在主线程上（后面那整块就包在 runOnUiThread 里），
          同步发一个网络请求会把 UI 冻住几百毫秒 —— 用户会觉得「点下载卡了一下」。
        */
        final String sha = expectedSha == null ? "" : expectedSha.trim().toLowerCase();
        pool.execute(() -> {
            /*
              每次都查 —— 不缓存、不跳过。
              查的是 **Buwrt/githup**（本软件仓库），跟这次下的仓库无关：
              未登录 / 没点 / 查询失败 都算「没点」。
            */
            final boolean starred = hasStarredSelf();
            activity.runOnUiThread(() -> {
                try {
                    ensureDownloadDir();

                    /* 没点 Star → 不管下的哪个仓库，一律走限速 */
                    if (!starred) {
                        startThrottledDownload(url, name, headersJson, sha, autoInstall, dlCategory);
                        return;
                    }

                    /*
                      点了 Star（或这不是本软件的包）→ 照常走加速。
                      注意这里仍然要算一次 isMirrorable，跟原来一样。
                    */
                    boolean allowMirror = DownloadChannels.isMirrorable(url);
                    DlTask t = new DlTask(name, url, headersJson, userAgent, sha, autoInstall,
                            candidateUrls(url, allowMirror), dlCategory);
                    t.expectedBytes = expectedBytes;
                    if (!startTask(t)) {
                        Toast.makeText(activity, "下载失败", Toast.LENGTH_SHORT).show();
                        return;
                    }
                    /* 有多个候选通道时说一声 —— 用户知道「慢了会自动换」就不会
                     * 盯着几十 KB/s 干着急，也不会一失败就以为软件坏了。
                     *
                     * 顺带把「一共几条路」讲清楚：以前只说「慢会自动换道」，
                     * 用户看到「加速 3」还是失败就来问「怎么就这么几条」；
                     * 说成「共同 5 条路可自动切换」才说明白 —— 换道是软件自己
                     * 走完的，不需要用户做任何事。 */
                    Toast.makeText(activity, t.urls.size() > 1
                            ? "开始下载 " + name + "（" + t.channel() + "，共 " + t.urls.size() + " 条路可自动切换）"
                            : "开始下载 " + name, Toast.LENGTH_SHORT).show();
                    startWatch();
                } catch (Exception e) {
                    Toast.makeText(activity, "下载失败", Toast.LENGTH_SHORT).show();
                }
            });
        });
    }

    /**
     * 用户给本软件仓库（Buwrt/githup）点过 Star 没有？
     *
     * 判定走 GitHub 官方接口 `GET /user/starred/{owner}/{repo}`，它是个
     * **只问状态不给内容**的接口，返回值非常特别：
     *   **204**（无内容）→ 点过 → 不限速
     *    404           → 没点过 → 限速
     *    其它（401 令牌失效、403 限流、网络不通…）→ **一律当没点过**
     *
     * ⚠️ 这里踩过一个真实的坑，写下来防止后人改回去：
     *   最初写的是 `r.code == 200`。但这个接口点过 Star 返回的是 **204**，
     *   永远不会是 200 —— 于是**不管用户点没点，全都判成「没点」**，
     *   点了 Star 的用户照样被限速（用户实测撞上的就是这个，截图里明明
     *   显示「已 Star」却还在限速）。判 2xx 区间才是对的。
     *
     * 为什么「查不到」要算「没点」而不是「放行」：
     *   如果查不到就放行，那用户只要开飞行模式、或者故意换个失效的令牌，
     *   限速就绕过去了 —— 这个功能等于白做。宁可误伤（真点了 Star 的人
     *   碰上网络抖动被限一次），也不能留个明摆着的口子。
     *
     * 另外，**未登录也走这条路**：没有令牌就发不出这个请求，自然算「没点」。
     *
     * 这个方法跑在线程池里（enqueueDownload 里调的），会阻塞，别在主线程调。
     */
    private boolean hasStarredSelf() {
        try {
            String token = getToken();
            if (token == null || token.isEmpty()) return false;   // 没登录 = 没点过

            Map<String, String> headers = new HashMap<>();
            headers.put("Authorization", "Bearer " + token);
            headers.put("Accept", "application/vnd.github+json");

            String url = "https://api.github.com/user/starred/"
                    + DownloadChannels.STAR_OWNER + "/" + DownloadChannels.STAR_REPO;

            Http.Response r = Http.request("GET", url, null, headers);
            /* 2xx 全算「点过」—— 实际会来的是 204（已 Star）。
             * 别再写 == 200，见上面那条踩坑记录。 */
            return r != null && r.code >= 200 && r.code < 300;
        } catch (Throwable t) {
            return false;   // 任何异常都当没点过，理由见上面注释
        }
    }

    /**
     * 走「限速」那条慢路下载。
     *
     * 和正常下载最大的区别：**不经过 DownloadManager**，由
     * {@link ThrottledDownloader} 自己拿着字节流写文件（见它的注释：
     * 要用 sleep 精确控速、还要定时断流，DownloadManager 给不了这个粒度）。
     *
     * ⚠️ 注意它下载时**写的是私有目录**，下完才由 moveToPublicDownloads
     * 搬进 Download/githup/ —— 原因见下面这段。
     *
     * ═══════════════ 落盘为什么写私有目录 ═══════════════
     *
     * 最初想直接写 Download/githup/，那是个**必然失败**的做法：
     * Android 10+ 是分区存储，App 自己 new FileOutputStream 往公共目录写
     * 会被系统拒绝（EACCES: Permission denied）。正常下载之所以能落那儿，
     * 是因为它交给 DownloadManager 代写，系统自己有权限。
     *
     * 所以限速下载先写进**应用私有目录**（那里随便写），下完再搬到公共目录。
     * 搬运走 MediaStore 两段式（见 moveToPublicDownloads），Android 10+ 上
     * 这是唯一被允许的写公共目录的方式。
     *
     * ═══════════════ 失败了怎么办 ═══════════════
     *
     * **直接切直链**，绝不在限速里死磕。理由很实在：限速是提醒，不是
     * 「下不到」——用户已经等了半天，再让他失败一次就过分了。
     * 注意是**直链**，不是加速镜像：加速那 10 条是给「正常用户」的待遇。
     */
    /**
     * 限速下载 / 续传接管共用的进度与收尾回调。
     *
     * 抽出来是因为「换道续传接管」走的也是 ThrottledDownloader，只是不限速；
     * 收尾（校验 → 搬公共目录 → 写历史 → 装 APK）完全一样，
     * 各写一份迟早改漏一处。
     */
    private ThrottledDownloader.Listener makeTlListener(TlTask t, String url, String name,
                                                        String headersJson, String sha,
                                                        boolean autoInstall, String category) {
        return new ThrottledDownloader.Listener() {
                        @Override public void onProgress(long done, long total, long bps) {
                            t.done = done;
                            t.total = total;
                            t.bps = bps;
                        }

                        @Override public void onDone(File file, long bytes) {
                            t.running = false;
                            /* 校验 + 搬去公共目录 + 装 APK。这些都要读文件，
                               可能慢，丢后台线程做，别卡 UI。 */
                            pool.execute(() -> {
                                String bad = null;
                                if (sha != null && !sha.isEmpty()) {
                                    bad = verifyShaFile(file, sha);
                                } else {
                                    /*
                                      没有 sha 时的兜底：至少比对长度。

                                      Release 附件常常不提供 sha，以前那种情况
                                      `if (sha != null && !sha.isEmpty())` 直接
                                      整段跳过，什么校验都不做 —— 「下完了」和
                                      「下对了」成了两回事，旧包就这么被搬进
                                      公共目录甚至装上。

                                      ThrottledDownloader 内部已经按 Content-Length
                                      判过一轮，这里再拿 t.total 跟落盘文件比对
                                      一次，是第二道闸。
                                    */
                                    bad = verifySize(file, t.total, bytes);
                                }
                                if (bad != null) {
                                    /* 包不对：不留了，也没法装。当失败处理并放行全速。 */
                                    try { file.delete(); } catch (Throwable ignored) { }
                                    activity.runOnUiThread(() -> {
                                        throttledTasks.remove(t.id);
                                        fallbackToDirect(url, name, headersJson, sha,
                                                autoInstall, "下载的包校验没通过", category);
                                    });
                                    return;
                                }
                                String[] movedName = new String[1];
                                boolean moved = moveToPublicDownloads(file, name,
                                        category, movedName);
                                if (moved && movedName[0] != null && !movedName[0].isEmpty()) {
                                    t.outName = movedName[0];
                                }
                                activity.runOnUiThread(() -> {
                                    throttledTasks.remove(t.id);
                                    finishThrottled(t, true, bytes, null, moved);
                                });
                            });
                        }

                        @Override public void onFail(String reason, boolean retryable) {
                            t.running = false;
                            activity.runOnUiThread(() -> {
                                throttledTasks.remove(t.id);
                                /* 限速彻底不成 → **切直链**，不在这里死磕。
                                   用户已经等很久了，必须让他拿到东西。 */
                                fallbackToDirect(url, name, headersJson, sha, autoInstall, reason, category);
                            });
                        }
                    };
    }

    private void startThrottledDownload(String url, String name, String headersJson,
                                        String sha, boolean autoInstall, String category) {
        try {
            ensureDownloadDir();

            /* 先写私有目录：公共目录在这个阶段写不了（分区存储） */
            File dir = activity.getExternalFilesDir(null);
            if (dir == null) dir = activity.getFilesDir();
            File sub = new File(dir, DOWNLOAD_SUBDIR);
            if (!sub.exists() && !sub.mkdirs()) {
                /* 私有目录都建不出来，那是真没辙了 —— 直接放行全速 */
                fallbackToDirect(url, name, headersJson, sha, autoInstall, "无法创建下载目录", category);
                return;
            }
            /* 开工前清一下过期残骸：老版本按文件名命名的 .part 已经读不到了，
               留着只会占地方（详见 ThrottledDownloader.sweepStale）。 */
            ThrottledDownloader.sweepStale(sub);
            File target = new File(sub, safeName(name));

            long tid = throttledSeq.getAndDecrement();
            TlTask t = new TlTask(tid, name, url, headersJson, sha, autoInstall, target, category);
            throttledTasks.put(tid, t);

            Map<String, String> headers = headersFrom(headersJson);

            Toast.makeText(activity,
                    "开始下载 " + name + "（限速通道）",
                    Toast.LENGTH_SHORT).show();
            /*
              ═══════════════ 限速软提示（60 秒） ═══════════════

              走前端 UI.starBoost：一张不遮罩、可关、60 秒自动收起的卡片。

              为什么不用原来的 toastOk 一句话：
                "给作者点个 Star 吧" 只讲了要做什么，没讲为什么、也没讲
                代价 —— 用户看到的是「下个文件还弹广告」，第一反应是烦，
                不是去点 Star。软提示把三件事一次说清：这次一定下得完、
                现在限速所以慢、点了 Star 以后下载任何文件都全速。

              ⚠️ 话必须讲实：这次下载**不会中断也不会失败**，只是慢。
              写「下载暂停 / 已受限」这类狠话，用户一旦发现其实在下，
              信任就没了，点 Star 的概率反而降到零。

              ⚠️ 60 秒是硬要求，别改长：卡片一直在那儿就变成遮挡。
            */
            runJs("try{if(window.UI&&UI.starBoost)UI.starBoost({seconds:60,owner:'"
                    + DownloadChannels.STAR_OWNER + "',repo:'"
                    + DownloadChannels.STAR_REPO + "'});}catch(e){}");

            ThrottledDownloader.Handle h = ThrottledDownloader.start(url, target, headers,
                    makeTlListener(t, url, name, headersJson, sha, autoInstall, category));
            t.handle = h;

            startWatch();
        } catch (Throwable e) {
            throttledTasks.remove(0);   // 防呆，正常不会命中的
            fallbackToDirect(url, name, headersJson, sha, autoInstall, "限速下载启动失败", category);
        }
    }

    /**
     * 限速失败后的放行：改用**直链**走正常的 DownloadManager 下载。
     *
     * 为什么是直链而不是「加速 1」：加速镜像是正常用户的待遇，
     * 没点 Star 的人不该享受。直链能通、下得完，就够了。
     *
     * 而且**绝不能再落回限速** —— 这里是最后一道兜底，再失败就是真失败了。
     */
    private void fallbackToDirect(String url, String name, String headersJson,
                                  String sha, boolean autoInstall, String why, String category) {
        try {
            Toast.makeText(activity,
                    "限速通道没走通，已改用直链下载", Toast.LENGTH_SHORT).show();

            DlTask t = new DlTask(name, url, headersJson, null, sha, autoInstall,
                    DownloadChannels.candidates(url, false),   // false = 不许走镜像
                    safeCategory(category));
            if (!startTask(t)) {
                Toast.makeText(activity, "下载失败", Toast.LENGTH_SHORT).show();
                return;
            }
            startWatch();
        } catch (Throwable e) {
            Toast.makeText(activity, "下载失败", Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * 限速任务收尾：写历史、给用户一个交代、必要时拉安装器。
     *
     * 注意「报失败」和「报成功」都要出声 —— 限速下载用户本来就等得久，
     * 下完了没动静他会以为又卡死了。
     *
     * @param moved 文件是否已经搬进公共目录（Download/githup/）。
     *              false = 还留在应用私有目录，提示文案得跟着改，
     *              否则用户按提示去 Download/githup/ 里找会扑空。
     */
    private void finishThrottled(TlTask t, boolean ok, long bytes, String reason, boolean moved) {
        throttledTasks.remove(t.id);
        try {
            JSONObject o = new JSONObject();
            o.put("name", t.filename);
            /* 落盘名：限速通道的文件也走 moveToPublicDownloads，
             * 那里同样会避让重名，所以必须记实际名字。 */
            o.put("saved", t.outName == null || t.outName.isEmpty()
                    ? t.filename : t.outName);
            o.put("url", t.originUrl == null ? "" : t.originUrl);
            o.put("dlId", -1);          // 限速任务没有 DownloadManager id
            o.put("ok", ok);
            o.put("bytes", bytes);
            o.put("time", System.currentTimeMillis());
            o.put("install", t.autoInstall);
            o.put("sha", t.expectedSha == null ? "" : t.expectedSha);
            synchronized (dlHistory) {
                loadHistoryLocked();
                /* 同上：put(0, o) 是替换不是插入 */
                prependHistoryLocked(o);
                dedupeLatestLocked();
                while (dlHistory.length() > HISTORY_MAX) {
                    dlHistory.remove(dlHistory.length() - 1);
                }
                saveHistoryLocked();
            }
        } catch (Throwable ignored) { }

        if (!ok) {
            Toast.makeText(activity,
                    "下载失败" + (reason == null || reason.isEmpty() ? "" : "：" + reason),
                    Toast.LENGTH_SHORT).show();
            return;
        }

        boolean isApk = t.filename.toLowerCase().endsWith(".apk");
        if (!t.autoInstall && !isApk) {
            /* 给的位置必须和文件实际在的地方一致，见 moved 的说明 */
            Toast.makeText(activity, moved
                            ? "已保存到 Download/" + DOWNLOAD_SUBDIR + "/" + t.filename
                            : "已保存到应用目录：" + t.filename,
                    Toast.LENGTH_SHORT).show();
            return;
        }

        /*
          要装的话：先把文件拷进 ApkProvider 的目录（filesDir/apks/），
          再让安装器读它。

          为什么不直接 openInstaller(Uri.fromFile(...))：Android 7+ 起
          file:// 形式的 Uri 会被安装器静默拦掉（FileUriExposedException），
          必须走 content://。ApkProvider 就是为这个存在的（见它的注释）。
        */
        try {
            File apkDir = new File(activity.getFilesDir(), ApkProvider.DIR);
            apkDir.mkdirs();
            String outName = safeName(t.filename);
            File dst = new File(apkDir, outName);
            if (!t.target.getCanonicalPath().equals(dst.getCanonicalPath())) {
                copyFile(t.target, dst);
            }
            /* 装之前先把这一笔落进应用库：此刻包名读得到、文件也在。
               失败不能影响安装本身，所以整段吞异常。 */
            try {
                AppLibrary.trackFromApk(activity, t.originUrl, dst);
            } catch (Throwable ignored) { }
            Uri uri = ApkProvider.uriFor(
                    activity.getPackageName() + ApkProvider.AUTHORITY_SUFFIX, outName);
            openInstaller(uri);
        } catch (Throwable e) {
            Toast.makeText(activity,
                    "请在下载目录中找到该 APK 并安装", Toast.LENGTH_LONG).show();
        }
    }

    /** 普通的文件复制。失败抛 IOException，由调用方兜底 */
    private void copyFile(File src, File dst) throws java.io.IOException {
        try (java.io.InputStream in = new java.io.FileInputStream(src);
             java.io.OutputStream out = new java.io.FileOutputStream(dst)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.flush();
        }
    }

    /**
     * 校验一个**普通文件**的 SHA-256（不是 content:// Uri）。
     *
     * 为什么另写一个而不是复用 {@link #verifySha}：那个是给 DownloadManager
     * 的产物用的，它靠 downloadId 去 DownloadProvider 里查权威地址，再走
     * ContentResolver 打开。限速下载根本没进 DownloadManager，没有 id，
     * 文件也是自己写出来的普通路径 —— 硬塞给它一个假 id 只会读不到。
     *
     * @return null 表示校验通过（或调用方没给期望值）；非 null 是拒绝原因
     */
    private String verifyShaFile(File file, String expected) {
        if (expected == null || expected.trim().isEmpty()) return null;
        if (file == null || !file.exists()) return "下载好的文件不见了";

        java.io.InputStream in = null;
        try {
            in = new java.io.FileInputStream(file);
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            byte[] d = md.digest();
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) sb.append(String.format("%02x", b & 0xff));
            if (sb.toString().equalsIgnoreCase(expected.trim())) return null;
            return "校验和不一致（安装包可能被篡改）";
        } catch (Throwable t) {
            return "校验失败：" + t.getClass().getSimpleName();
        } finally {
            if (in != null) try { in.close(); } catch (Throwable ignored) { }
        }
    }

    /**
     * 没有 sha 时的兜底校验：拿「应下字节数」跟落盘文件比一比。
     *
     * 只能防住"下短了/下长了"这类一眼可见的错，防不住"长度恰好相同但内容
     * 不同"—— 那种只有 sha 能判。但总比什么都不做强：旧版本和新版本的
     * 附件长度多数时候是不一样的。
     *
     * 拿不到期望长度（分块传输）时返回 null，不拦 —— 没有依据的拦截比
     * 不拦截更糟，那会让用户一次都下不成。
     */
    private String verifySize(File file, long expectedTotal, long reportedBytes) {
        if (file == null || !file.exists()) return "下载好的文件不见了";
        long actual = file.length();
        if (expectedTotal > 0 && actual != expectedTotal) {
            return "文件大小不对（应为 " + expectedTotal + " 字节，实际 " + actual + " 字节）";
        }
        if (expectedTotal <= 0 && reportedBytes > 0 && actual != reportedBytes) {
            return "文件大小不对（应为 " + reportedBytes + " 字节，实际 " + actual + " 字节）";
        }
        return null;
    }

    /**
     * 把限速下载好的文件从应用私有目录搬进公共下载目录 Download/githup/。
     *
     * ═══════════════ 为什么不能直接 FileOutputStream 写过去 ═══════════════
     *
     * Android 10（API 29）起是**分区存储**：App 自己的 FileOutputStream
     * 写不了公共 Download/，一写就是 EACCES。想让文件出现在那里只有两条路：
     *   1. 交给 DownloadManager 代写（正常下载走的就是这条）；
     *   2. 走 MediaStore —— 把文件"登记"给系统媒体库，由系统落盘。
     *
     * 限速下载没法用第 1 条（它必须自己控制字节流，见 ThrottledDownloader），
     * 所以只能走第 2 条。
     *
     * ═══════════════ 两段式为什么必要 ═══════════════
     *
     * MediaStore 的规矩是：先 insert 占一个坑（此时 IS_PENDING=1，别的 App
     * 看不到这个文件），再把字节写进去，最后把 IS_PENDING 置 0 表示"写好了"。
     * 少了最后一步，文件在文件管理器里会一直显示不出来 —— 用户会认为下载失败。
     *
     * 落盘仍然要靠系统给的那条 Uri 去 openOutputStream（而不是自己 File），
     * 这也是分区存储下唯一被允许的写法。
     *
     * @return true = 已搬进公共目录；false = 没搬成（文件仍留在私有目录，
     *         调用方据此改提示文案，见 finishThrottled 的 moved 参数）
     */
    private boolean moveToPublicDownloads(File file, String name, String category,
                                          String[] nameOut) {
        if (file == null || !file.exists()) return false;
        final String cat = safeCategory(category);

        /*
          同样要先避让重名 —— 限速通道也会覆盖别人的文件。

          ⚠️ 以前 Android 9 及以下那支有一句 `if (dst.exists()) dst.delete();`，
          那是覆盖本身；Android 10+ 那边交给了 MediaStore，它会自己把同名
          改成 foo(1).apk，名字跟记录里存的对不上，后面「打开 / 删除」就扑空。

          所以这里也走 uniqueName 主动编号，落盘名由我们决定，不交给系统猜。
        */
        final String outName = uniqueName(name, category, true);
        /* 同上：同名覆盖，先清旧的，保证落盘名就是 outName */
        purgeExistingInDownloads(outName, category, true);
        if (nameOut != null && nameOut.length > 0) nameOut[0] = outName;

        /* Android 9 及以下：没有分区存储这回事，直接文件系统搬就行，比 MediaStore 稳 */
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            try {
                File dst = new File(publicDownloadDir(cat), safeName(outName));
                File parent = dst.getParentFile();
                if (parent != null && !parent.exists()) parent.mkdirs();
                if (dst.exists()) //noinspection ResultOfMethodCallIgnored
                    dst.delete();
                if (file.renameTo(dst)) return true;
                copyFile(file, dst);            // rename 跨分区会失败，退回拷贝
                //noinspection ResultOfMethodCallIgnored
                file.delete();
                return true;
            } catch (Throwable e) {
                return false;
            }
        }

        /* Android 10+：MediaStore 两段式 */
        Uri item = null;
        java.io.OutputStream out = null;
        try {
            android.content.ContentValues cv = new android.content.ContentValues();
            cv.put(MediaStore.Downloads.DISPLAY_NAME, safeName(outName));
            /* RELATIVE_PATH 必须带 "Download/" 前缀，写 "githup" 是无效的；
               有分类时再往下挂一级，如 Download/githup/议题 */
            cv.put(MediaStore.Downloads.RELATIVE_PATH,
                    Environment.DIRECTORY_DOWNLOADS + "/" + DOWNLOAD_SUBDIR
                            + (cat.isEmpty() ? "" : "/" + cat));
            cv.put(MediaStore.Downloads.IS_PENDING, 1);

            item = activity.getContentResolver()
                    .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
            if (item == null) return false;

            out = activity.getContentResolver().openOutputStream(item);
            if (out == null) {
                activity.getContentResolver().delete(item, null, null);
                return false;
            }

            java.io.InputStream in = new java.io.FileInputStream(file);
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.flush();
            in.close();
            out.close();
            out = null;

            /* 收尾：把 IS_PENDING 清掉，系统才让这个文件出现在文件管理器里 */
            android.content.ContentValues done = new android.content.ContentValues();
            done.put(MediaStore.Downloads.IS_PENDING, 0);
            activity.getContentResolver().update(item, done, null, null);

            //noinspection ResultOfMethodCallIgnored
            file.delete();     // 私有目录那份可以清掉，省空间
            return true;
        } catch (Throwable e) {
            /* 失败要收摊：留着 pending 记录会变成一个永远看不见的幽灵文件 */
            if (item != null) {
                try { activity.getContentResolver().delete(item, null, null); }
                catch (Throwable ignored) { }
            }
            return false;
        } finally {
            if (out != null) try { out.close(); } catch (Throwable ignored) { }
        }
    }

    /** 把 headersJson 解成 Map。null/空/解析失败都返回空表 */
    private Map<String, String> headersFrom(String headersJson) {
        Map<String, String> headers = new HashMap<>();
        if (headersJson == null || headersJson.isEmpty()) return headers;
        try {
            JSONObject jo = new JSONObject(headersJson);
            Iterator<String> it = jo.keys();
            while (it.hasNext()) {
                String k = it.next();
                headers.put(k, jo.optString(k, ""));
            }
        } catch (Throwable ignored) { }
        return headers;
    }

    /**
     * 公共下载目录：Download/githup（有分类时再往下挂子目录）。
     *
     * ⚠️ 只是**路径拼装**，不代表这个路径可写。Android 10+ 上 App 自己
     * 往里写会被分区存储拒绝 —— 要落盘必须走 MediaStore（见
     * {@link #moveToPublicDownloads}）或 DownloadManager。
     */
    private File publicDownloadDir(String category) {
        try {
            File d = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            File g = new File(d, DOWNLOAD_SUBDIR);
            String cat = safeCategory(category);
            return cat.isEmpty() ? g : new File(g, cat);
        } catch (Throwable e) {
            return null;
        }
    }

    /** 用任务当前的通道发起下载；成功返回 true */
    private boolean startTask(DlTask t) {
        DownloadManager dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) return false;
        /*
          第一次发车前先问一句「这个文件多大」。

          两条用途：
            1. 完成时能判断「下全了没有」—— 镜像把请求转到 HTML 错误页、
               或者传到一半断了却报 200，DownloadManager 都会当成成功；
            2. 万一所有通道都拿不到大小，也不影响下载本身（只是少一层校验）。

          只探一次（t.expectedBytes 已知就跳过），并且**只探原始地址**：
          各镜像的文件大小必然一致，没必要为每条通道都发一次请求。
        */
        if (t.expectedBytes <= 0 && t.idx == 0) {
            t.expectedBytes = probeLength(t.originUrl, t.headersJson, t.userAgent);
        }
        long id = safeEnqueue(dm, t, true);
        if (id <= 0 && !t.category.isEmpty()) {
            /* 带子目录（githup/议题 等）建不起来：退到 githup 根目录再试一次。
             * category 不是 final，这里临时清空只为重发，发完恢复 ——
             * 换道重发时仍按原分类走。 */
            String savedCat = t.category;
            t.category = "";
            id = safeEnqueue(dm, t, true);
            t.category = savedCat;
        }
        if (id <= 0) {
            /* githup 目录也建不起来（个别 ROM 的 DownloadManager 不给建），
             * 退回 Download 根目录再试一次 —— 位置不对也比下不到强。
             *
             * 注意后果：**文件会落在 Download 根目录**，而下载管理里显示的
             * 名字仍是原文件名。所以查找已下载文件一律走 DownloadManager
             * （见 DownloadProvider.resolve），不能按「Download/githup/名字」
             * 去拼 —— 拼出来的路径在这里是不存在的。 */
            id = safeEnqueue(dm, t, false);
        }
        if (id <= 0) { t.switching = false; return false; }
        t.id = id;
        t.switching = false;      /* 发车完成，watchTick 可以正常观察它了 */
        t.startedAt = System.currentTimeMillis();
        t.lastAt = t.startedAt;
        t.lastBytes = 0;
        t.slowStrikes = 0;
        /*
          每次发车（含换道后重发）都要把「观察起点」清干净。
          这两个字段是**每条通道各自**的，不是任务级的 —— 留着上一个通道的值，
          新通道就会带着别人的计时开局：
            firstDataAt 不清 → 宽限期立刻生效，新通道刚连上就被判慢；
            stallAt     不清 → 新通道还在建连就被判「卡死」。
        */
        t.firstDataAt = 0;
        t.stallAt = 0;
        downloads.put(id, t);
        if (t.autoInstall) autoInstalls.add(id);
        expectedShas.put(id, t.expectedSha);
        if (downloads.size() > 50) {
            downloads.clear();
            autoInstalls.clear();
            expectedShas.clear();
        }
        return true;
    }

    /**
     * 问一句「这个文件多大」，只发一个 HEAD，不下载内容。
     *
     * 为什么用 HttpURLConnection 手写而不是复用 Http.java：这里要的是一个
     * **同步**、**不跟随重定向到文件体**的长度值，而且它跑在下载线程上，
     * 不能占着 Http 那套给页面用的连接池 —— 下载在跑的时候页面还要刷数据。
     *
     * 拿不到就返回 0（网络拒了 HEAD、镜像不支持、超时……都算「不知道」），
     * 只是少一层完成校验，不影响下载继续。
     */
    private long probeLength(String url, String headersJson, String userAgent) {
        if (url == null || url.isEmpty()) return 0;
        java.net.HttpURLConnection c = null;
        try {
            java.net.URL u = new java.net.URL(url);
            c = (java.net.HttpURLConnection) u.openConnection();
            c.setRequestMethod("HEAD");
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(5_000);
            c.setReadTimeout(5_000);
            c.setRequestProperty("User-Agent",
                    (userAgent == null || userAgent.isEmpty()) ? "githup" : userAgent);
            if (headersJson != null && !headersJson.isEmpty()) {
                try {
                    JSONObject jo = new JSONObject(headersJson);
                    Iterator<String> it = jo.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        String v = jo.optString(k, "");
                        if (!v.isEmpty()) c.setRequestProperty(k, v);
                    }
                } catch (Exception ignored) { }
            }
            int code = c.getResponseCode();
            if (code < 200 || code >= 400) return 0;
            long len = c.getContentLengthLong();
            /*
              有些服务端对 HEAD 回 Content-Length: -1 或 0，但把真实长度放在
              Content-Range 里。这里顺手再找一遍，找不到就算了。
            */
            if (len <= 0) {
                String cr = c.getHeaderField("Content-Range");
                if (cr != null) {
                    int slash = cr.lastIndexOf('/');
                    if (slash > 0) {
                        try { len = Long.parseLong(cr.substring(slash + 1).trim()); }
                        catch (Throwable ignored) { }
                    }
                }
            }
            return len > 0 ? len : 0;
        } catch (Throwable ignored) {
            return 0;
        } finally {
            try { if (c != null) c.disconnect(); } catch (Throwable ignored) { }
        }
    }

    private final android.os.Handler watchHandler =
            new android.os.Handler(android.os.Looper.getMainLooper());
    private boolean watching = false;

    private void startWatch() {
        if (watching) return;
        watching = true;
        watchHandler.post(this::watchTick);
    }

    /**
     * 每隔几秒看一眼进行中的下载：**不动、太慢、失败**都自动换到下一条通道。
     *
     * 这是「下载失败 / 下载慢」最实际的一层兜底：用户不用守着点重试，
     * 也不用知道 gh-proxy 是什么 —— 软件自己把能走的路都走一遍。
     */
    private void watchTick() {
        try {
            DownloadManager dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null || downloads.isEmpty()) {
                watching = false;
                return;
            }
            long now = System.currentTimeMillis();
            for (Object key : new ArrayList<Object>(downloads.keySet())) {
                long id = (Long) key;
                DlTask t = downloads.get(id);
                if (t == null) continue;
                /* 换道中：旧任务已摘掉、新任务还没发车，它的 DM id 已经作废。
                   不跳过就会拿作废的状态再判一次「慢 / 卡死」，触发二次换道。 */
                if (t.switching) continue;
                long status = -1, sofar = -1;
                android.database.Cursor c = null;
                try {
                    c = dm.query(new DownloadManager.Query().setFilterById(id));
                    if (c == null || !c.moveToFirst()) continue;
                    int si = c.getColumnIndex(DownloadManager.COLUMN_STATUS);
                    int bi = c.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR);
                    if (si >= 0) status = c.getInt(si);
                    if (bi >= 0) sofar = c.getLong(bi);
                } catch (Throwable ignored) {
                } finally {
                    if (c != null) c.close();
                }
                if (status == DownloadManager.STATUS_FAILED
                        || status == DownloadManager.STATUS_SUCCESSFUL) {
                    /* 终态统一交给收尾入口：失败走换道，成功走安装/提示。
                     * 广播虽然通常也会来，但这里不等它 —— 广播可能丢。 */
                    finishDownload(id);
                    continue;
                }
                /* 排队中 / 被系统暂停（比如等 WiFi）：不是通道的锅，别动它 */
                if (status == DownloadManager.STATUS_PENDING
                        || status == DownloadManager.STATUS_PAUSED) continue;
                if (sofar < 0) continue;

                /*
                  第一滴数据到了才开始计时 —— 这是「宽限期」该有的语义。

                  原来宽限期是从**入队时刻** startedAt 算的，而 DownloadManager
                  的队列排位、DNS、TLS 握手、302 跳转全挤在前几秒里。于是出现
                  这种误判（用真实参数推演过）：

                       t=1.5s  累计 0B      宽限期内，不判
                       t=3.0s  累计 0B      ← 宽限期刚好到点，而这一轮量的是
                                             1.5~3.0s 这个窗口的字节差 = 0，
                                             speed=0 < 15KB/s，判慢
                       t=4.5s  累计 1150KB  speed=766KB/s 好得很 —— 但已经在
                                            3.0s 那拍被切走了

                  一条 500KB/s 的好通道，就因为「前 2.2 秒在建连」被误切。
                  用户看到的就是「明明在下，却弹速度太慢」。

                  改法：第一个字节到达前**永远不判慢**（那是在建连，不是慢），
                  一旦出过数据，就把 firstDataAt 定为当前时刻，
                  宽限期从这一刻起算。真正卡死的通道仍有兜底 —— 见下面的
                  STALL_LIMIT（一个字都不进超过这个时长就换道），
                  所以不会出现「永远等着」。
                */
                if (t.firstDataAt == 0) {
                    if (sofar <= 0) {
                        /*
                          首字节一直不来 —— 这不是「在建连」，是这条通道根本没接上。

                          必须有这个出口：上面那句「没出数据就 continue」如果不配兜底，
                          一条永远连不通的通道会被永久豁免，任务就一直挂着，谁也不管。
                        */
                        if (now - t.startedAt >= CONNECT_LIMIT) switchChannel(t, "连接超时");
                        continue;
                    }
                    t.firstDataAt = now;
                    t.lastAt = now;
                    t.lastBytes = sofar;
                    /* 首字节到达也算「进过账」，否则 stallAt 还停在 0，
                     * 下一拍万一没新数据，now - 0 是个天文数字，会被误判成卡死。 */
                    t.stallAt = now;
                    continue;
                }

                /* 用「这一轮的实测速度」判断：既抓得住完全卡死，
                 * 也抓得住「一直在爬但只有几十 KB/s」这种更气人的情况。 */
                long dt = now - t.lastAt;
                long dB = sofar - t.lastBytes;
                t.lastAt = now;
                t.lastBytes = sofar;
                if (dt <= 0) continue;
                long speed = dB * 1000L / dt;

                /*
                  一个字都不进超过 STALL_LIMIT：这是真卡死，立刻换道。
                  它和「慢」是两回事 —— 慢至少还在动，卡死是一个字节都不来。
                  必须有这条兜底，否则「出过第一个字节之后就再也不判慢」，
                  遇到半死不活的通道会一直挂着。
                */
                if (dB <= 0) {
                    if (now - t.stallAt >= STALL_LIMIT) switchChannel(t, "连接卡住");
                    continue;
                }
                t.stallAt = now;
                /*
                  喂一个采样点给「慢速建议」。放在这里而不是换道分支里，是因为
                  两种情况都要抓：
                    · 慢到触发换道（下面会切走）
                    · 慢但被进度保护放过了（已下不少、速度还没到绝望）
                      —— 这种用户是干等着，最需要一句提示
                */
                noteSlowSample(now, sofar, speed);
                if (speed >= MIN_SPEED_BPS) {
                    t.slowStrikes = 0;
                    continue;
                }
                if (now - t.firstDataAt < GRACE_MS) continue;
                if (++t.slowStrikes >= SLOW_STRIKES) {
                    /*
                      ═══ 进度保护 ═══

                      仅仅因为「慢」要换道时，先算一笔账：

                        换道 = 换 URL = DownloadManager 无法续传，
                               已经下好的部分很可能全部作废。

                      已经下了 KEEP_GOING_BYTES 以上、且速度还没低到绝望
                      （还有 GIVE_UP_SPEED_BPS），那就继续等 —— 重来的代价
                      大概率大于继续等的代价。

                      注意这里用的是 sofar（DownloadManager 报的已下载字节），
                      不依赖是否接管成功，判据稳定。
                    */
                    if (sofar >= KEEP_GOING_BYTES && speed >= GIVE_UP_SPEED_BPS) {
                        t.slowStrikes = 0;    // 清零，下个窗口重新观察
                        continue;
                    }
                    /* 走到这里 = 真的因为慢要换道了，这是一次实打实的「慢」 */
                    recordSlowEvent(now);
                    switchChannel(t, "速度太慢");
                }
            }
        } catch (Throwable ignored) { }
        if (downloads.isEmpty()) {
            watching = false;
            return;
        }
        watchHandler.postDelayed(this::watchTick, WATCH_MS);
    }

    /** 当前通道不行，换下一条重下；所有通道都试过了才报失败 */
    /* ═══════════════ 换道续传的「接管」 ═══════════════
     *
     * 换道为什么不能交给 DownloadManager 续传 ——
     *
     *   DownloadManager 的每次 enqueue 都是一个独立任务、写进一个独立文件。
     *   给它加 Range 头，服务端确实只回「剩余那一段」，但 DownloadManager
     *   会把这**一段**当成整个文件写下去 —— Android 10+ 上 MediaStore 遇到
     *   同名还会自动改名成 xxx(1).apk，于是我们手里只剩一个残缺的片段，
     *   而原来下了一半的那个文件还停在原地。
     *
     *   它绝不会「追加到已有文件后面」，因为一个下载任务对应一个目标文件
     *   是它的基本模型，没有"续写别人的文件"这个概念。
     *
     *   所以上层按磁盘真实大小一验就发现对不上，只好整份重下 —— 用户看到
     *   的就是「换个通道，进度条回到 0，白等半天」，而且**还多等了一轮**。
     *
     * 于是换道续传改由 ThrottledDownloader 接管：它是自己拿着字节流写文件的，
     * 能以 append 模式打开已有的 .part 从指定偏移接着写。
     */

    /** 私有目录里的落盘位置（限速通道与接管通道共用同一套） */
    private File throttledTarget(String name) {
        File dir = activity.getExternalFilesDir(null);
        if (dir == null) dir = activity.getFilesDir();
        File sub = new File(dir, DOWNLOAD_SUBDIR);
        if (!sub.exists() && !sub.mkdirs()) return null;
        return new File(sub, safeName(name));
    }

    /**
     * 把 DownloadManager 已经下到的字节复制到 .part 里，作为接管的起点。
     *
     * ⚠️ 必须在 dm.remove 之前调用 —— 摘掉任务后就读不到文件了。
     *
     * @return 实际复制的字节数（0 = 读不到，别接管）
     */
    private long copyPrefixToPart(DlTask t, long want) {
        if (want <= 0) return 0;
        DownloadManager dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null || t.id <= 0) return 0;

        android.database.Cursor c = null;
        OutputStream out = null;
        long written = 0;
        File part = null;
        try {
            /*
              ⚠️ 以前只读 COLUMN_LOCAL_URI 一个来源，读不到就直接放弃接管
              —— 这就是「换个通道，进度归零」的直接原因。

              Android 10+ 分区存储下，DownloadManager 下载中的条目挂着
              IS_PENDING=1，很多 ROM 此刻根本不给读（openInputStream 返回空
              或第一次 read 就 -1）；而 COLUMN_LOCAL_FILENAME 在 Q+ 上又已经
              废弃。两个来源都抓瞎，接管必然失败，换道必然整份重下。

              现在按顺序试三条路，哪条通走哪条：

                1) COLUMN_LOCAL_URI     —— content:// 条目（最标准）
                2) COLUMN_LOCAL_FILENAME —— Android 9- 给真实路径，部分 ROM 也给
                3) 目标路径直读          —— 有的 ROM 直接往最终位置写，
                                            落盘文件本身就有已经下好的前缀
            */
            String uriStr = null;
            String pathStr = null;
            try {
                c = dm.query(new DownloadManager.Query().setFilterById(t.id));
                if (c != null && c.moveToFirst()) {
                    int i = c.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI);
                    if (i >= 0) uriStr = c.getString(i);
                    int j = c.getColumnIndex(DownloadManager.COLUMN_LOCAL_FILENAME);
                    if (j >= 0) pathStr = c.getString(j);
                }
            } catch (Throwable ignored) { }
            finally { if (c != null) { try { c.close(); } catch (Throwable ignored) { } } }

            File target = throttledTarget(t.filename);
            if (target == null) return 0;
            /* 用**换道后**的 URL 算 .part 路径 —— 必须与随后 resume() 里
               tmpFile 算出来的完全一致，写错地方等于什么都没接管。 */
            part = ThrottledDownloader.partFileFor(target, t.url());
            File dir = part.getParentFile();
            if (dir != null && !dir.exists() && !dir.mkdirs()) return 0;

            out = new FileOutputStream(part, false);
            byte[] buf = new byte[64 * 1024];

            /* 来源 1：content:// 条目 */
            if (uriStr != null && !uriStr.isEmpty()) {
                written = drainTo(out, buf, want,
                        activity.getContentResolver().openInputStream(android.net.Uri.parse(uriStr)));
            }
            /* 来源 2：真实文件路径（Android 9- / 部分 ROM） */
            if (written <= 0 && pathStr != null && !pathStr.isEmpty()) {
                try {
                    File f = new File(pathStr);
                    if (f.exists() && f.canRead()) {
                        written = drainTo(out, buf, want, new FileInputStream(f));
                    }
                } catch (Throwable ignored) { }
            }
            /* 来源 3：最终落盘位置直读（有的 ROM 直接写目标文件） */
            if (written <= 0 && target.exists() && target.canRead()) {
                try {
                    written = drainTo(out, buf, want, new FileInputStream(target));
                } catch (Throwable ignored) { }
            }

            if (written <= 0) return 0;
            out.flush();
            /* 记在任务上：起点字节数与 .part 位置必须成对，缺一个接不了管 */
            t.resumePart = part;
            t.resumeSeed = written;
            return written;
        } catch (Throwable e) {
            return 0;
        } finally {
            if (out != null) { try { out.close(); } catch (Throwable ignored) { } }
            if (written <= 0 && part != null) {
                try { part.delete(); } catch (Throwable ignored) { }
            }
        }
    }

    /** 从 in 里最多读 want 字节写进 out，返回实际写入数；in 为 null 返回 0 */
    private static long drainTo(OutputStream out, byte[] buf, long want, InputStream src) {
        if (src == null) return 0;
        long w = 0;
        try {
            while (w < want) {
                int n = src.read(buf, 0, (int) Math.min(buf.length, want - w));
                if (n < 0) break;          // 文件还在写，能读多少算多少
                out.write(buf, 0, n);
                w += n;
                if (n == 0) break;         // 读不出东西，别空转
            }
        } catch (Throwable ignored) { }
        finally { try { src.close(); } catch (Throwable ignored) { } }
        return w;
    }

    /** 放弃接管：删掉 .part，清掉字段（之后这个任务整份重下） */
    private void discardResumePart(DlTask t) {
        try {
            if (t.resumePart != null && t.resumePart.exists()) t.resumePart.delete();
        } catch (Throwable ignored) { }
        t.resumePart = null;
        t.resumeSeed = 0;
    }

    /**
     * 接管下载：从 resumeSeed 往后接着下，走 ThrottledDownloader 但**不限速**。
     *
     * @return true = 接管已启动；false = 起不来，调用方应退回整份重下
     */
    private boolean startResumeTakeover(DlTask t) {
        try {
            File target = throttledTarget(t.filename);
            if (target == null) return false;
            /* 前缀必须还在 —— 期间被清掉就别接管了 */
            if (t.resumePart == null || !t.resumePart.exists()
                    || t.resumePart.length() < t.resumeSeed) return false;

            long tid = throttledSeq.getAndDecrement();
            TlTask tl = new TlTask(tid, t.filename, t.url(), t.headersJson,
                    t.expectedSha, t.autoInstall, target, t.category);
            throttledTasks.put(tid, tl);

            Map<String, String> headers = headersFrom(t.headersJson);
            /*
              走镜像时把凭据摘掉：那些 Authorization 是用户的私有令牌，
              不能交到第三方代理手上（直连那一条保留，那正是需要令牌的场景）。
            */
            if (DownloadChannels.hasAuthHeader(t.headersJson)
                    && !DownloadChannels.DIRECT.equals(DownloadChannels.channelKey(t.url()))) {
                Map<String, String> safe = new HashMap<String, String>();
                for (Map.Entry<String, String> e : headers.entrySet()) {
                    if (isCredentialKey(e.getKey())) continue;
                    safe.put(e.getKey(), e.getValue());
                }
                headers = safe;
            }

            ThrottledDownloader.Handle h = ThrottledDownloader.resume(
                    t.url(), target, headers,
                    makeTlListener(tl, t.url(), t.filename, t.headersJson,
                            t.expectedSha, t.autoInstall, t.category),
                    t.resumeSeed, t.expectedBytes);
            tl.handle = h;
            startWatch();
            return true;
        } catch (Throwable e) {
            android.util.Log.w("githup", "续传接管启动失败", e);
            return false;
        }
    }

    private void switchChannel(DlTask t, String why) {
        switchChannel(t, why, -1);
    }

    private void switchChannel(DlTask t, String why, long bytes) {
        switchChannel(t, why, bytes, false);
    }

    /**
     * @param quiet true = 静默换道，不弹「已切换到某某」。
     *
     * 为什么要这个开关：一条 login 用户的私有附件现在会先去撞 10 条镜像，
     * 每条都拿不到（github 回 404）、每条都几乎立刻失败。要是每次都弹一句
     * 「下载失败，已切换到加速 N」，用户会被十几条 toast 糊一脸，
     * 看着比真的坏了还吓人。秒错的责任不在用户，没必要打扰他 ——
     * 真正需要告知的是两种：用户确实等了很久（慢 / 卡死），
     * 以及所有通道都走完了（那条长提示见下面 first 分支）。
     */
    private void switchChannel(DlTask t, String why, long bytes, boolean quiet) {
        DownloadManager dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
        /* ── 先把「已经拿到多少字节」问出来，再摘掉这个下载 ──
           摘掉之后 DownloadManager 就查不到了，顺序不能反。 */
        long got = bytes > 0 ? bytes : queryBytesSoFar(dm, t.id);
        if (got < 0) got = 0;

        if (t.idx + 1 >= t.urls.size()) {
            if (dm != null && t.id > 0) {
                try { dm.remove(t.id); } catch (Throwable ignored) { }
                downloads.remove(t.id);
                autoInstalls.remove(t.id);
                expectedShas.remove(t.id);
            }
            /* 一条都不剩了：这才算真正的失败，落进历史里 */
            addHistory(t, false, bytes);
            final String n = t.filename;
            notifyUpdateAborted("download-failed");     // 撤回「正在装」，别把后续提醒一并压住
            activity.runOnUiThread(() -> Toast.makeText(activity,
                    "下载失败：" + n + "（所有通道都试过了，请检查网络）",
                    Toast.LENGTH_LONG).show());
            return;
        }
        t.idx++;
        t.slowStrikes = 0;
        /*
          换到新通道，两个时间戳必须一起归零：
            firstDataAt 不清零 → 新通道一上来就被当成「早就出过数据」，
                                 宽限期立刻生效，等于又回到误判老路；
            stallAt     不清零 → 新通道还在建连，就可能被判成「卡死」。
        */
        t.firstDataAt = 0;
        t.stallAt = 0;
        t.switching = true;

        /*
          ── 把已经下好的那一半接管过来 ──

          ⚠️ 必须在 dm.remove **之前**做：摘掉任务后 DownloadManager 就把
             文件收走了，再也读不到已经下好的字节。
        */
        final long base = t.resumeFrom + got;      // 累计：上一次的起点 + 这一段拿到的
        /*
          ⚠️ expectedBytes 不能再当硬门槛。

          以前要求 t.expectedBytes > 0 —— 而这个值是发车前用 HEAD 探出来的，
          很多镜像对 HEAD 直接不响应。探不到就永远走不了续传，
          换道必然整份重下。

          现在它只是**软条件**：探到了就顺带校验总长（见 ThrottledDownloader
          的 206 分支），探不到就不校验 —— 反正换过去的是同一个 URL 的内容，
          真出问题还有 sha 兜底。没有总长就不让续传，属于把「更谨慎」
          凌驾于「别让用户白等」之上。
        */
        final boolean worthResume = !t.noResume
                && base >= RESUME_MIN_BYTES
                && (t.expectedBytes <= 0 || base < t.expectedBytes);
        if (worthResume) {
            long seeded = copyPrefixToPart(t, base);
            /*
              实际能读到的可能少于 base —— DownloadManager 还在写这个文件。
              太少就不值得接管：省下的时间还不如一次探测请求的开销。
            */
            if (seeded < RESUME_MIN_BYTES / 2) {
                discardResumePart(t);
                /*
                  ⚠️ 以前这里直接 `t.noResume = true` —— 失败一次就终身放弃。

                  而失败的原因常常只是「这一次没读到」：MediaStore 条目还挂
                  着 IS_PENDING、文件刚被回收、ROM 实现不同。判成终身的话，
                  后面每一次换道都必然整份重下 —— 用户看到的就是「一换通道
                  就从零开始」。

                  现在记次数，连续失败 RESUME_FAIL_LIMIT 次才认命。
                */
                if (++t.resumeFails >= RESUME_FAIL_LIMIT) t.noResume = true;
            } else {
                t.resumeFails = 0;      // 成功过一次就重新计数
            }
        }
        if (dm != null && t.id > 0) {
            try { dm.remove(t.id); } catch (Throwable ignored) { }
            downloads.remove(t.id);
            autoInstalls.remove(t.id);
            expectedShas.remove(t.id);
        }

        /*
          ── 断点续传 ──

          以前换道一律从头开始：dm.remove 摘掉旧任务，再用新 URL 发一个全新的
          DownloadManager 请求。新请求不带 Range，服务端自然从第 0 字节发 ——
          已经下了一半的几十 MB 全部作废，进度条回到 0。用户看到的就是
          「换个通道，白等半天」。

          现在：摘掉旧任务前先记下拿到多少字节，新通道从**这个字节往后**接着要。

          ═══ 现在的门槛 ═══

            1) 已经拿到的字节够多（RESUME_MIN_BYTES = 32KB）。
               ⚠️ 以前是 128KB —— 而换道恰恰是因为慢（连续两轮 < 15KB/s），
               6 秒最多也就下 90KB，永远够不着，续传等于没写。
            2) 知道文件总长就顺带校验（expectedBytes > 0 时比对
               Content-Range）；不知道就不校验，靠 sha 兜底。
               ⚠️ 以前把它当硬门槛，而总长是发车前用 HEAD 探的，
               很多镜像不响应 HEAD —— 探不到就永远走不了续传。

          还有一条兜底在 finishDownload：续传下完之后**按磁盘上的真实大小**
          再验一次。ROM 的 DownloadManager 若把续传的内容写进了新文件
          （而不是追加到原来那个），大小必然对不上 —— 那就认栽，
          noResume 置位，之后这个任务老老实实整份重下。
          所以最坏情况只是「白试一次」，不会比现在更差。
        */
        /* DownloadManager 那条路不再带 Range —— 它续不了（见上面说明）。
           接管与否全看 resumeSeed。 */
        t.resumeFrom = 0;

        final String reason = why;
        /* 探测要发网络请求，必须在后台线程 —— 这个入口有时是从
           runOnUiThread 里调进来的（见 finishDownload 的「文件不完整」分支）。 */
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    /*
                      ⚠️ 这里以前先跑 probeResume() 探一次（发 Range 请求、确认
                      206 且总长一致才敢接管）。**那次探测要花一个完整往返** ——
                      跨国镜像常常 1~3 秒，超时上限 8 秒。用户已经因为慢等了
                      一轮，换道时还要干等一次探测，而这期间一个字节都没在下。

                      现在直接接管：总长校验并进正式请求里做（ThrottledDownloader
                      的 206 分支会比对 Content-Range），省掉一整次往返。
                      新通道不支持 Range 时它会收到 200，自己截断重写 ——
                      结果等价于从头下，不会比现在更差。
                    */
                    if (t.resumeSeed > 0 && t.resumePart != null) {
                        if (startResumeTakeover(t)) {
                            if (!quiet) {
                                final String ch = t.channel();
                                final long from = t.resumeSeed;
                                activity.runOnUiThread(() -> Toast.makeText(activity,
                                        reason + "，已切换到" + ch +
                                        "（从第 " + (from / 1024) + " KB 继续）",
                                        Toast.LENGTH_SHORT).show());
                            }
                            return;
                        }
                        discardResumePart(t);   // 接管没起来，整份重来
                    }
                    if (!startTask(t)) {
                        addHistory(t, false, bytes);
                        final String n = t.filename;
                        notifyUpdateAborted("start-failed");
                        activity.runOnUiThread(() -> Toast.makeText(activity,
                                "下载失败：" + n, Toast.LENGTH_SHORT).show());
                        return;
                    }
                    if (quiet) return;
                    final String ch = t.channel();
                    activity.runOnUiThread(() -> Toast.makeText(activity,
                            reason + "，已切换到" + ch,
                            Toast.LENGTH_SHORT).show());
                } catch (Throwable e) {
                    /* 兜底：换道线程自己炸了也不能把任务丢在半路 */
                    t.switching = false;
                    discardResumePart(t);
                    if (!startTask(t)) {
                        addHistory(t, false, bytes);
                        notifyUpdateAborted("start-failed");
                    }
                }
            }
        }, "ch-switch").start();
    }

    /** 问 DownloadManager 这个任务当前拿到多少字节；查不到返回 -1 */
    private long queryBytesSoFar(DownloadManager dm, long id) {
        if (dm == null || id <= 0) return -1;
        android.database.Cursor c = null;
        try {
            c = dm.query(new DownloadManager.Query().setFilterById(id));
            if (c == null || !c.moveToFirst()) return -1;
            int bi = c.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR);
            return bi >= 0 ? c.getLong(bi) : -1;
        } catch (Throwable ignored) {
            return -1;
        } finally {
            if (c != null) { try { c.close(); } catch (Throwable ignored) { } }
        }
    }

    /**
     * 下载完成后，把文件的**确切落盘位置**问出来。
     *
     * ═══ 为什么要这个 ═══
     *
     * 以前的历史只存文件名，要找文件时拿名字去拼
     * `Download/githup/xxx.apk`。这有三个躲不掉的问题：
     *
     *   1) Android 10+ 分区存储下，拼出来的路径未必是真实位置
     *      （ROM 可能带 (1) 后缀、可能放在别的卷）
     *   2) 同名文件分不清 —— 删 A 可能删到 B
     *   3) 最要命的：拼错了就以为「文件不在了」，于是又加一套磁盘扫描
     *      去补回，扫描再出错…越修越绕（这几版反复出的问题都源于此）
     *
     * 现在改成和 YunX 的 savePath 同一个思路：**下载完成的那一刻就把
     * 确切位置记下来**。之后打开、删除、判断在不在，全部直接用它。
     *
     * 有确切位置就不需要「猜」，不需要猜就不需要那套容易出错的扫描同步。
     *
     * @return content:// URI 或绝对路径；查不到返回空串
     */
    private String queryFinalUri(long dlId) {
        if (dlId <= 0) return "";
        DownloadManager dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) return "";
        android.database.Cursor c = null;
        try {
            c = dm.query(new DownloadManager.Query().setFilterById(dlId));
            if (c == null || !c.moveToFirst()) return "";
            /* Android 10+ 给 content://media/external/downloads/<id> */
            int i = c.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI);
            if (i >= 0) {
                String u = c.getString(i);
                if (u != null && !u.isEmpty()) return u;
            }
            /* Android 9 及以下给真实绝对路径 */
            int j = c.getColumnIndex(DownloadManager.COLUMN_LOCAL_FILENAME);
            if (j >= 0) {
                String p = c.getString(j);
                if (p != null && !p.isEmpty()) return p;
            }
        } catch (Throwable ignored) {
        } finally {
            if (c != null) { try { c.close(); } catch (Throwable ignored) { } }
        }
        return "";
    }

    /**
     * 这个 uri 指向的文件还在不在。
     *
     * 只认确切位置，不按名字猜：
     *   · content:// —— 用 ContentResolver 打开，能开就是在
     *   · 绝对路径  —— File.exists()
     */
    private boolean uriAlive(String uri) {
        if (uri == null || uri.isEmpty()) return false;
        try {
            if (uri.startsWith("content://")) {
                android.net.Uri u = android.net.Uri.parse(uri);
                android.database.Cursor c = null;
                try {
                    c = activity.getContentResolver().query(u,
                            new String[]{"_id"}, null, null, null);
                    return c != null && c.moveToFirst();
                } finally {
                    if (c != null) { try { c.close(); } catch (Throwable ignored) { } }
                }
            }
            return new File(uri).exists();
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** 按确切位置删文件。返回是否删掉了 */
    private boolean deleteByUri(String uri) {
        if (uri == null || uri.isEmpty()) return false;
        try {
            if (uri.startsWith("content://")) {
                return activity.getContentResolver()
                        .delete(android.net.Uri.parse(uri), null, null) > 0;
            }
            File f = new File(uri);
            return f.exists() && f.delete();
        } catch (Throwable ignored) {
            return false;
        }
    }

    /*
      换道续传的**预检探测已经删掉**。

      以前这里有个 probeResume()：换道前先发一个 Range 请求，确认新通道
      回 206 且总长一致，才敢接管。问题见 switchChannel 里的说明 ——
      那次探测要花一个完整往返，期间一个字节都没在下。

      现在总长校验并进正式请求（ThrottledDownloader 的 206 分支读
      Content-Range 比对），省掉一整次往返。新通道不支持 Range 时它收到
      200，自己截断重写，结果等价于从头下，不会更差。

      少一次往返 = 换道后更快出数据，这正是用户要的。
    */

    /**
     * 组装下载请求。subDir = true 时落到 Download/githup/ 下，
     * 有 category 时再挂子目录（githup/议题、githup/release）。
     */
    private DownloadManager.Request buildRequest(String url, String filename,
                                                 String headersJson, String userAgent,
                                                 boolean subDir, String category,
                                                 String[] nameOut, long resumeFrom) {
        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
        req.setTitle(filename);
        req.setDescription("githup 下载");
        req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        /*
          落盘前先处理重名。

          ⚠️ 最早没有这一步，直接 `downloadSubPath(filename, category)` 当路径：
          同名附件（app-release.apk 满地都是）后下的会把先下的**整个文件覆盖掉**。

          中间一版改成自动编号（foo.apk → foo-2.apk → foo-3.apk），
          用户明确不要 —— 不想看到一串编号副本。

          现在是**同名覆盖**：先用 purgeExistingInDownloads 清掉旧的，
          再让新文件用原名落下。磁盘上始终只有一份。
        */
        String outName = uniqueName(filename, category, subDir);
        /*
          同名覆盖：先把旧的同名文件清掉。
          不清的话 Android 10+ 的 DownloadManager / MediaStore 会自动把它
          改名成 foo(1).apk，落盘名就不再是我们记进历史的这个名字了。

          ⚠️ 续传时**绝不能清** —— 那个「旧的同名文件」正是我们已经下了一半
          的内容，清掉就等于续传了个寂寞。续传要的就是让新数据追加到它后面。
        */
        if (resumeFrom <= 0) purgeExistingInDownloads(outName, category, subDir);
        if (nameOut != null && nameOut.length > 0) nameOut[0] = outName;
        req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                subDir ? downloadSubPath(outName, category) : safeName(outName));
        /* 记下真正落到磁盘上的名字：历史要靠它「打开 / 删除」，
         * 存原名的话一旦加了 -2 后缀就永远定位不到真文件。 */
        req.setTitle(outName);
        req.allowScanningByMediaScanner();
        req.addRequestHeader("User-Agent",
                (userAgent == null || userAgent.isEmpty()) ? "githup" : userAgent);
        // 默认按 API 语义请求；调用方可覆盖
        req.addRequestHeader("Accept", "*/*");
        req.addRequestHeader("X-GitHub-Api-Version", "2022-11-28");
        /*
          续传：只要从这个字节往后的部分。

          Range 是**客户端请求头**，服务端愿意就回 206 给这一段，不愿意就回
          200 给整份（说明它无视 Range）—— 那一段就按整份写，
          真漏过来（服务端头尾不一致）也还有 finishDownload 的大小校验兜底。
        */
        if (resumeFrom > 0) req.addRequestHeader("Range", "bytes=" + resumeFrom + "-");
        /*
          走镜像时把凭据摘掉。

          那些 Authorization 是用户的私有令牌（见 DownloadChannels.hasAuthHeader
          里记的那段由来）：它们是给 GitHub 的，不能交到第三方代理手上。
          镜像拿不到令牌就会回 404 —— 对公共资源没影响（本来也不需要令牌），
          对私有资源则是快速失败、接着换到末尾那条**带令牌的直连**，照样能下。

          直连那一条不摘，因为那正是需要令牌才能取到东西的场景。
        */
        final boolean stripCreds = DownloadChannels.hasAuthHeader(headersJson)
                && !DownloadChannels.DIRECT.equals(DownloadChannels.channelKey(url));
        if (headersJson != null && !headersJson.isEmpty()) {
            try {
                JSONObject jo = new JSONObject(headersJson);
                Iterator<String> it = jo.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    if (stripCreds && isCredentialKey(k)) continue;
                    String v = jo.optString(k, "");
                    if (!v.isEmpty()) req.addRequestHeader(k, v);
                }
            } catch (Exception ignored) { }
        }
        return req;
    }

    /**
     * 这一类请求头属于凭据，走镜像时必须摘掉。
     *
     * 只认名字不认值：它们格式各异（Bearer / Basic / 裸 token），认名字最稳。
     * Cookie 一并摘 —— 有些镜像自己也种 cookie，混着转发更说不清。
     */
    private static boolean isCredentialKey(String name) {
        if (name == null) return false;
        String s = name.toLowerCase();
        return s.equals("authorization") || s.equals("cookie")
                || s.contains("x-github-token") || s.equals("x-oauth-basic");
    }

    // ------------------------------------------------------------------
    // 下载通道：直连慢 / 连不上时自动换道
    //
    // 为什么需要：系统 DownloadManager 是**自己直连** GitHub 的。Release 附件、
    // 源码包最终都会 302 到 objects.githubusercontent.com，这个域名在国内不少
    // 宽带（广电 / 移动 / 长城…）下又慢又容易中途断，表现就是「几十 KB/s 慢慢
    // 爬」或者直接「下载失败」。而 App 里的列表、README、图片是通的 —— 它们走
    // 的是原生网络栈 + 加速镜像。所以给下载也补上同样的多通道。
    // ------------------------------------------------------------------

    /** 低于这个速度算「太慢」，连续观察几轮还这样就换道 */
    private static final long MIN_SPEED_BPS = 15 * 1024;
    /** 监控间隔 */
    private static final long WATCH_MS = 1_500;
    /**
     * 连续几轮判定太慢才真的换道（免得刚起步的抖动被误判）。
     *
     * 历史：2 轮 → 1 轮 → 现在回到 2 轮。
     *
     * 压到 1 轮的初衷是「别让用户干等」（当时配 3 秒监控间隔 + 8 秒宽限期，
     * 最坏 14 秒才切走）。但压到 1 轮之后变成**零容错**：镜像的限速本来就是
     * 波动的，某一轮掉到 15KB/s 以下很正常，下一轮又回到 100KB/s。
     * 1 轮就切，等于被抖动牵着鼻子走 —— 用户看到的是「下载好好的突然换道、
     * 进度从头再来」。
     *
     * 现在把「等待」交给监控间隔（1.5 秒）和下面的 STALL_LIMIT 去解决，
     * 这里保留 2 轮做抖动容错：真的要判一条通道的死刑，得连续两轮都不行。
     */
    private static final int SLOW_STRIKES = 2;
    /**
     * 首次出数据前的观察期。
     *
     * 注意语义已经改了：**建连阶段（一个字节都没来）根本不判慢**，
     * 这个宽限期是从「第一个字节到达」那一刻起算的 —— 见 watchTick 里的
     * firstDataAt。所以它现在衡量的是「出过数据之后，允许低速多久才认账」。
     *
     * 原来是 8 秒，后来压到 3 秒。压到 3 秒时配合的是「从入队算起」的老语义，
     * 那正是「明明在下却弹速度太慢」的根源。现在语义对了，3 秒够用：
     * 出过数据还连续 3 秒低于 15KB/s，基本可以判定这条通道被限速了。
     */
    private static final long GRACE_MS = 3_000;
    /**
     * 出过数据之后，**一个字节都不进**超过这个时长就换道。
     *
     * 为什么必须有它：建连阶段不再判慢之后，如果一条通道「发了起始几个包
     * 然后就彻底不动」，就会永远挂着不动。慢（还在爬）和卡死（完全不动）
     * 要分开对待：慢给宽限期，卡死直接切。
     * 8 秒是权衡 —— 短了会误切正在重试的通道，长了用户等得难受。
     */
    private static final long STALL_LIMIT = 8_000;
    /**
     * 从发车算起，多久还拿不到**第一个字节**就认定这条通道连不通。
     *
     * 和 STALL_LIMIT 分工不同：
     *   STALL_LIMIT    —— 出过数据、后来不动了（半路卡死），8 秒；
     *   CONNECT_LIMIT  —— 从头到尾一个字节都没有（压根没连上），15 秒。
     *
     * 15 秒看着长，但这里是「连握手都没完成」的量级：DownloadManager 排队、
     * DNS、TLS、镜像的 302 跳转都算在里面，直连 GitHub 在弱网下十几秒也正常。
     * 反过来，超过 15 秒还没动静的通道基本没有抢救价值，
     * 后面还有 5 条候选，早点让位更划算。
     */
    private static final long CONNECT_LIMIT = 15_000;

    /**
     * 完成时「大小对不上多少才算坏包」。
     *
     * 头部的 Content-Length 与 DownloadManager 统计的字节数偶尔会差一点
     * （重定向后的分块传输、ROM 的统计口径），卡死在完全相等会把好包也拦掉。
     * 32KB 足够区分「差几字节的统计口径」和「少了一多半的残包」。
     */
    private static final long SIZE_TOLERANCE = 32 * 1024;

    private static final String PREF_DL = "githup_dl";
    /** 「下载慢」建议被用户永久关掉 */
    private static final String KEY_ADVICE_OFF = "advice_off";
    /** 用户手动指定的下载通道；空 = 自动 */
    private static final String KEY_CH_PREF = "ch_pref";

    /** 记录下载任务，便于完成后提示安装 APK / 卡住时换道重下 */
    private final java.util.Map<Long, DlTask> downloads = new java.util.concurrent.ConcurrentHashMap<>();
    /** 需要在下载完成后解压并安装的下载任务 */
    private final java.util.Set<Long> autoInstalls = new java.util.HashSet<>();
    /** 每个下载任务期望的 SHA-256（空串 = 不校验） */
    private final java.util.Map<Long, String> expectedShas = new java.util.HashMap<>();

    /* ═══════════════ 限速通道的状态 ═══════════════
     *
     * 限速那条路不走 DownloadManager（见 ThrottledDownloader 的注释），
     * 所以它的任务 DownloadManager 一问三不知 —— downloadStatus() 得
     * 自己把这边的情况补进返回值里，否则「下载管理」页上这个任务会凭空消失：
     * 用户点了下载，进度条不出现，文件过一会儿又冒出来了。
     *
     * 用负数 id 和 DownloadManager 的 id 隔开，两边的 key 永不会撞。
     */
    private final java.util.Map<Long, TlTask> throttledTasks =
            new java.util.concurrent.ConcurrentHashMap<>();
    private final java.util.concurrent.atomic.AtomicLong throttledSeq =
            new java.util.concurrent.atomic.AtomicLong(-1);

    /** 一个限速下载任务的状态。字段都 volatile —— 下载线程写、UI 线程读 */
    private static final class TlTask {
        final long id;
        final String filename;
        final String originUrl;
        final String headersJson;
        final String expectedSha;
        final boolean autoInstall;
        final File target;
        volatile long done = 0;
        volatile long total = -1;
        volatile long bps = 0;
        volatile boolean running = true;
        volatile ThrottledDownloader.Handle handle;

        TlTask(long id, String filename, String originUrl, String headersJson,
               String expectedSha, boolean autoInstall, File target, String category) {
            this.id = id;
            this.filename = filename;
            this.originUrl = originUrl;
            this.headersJson = headersJson;
            this.expectedSha = expectedSha;
            this.autoInstall = autoInstall;
            this.target = target;
            this.category = safeCategory(category);
        }

        /** 下载分类（已清洗）：议题 / release；空串 = githup 根目录 */
        String category;

        /** 搬进公共目录后的实际文件名（可能被避让成 foo-2.apk） */
        String outName = "";
    }

    /** 一个下载任务的完整状态。换道时要靠它原样重下一次，所以都存着 */
    private static final class DlTask {
        final String filename;
        final String originUrl;
        final String headersJson;
        final String userAgent;
        final String expectedSha;
        final boolean autoInstall;
        final List<String> urls;
        int idx = 0;
        long id = -1;
        long startedAt = 0;
        long lastBytes = 0;
        long lastAt = 0;
        int slowStrikes = 0;
        /**
         * 第一个字节到达的时刻，0 = 还没出过数据。
         *
         * 宽限期（GRACE_MS）从这一刻算起，而不是从入队时刻 startedAt 算起 ——
         * 建连那几秒里 DownloadManager 在排队、握手、追 302，一个字节都没有
         * 属于正常，拿它当「慢」就会把好通道误切掉。
         */
        long firstDataAt = 0;
        /**
         * 上一次「有字节进账」的时刻，用来判真卡死（见 STALL_LIMIT）。
         * 和 lastAt 的区别：lastAt 每轮都更新（用于算窗口速度），
         * 这个只在真的有字节进来时才更新。
         */
        long stallAt = 0;
        /**
         * 断点续传：本次发车从文件的第几个字节开始要。
         *
         * 0 = 从头下（默认，也是所有非续传场景的值）。
         * > 0 = 只向服务端要「从这个字节往后的部分」，前面已经拿到的不再重下。
         *
         * ⚠️ 它是**累计**的：换一次道续一次，第二次续传的起点是
         *    「上一次的起点 + 这一段实际拿到的字节」，不是这一段的长度。
         */
        long resumeFrom = 0;
        /**
         * 这个任务从此**不再尝试续传**。
         *
         * 续传能不能成取决于 ROM 的 DownloadManager 怎么处理 Range + 已存在的
         * 目标文件（有的追加、有的另起一个 foo (1).apk）。试出来不行就认了，
         * 之后老老实实整份重下 —— 每次换道都白试一遍比不试更糟。
         */
        boolean noResume = false;
        /**
         * 接管连续失败的次数。
         *
         * 读不到 DownloadManager 的半成品**不等于这条路永远走不通** ——
         * 很可能只是这一次的时机问题（MediaStore 条目还挂着 IS_PENDING、
         * 文件刚被回收、ROM 自己的实现不同）。以前失败一次就永久置
         * noResume，等于把一次偶然判成终身。
         *
         * 现在记次数，超过 RESUME_FAIL_LIMIT 才认命。
         */
        int resumeFails = 0;
        /**
         * 续传接管：DownloadManager 已经下到的那一段，被复制到这个 .part 里。
         *
         * 换道续传不能再交给 DownloadManager（它只会把「剩余那一段」写进
         * 另一个文件），所以交给 ThrottledDownloader 从 .part 后面接着写。
         * null = 这次换道不接管（走原来的整份重下）。
         */
        File resumePart = null;
        /** 已经写进 resumePart 的字节数（= 新通道要从哪里开始要） */
        long resumeSeed = 0;
        /**
         * 正在换道中（已摘掉旧任务、新任务还没发车）。
         *
         * 换道要做一次探测请求，只能在后台线程跑；这期间 watchTick 还会
         * 扫到这个任务，而它的 DM id 已经作废 —— 不跳过的话会拿旧状态
         * 再判一次「慢 / 卡死」，触发第二次换道，任务就乱了。
         */
        boolean switching = false;
        /**
         * 这条文件应该有多大（字节），0 = 未知。
         *
         * 用来抓「下完了但它其实是坏的」：镜像把请求 302 到一个 HTML 错误页、
         * 或者传到一半断了却报了 200，DownloadManager 都会当成成功。
         * 不看大小的话，用户拿到的是个装不上的包，还得自己猜为什么。
         */
        long expectedBytes = 0;

        /* 用来给日志/提示标明「这是第几次尝试」 */
        int attempt = 1;

        DlTask(String filename, String originUrl, String headersJson, String userAgent,
               String expectedSha, boolean autoInstall, List<String> urls, String category) {
            this.filename = filename;
            this.originUrl = originUrl;
            this.headersJson = headersJson;
            this.userAgent = userAgent;
            this.expectedSha = expectedSha;
            this.autoInstall = autoInstall;
            this.urls = urls;
            this.category = safeCategory(category);
        }

        /**
         * 下载分类（已清洗）：议题 / release；空串 = 直接放 githup/ 根。
         * 非 final：startTask 在子目录建不起来时会临时清空重发（见其注释）。
         */
        String category;

        /**
         * 真正落到磁盘上的文件名。
         *
         * 通常等于 filename，但撞名时会被 uniqueName 改成 foo-2.apk。
         * 历史和「打开 / 删除」都必须用它 —— 存原名的话，一旦加了后缀
         * 就永远定位不到真文件（用户点了「打开」却报「文件不在了」）。
         */
        String savedName = "";

        /** 给历史用的落盘名：没算出来就退回原始名 */
        String outName() {
            return (savedName == null || savedName.isEmpty()) ? filename : savedName;
        }

        String url() { return urls.get(Math.min(idx, urls.size() - 1)); }

        /** 给进度条看的通道名，如「加速 1」/「直连」 */
        String channel() { return DownloadChannels.channelName(url()); }

        /** 这条通道的稳定标识，如 "https://ghfast.top/" / "direct" */
        String channelKey() { return DownloadChannels.channelKey(url()); }
    }

    /**
     * 发起一次下载，把 DownloadManager 可能抛的异常收住。
     *
     * enqueue 会因为各种环境原因抛：外部存储没挂载、ROM 定制后拒绝带子目录的
     * 目标路径、DownloadManager 被禁用…… 这些都是「下不了」，不是「软件坏了」，
     * 所以返回 <=0 让上层去试下一条路，别把异常一路抛到 UI 线程炸给用户看。
     */
    private long safeEnqueue(DownloadManager dm, DlTask t, boolean subDir) {
        try {
            String[] nameOut = new String[1];
            long id = dm.enqueue(buildRequest(t.url(), t.filename, t.headersJson,
                    t.userAgent, subDir, t.category, nameOut, t.resumeFrom));
            if (id > 0 && nameOut[0] != null && !nameOut[0].isEmpty()) {
                t.savedName = nameOut[0];
            }
            return id;
        } catch (Throwable e) {
            android.util.Log.w("githup", "enqueue 失败", e);
            return -1;
        }
    }

    /* ═══════════════ 通道自选 + 实时测速 ═══════════════
     *
     * 用户要的是「我自己挑一条通道」，以及「自动选最快的」。
     *
     * 关键约束：**绝不自动测速**。以前试过发车前探测各通道，结果用户
     * 点完下载要干等几秒，比走错通道再换还难受。这里的测速只在用户
     * 主动打开通道面板时才跑，而且是并发的、结果逐个显现，不阻塞任何
     * 正在进行的下载。
     */

    /**
     * 测速目标 —— **必须是真实的文件下载链接，不能用网页地址**。
     *
     * 这是上一版「只有一条通道测得出速度」的根因：
     * 原来用的是 `https://github.com/Buwrt/githup`（一个普通网页），
     * 而 ghproxy 这类加速镜像**只代理文件下载**（Release 附件、源码包、
     * raw 文件），网页路径它们要么不认、要么回一段几十字节的 HTML 错误页 ——
     * 于是绝大多数通道被判成「不可用」，只有个别镜像碰巧能代理网页才测出速度。
     *
     * 换成 Release 附件直链：这是所有镜像的标准用法，成功率天差地别。
     * 文件约 1MB，读满 64KB 就够算速度了。
     */
    private static final String PROBE_TARGET =
            "https://github.com/Buwrt/githup/releases/download/v1.2.15/githup-v1.2.15.apk";
    /**
     * 云速通道专用的测速目标 —— 必须是 **raw 类地址**。
     *
     * 见 {@link #measureChannel}：jsdelivr 只代理仓库文件，
     * 用上面那个 Release 附件去测它一定 404。
     */
    private static final String PROBE_TARGET_RAW =
            "https://raw.githubusercontent.com/Buwrt/githup/main/README.md";
    /** 单条通道的测速预算（毫秒） */
    private static final int PROBE_BUDGET_MS = 5_000;
    /**
     * 每条通道测多久（毫秒）。
     *
     * ⚠️ 原来是「读固定字节就停」，这是个 bug：
     *   setReadTimeout 是**单次 read 的超时**，不是总时长。慢通道要花很久
     *   才能凑够目标字节，于是它一直挂着，最后一律被判成「不可用」——
     *   慢 ≠ 不可用，20KB/s 的通道明明能下，却被标成失败。
     *   这就是「只有加速 3 能用」的真正原因：**不是别的镜像挂了，
     *   是它们稍慢一点就被误判成死链**。
     *
     * 改成读固定时长：这个时间内读多少算多少，慢通道也能给出真实速度。
     */
    /*
      通道从 10 条扩到 24 条后，一轮测速的总耗时必须压住，否则用户点开
      面板要等很久才看到第一屏结果。所以窗口从 3 秒收到 2 秒 ——
      2 秒足够读出几十 KB，算速度完全够用。
    */
    private static final int PROBE_WINDOW_MS = 2_000;
    /** 单条通道最多读多少字节 —— 兜住快通道，也保证样本够大（太小算不准） */
    private static final int PROBE_MAX_BYTES = 1024 * 1024;
    /**
     * 测速专用线程池（6 条）。
     *
     * · 不能跟下载任务抢 pool 那 8 条线程，否则排不上队；
     * · 也不能一次全开 11 条：11 个 HTTPS 连接同时打出去会互相抢带宽，
     *   在弱网下连首字节都挤不出来，本来能通的也会被挤成超时。
     *   6 条一批，剩下的排队等空位，总耗时可控，结果也更准。
     */
    /** 是否在持续测速中（面板开着 = true） */
    private volatile boolean probing = false;
    /**
     * 测速结果的新鲜度上限。
     *
     * 自动模式要拿「当前」最快的通道，但不能用一小时前的速度做决定 ——
     * 那时最快的现在未必还快。超过这个时长没测过，就当没数据，退回固定
     * 顺序，让换道机制去兜底。
     */
    private static final long PROBE_FRESH_MS = 10 * 60 * 1000L;
    /** 最后一次跑完一整轮测速的时间戳（0 = 从没测过） */
    private volatile long probeAt = 0;
    /**
     * 各通道连续失败次数。
     *
     * 通道从 10 扩到 24 之后，死链会明显变多。如果每轮都在这些死链上
     * 完整等一遍超时，一轮能拖到一分钟以上 —— 用户点开面板半天看不到
     * 结果，体验直接崩掉。
     *
     * 所以连续失败达到阈值就让这条「休眠」几轮：休眠期间直接标成不可用
     * 并跳过，不发起连接。冷却结束后再给它一次机会（免费镜像随时可能
     * 复活，不能永久拉黑）。
     */
    private final java.util.Map<String, Integer> probeFails =
            new java.util.HashMap<>();
    /** 连续失败几次进入休眠 */
    private static final int PROBE_FAIL_MAX = 2;
    /** 休眠几轮 */
    private static final int PROBE_COOL_ROUNDS = 3;
    /** 通道 key -> 还剩几轮休眠 */
    private final java.util.Map<String, Integer> probeCool =
            new java.util.HashMap<>();
    /** 两轮测速之间的间隔（毫秒） */
    private static final int PROBE_GAP_MS = 1_500;
    /** 测速循环用的主线程 Handler */
    private final android.os.Handler probeHandler =
            new android.os.Handler(android.os.Looper.getMainLooper());
    private final java.util.concurrent.ExecutorService probePool =
            java.util.concurrent.Executors.newFixedThreadPool(8);

    private final Object probeLock = new Object();
    /** 通道 key -> 实测速度（字节/秒）；-1 = 不可用；没有这个 key = 还在测 */
    private volatile java.util.Map<String, Long> probeBps = new java.util.HashMap<>();

    /*
      ═══════ 慢速建议 ═══════

      思路来自 komi-store 的 SlowDownloadDetector：它自己不做加速，而是
      **盯着速度，慢到一定程度就主动告诉用户「你该开镜像了」**。

      为什么 githup 也需要这一层：换道是**静默**的 —— 用户只看到进度条
      一直在爬，不知道软件已经在后台换了好几条通道，更不知道「其实可以
      自己挑一条」。加上这一层之后，慢到一定程度会明确提示一次。

      参数直接沿用 komi-store 的取值（它那套是调过的）：
        · 观察窗口 30 秒 —— 太短会把「刚建连」误判成慢
        · 慢的判据 < 100 KB/s
        · 10 分钟内累计 3 次才提醒 —— 偶尔卡一下不打扰
    */
    /** 慢速事件的统计窗口 */
    private static final long SLOW_WINDOW_MS = 10 * 60 * 1000L;
    /** 单次「慢」的观察窗口（要持续这么久才算数） */
    private static final long SLOW_SUSTAINED_MS = 30 * 1000L;
    /** 低于这个速度算慢 */
    private static final long SLOW_THRESHOLD_BPS = 100 * 1024L;
    /** 窗口内累计几次才提醒 */
    private static final int SLOW_TRIGGER = 3;
    /** 提醒过一次之后的静默时长，避免反复弹 */
    private static final long SLOW_SNOOZE_MS = 10 * 60 * 1000L;

    /** 速度采样点 {时刻, 累计字节}，用于算 30 秒窗口内的平均速度 */
    private final java.util.ArrayDeque<long[]> slowSamples = new java.util.ArrayDeque<>();
    /** 每一次判定为「慢」的时刻 */
    private final java.util.ArrayDeque<Long> slowEvents = new java.util.ArrayDeque<>();
    private long slowSnoozeUntil = 0;

    /**
     * 喂一个速度采样点。
     *
     * 只在**已有数据进账**之后才喂（建连期一个字节都没有，那不是慢）。
     * 窗口攒够 30 秒就算一次平均速度，低于阈值记一次慢事件。
     */
    private void noteSlowSample(long now, long sofar, long speed) {
        slowSamples.addLast(new long[]{now, sofar});
        while (!slowSamples.isEmpty() && slowSamples.peekFirst()[0] < now - SLOW_SUSTAINED_MS) {
            slowSamples.pollFirst();
        }
        if (slowSamples.size() < 2) return;
        long[] a = slowSamples.peekFirst();
        long[] b = slowSamples.peekLast();
        long span = b[0] - a[0];
        if (span < SLOW_SUSTAINED_MS - 500) return;      /* 窗口还没攒满 */
        long dB = b[1] - a[1];
        if (dB < 0) dB = 0;
        long avg = dB * 1000L / (span <= 0 ? 1 : span);
        if (avg < SLOW_THRESHOLD_BPS) recordSlowEvent(now);
    }

    /** 记一次「慢」，够次数就提醒 */
    private void recordSlowEvent(long now) {
        slowEvents.addLast(now);
        while (!slowEvents.isEmpty() && slowEvents.peekFirst() < now - SLOW_WINDOW_MS) {
            slowEvents.pollFirst();
        }
        if (slowEvents.size() < SLOW_TRIGGER) return;
        slowEvents.clear();
        fireSlowAdvice(now);
    }

    /**
     * 真的提醒一次。
     *
     * 三道闸，缺一个都会变成骚扰：
     *   1) 用户点过「不再提示」 —— 永久不问（存盘）
     *   2) 刚提醒过 —— 静默 10 分钟
     *   3) 用户**已经手动指定过通道** —— 他自己挑过了，再说就是废话
     *      （这一条对应 komi-store 里「已经开了镜像就不再建议」）
     */
    private void fireSlowAdvice(long now) {
        try {
            android.content.SharedPreferences sp =
                    activity.getSharedPreferences(PREF_DL, Context.MODE_PRIVATE);
            if (sp.getBoolean(KEY_ADVICE_OFF, false)) return;
            if (now < slowSnoozeUntil) return;
            String pref = readPreferredChannel();
            if (pref != null && !pref.isEmpty() && !"auto".equals(pref)) return;
            slowSnoozeUntil = now + SLOW_SNOOZE_MS;
            runJs("(function(){try{window.DlAdvice && window.DlAdvice.show();}catch(e){}})()");
        } catch (Throwable ignored) { }
    }

    /** 用户点了「不再提示」 */
    @JavascriptInterface
    public void dismissSlowAdvice() {
        try {
            activity.getSharedPreferences(PREF_DL, Context.MODE_PRIVATE)
                    .edit().putBoolean(KEY_ADVICE_OFF, true).apply();
        } catch (Throwable ignored) { }
    }

    /** 用户指定的通道 key；空 = 自动（按 MIRRORS 固定顺序） */
    private String readPreferredChannel() {
        try {
            return activity.getSharedPreferences(PREF_DL, Context.MODE_PRIVATE)
                    .getString(KEY_CH_PREF, "");
        } catch (Throwable t) {
            return "";
        }
    }

    private void savePreferredChannel(String key) {
        try {
            activity.getSharedPreferences(PREF_DL, Context.MODE_PRIVATE)
                    .edit().putString(KEY_CH_PREF, key == null ? "" : key).apply();
        } catch (Throwable ignored) { }
    }

    /** 当前选中的通道 key（前端用来打勾）；空串 = 自动 */
    @JavascriptInterface
    public String getChannel() {
        return readPreferredChannel();
    }

    /**
     * 选定通道。
     *
     * key = "auto"：自动 —— 取当前测速结果里最快的那条；还没测过就清空，
     * 走默认的固定顺序。
     * key = 某条通道（如 "https://ghfast.top/" 或 "direct"）：锁定它。
     */
    @JavascriptInterface
    public void setChannel(String key) {
        if (key == null) key = "";
        /*
          自动模式存的就是 "auto" 这个**模式**，不是当时最快的那条通道。

          以前是把当时最快的那条锁死写进 prefs —— 那不叫自动，那叫
          「在某一瞬间自动了一次」，之后速度怎么变都跟它无关了。
          存 "auto" 之后，每次发车都重新去查当前最快的那条，
          实时数据变了，起步通道跟着变。
        */
        savePreferredChannel(key);
    }

    /** 已知测速结果里最快的那条；没有新鲜结果返回 null */
    private String fastestKnownChannel() {
        return fastestKnownChannel(-1);
    }

    /**
     * 已知测速结果里最快的那条。
     *
     * @param maxAgeMs 允许的最大数据年龄；<0 表示用默认新鲜度（PROBE_FRESH_MS）
     * @return 最快的通道 key；没有结果 / 数据过期 返回 null
     */
    private String fastestKnownChannel(long maxAgeMs) {
        long budget = maxAgeMs < 0 ? PROBE_FRESH_MS : maxAgeMs;
        long at = probeAt;
        if (at <= 0) return null;                                  // 从没测过
        if (System.currentTimeMillis() - at > budget) return null;  // 数据过期
        String best = null;
        long bv = 0;
        synchronized (probeLock) {
            for (java.util.Map.Entry<String, Long> e : probeBps.entrySet()) {
                Long v = e.getValue();
                if (v == null || v <= 0) continue;
                if (v > bv) { bv = v; best = e.getKey(); }
            }
        }
        return best;
    }

    /* ═══════════ 预热：让面板一打开就有数字 ═══════════
     *
     * 原先只在用户点开面板时才起测，于是总要「测量中…」等几秒。
     * 改成后台提前测好：结果落盘，面板打开时先显示上次成绩，
     * 同时在后台刷新一轮 —— 数字立刻可见，且是新鲜的。
     */

    /** 预热结果的有效期：超过就重新测 */
    private static final long PROBE_TTL_MS = 10 * 60 * 1000L;
    /** 上次预热完成的时间戳 */
    private static final String SP_PROBE_AT = "probe_at";
    /** 上次预热结果："key:bps|key:bps" */
    private static final String SP_PROBE_VAL = "probe_val";

    /** 启动时调用：有缓存且还新鲜就直接用，否则后台静默测一轮 */
    void warmupChannelProbe() {
        long at = 0;
        try {
            at = activity.getSharedPreferences(PREF_DL, Context.MODE_PRIVATE)
                    .getLong(SP_PROBE_AT, 0);
        } catch (Throwable ignored) { }
        if (System.currentTimeMillis() - at < PROBE_TTL_MS) {
            loadCachedProbe();          // 有新鲜缓存，直接用
            return;
        }
        /* 有正在下载的任务就不凑热闹 —— 别跟用户抢带宽 */
        if (!downloads.isEmpty()) return;
        /*
          后台预热只跑**一轮**，不进持续模式 —— 那时面板没开，没必要
          一直跑；跑一轮把成绩存下来，用户下次打开面板就能立刻看到数字。
        */
        synchronized (probeLock) { probing = false; }
        runProbeRound();
    }

    private void loadCachedProbe() {
        try {
            android.content.SharedPreferences sp =
                    activity.getSharedPreferences(PREF_DL, Context.MODE_PRIVATE);
            String raw = sp.getString(SP_PROBE_VAL, "");
            if (raw == null || raw.isEmpty()) return;
            java.util.Map<String, Long> m = new java.util.HashMap<>();
            for (String seg : raw.split("\\|")) {
                if (seg.isEmpty()) continue;
                int c = seg.lastIndexOf(':');
                if (c <= 0) continue;
                try {
                    m.put(seg.substring(0, c), Long.parseLong(seg.substring(c + 1)));
                } catch (NumberFormatException ignored) { }
            }
            if (!m.isEmpty()) {
                synchronized (probeLock) { probeBps = m; }
                /* 缓存里的时间戳也恢复，否则进程重启后自动选择会以为没数据 */
                probeAt = sp.getLong(SP_PROBE_AT, 0);
            }
        } catch (Throwable ignored) { }
    }

    private void saveCachedProbe() {
        try {
            StringBuilder sb = new StringBuilder();
            synchronized (probeLock) {
                boolean first = true;
                for (java.util.Map.Entry<String, Long> e : probeBps.entrySet()) {
                    if (first) first = false; else sb.append('|');
                    sb.append(e.getKey()).append(':').append(e.getValue());
                }
            }
            activity.getSharedPreferences(PREF_DL, Context.MODE_PRIVATE)
                    .edit()
                    .putString(SP_PROBE_VAL, sb.toString())
                    .putLong(SP_PROBE_AT, System.currentTimeMillis())
                    .apply();
        } catch (Throwable ignored) { }
    }

    /**
     * 开启**持续**测速：跑完一轮自动接着跑下一轮，速度数字一直在跳。
     *
     * 用户要的是「实时数据」—— 面板开着就一直在测，能看到各通道此刻的
     * 快慢，而不是测一次定终身。所以这里不是测完即止，而是循环。
     *
     * 必须调 stopChannelProbe() 收摊，否则面板关了线程还在跑（费电、费流量）。
     */
    @JavascriptInterface
    public void startChannelProbe() {
        synchronized (probeLock) {
            probing = true;
            /* 用户主动打开面板：清空休眠，给所有通道一次机会。
               冷却只是为了避免死链拖慢轮询，不该拦着用户主动测。 */
            probeCool.clear();
            probeFails.clear();
            /*
              ⚠️ 这里**不要清空** probeBps。

              清空的话每轮一开始所有通道都变回「测量中」，界面整片闪一下
              再逐个出数字 —— 看着像卡了，也不是「实时」该有的样子。
              保留上一轮的值，新结果回来时逐个替换，数字直接跳变，
              这才是持续刷新。只有第一次打开（本来就没值）才会显示
              「测量中」。
            */
        }
        runProbeRound();
    }

    /** 停止持续测速。面板关闭时必须调 */
    @JavascriptInterface
    public void stopChannelProbe() {
        synchronized (probeLock) {
            probing = false;
        }
        saveCachedProbe();
    }

    /** 跑一轮：11 条通道并发，全部回来后如果还在「持续」就自动接下一轮 */
    private void runProbeRound() {
        final java.util.List<String> keys = new java.util.ArrayList<>();
        for (String m : DownloadChannels.MIRRORS) keys.add(m);
        keys.add(DownloadChannels.DIRECT);
        final java.util.concurrent.atomic.AtomicInteger left =
                new java.util.concurrent.atomic.AtomicInteger(keys.size());
        for (final String k : keys) {
            probePool.execute(new Runnable() {
                @Override public void run() {
                    /*
                      ⚠️ measureChannel() 必须在锁**外**跑。

                      它一次要花几秒（连接 + 读 2 秒窗口）。如果握着
                      probeLock 去调它，24 条通道就得一条一条排队 ——
                      并发线程池形同虚设，一轮要跑好几分钟。
                      只在更新结果那一小段加锁。
                    */
                    boolean sleep = false;
                    synchronized (probeLock) {
                        Integer cool = probeCool.get(k);
                        if (cool != null && cool > 0) {
                            /* 休眠中：直接判不可用，不发起连接。
                               省下的正是「等一个死链超时」的那几秒。 */
                            probeCool.put(k, cool - 1);
                            sleep = true;
                        }
                    }
                    long bps = sleep ? -1 : measureChannel(k);
                    synchronized (probeLock) {
                        if (!sleep) {
                            if (bps < 0) {
                                int f = (probeFails.get(k) == null ? 0 : probeFails.get(k)) + 1;
                                probeFails.put(k, f);
                                if (f >= PROBE_FAIL_MAX) {
                                    probeCool.put(k, PROBE_COOL_ROUNDS);
                                    probeFails.put(k, 0);
                                }
                            } else {
                                probeFails.put(k, 0);   // 活了就清零
                            }
                        }
                        probeBps.put(k, bps);
                    }
                    /* 全部跑完才落盘：写一半的结果没意义，而且下次读进来
                       会缺几条，面板上就又出现「测量中」。 */
                    if (left.decrementAndGet() != 0) return;
                    /* 整轮跑完，这批数据才算「新鲜」，可以拿去做自动选择 */
                    probeAt = System.currentTimeMillis();
                    saveCachedProbe();
                    boolean goon;
                    synchronized (probeLock) { goon = probing; }
                    if (!goon) return;
                    /* 两轮之间喘口气：既避免把镜像打得太狠（都是免费服务），
                       也让用户有时间看清上一轮的数字。 */
                    probeHandler.postDelayed(new Runnable() {
                        @Override public void run() {
                            boolean goon2;
                            synchronized (probeLock) { goon2 = probing; }
                            if (goon2) runProbeRound();
                        }
                    }, PROBE_GAP_MS);
                }
            });
        }
    }

    /** 测一条通道：连上、读一小段，用耗时算吞吐。失败/超时返回 -1 */
    private long measureChannel(String key) {
        String url;
        if (DownloadChannels.DIRECT.equals(key)) {
            url = PROBE_TARGET;
        } else if (DownloadChannels.isTemplated(key)) {
            /*
              云速（jsdelivr）只代理仓库文件，拿 Release 附件去测必然 404。
              必须换一个 raw 类目标，否则面板上它会永远显示「不可用」——
              而实际上它是最快的那条（CI 实测 155MB/s）。
            */
            url = DownloadChannels.templatedUrl(PROBE_TARGET_RAW);
            if (url == null) return -1;
        } else {
            url = key + PROBE_TARGET;
        }
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod("GET");
            c.setInstanceFollowRedirects(true);
            c.setConnectTimeout(PROBE_BUDGET_MS);
            c.setReadTimeout(PROBE_BUDGET_MS);
            c.setRequestProperty("User-Agent", "githup");
            /* 只要前几十 KB 就能算出吞吐，没必要把整个文件拉完 ——
               顺带避免「测个速度反而吃掉用户几十 MB 流量」 */
            c.setRequestProperty("Range", "bytes=0-" + (PROBE_MAX_BYTES - 1));
            int code = c.getResponseCode();
            /* 206 = 服务端支持断点续传（我们主动要了 Range），这是正常且更快的；
               200 = 不支持 Range，直接从头读也一样算。两者都算通。 */
            if (code != 200 && code != 206 && (code < 200 || code >= 400)) return -1;
            InputStream in = null;
            byte[] buf = new byte[16 * 1024];
            long got = 0;
            long firstByteAt = 0;
            long last = 0;
            try {
                in = c.getInputStream();
                int n;
                /*
                  ⚠️ 计时的起点必须是**首字节到达**，不是「发起请求」。

                  这里踩过一个坑：上一版把 t0 取在 getResponseCode() 之前，
                  deadline = t0 + 3 秒。但 getResponseCode() 要完成 DNS、
                  TLS 握手、等响应头 —— 第三方镜像是跨国代理，光这一步
                  常常就要 2~4 秒。等它返回时 3 秒窗口已经用光，循环一次
                  都不执行，got 恒为 0，于是**所有通道**一律被判成
                  「不可用」。本来能用的加速 3 也跟着挂了。

                  连接慢 ≠ 通道死。所以：
                    · 连接 / 等响应头的耗时**不计入**速度窗口
                    · 首字节迟迟不来（超过 read timeout）才算真不通，
                      由 SocketTimeoutException 兜住
                    · 窗口从首字节起算，这段才真正反映吞吐
                */
                while (got < PROBE_MAX_BYTES && (n = in.read(buf)) > 0) {
                    long now = android.os.SystemClock.elapsedRealtime();
                    if (got == 0) {
                        firstByteAt = now;                      // 首字节到达，开始计窗口
                    } else if (now - firstByteAt >= PROBE_WINDOW_MS) {
                        break;                                  // 窗口到了，收
                    }
                    got += n;
                    last = now;
                }
            } finally {
                if (in != null) { try { in.close(); } catch (Throwable ignored) { } }
            }
            /* 一个字节都没读到 = 这条通道根本没在送数据，才算真不可用 */
            if (got <= 0) return -1;
            /*
              正常情况 dt 会接近 3 秒（读满窗口）。只有流提前结束时 dt 才小。
              给个 200ms 的下限：只捞到一两包就结束的话，直接除会算出
              天文数字（16KB / 1ms = 16MB/s），那不是真实速度。
            */
            /*
              ⚠️ 下限 200ms + 上限 512KB，天花板只有 512KB/0.2s ≈ 2.6MB/s。

              快通道几十毫秒就把 512KB 读完了，dt 被硬拉到 200ms，
              算出来一律是 2.5 MB/s —— 面板上所有能用的通道都显示同一个
              数字，用户根本分不出哪条更快，「测速」就白测了。

              所以样本放大到 1MB、下限收到 100ms：天花板抬到约 10MB/s，
              快通道之间就能拉开差距。慢通道读不满 1MB 也不会多耗流量
              —— 窗口到了就收，不是非得读满。
            */
            long dt = last - firstByteAt;
            if (dt < 100) dt = 100;
            return got * 1000L / dt;
        } catch (Throwable t) {
            return -1;
        } finally {
            if (c != null) { try { c.disconnect(); } catch (Throwable ignored) { } }
        }
    }

    /**
     * 通道列表 + 各自的实时速度。
     *
     * state: pending（还在测）/ ok / fail
     */
    @JavascriptInterface
    public String channelProbe() {
        org.json.JSONArray out = new org.json.JSONArray();
        synchronized (probeLock) {
            int i = 0;
            for (String m : DownloadChannels.MIRRORS) {
                i++;
                /* 第二组是未经实测的候选，界面上标注出来 —— 用户看到
                   「候选」就知道这条可能压根用不了，别误以为软件坏了。 */
                boolean verified = i <= DownloadChannels.VERIFIED_COUNT;
                /* 名字统一走 channelLabel：第 1 条叫「云析通道」、第 2 条
                 * 「云速通道」，其后「加速1」「加速2」…。i 从 1 起，减 1 换下标。 */
                out.put(channelItem(m, DownloadChannels.channelLabel(i - 1), hostOf(m),
                        probeBps.get(m), verified));
            }
            out.put(channelItem(DownloadChannels.DIRECT, "直连", "github.com",
                    probeBps.get(DownloadChannels.DIRECT), true));
        }
        return out.toString();
    }

    private static org.json.JSONObject channelItem(String key, String name,
                                                   String host, Long bps,
                                                   boolean verified) {
        org.json.JSONObject o = new org.json.JSONObject();
        try {
            o.put("key", key);
            o.put("name", name);
            o.put("host", host);
            o.put("verified", verified);
            /* 适用范围（云速 = 「仅仓库文件」），前端原样显示 */
            String sc = DownloadChannels.scopeOf(key);
            if (sc != null && !sc.isEmpty()) o.put("scope", sc);
            if (bps == null) {
                o.put("state", "pending");
                o.put("bps", 0);
            } else if (bps < 0) {
                o.put("state", "fail");
                o.put("bps", 0);
            } else {
                o.put("state", "ok");
                o.put("bps", bps.longValue());
            }
        } catch (Throwable ignored) { }
        return o;
    }

    /** "https://ghfast.top/" -> "ghfast.top" */
    private static String hostOf(String mirrorPrefix) {
        try {
            String h = mirrorPrefix;
            int i = h.indexOf("://");
            if (i >= 0) h = h.substring(i + 3);
            while (h.endsWith("/")) h = h.substring(0, h.length() - 1);
            return h;
        } catch (Throwable t) {
            return mirrorPrefix;
        }
    }

    /**
     * 生成候选下载地址。具体规则（哪些域名可加速、带令牌必须直连）
     * 都在 DownloadChannels 里，那边是纯逻辑、能单测。
     *
     * 用户手动挑过通道的话，把那条顶到最前 —— 这是「客户选择哪个就走
     * 哪个通道」的落点。没挑过（自动）就保持固定顺序。
     */
    private List<String> candidateUrls(String url, boolean allowMirror) {
        List<String> c = DownloadChannels.candidates(url, allowMirror);
        String pref = readPreferredChannel();
        if (pref == null || pref.isEmpty() || c.size() <= 1) return c;

        /*
          自动模式：**每次发车都重新查**当前最快的那条。

          这里就是「实时选择」的落点 —— 存的不是某条通道，而是 "auto"
          这个意图，所以实时数据变了，起步通道跟着变，不需要用户再点一次。

          查不到新鲜数据（从没测过 / 结果过期）就退回固定顺序，
          剩下的交给换道机制：走错了也会被 switchChannel 换掉。
        */
        final boolean isAuto = "auto".equals(pref);
        if (isAuto) {
            String best = fastestKnownChannel();
            if (best == null) return c;
            pref = best;
        }

        /*
          ⚠️ 手动挑的通道可能**压根进不了候选链**。

          云速（jsdelivr）只代理仓库文件，下载 Release 附件时 buildUrl
          返回 null，candidates() 直接把它剔掉了。于是下面的循环一条都
          匹配不上，什么都不做 —— 候选链保持原样，下载照常成功。

          结果就是用户看到的怪事：明明选了云速、面板上它还标着「不可用」，
          东西却下载下来了。**因为压根没走它**。以前这里静默跳过，用户
          只能自己猜。现在说明白：它适用于哪类文件、这次实际走了哪条。
        */
        if (!isAuto && !c.isEmpty()) {
            boolean hit = false;
            for (String u : c) {
                if (pref.equals(DownloadChannels.channelKey(u))) { hit = true; break; }
            }
            if (!hit) {
                final String why = DownloadChannels.isTemplated(pref)
                        ? "（这条只代理仓库里的文件，Release 附件用不上）"
                        : "";
                int ri = indexOfKey(c.get(0));
                final String real = ri < 0 ? "直连"
                        : DownloadChannels.channelLabel(ri);
                activity.runOnUiThread(() -> Toast.makeText(activity,
                        "已选通道不适用于这个文件" + why + "，本次改用" + real,
                        Toast.LENGTH_LONG).show());
                return c;
            }
        }

        for (int i = 0; i < c.size(); i++) {
            if (pref.equals(DownloadChannels.channelKey(c.get(i)))) {
                String hit = c.remove(i);
                c.add(0, hit);
                break;
            }
        }
        return c;
    }

    /**
     * 候选链第一条在 MIRRORS 里的下标（用来取名字）；直连返回 -1。
     *
     * 注意传进来的已经是**拼好的**地址（mirror + 原 URL），所以只能拿
     * host 反查 —— 再用 buildUrl 正推会拼成「前缀 + 前缀 + 原地址」，
     * 一条都匹配不上。
     */
    private static int indexOfKey(String builtUrl) {
        String h = hostOf(builtUrl);
        if (h == null || h.isEmpty()) return -1;
        for (int i = 0; i < DownloadChannels.MIRRORS.length; i++) {
            if (h.equals(hostOf(DownloadChannels.MIRRORS[i]))) return i;
        }
        return -1;
    }

    /**
     * 正在进行的下载任务（JSON 数组），给前端的进度条轮询。
     *
     * 终态（成功/失败）的任务**绝不返回** —— 以前广播偶尔丢一次（App 在后台
     * 被杀），完成的任务就赖在表里，前端进度条每 800ms 弹一次「100%」，
     * 用户看到的就是「下载完了还不停地弹」。现在查到终态就地收尾，前端永远
     * 只会看到「正在进行」的。
     */
    @JavascriptInterface
    public String downloadStatus() {
        try {
            DownloadManager dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) return "[]";
            org.json.JSONArray arr = new org.json.JSONArray();
            final java.util.List<Long> ended = new ArrayList<>();
            for (Map.Entry<Long, DlTask> e : downloads.entrySet()) {
                android.database.Cursor c = null;
                try {
                    c = dm.query(new DownloadManager.Query().setFilterById(e.getKey()));
                    if (c == null || !c.moveToFirst()) continue;
                    int si = c.getColumnIndex(DownloadManager.COLUMN_STATUS);
                    int bi = c.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR);
                    int ti = c.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES);
                    int st = si < 0 ? 0 : c.getInt(si);
                    if (st == DownloadManager.STATUS_SUCCESSFUL
                            || st == DownloadManager.STATUS_FAILED) {
                        ended.add(e.getKey());
                        continue;
                    }
                    DlTask t = e.getValue();
                    JSONObject o = new JSONObject();
                    o.put("id", e.getKey());
                    o.put("name", t.filename);
                    o.put("ch", t.channel());
                    o.put("status", st);
                    o.put("sofar", bi < 0 ? 0 : c.getLong(bi));
                    o.put("total", ti < 0 ? -1 : c.getLong(ti));
                    arr.put(o);
                } catch (Throwable ignored) {
                } finally {
                    if (c != null) c.close();
                }
            }
            /* 收尾要在主线程做（里面会弹 Toast / 拉安装器） */
            if (!ended.isEmpty()) {
                activity.runOnUiThread(() -> {
                    for (long id : ended) finishDownload(id);
                });
            }

            /* ── 把限速任务也报上去 ──
             *
             * 它们不在 DownloadManager 里，不补这一段的话，用户在下载管理页
             * 看不到任何进度：点了下载，界面静悄悄，过一会儿文件忽然出现。
             *
             * status 固定给 1（对应前端的「进行中」）—— 限速任务是死是活由
             * 这边的 running 标志说话，不适用 DownloadManager 那套状态码。
             */
            for (Map.Entry<Long, TlTask> e : throttledTasks.entrySet()) {
                TlTask t = e.getValue();
                if (!t.running) continue;
                JSONObject o = new JSONObject();
                o.put("id", e.getKey());
                o.put("name", t.filename);
                o.put("ch", "限速");
                o.put("status", 1);
                o.put("sofar", t.done);
                o.put("total", t.total);
                o.put("speed", t.bps);
                arr.put(o);
            }

            return arr.toString();
        } catch (Throwable t) {
            return "[]";
        }
    }

    /**
     * 校验下载下来的 APK 该不该装。
     *
     *  1) **SHA-256** —— 调用方给了期望值就比对，确保装的是
     *     清单里写明的那一份，而不是「版本不对 / 被换掉」的包。
     *
     *  （本库是未加固版本：官方签名证书那道校验依赖 githup 才有的
     *   SignCheck / 防护链，这里不做。）
     *
     * 读文件的顺序很关键：**先问 DownloadManager 要地址**，再退回传进来的
     * content:// 地址。以前只走后者，而后者内部是自己拼公共目录路径 ——
     * Android 10+ 分区存储下读不到文件，于是抛 FileNotFoundException，
     * 用户看到「已阻止安装：校验失败：FileNotFoundException」，
     * 而那个包其实是完好的。
     *
     * @param downloadId DownloadManager 的下载 id，用它拿权威地址
     * @param fallback   兜底地址（content:// 形式的 DownloadProvider）
     * @return null 表示可以装；非 null 是拒绝原因（直接展示给用户）
     */
    private String verifySha(long downloadId, Uri fallback, String expected) {
        // --- SHA-256：给了期望值就必须对上 ---
        if (expected == null || expected.trim().isEmpty()) return null;

        Uri src = localUriOf(downloadId);
        if (src == null) src = fallback;

        InputStream in = null;
        Throwable first = null;
        try {
            in = activity.getContentResolver().openInputStream(src);
            /* DownloadManager 给的地址在某些 ROM 上可能打不开，再退兜底地址试一次 */
            if (in == null && fallback != null && !fallback.equals(src)) {
                in = activity.getContentResolver().openInputStream(fallback);
            }
            if (in == null) {
                /* 别把它说成「可能被篡改」—— 校验压根没跑起来，
                 * 两件事完全不同，前者会让人以为是被人动了手脚。 */
                return "读不到下载好的文件（可能已被清理，也可能是系统限制）";
            }
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            byte[] d = md.digest();
            StringBuilder sb = new StringBuilder(d.length * 2);
            for (byte b : d) sb.append(String.format("%02x", b & 0xff));
            if (sb.toString().equalsIgnoreCase(expected.trim())) return null;
            return "校验和不一致（安装包可能被篡改）";
        } catch (Throwable t) {
            first = t;
            return "读不到下载好的文件：" + t.getClass().getSimpleName();
        } finally {
            if (in != null) try { in.close(); } catch (Throwable ignored) { }
            if (first != null) {
                android.util.Log.w("githup", "安装前校验失败", first);
            }
        }
    }

    /**
     * APK 下载完成后弹出安装界面。
     *
     * 用户在 Actions 里下载的构建产物、或在 Release 里下载的 APK，下载完
     * 如果只是躺在通知栏会很不方便 —— 这里直接拉起安装。
     * Android 8.0+ 要求声明 REQUEST_INSTALL_PACKAGES 权限，否则会被系统拦截。
     */
    /** 完成广播的注册开关：**只许注册一次**。
     * 以前每次建 JsBridge（每次进主界面）都注册一遍，同一个完成广播就触发
     * N 遍 —— 安装弹窗、「已保存」提示连着弹好几次，用户以为出了鬼。 */
    private static final java.util.concurrent.atomic.AtomicBoolean RX_DONE =
            new java.util.concurrent.atomic.AtomicBoolean(false);

    private void watchDownloads() {
        if (!RX_DONE.compareAndSet(false, true)) return;
        try {
            android.content.IntentFilter f =
                    new android.content.IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
            android.content.BroadcastReceiver r = new android.content.BroadcastReceiver() {
                @Override
                public void onReceive(Context ctx, Intent intent) {
                    long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                    if (id > 0) finishDownload(id);
                }
            };
            activity.getApplicationContext().registerReceiver(r, f);
        } catch (Throwable t) {
            RX_DONE.set(false);   // 没注册上就放开，下次再试
        }
    }

    /**
     * 下载收尾的**唯一入口**：完成广播、进度轮询、任务监控三处都汇到这里。
     *
     * `downloads.remove(id)` 的原子性保证一个任务只会被收尾一次 ——
     * 以前广播和轮询各管各的：广播一旦没送到（App 在后台被杀再回来），
     * 完成的任务就永远躺在表里，App 内进度条每 800ms 弹一次「100%」，
     * 用户看到的就是「下载完了还不停地弹」。
     */
    /**
     * 这条通道是不是「还没怎么努力就放弃了」。
     *
     * 判定：从发车到现在不到 QUIET_FAIL_MS。这种情况基本都是服务端**明确拒绝**
     * （404 / 403 —— 最典型的就是镜像拿不到私有附件），不是网络不好。
     * 用户什么都没感觉到，默默换下一条即可；只有「熬了一会儿才死」的通道
     * 才值得说一句，否则用户会以为卡住了。
     */
    private static boolean isQuickGiveUp(DlTask t) {
        return System.currentTimeMillis() - t.startedAt < QUIET_FAIL_MS;
    }

    /**
     * 多久之内失败算「秒错」（静默换道，不弹提示）。
     *
     * 取 8 秒：一条真正在建连、正握手的通道，从发车到报错通常也就两三秒，
     * 8 秒足够把「对方干净利落地拒绝」都收进来；反过来，熬过 8 秒才失败的
     * 多半是慢速拖死的，用户已经在盯着进度条了，那就要告诉他一声。
     */
    private static final long QUIET_FAIL_MS = 8_000;

    /**
     * 续传的最小 worthwhile 字节数。
     *
     * 只拿到几十 KB 就换道的话，续传省下的时间和一次探测请求的开销差不多，
     * 还多一层出错的可能 —— 不如干净地重来。
     */
    /**
     * 接管续传的最低字节数。
     *
     * ═══ 为什么从 128KB 降到 32KB ═══
     *
     * 这个门槛和「换道时机」是打架的：
     *
     *   换道是因为**慢**（连续两轮低于 15KB/s）才换 —— 慢就意味着下得少。
     *   宽限 3 秒 + 两轮 1.5 秒 ≈ 6 秒，按临界 15KB/s 算也就 90KB，
     *   **根本到不了 128KB**。于是每次换道都因为「字节不够」放弃续传、
     *   整份重下 —— 用户看到的就是「换个通道，进度条回到 0，白等半天」。
     *
     *   换句话说：门槛定得越高，越是只有「下得快」的通道才能续传，
     *   而真正需要续传的恰恰是那些下得慢的。
     *
     * 32KB 的理由：低于这个量级，省下的时间还不如一次连接的建立开销；
     * 高于它就开始有净收益。换道场景下这个量级是够得着的。
     */
    private static final long RESUME_MIN_BYTES = 32 * 1024;
    /**
     * 接管连续失败几次才放弃续传（见 switchChannel）。
     *
     * 为什么不是失败一次就放弃：读不到 DownloadManager 的半成品常常只是
     * 「这一次没读到」，判成终身的话后面每次换道都必然整份重下。
     */
    private static final int RESUME_FAIL_LIMIT = 3;
    /**
     * 进度保护：已经下了这么多字节之后，**仅仅因为「慢」就不再换道**。
     *
     * ═══ 为什么 ═══
     *
     * 换道必然要换 URL，而 DownloadManager 换 URL 就没法续传（每次
     * enqueue 都是独立任务、写进独立文件）。接管半成品这条路又不一定
     * 读得到（见 copyPrefixToPart）。所以换道的真实代价是：
     * **已经下好的那部分可能全部作废，进度归零。**

     * 已经下了 1MB 说明通道是通的，只是慢。这时候继续等，大概率比
     * 「扔掉 1MB 从头再来」更快 —— 尤其新通道未必更好。

     * 完全停滞（一个字节都不来）和连接超时不受这条限制：那种情况下
     * 已下载量往往很小，且等下去没有意义。
     */
    private static final long KEEP_GOING_BYTES = 1024L * 1024L;
    /**
     * 但也不能因为「已经下了不少」就永远死等：速度低到这个程度
     * （MIN_SPEED_BPS 的四分之一）说明通道基本废了，重来比干等划算。
     */
    private static final long GIVE_UP_SPEED_BPS = MIN_SPEED_BPS / 4;

    /* 换道预检的探测超时常量已删 —— 那次探测本身已经去掉，
       见 switchChannel 里的说明（省掉一整次往返）。 */

    /**
     * 读磁盘上这个文件的真实大小（字节），读不到返回 -1。
     *
     * Android 10+ 走 MediaStore：分区存储下 App 自己按路径 stat 会被拒，
     * 而 DownloadManager 落盘的文件就是在公共 Downloads 里，MediaStore
     * 查得到。Android 9 及以下直接看文件。
     */
    private long downloadedFileSize(String name, String category) {
        if (name == null || name.isEmpty()) return -1;
        try {
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                String rel = "Download/" + DOWNLOAD_SUBDIR
                        + (category == null || category.isEmpty() ? "" : "/" + safeCategory(category));
                /* 有的 ROM 存相对路径时带尾斜杠、有的不带，两种都试 */
                String[] rels = { rel + "/", rel };
                for (String r : rels) {
                    android.database.Cursor c = null;
                    try {
                        c = activity.getContentResolver().query(
                                android.provider.MediaStore.Downloads.getContentUri(
                                        android.provider.MediaStore.VOLUME_EXTERNAL),
                                new String[]{ android.provider.MediaStore.MediaColumns.SIZE },
                                android.provider.MediaStore.MediaColumns.DISPLAY_NAME + "=? AND "
                                        + android.provider.MediaStore.MediaColumns.RELATIVE_PATH + "=?",
                                new String[]{ name, r }, null);
                        if (c != null && c.moveToFirst()) {
                            int i = c.getColumnIndex(android.provider.MediaStore.MediaColumns.SIZE);
                            return i >= 0 ? c.getLong(i) : -1;
                        }
                    } catch (Throwable ignored) {
                    } finally {
                        if (c != null) { try { c.close(); } catch (Throwable ignored) { } }
                    }
                }
                return -1;
            }
            File dir = publicDownloadDir(category);
            if (dir == null) return -1;
            File f = new File(dir, name);
            return f.exists() ? f.length() : -1;
        } catch (Throwable ignored) {
            return -1;
        }
    }

    private void finishDownload(final long id) {
        final DlTask t = downloads.remove(id);
        if (t == null) return;          // 已经被别的入口收尾过了
        final boolean inst = autoInstalls.remove(id);
        final String exp = expectedShas.remove(id);
        DownloadManager dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) return;
        long bytes = 0;
        boolean ok = false;
        android.database.Cursor c = null;
        try {
            c = dm.query(new DownloadManager.Query().setFilterById(id));
            if (c != null && c.moveToFirst()) {
                int si = c.getColumnIndex(DownloadManager.COLUMN_STATUS);
                int bi = c.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR);
                ok = si >= 0 && c.getInt(si) == DownloadManager.STATUS_SUCCESSFUL;
                if (bi >= 0) bytes = c.getLong(bi);
            }
        } catch (Throwable ignored) {
        } finally {
            if (c != null) c.close();
        }
        if (!ok) {
            /* 失败：还有备选通道就再试一次，全部试完才落历史 */
            switchChannel(t, "下载失败", bytes, isQuickGiveUp(t));
            return;
        }
        /*
          续传时 DownloadManager 报的 bytes 只是**这一段**的长度
          （它不知道之前已经有了多少）。所以判断「下全了没有」必须加上起点。
        */
        long totalBytes = t.resumeFrom + bytes;

        if (t.expectedBytes > 0 && totalBytes > 0 && totalBytes != t.expectedBytes) {
            /*
              大小对不上 —— 这不是「下载失败」那么明显，但同样不能用。
              最常见的成因是镜像返回了一段残缺的文件（下到一半断了却报了
              200），或者镜像把请求重定向到了一个 HTML 错误页。这种包
              装下去只会被校验拦下，不如直接换道重下。

              只在「差得离谱」时才换（见 SIZE_TOLERANCE）：服务端给的
              Content-Length 与 DownloadManager 的统计口径偶尔差几字节，
              卡死在完全相等会把好包也拦掉。
            */
            long diff = Math.abs(totalBytes - t.expectedBytes);
            if (diff > SIZE_TOLERANCE) {
                /* lambda 里用到的都必须是 final / effectively final，
                   所以 LOST 要在外面先取好 */
                final long got = bytes;
                final String ch = t.channel();
                final boolean quiet = isQuickGiveUp(t);
                /*
                  续传出来的大小不对：多半是这台机器的 DownloadManager 把
                  续传的内容写进了新文件（而不是追加到原来那个半截文件），
                  于是磁盘上要么只有尾巴、要么是两份叠在一起。

                  认栽：这个任务从此不续传，整份重下一次。
                  只认栽一次 —— 之后 noResume 一直为真，不会再白白多试。
                */
                if (t.resumeFrom > 0 && !t.noResume) {
                    t.noResume = true;
                    t.resumeFrom = 0;
                    activity.runOnUiThread(() -> switchChannel(t, "续传失败，重新下载", 0, true));
                    return;
                }
                activity.runOnUiThread(() -> switchChannel(t, "文件不完整（" + ch + "）", got, quiet));
                return;
            }
        }
        /*
          续传后的第二道校验：**看磁盘上真实的大小**。

          上面那道用的是 DownloadManager 报的数字，它只反映这一段；
          这里读的是文件的实际长度，能抓出「续传的内容没追加到原文件上」
          这种情况 —— 那是最容易得到坏包的一种失败。

          对不上就按上面同一套处理：认栽一次，之后整份重下。
        */
        if (t.resumeFrom > 0 && t.expectedBytes > 0) {
            long real = downloadedFileSize(t.savedName, t.category);
            if (real > 0 && Math.abs(real - t.expectedBytes) > SIZE_TOLERANCE) {
                if (!t.noResume) {
                    t.noResume = true;
                    t.resumeFrom = 0;
                    activity.runOnUiThread(() -> switchChannel(t, "续传失败，重新下载", 0, true));
                    return;
                }
                final long got2 = bytes;
                final String ch2 = t.channel();
                activity.runOnUiThread(() -> switchChannel(t, "文件不完整（" + ch2 + "）", got2, true));
                return;
            }
            if (real > 0) totalBytes = real;
        }
        final long size = totalBytes;
        activity.runOnUiThread(() -> {
            /*
              不再记录「上次哪条通道通了」。

              那套记忆会让**每一次**下载都被历史上某一次偶然的成功改写顺序 ——
              用户看到的就是「一上来就是加速 3」，而它此刻未必还快。
              去掉之后起步永远按 MIRRORS 的固定顺序（加速 1 优先），
              慢了照旧走 switchChannel 换道，行为可预期。
            */
            addHistory(t, true, size);
            boolean isApk = t.filename.toLowerCase().endsWith(".apk");
            if (!inst && !isApk) {
                /* 普通文件：下完告诉一声存哪了，省得去 Download 里翻 */
                /* 子目录要带上：文件按来源分目录存放（Download/githup/release/…），
                 * 提示里只说 githup/ 的话用户去根目录找不到，会以为下载丢了。 */
                String catNow = safeCategory(t.category);
                Toast.makeText(activity,
                        "已保存到 Download/" + DOWNLOAD_SUBDIR +
                                (catNow.isEmpty() ? "" : "/" + catNow) + "/" + t.filename,
                        Toast.LENGTH_SHORT).show();
                return;
            }
            installFinished(t, exp, inst);
        });
    }

    /** 成功后的安装环节：SHA 校验 →（ZIP 就解压装）→ 拉起安装器 */
    private void installFinished(DlTask t, String exp, boolean inst) {
        DownloadManager dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) return;
        android.database.Cursor c = null;
        try {
            c = dm.query(new DownloadManager.Query().setFilterById(t.id));
            if (c == null || !c.moveToFirst()) return;
            String name = t.filename;
            boolean isZip = name.toLowerCase().endsWith(".zip");

            /* 交给外部（安装器）的地址统一用 content://：
             * DownloadManager 给的 file:// 在 Android 7+ 会被静默拦掉。 */
            /* 带上 category（release / 议题）：文件按来源分目录存放，
             * 不带的话 openFile 会去根目录找，子目录里的包会
             * FileNotFoundException → 被误判成「校验失败」而拦下安装。 */
            Uri uri = DownloadProvider.uriFor(activity.getPackageName(), name, t.category);

            /* 校验读文件必须走 DownloadManager 自己的地址，不要手拼公共目录路径 ——
             * Android 10+ 分区存储下那条路径拿不到文件，会把完好的包误判成
             * 「校验失败：FileNotFoundException」而拦下安装。详见 DownloadProvider 注释。 */
            if (exp != null && !exp.isEmpty() && !isZip) {
                String bad = verifySha(t.id, uri, exp);
                if (bad != null) {
                    final String msg = bad;
                    /* 包被拦下了，等于没装成 —— 同样要撤回「正在装」 */
                    notifyUpdateAborted("verify-failed");
                    Toast.makeText(activity,
                            "已阻止安装：" + msg + "。请到下载管理里删除后重试。",
                            Toast.LENGTH_LONG).show();
                    return;
                }
            }
            if (inst && isZip) {
                pool.execute(() -> extractAndInstall(uri, name, t.originUrl));
            } else if (inst && name.toLowerCase().endsWith(".apk")) {
                /* 入账：加速通道下完给的是 content://，不是 File，
                   所以先落进 ApkProvider 目录（顺便就能读包名），
                   装的时候也用同一个地址。
                   入账失败不能影响安装 —— 落 null 就照原样装。 */
                File staged = null;
                try {
                    staged = AppLibrary.stageApk(activity, t.originUrl, uri, name);
                } catch (Throwable ignored) { }
                if (staged != null) {
                    openInstaller(ApkProvider.uriFor(
                            activity.getPackageName() + ApkProvider.AUTHORITY_SUFFIX,
                            staged.getName()));
                } else {
                    openInstaller(uri);
                }
            } else {
                openInstaller(uri);
            }
        } finally {
            if (c != null) c.close();
        }
    }

    /** 取某个已完成下载的真实可读地址；拿不到返回 null */
    private Uri localUriOf(long downloadId) {
        DownloadManager dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) return null;
        try {
            Uri u = dm.getUriForDownloadedFile(downloadId);
            if (u != null) return u;
        } catch (Throwable ignored) { }
        /* 官方 API 在个别 ROM 上会给 null，退回查 _data / local_uri 列 */
        android.database.Cursor c = null;
        try {
            c = dm.query(new DownloadManager.Query().setFilterById(downloadId));
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI);
                if (i >= 0) {
                    String s = c.getString(i);
                    if (s != null && !s.isEmpty()) return Uri.parse(s);
                }
            }
        } catch (Throwable ignored) {
        } finally {
            if (c != null) c.close();
        }
        return null;
    }

    /** 删除某个已完成下载产出的文件（走 DownloadManager 的地址，别拼路径） */
    private boolean deleteDownloadedFile(long downloadId, String name) {
        return deleteDownloadedFile(downloadId, name, "");
    }

    private boolean deleteDownloadedFile(long downloadId, String name, String sub) {
        boolean gone = false;
        DownloadManager dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm != null && downloadId > 0) {
            /* dm.remove 会把这条记录和它产出的文件一起清掉 */
            try { gone = dm.remove(downloadId) > 0; } catch (Throwable ignored) { }
        }
        /* 再按名字兜一次：老记录（升级前下载的）里没有 dlId，
         * 或者记录已经不在 DownloadManager 里了，就按文件名找。
         * 子目录要带上，否则删不到分目录存放的文件。 */
        try {
            File f = DownloadProvider.resolve(activity, name, sub);
            if (f != null && f.exists() && f.delete()) gone = true;
        } catch (Throwable ignored) { }
        try {
            File direct = subOf(sub, name);
            if (direct != null && direct.exists() && direct.delete()) gone = true;
        } catch (Throwable ignored) { }
        /* Android 10+ 上 File.delete() 多半删不动公共目录，走 MediaStore 再删一次 */
        if (!gone) gone = mediaStoreDelete(name, sub);
        return gone;
    }

    /**
     * 目标位置有没有叫这个名字的文件。
     *
     * 精确点名，不去枚举整个目录：只问「这个目录里有没有这个文件」。
     *
     * · Android 10+：MediaStore 按 DISPLAY_NAME + RELATIVE_PATH 精确匹配。
     *   有的 ROM 给 RELATIVE_PATH 带尾斜杠、有的不带，两种都试一遍。
     *   ⚠️ 不能拿 DownloadManager 历史的路径尾段当依据 —— 在 Android 10+
     *   上 COLUMN_LOCAL_FILENAME 已废弃（多数机型直接给 null），退回
     *   COLUMN_LOCAL_URI 拿到的是 content://…/12345，取尾段得到的是**数字 id**
     *   而不是文件名，永远匹配不上。
     * · Android 9 及以下：直接 File.exists()。
     *
     * 查不到一律当「没有」 —— 宁可偶尔覆盖，也不能因为查不动就拒绝下载。
     */
    private boolean nameExistsInDownloads(String name, String category, boolean subDir) {
        if (name == null || name.isEmpty()) return false;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            try {
                File f = new File(publicDownloadDir(safeCategory(category)), safeName(name));
                return f.exists();
            } catch (Throwable ignored) {
                return false;
            }
        }
        android.content.ContentResolver cr = activity.getContentResolver();
        for (String dir : relDirs(subDir ? category : "")) {
            Cursor c = null;
            try {
                c = cr.query(MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL),
                        new String[]{MediaStore.MediaColumns._ID},
                        MediaStore.MediaColumns.DISPLAY_NAME + "=? AND "
                                + MediaStore.MediaColumns.RELATIVE_PATH + "=?",
                        new String[]{safeName(name), dir}, null);
                if (c != null && c.moveToFirst()) return true;
            } catch (Throwable ignored) {
                /* 查不动就当没有，别把下载卡在这 */
            } finally {
                if (c != null) { try { c.close(); } catch (Throwable ignored) { } }
            }
        }
        /* 兜底：按名字直接问一次（不限制目录），有些 ROM 的 RELATIVE_PATH 写法刁钻 */
        return mediaStoreHas(name, subDir ? category : "");
    }

    /**
     * 落盘名 —— **就是原名，不加任何后缀**。
     *
     * ═══ 为什么改回覆盖 ═══
     *
     * 以前这里会避让重名：`foo.apk` → `foo-2.apk` → `foo-3.apk`。
     * 用户明确不要这个：同一个文件下多次，就该是同一个名字、同一个文件，
     * 而不是堆一串 `-2 -3 -4` 的副本。
     *
     * 现在的语义是**同名覆盖**：新下载的替换掉旧的，磁盘上始终只有一份。
     * 这也和「历史跟着本地走」一致 —— 一个文件对应一条记录。
     *
     * ═══ 关键：必须保证落盘名**确定** ═══
     *
     * Android 10+ 用 MediaStore insert 时，如果同名文件已存在，系统会自动
     * 把它改成 `foo(1).apk` —— 于是实际落盘名和我们记在历史里的名字对不上，
     * 「打开 / 删除」就永远定位不到。
     *
     * 所以落盘前要先调用 {@link #purgeExistingInDownloads} 把同名条目清掉，
     * 让系统无处可"自动改名"。调用方在拿这个名字之后必须做这一步。
     */
    private String uniqueName(String filename, String category, boolean subDir) {
        String base = safeName(filename);
        if (base.isEmpty()) base = "download";
        return base;
    }

    /**
     * 落盘前清掉同名文件，保证新文件能用**原名**落下。
     *
     * 不做这一步，Android 10+ 的 MediaStore 会把重名文件自动改成
     * `foo(1).apk`，落盘名就不再是我们记进历史的那个名字了。
     *
     * @return 是否清掉了旧文件
     */
    private boolean purgeExistingInDownloads(String name, String category, boolean subDir) {
        if (name == null || name.isEmpty()) return false;
        boolean gone = false;
        try {
            File direct = subOf(safeCategory(category), name);
            if (direct != null && direct.exists()) {
                if (direct.delete()) gone = true;
            }
        } catch (Throwable ignored) { }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            android.content.ContentResolver cr = activity.getContentResolver();
            for (String dir : relDirs(subDir ? category : "")) {
                Cursor c = null;
                try {
                    c = cr.query(MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL),
                            new String[]{MediaStore.MediaColumns._ID},
                            MediaStore.MediaColumns.DISPLAY_NAME + "=? AND "
                                    + MediaStore.MediaColumns.RELATIVE_PATH + "=?",
                            new String[]{safeName(name), dir}, null);
                    if (c == null) continue;
                    while (c.moveToNext()) {
                        long id = c.getLong(0);
                        try {
                            if (cr.delete(MediaStore.Downloads.getContentUri(
                                    MediaStore.VOLUME_EXTERNAL, id), null, null) > 0) gone = true;
                        } catch (Throwable ignored) { }
                    }
                } catch (Throwable ignored) {
                } finally {
                    if (c != null) { try { c.close(); } catch (Throwable ignored) { } }
                }
            }
        }
        return gone;
    }

    /** 文件名是否已经落在磁盘上（用来判断「打开」能不能点得动） */
    private boolean downloadedFileExists(String name) {
        return downloadedFileExists(name, "");
    }

    /**
     * @param sub Download/githup/ 下的子目录（如 "release"）；空串 = 根目录。
     *
     * 带上它才能找到按来源分目录存放的文件 —— 以前只按名字去根目录找，
     * 子目录里的文件永远定位不到，用户点「打开」就弹「文件不在了」。
     */
    private boolean downloadedFileExists(String name, String sub) {
        try {
            File f = DownloadProvider.resolve(activity, name, sub);
            if (f != null && f.exists()) return true;
            /* 兜底：MediaStore / 文件系统都没查到时，再直接扫一次目录。
               某些 ROM 的 MediaStore 索引滞后（刚下的文件还没进库），
               这时文件系统是唯一可靠的判据。 */
            File direct = subOf(sub, name);
            if (direct != null && direct.exists()) return true;
            /* 最后问 MediaStore：Android 10+ 上它才是权威账本。
               File.exists() 在这上面有时查不到刚落盘的文件，
               于是明明在却弹「文件不在了」。 */
            return mediaStoreHas(name, sub);
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** Download/githup/ + 子目录 + 文件名的直接路径 */
    private File subOf(String sub, String name) {
        try {
            File root = publicDownloadDir("");
            if (root == null) return null;
            String s = (sub == null) ? "" : sub;
            File dir = s.isEmpty() ? root : new File(root, s);
            return new File(dir, safeName(name));
        } catch (Throwable ignored) {
            return null;
        }
    }

    /**
     * RELATIVE_PATH 的候选写法（**只到目录，不含文件名**）。
     *
     * ⚠️ 这里以前是个实打实的 bug：把文件名也拼进 RELATIVE_PATH 了
     * （`Download/githup/release/xxx.apk`）。RELATIVE_PATH 是**目录**，
     * 拿它去等于匹配一个带文件名的字符串，永远命中 0 条。
     *
     * 后果链条：
     *   落盘前清同名文件 → 查不到 → 没清掉
     *   → Android 10+ 的 DownloadManager 发现重名，自动改名成
     *     `xxx-1.apk`（各 ROM 写法不同）
     *   → 历史里记的 saved 还是 `xxx.apk`，跟真实落盘名对不上
     *   → 「打开 / 删除」按 saved 定位，永远找不到 → 弹「文件不在了」
     *
     * 有的 ROM 给 RELATIVE_PATH 带尾斜杠、有的不带，两种都试；
     * 带子目录的还要再试一次根目录（文件可能在旧版本落在根目录）。
     */
    private static java.util.List<String> relDirs(String sub) {
        String base = "Download/" + DOWNLOAD_SUBDIR;
        String cat = safeCategory(sub);
        String tail = cat.isEmpty() ? "" : "/" + cat;
        java.util.List<String> out = new java.util.ArrayList<>();
        out.add(base + tail + "/");
        out.add(base + tail);
        if (!tail.isEmpty()) { out.add(base + "/"); out.add(base); }
        return out;
    }

    /** Android 10+ 用 MediaStore 精确查「这个目录里有没有这个文件」 */
    private boolean mediaStoreHas(String name, String sub) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false;
        if (name == null || name.isEmpty()) return false;
        String n = safeName(name);
        android.content.ContentResolver cr = activity.getContentResolver();
        for (String dir : relDirs(sub)) {
            android.database.Cursor c = null;
            try {
                c = cr.query(MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL),
                        new String[]{MediaStore.MediaColumns._ID},
                        MediaStore.MediaColumns.DISPLAY_NAME + "=? AND "
                                + MediaStore.MediaColumns.RELATIVE_PATH + "=?",
                        new String[]{n, dir}, null);
                if (c != null && c.moveToFirst()) return true;
            } catch (Throwable ignored) {
            } finally {
                if (c != null) { try { c.close(); } catch (Throwable ignored) { } }
            }
        }
        return false;
    }

    /**
     * Android 10+ 删公共下载目录里的文件，**只能走 MediaStore**。
     *
     * 直接 `new File("/storage/emulated/0/Download/...").delete()` 在
     * Android 11+ 上没有权限，静默失败 —— 表现就是「点了删除，记录没了，
     * 文件还在」，用户下次扫一眼又看到它。
     */
    private boolean mediaStoreDelete(String name, String sub) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false;
        if (name == null || name.isEmpty()) return false;
        String n = safeName(name);
        boolean gone = false;
        android.content.ContentResolver cr = activity.getContentResolver();
        for (String dir : relDirs(sub)) {
            android.database.Cursor c = null;
            try {
                c = cr.query(MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL),
                        new String[]{MediaStore.MediaColumns._ID},
                        MediaStore.MediaColumns.DISPLAY_NAME + "=? AND "
                                + MediaStore.MediaColumns.RELATIVE_PATH + "=?",
                        new String[]{n, dir}, null);
                if (c == null) continue;
                while (c.moveToNext()) {
                    long id = c.getLong(0);
                    try {
                        if (cr.delete(MediaStore.Downloads.getContentUri(
                                MediaStore.VOLUME_EXTERNAL, id), null, null) > 0) gone = true;
                    } catch (Throwable ignored) { }
                }
            } catch (Throwable ignored) {
            } finally {
                if (c != null) { try { c.close(); } catch (Throwable ignored) { } }
            }
        }
        return gone;
    }

    /**
     * 下载完成后回查**真实落盘名**。
     *
     * DownloadManager 碰到重名会自己改名（`xxx.apk` → `xxx-1.apk`），
     * 历史里记的是我们给的原名，两者对不上就定位不到文件。
     * 所以成功后拿 uri 去问 MediaStore 要 DISPLAY_NAME，以它为准。
     */
    private String queryFinalName(String uri) {
        if (uri == null || uri.isEmpty()) return "";
        try {
            if (uri.startsWith("content://")) {
                android.database.Cursor c = null;
                try {
                    c = activity.getContentResolver().query(android.net.Uri.parse(uri),
                            new String[]{MediaStore.MediaColumns.DISPLAY_NAME},
                            null, null, null);
                    if (c != null && c.moveToFirst()) {
                        String n = c.getString(0);
                        if (n != null && !n.isEmpty()) return n;
                    }
                } finally {
                    if (c != null) { try { c.close(); } catch (Throwable ignored) { } }
                }
                return "";
            }
            File f = new File(uri);
            return f.exists() ? f.getName() : "";
        } catch (Throwable ignored) {
            return "";
        }
    }

    // ------------------------------------------------------------------
    // 下载历史（给「下载管理」页）
    //
    // 进行中的任务查 DownloadManager 就有，但「下完了 / 失败了」的记录
    // 系统不留账 —— 想找到刚下的文件得去文件管理器翻。这里自己记一本，
    // 存在本地（最多 30 条），管理页里能打开、删除、重试。
    // ------------------------------------------------------------------

    private static final String SP_DL_HISTORY = "dl_history";
    private static final int HISTORY_MAX = 30;

    /**
     * 最新的在最前。JSONArray 非线程安全：UI 线程写、JS 线程读，得锁。
     *
     * 非 final：重载时整个换掉（JSONArray 没有 clear()）。
     */
    private org.json.JSONArray dlHistory = new org.json.JSONArray();

    /**
     * 从磁盘重载历史。
     *
     * 以前有一句 `if (dlHistory.length() > 0) return;` —— 只加载一次。
     * 那让内存成了"第二本账"：一旦内存和磁盘对不上（进程被杀、写入丢失、
     * 别的路径改过 SP），页面就永远读着旧的那份，看不到新记录。
     *
     * 现在**每次都以磁盘为真源**重新解析。历史才 30 条，解析一次不到
     * 1 毫秒，轮询 800ms 一次，开销可以忽略；换来的是"页面上看到的
     * 就是磁盘上有的"，不可能再分叉。
     */
    private void loadHistoryLocked() {
        org.json.JSONArray fresh = new org.json.JSONArray();
        try {
            String s = activity.getSharedPreferences(PREF_DL, Context.MODE_PRIVATE)
                    .getString(SP_DL_HISTORY, "[]");
            org.json.JSONArray a = new org.json.JSONArray(s);
            for (int i = 0; i < a.length() && i < HISTORY_MAX; i++) fresh.put(a.get(i));
        } catch (Throwable ignored) { }
        dlHistory = fresh;
    }

    /**
     * 诊断：把磁盘和内存两边的情况都摊出来。
     *
     * 加它是因为「历史记不住」排查了好几轮都没找到 —— 根因在运行时
     * （apply 异步 + 装自己被杀进程），静态看代码完全正常。与其继续猜，
     * 不如让 App 自己把真相说出来：磁盘上到底有几条、内存里几条、
     * 最后一次写入是什么时候。
     */
    @JavascriptInterface
    public String downloadHistoryDiag() {
        synchronized (dlHistory) {
            try {
                String disk = activity.getSharedPreferences(PREF_DL, Context.MODE_PRIVATE)
                        .getString(SP_DL_HISTORY, "[]");
                int diskN = 0;
                try { diskN = new org.json.JSONArray(disk).length(); } catch (Throwable ignored) { }
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("diskCount", diskN);
                o.put("diskBytes", disk == null ? 0 : disk.length());
                o.put("memCount", dlHistory.length());
                o.put("max", HISTORY_MAX);
                return o.toString();
            } catch (Throwable ignored) {
                return "{}";
            }
        }
    }

    /**
     * 落盘。
     *
     * ⚠️⚠️ 必须用 commit()（同步），不能用 apply()（异步）。
     *
     * ═══════ 这就是「下载历史记不住」的根因 ═══════
     *
     * 场景是这样的 —— 而它在这个 App 里**每次都会发生**：
     *
     *   1. 下载完成 → addHistory() → put(0, o) → apply()
     *   2. 紧接着 installFinished() → openInstaller() 拉起安装器
     *   3. **装的是 githup 自己**（用户下的就是本 App 的更新包）
     *   4. 覆盖安装自己 → **App 进程立刻被系统杀掉**
     *   5. apply() 只是把修改排进了异步队列，**还没来得及写磁盘**
     *      → 这一条历史**永久丢失**
     *
     * 下次启动读到的还是旧内容，用户看到的就是「记录被覆盖 / 没了」。
     * 偶尔能留住一条，是那次 apply 恰好赶在被杀之前落了盘 —— 所以现象
     * 看起来随机、时好时坏。
     *
     * commit() 是同步写：返回时数据已在磁盘上。代价是阻塞调用线程
     * （一次几十毫秒，历史才 30 条，可忽略），换来的是「写完就一定在」。
     * 历史这种丢一次就解释不清的数据，必须同步。
     */
    private void saveHistoryLocked() {
        try {
            activity.getSharedPreferences(PREF_DL, Context.MODE_PRIVATE)
                    .edit().putString(SP_DL_HISTORY, dlHistory.toString()).commit();
        } catch (Throwable ignored) { }
    }

    /** 收尾时写一条历史。ok=false 也会记 —— 失败了才知道要去重试 */
    /**
     * 把一条新记录放到最前面，并累积保留旧记录。
     *
     * ═══ 为什么不直接 dlHistory.put(0, o) ═══
     *
     * org.json.JSONArray 的 put(int index, Object value) 语义是
     * **设置该下标的值**，不是「插入并后移」：
     *
     *     if (index < values.size())      values.set(index, value);   // 替换
     *     else if (index == values.size()) values.add(value);          // 追加
     *
     * 所以每下载一次 put(0, o)，就是**把第 0 条换成新的** —— 历史永远
     * 只有一条，跟下的是什么文件、叫什么名字一点关系都没有。
     *
     * 用户看到的就是「下载一次，上一条就没了」。这个 bug 从 v1.2.14 起
     * 一直存在，之前几轮查落盘、查子目录、查磁盘同步都没查到这行 ——
     * 它读起来就是「放一条新的在最前面」，意图对，实现错。
     *
     * JSONArray 没有「插入到指定位置」这个方法，只能重建数组。
     */
    private void prependHistoryLocked(JSONObject fresh) {
        try {
            org.json.JSONArray next = new org.json.JSONArray();
            next.put(fresh);
            for (int i = 0; i < dlHistory.length() && next.length() < HISTORY_MAX; i++) {
                next.put(dlHistory.opt(i));
            }
            dlHistory = next;
        } catch (Throwable ignored) { }
    }

    /**
     * 同名去重：只保留最新那条。
     *
     * ═══ 为什么要这个 ═══
     *
     * 落盘是**同名覆盖**（用户明确不要 -2 / -3 后缀），第二次下载会把
     * 第一次的文件物理删掉。如果历史里留两条，它们指向的是同一个文件：
     *
     *   · 点开旧的那条，看到的是新下载的内容 —— 以为是「第一次没了」
     *   · 删其中一条 → 文件没了 → 另一条还在，但点开报「文件不在了」
     *   · 两条长得一模一样，还白占 30 条配额
     *
     * 所以覆盖落盘的另一半必须是：历史里也只留一条。
     */
    private void dedupeLatestLocked() {
        try {
            /* 第一遍：按「子目录/落盘名」去重，只留最新那条 */
            java.util.Set<String> seen = new java.util.HashSet<>();
            org.json.JSONArray pass1 = new org.json.JSONArray();
            for (int i = 0; i < dlHistory.length(); i++) {
                JSONObject o = dlHistory.optJSONObject(i);
                if (o == null) continue;
                String key = dedupeKeyOf(o);
                if (seen.contains(key)) continue;   // 已有更新的同款，跳过
                seen.add(key);
                pass1.put(o);
                if (pass1.length() >= HISTORY_MAX) break;
            }
            /*
              第二遍：老版本落在**根目录**（sub 为空）的同名记录，
              被带子目录的新记录顶掉。

              ═══ 为什么要这一遍 ═══

              改成按来源分目录后，同一个附件会存在两处：
                · 旧版本下的  Download/githup/xxx.apk           （sub = ""）
                · 新版本下的  Download/githup/release/xxx.apk   （sub = "release"）

              两条都在历史里的话，列表上就是两个一模一样的名字 ——
              用户又要问「我下载一次为什么有两条」。

              新记录（带子目录）是当前的，老记录是旧版本遗留，顶掉它。
              注意：只动**记录**，根目录那个旧文件不删 —— 万一它还被别处引用。
            */
            java.util.Set<String> withSub = new java.util.HashSet<>();
            for (int i = 0; i < pass1.length(); i++) {
                JSONObject o = pass1.optJSONObject(i);
                if (o == null || !o.optBoolean("ok", false)) continue;
                String sub = o.optString("sub", "");
                if (!sub.isEmpty()) {
                    String saved = o.optString("saved", "");
                    if (saved.isEmpty()) saved = o.optString("name", "");
                    if (!saved.isEmpty()) withSub.add(saved);
                }
            }
            org.json.JSONArray next = new org.json.JSONArray();
            for (int i = 0; i < pass1.length(); i++) {
                JSONObject o = pass1.optJSONObject(i);
                if (o == null) continue;
                if (o.optBoolean("ok", false)) {
                    String sub = o.optString("sub", "");
                    String saved = o.optString("saved", "");
                    if (saved.isEmpty()) saved = o.optString("name", "");
                    if (sub.isEmpty() && !saved.isEmpty() && withSub.contains(saved)) continue;
                }
                next.put(o);
                if (next.length() >= HISTORY_MAX) break;
            }
            dlHistory = next;
        } catch (Throwable ignored) { }
    }

    /** 去重键 = 子目录/落盘名；失败记录按 原始url 区分（它们没有落盘名概念） */
    private static String dedupeKeyOf(JSONObject o) {
        String saved = o.optString("saved", "");
        if (saved.isEmpty()) saved = o.optString("name", "");
        String sub = o.optString("sub", "");
        if (!o.optBoolean("ok", false)) return "fail:" + o.optString("url", "") + "|" + saved;
        return sub + "/" + saved;
    }

    private void addHistory(DlTask t, boolean ok, long bytes) {
        synchronized (dlHistory) {
            loadHistoryLocked();
            /* 有新下载了，说明用户想看到记录 —— 解除「已清空」标记，
             * 让下次历史为空时还能自动补回。 */
            try {
                activity.getSharedPreferences(PREF_DL, Context.MODE_PRIVATE)
                        .edit().putBoolean(SP_DL_CLEARED, false).apply();
            } catch (Throwable ignored) { }
            try {
                JSONObject o = new JSONObject();
                o.put("name", t.filename);
                /* 真正落盘的名字（撞名时带 -2 后缀）：「打开 / 删除」用它定位。
                 * 只存 filename 的话，加过后缀的记录会永远找不到自己的文件。 */
                String realUri = ok ? queryFinalUri(t.id) : "";
                String savedName = t.outName();
                if (ok && !realUri.isEmpty()) {
                    String real = queryFinalName(realUri);
                    /* 系统给改过名（重名自动加后缀）就以系统的为准 */
                    if (!real.isEmpty()) savedName = real;
                }
                o.put("saved", savedName);
                /*
                  记下子目录（release / 议题 / actions…）。

                  ⚠️ 以前这里没写 sub，于是正常记录的 sub 是空串；而「本地补回」
                  扫磁盘扫出来的那条带着真实子目录（"release"）。去重键是
                  "子目录/落盘名"，两者算出的 key 不同 —— 去重失效，
                  **下了一次却列出两条一模一样的记录**。

                  用户看到的就是「我下载一次，为什么有两条」。
                */
                o.put("sub", t.category == null ? "" : t.category);
                o.put("url", t.originUrl == null ? "" : t.originUrl);
                /* 记下 DownloadManager 的下载 id：「删除」要按它删才删得掉真文件。
                 * 以前只存文件名，删除时去拼公共目录路径，Android 10+ 上删的是
                 * 沙箱里的影子路径，文件还在原地。 */
                o.put("dlId", t.id);
                /*
                  确切落盘位置（content:// URI 或绝对路径），打开 / 删除 /
                  判断在不在都用它 —— 见 queryFinalUri 的说明。

                  只在成功时有意义：失败的任务没有产出文件。
                */
                o.put("uri", realUri);
                o.put("ok", ok);
                o.put("bytes", bytes);
                o.put("time", System.currentTimeMillis());
                o.put("install", t.autoInstall);
                o.put("sha", t.expectedSha == null ? "" : t.expectedSha);
                /* put(0, o) 是替换不是插入 —— 见 prependHistoryLocked 的说明 */
                prependHistoryLocked(o);
                /* 落盘是同名覆盖，历史里也只留最新那条 */
                dedupeLatestLocked();
                while (dlHistory.length() > HISTORY_MAX) dlHistory.remove(dlHistory.length() - 1);
                saveHistoryLocked();
            } catch (Throwable ignored) { }
        }
    }

    /**
     * 删一条历史。
     *
     * ⚠️ 以前是「按名字删所有匹配项」：两个仓库下同名附件（app-release.apk
     * 太常见）时，删其中一条会把另一条也删掉 —— 用户看到的就是「记录莫名
     * 其妙少了一条」，于是以为历史不可靠。
     *
     * 现在优先按 dlId 精确定位（它唯一），只删**一条**。没有 dlId 的老记录
     * 才退回按落盘名匹配，同样只删一条。
     */
    private void removeHistoryLocked(long dlId, String saved) {
        synchronized (dlHistory) {
            loadHistoryLocked();
            int target = -1;
            if (dlId > 0) {
                for (int i = 0; i < dlHistory.length(); i++) {
                    JSONObject o = dlHistory.optJSONObject(i);
                    if (o != null && o.optLong("dlId", -1) == dlId) { target = i; break; }
                }
            }
            if (target < 0 && saved != null && !saved.isEmpty()) {
                for (int i = 0; i < dlHistory.length(); i++) {
                    JSONObject o = dlHistory.optJSONObject(i);
                    if (o == null) continue;
                    if (saved.equals(o.optString("saved", "")) ||
                            saved.equals(o.optString("name", ""))) { target = i; break; }
                }
            }
            if (target >= 0) dlHistory.remove(target);
            saveHistoryLocked();
        }
    }

    /* ─────────────── 以磁盘为准：把已存在的文件补回历史 ─────────────── */

    /** 用户主动清空过记录：置位后就不再自动扫回来，否则「清空」等于白点 */
    private static final String SP_DL_CLEARED = "dl_cleared";
    /** 已经补回过一次，避免每次启动都去查 MediaStore */
    private static final String SP_DL_RECOVERED = "dl_recovered";
    /** 补回节流：页面 800ms 轮询一次，不能每次都扫 */
    private static final long RECOVER_GAP_MS = 10_000L;
    private volatile long lastRecoverAt = 0;

    /**
     * 扫 Download/githup/ 下**真实存在**的文件。
     *
     * @return [文件名, 字节数, 最后修改毫秒]
     */
    private java.util.List<Object[]> collectDownloadedFiles() {
        java.util.List<Object[]> out = new java.util.ArrayList<>();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                Cursor c = null;
                try {
                    c = activity.getContentResolver().query(
                            MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL),
                            new String[]{MediaStore.MediaColumns.DISPLAY_NAME,
                                    MediaStore.MediaColumns.SIZE,
                                    MediaStore.MediaColumns.DATE_MODIFIED,
                                    MediaStore.MediaColumns.RELATIVE_PATH},
                            MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?",
                            new String[]{"Download/" + DOWNLOAD_SUBDIR + "%"}, null);
                    if (c == null) return out;
                    while (c.moveToNext()) {
                        String rel = c.getString(3);
                        if (rel == null) continue;
                        /* 只认自己的目录：Download/githup 本身及其子目录。
                         * LIKE 'Download/githup%' 会误带 Download/githupfoo，
                         * 这里再精确判一次。 */
                        if (!rel.equals("Download/" + DOWNLOAD_SUBDIR) &&
                                !rel.equals("Download/" + DOWNLOAD_SUBDIR + "/") &&
                                !rel.startsWith("Download/" + DOWNLOAD_SUBDIR + "/")) continue;
                        String n = c.getString(0);
                        if (n == null || n.isEmpty()) continue;
                        long sz = c.getLong(1);
                        long mod = c.getLong(2) * 1000L;   // DATE_MODIFIED 是秒
                        if (mod <= 0) mod = System.currentTimeMillis();
                        /* 记下相对于 Download/githup/ 的子目录。
                         * 没有它，「打开」会去 Download/githup/ 根目录找，
                         * 子目录里的文件永远定位不到 → 弹「文件不在了」。 */
                        String sub = subOfRel(rel);
                        out.add(new Object[]{n, sz, mod, sub});
                    }
                } catch (Throwable ignored) {
                } finally {
                    if (c != null) { try { c.close(); } catch (Throwable ignored) { } }
                }
                return out;
            }
            /* Android 9 及以下：直接遍历文件系统 */
            File root = publicDownloadDir("");
            if (root == null || !root.isDirectory()) return out;
            collectFilesRec(root, out);
        } catch (Throwable ignored) { }
        return out;
    }

    private void collectFilesRec(File dir, java.util.List<Object[]> out) {
        collectFilesRec(dir, "", out);
    }

    private void collectFilesRec(File dir, String relSub, java.util.List<Object[]> out) {
        File[] fs = dir.listFiles();
        if (fs == null) return;
        for (File f : fs) {
            if (f.isDirectory()) {
                collectFilesRec(f, relSub.isEmpty() ? f.getName()
                        : relSub + "/" + f.getName(), out);
            } else if (f.isFile()) {
                long mod = f.lastModified();
                out.add(new Object[]{f.getName(), f.length(),
                        mod > 0 ? mod : System.currentTimeMillis(), relSub});
            }
        }
    }

    /** 从 MediaStore 的 RELATIVE_PATH 里剥出相对于 Download/githup/ 的子目录 */
    private static String subOfRel(String rel) {
        if (rel == null || rel.isEmpty()) return "";
        String p = rel.replace('\\', '/');
        while (p.endsWith("/")) p = p.substring(0, p.length() - 1);
        String prefix = "Download/" + DOWNLOAD_SUBDIR;
        if (!p.startsWith(prefix)) return "";
        String rest = p.substring(prefix.length());
        while (rest.startsWith("/")) rest = rest.substring(1);
        return rest;
    }

    /**
     * 把磁盘上存在、历史里没有的文件补进历史。
     *
     * ═══════ 为什么要这个 ═══════
     *
     * 历史只记「本次 App 自己下载过什么」。凡是没走记录路径留下来的文件
     * —— 上上轮 apply() 异步落盘被杀进程吞掉的那条、装旧版本前下的、
     * 别的原因丢了的 —— 磁盘上有，下载管理里却看不到。
     *
     * 用户看到的「第一个下载的记录被第二个覆盖没了」，实际是：
     * **文件两个都在**（文件管理器里能看到），**历史只剩后写进去的那条**。
     *
     * 所以判据不能是「历史里记了什么」，得是「磁盘上有什么」：
     * 文件在 → 记录就该在。
     *
     * @return 补回了几条
     */
    private int recoverHistoryFromDiskLocked() {
        return recoverHistoryFromDiskLocked(dropRootDuplicates(collectDownloadedFiles()));
    }

    private int recoverHistoryFromDiskLocked(java.util.List<Object[]> files) {
        if (files == null || files.isEmpty()) return 0;

        /* 已有的落盘名（补回只补缺失的，不重复加） */
        /* key = 子目录/文件名：同名不同目录是两个不同的文件，不能互相挡 */
        java.util.Set<String> known = new java.util.HashSet<>();
        for (int i = 0; i < dlHistory.length(); i++) {
            JSONObject o = dlHistory.optJSONObject(i);
            if (o == null) continue;
            String sv = o.optString("saved", "");
            String sb = o.optString("sub", "");
            if (!sv.isEmpty()) known.add(keyOf(sb, sv));
            String nm = o.optString("name", "");
            if (!nm.isEmpty()) known.add(keyOf(sb, nm));
            /* 老记录没有 sub：也按「任意目录同名」挡一下，避免重复补 */
            if (!sv.isEmpty()) known.add(keyOf("", sv));
        }

        int added = 0;
        for (Object[] f : files) {
            String n = (String) f[0];
            String sub = f.length > 3 ? String.valueOf(f[3]) : "";
            if (n == null || n.isEmpty()) continue;
            if (known.contains(keyOf(sub, n))) continue;

            /*
              已有同名记录、但它的 sub 是空串（老版本留下的，或早期没写 sub
              的那批）—— 这不是新文件，就是它。把 sub 补全即可，**不要新增**。

              不补全的话，"release/foo.apk"（磁盘上）和 "foo.apk"（记录里）
              算两个 key，去重键对不上，列表里就会出现两条一模一样的记录。
            */
            JSONObject exist = findNoSubLocked(n);
            if (exist != null) {
                try {
                    exist.put("sub", sub);
                    exist.put("saved", n);
                    known.add(keyOf(sub, n));
                } catch (Throwable ignored) { }
                continue;
            }
            try {
                JSONObject o = new JSONObject();
                o.put("name", n);
                o.put("saved", n);
                o.put("sub", f.length > 3 ? String.valueOf(f[3]) : "");
                o.put("url", "");                    // 老文件没有原始地址，重试不了
                o.put("dlId", 0);                    // 也没有 DownloadManager id
                o.put("ok", true);
                o.put("bytes", ((Long) f[1]));
                o.put("time", ((Long) f[2]));
                o.put("install", false);
                o.put("sha", "");
                o.put("recovered", true);            // 标出来，前端显示「本地补回」
                dlHistory.put(o);
                known.add(keyOf(sub, n));
                added++;
            } catch (Throwable ignored) { }
        }
        if (added > 0) {
            sortHistoryLocked();
            trimHistoryLocked();
        }
        return added;
    }

    /** 历史去重的键：子目录 + 文件名 */
    private static String keyOf(String sub, String name) {
        String s = (sub == null) ? "" : sub;
        return s.isEmpty() ? name : s + "/" + name;
    }

    /**
     * 同一个文件只留一条记录（保留最新的）。
     *
     * ═══ 为什么需要 ═══
     *
     * 落盘改成**同名覆盖**之后，磁盘上一个文件只有一份。而历史是每次
     * 下载追加一条，同名下两次就会有两条记录指向同一个文件 ——
     * 用户看到的是「同一个文件列出了两遍」。
     *
     * 要求「历史跟着本地走」，那就是：一个文件 ↔ 一条记录。
     *
     * 只按「子目录/落盘名」去重，不动失败记录（它没有文件，且留着
     * 是为了让用户重试）。
     */
    private int dedupeHistoryLocked() {
        java.util.Set<String> seen = new java.util.HashSet<>();
        java.util.List<Integer> dead = new java.util.ArrayList<>();
        try {
            /* 已按时间倒序：先遇到的就是最新的，后面再遇到同名的都是旧的 */
            for (int i = 0; i < dlHistory.length(); i++) {
                JSONObject o = dlHistory.optJSONObject(i);
                if (o == null) continue;
                if (!o.optBoolean("ok", false)) continue;      // 失败记录不去重
                String saved = o.optString("saved", "");
                if (saved.isEmpty()) saved = o.optString("name", "");
                if (saved.isEmpty()) continue;
                String sub = o.optString("sub", "");
                String k = keyOf(sub, saved);
                if (!seen.add(k)) dead.add(i);
            }
        } catch (Throwable ignored) {
            return 0;
        }
        for (int i = dead.size() - 1; i >= 0; i--) {
            try { dlHistory.remove(dead.get(i).intValue()); } catch (Throwable ignored) { }
        }
        return dead.size();
    }

    /** 按时间倒序（最新在前） */
    private void sortHistoryLocked() {
        try {
            java.util.List<JSONObject> l = new java.util.ArrayList<>();
            for (int i = 0; i < dlHistory.length(); i++) {
                JSONObject o = dlHistory.optJSONObject(i);
                if (o != null) l.add(o);
            }
            l.sort((a, b) -> Long.compare(b.optLong("time", 0), a.optLong("time", 0)));
            org.json.JSONArray fresh = new org.json.JSONArray();
            for (JSONObject o : l) fresh.put(o);
            dlHistory = fresh;
        } catch (Throwable ignored) { }
    }

    private void trimHistoryLocked() {
        try {
            while (dlHistory.length() > HISTORY_MAX) dlHistory.remove(dlHistory.length() - 1);
        } catch (Throwable ignored) { }
    }

    /* ─────────────── 磁盘 ⇄ 历史 双向同步 ─────────────── */

    private volatile long lastSyncAt = 0;
    private static final long SYNC_GAP_MS = 10_000L;

    /**
     * 找一条落盘名匹配、但 sub 为空的记录（老版本留下的那批）。
     *
     * 用来在补回时「补全」而不是「新增」—— 它们是同一个文件。
     */
    private JSONObject findNoSubLocked(String saved) {
        try {
            for (int i = 0; i < dlHistory.length(); i++) {
                JSONObject o = dlHistory.optJSONObject(i);
                if (o == null) continue;
                String sv = o.optString("saved", "");
                if (sv.isEmpty()) sv = o.optString("name", "");
                if (!sv.equals(saved)) continue;
                if (o.optString("sub", "").isEmpty()) return o;
            }
        } catch (Throwable ignored) { }
        return null;
    }

    /**
     * 本地文件没了 → 记录跟着消失。
     *
     * ═══ 为什么需要这个 ═══
     *
     * 用户在文件管理器里删了文件（或在系统「最近下载」里删），
     * App 这边毫不知情 —— 记录还挂着，点「打开」才被告知「文件不在了」。
     * 要求就是「本地卸载了，软件里也要跟着卸载」。
     *
     * @param onDisk 磁盘上真实存在的文件（key = "子目录/文件名" 和 "文件名"）
     * @return 删了几条
     */
    private int pruneHistoryLocked(java.util.Set<String> onDisk) {
        int removed = 0;
        java.util.List<Integer> dead = new java.util.ArrayList<>();
        try {
            for (int i = 0; i < dlHistory.length(); i++) {
                JSONObject o = dlHistory.optJSONObject(i);
                if (o == null) continue;
                /* 只看成功记录：失败的那条本来就没有文件，留在那是给用户
                 * 「重试」用的，按文件在不在一刀切会把重试入口抹掉。 */
                if (!o.optBoolean("ok", false)) continue;
                String saved = o.optString("saved", "");
                if (saved.isEmpty()) saved = o.optString("name", "");
                if (saved.isEmpty()) continue;
                String sub = o.optString("sub", "");
                /*
                  磁盘集合里同时放了带 sub 和不带 sub 两种 key：
                  老记录的 sub 是空串，只能用不带 sub 的那个 key 匹配上。
                */
                if (!onDisk.contains(keyOf(sub, saved)) && !onDisk.contains(saved)) {
                    dead.add(i);
                }
            }
        } catch (Throwable ignored) {
            return 0;
        }
        if (dead.isEmpty()) return 0;
        for (int i = dead.size() - 1; i >= 0; i--) {
            try {
                dlHistory.remove(dead.get(i).intValue());
                removed++;
            } catch (Throwable ignored) { }
        }
        return removed;
    }

    /**
     * 剔除「根目录遗留的同名文件」。
     *
     * ═══ 为什么要这一步 ═══
     *
     * 现在的规则是所有下载都落在 `Download/githup/&lt;分类&gt;/xxx.apk`
     * （release / 议题 / actions…）。但**更早的版本落的是根目录**
     * `Download/githup/xxx.apk`。升级上来之后，磁盘上就同时存在两个同名文件：

     *     Download/githup/githup-v1.2.15.apk          ← 旧版本留下的
     *     Download/githup/release/githup-v1.2.15.apk  ← 现在真正用的

     * 扫描会把两个都收进来，于是「我明明只下载了一次，列表里却有两条
     * 一模一样的记录」—— 其中一条还带着「本地补回」，看着更像是软件出错。

     * 规则：同名文件**优先认子目录下的那个**，根目录的同名条目跳过。
     * 它只是历史遗留，不是用户当前关心的文件。
     */
    private java.util.List<Object[]> dropRootDuplicates(java.util.List<Object[]> files) {
        java.util.Set<String> inSub = new java.util.HashSet<>();
        try {
            for (Object[] f : files) {
                if (f == null || f.length < 4) continue;
                String sub = f[3] == null ? "" : String.valueOf(f[3]);
                if (!sub.isEmpty()) inSub.add(String.valueOf(f[0]));
            }
            if (inSub.isEmpty()) return files;
            java.util.List<Object[]> out = new java.util.ArrayList<>();
            for (Object[] f : files) {
                if (f == null || f.length < 4) continue;
                String n = String.valueOf(f[0]);
                String sub = f[3] == null ? "" : String.valueOf(f[3]);
                if (sub.isEmpty() && inSub.contains(n)) continue;   // 根目录的同名遗留
                out.add(f);
            }
            return out;
        } catch (Throwable ignored) {
            return files;
        }
    }

    /**
     * 磁盘扫描结果 → 查找集合。
     *
     * 同时放两种 key：带子目录的（精确）和不带的（老记录没 sub 时的兜底）。
     */
    private java.util.Set<String> diskKeySet(java.util.List<Object[]> files) {
        java.util.Set<String> out = new java.util.HashSet<>();
        for (Object[] f : files) {
            if (f == null || f.length == 0) continue;
            String n = String.valueOf(f[0]);
            if (n == null || n.isEmpty()) continue;
            String sub = (f.length > 3 && f[3] != null) ? String.valueOf(f[3]) : "";
            if (!sub.isEmpty()) out.add(keyOf(sub, n));
            out.add(n);
        }
        return out;
    }

    /**
     * 双向同步：先把没了的删掉，再把新出现的补回来。
     *
     * ═══ 安全网（非常重要，这里踩过大坑）═══
     *
     * 如果磁盘上**一个文件都扫不到**，而历史里却有成功记录 —— 那几乎
     * 不可能是用户真把文件全删了，而是**查询本身失效**（ROM 的 MediaStore
     * 抽风、没给存储权限、外部存储没挂载）。
     *
     * 这时一条都不删。宁可留几条幽灵记录，也不能把整份历史清空且不可
     * 恢复 —— 之前正是这类逻辑误清过一次，教训很痛。
     *
     * 判据用「磁盘扫描结果为空」而不是「记录全被判死」：后者在用户只有
     * 一条记录、且真的删掉了那个文件时会被误判成失效，导致该删的没删。
     *
     * 只扫一次磁盘，prune 和 recover 共用这份结果 —— 30 条记录逐个查
     * MediaStore 要 30 次跨进程调用，太慢。
     */
    private boolean syncWithDiskLocked(boolean force) {
        /*
          ═══ 还原 v1.2.14：不再做「以磁盘为准」的双向同步 ═══

          v1.2.14 的历史就是**一本自己记的账**：下载完记一条，删记录就
          少一条，跟磁盘上到底有什么无关。

          后来为了修「文件在、记录没了」加了一套同步：扫描 Download/githup/
          ——磁盘上有、历史没有的补回来（recover），历史里有、磁盘上没有
          的删掉（prune），再按落盘名去重（dedupe）。

          这套东西在单层目录下问题不大，但和「按来源分子目录」叠在一起后
          反复出问题：补回的带 sub、正常记录不带 sub，去重键不同导致同一
          个文件记两条；根目录老文件和子目录新文件又重复…越修越绕。

          既然这次连目录都还原成单层了，同步这套一并关掉 —— 回到最简单
          的记账模型，少一层猜测就少一类 bug。

          实现上**不删代码**，只在这里不动返回 false：
            · 免去改十几处调用点，风险最小
            · 万一以后还想开回来，改一行就行
        */
        return false;
    }

    /**
     * 立刻同步一次再返回（进页面时用，不等 10 秒节流）。
     *
     * 页面刚打开时用户最想看到「现在磁盘上有什么」，等 10 秒会以为坏了。
     */
    @JavascriptInterface
    public String downloadHistoryNow() {
        String out;
        synchronized (dlHistory) {
            loadHistoryLocked();
            /* 先把磁盘上真实存在的文件补回来（syncWithDiskLocked），
               再剔除「uri 死了、路径也找不到」的那几条 —— 两步确认，
               所以这里敢跳过节流：用户是主动打开页面的，他要的就是
               「现在磁盘上有什么」。
               例行轮询（downloadHistory）仍然走带节流的那条。 */
            syncWithDiskLocked(true);
            if (pruneMissingNow() > 0) saveHistoryLocked();
            out = dlHistory.toString();
        }
        releasePendingForPruned();
        return out;
    }

    /**
     * 最近一次「因本地文件不在了而剔除」的那些记录的原始下载 URL。
     *
     * 剔除发生在 dlHistory 这把锁里面，而联动清台账要动另一把锁
     * （AppLibrary 自己的）。两把锁嵌套迟早要出事，所以这里只记账，
     * 等出了 synchronized 块再统一处理 —— 见 releasePendingForPruned。
     */
    private final java.util.List<String> prunedUrls = new java.util.ArrayList<>();

    /**
     * 把「刚刚因为文件不在了而被剔除」的那些记录对应的待安装一并作废。
     *
     * 用户在文件管理器里删掉下载的文件 → 下载历史里那条记录跟着没
     * （这是既有行为，见 pruneMissingByUriLocked）。
     *
     * 但那次下载如果停在「已下载、等着装」，台账里还挂着一行 pending，
     * 还留着一个我们替他暂存的文件。历史记录都没了，这个停放就没有依托了
     * —— 留着只会变成永远停在待安装、点开又说找不到文件的幽灵行。
     *
     * 所以剔记录的时候顺手把对应 pending 也清掉：没装上的整行删，
     * 已经装上的只清标记、保留台账（应用都装上了，这条不能抹）。
     */
    private void releasePendingForPruned() {
        if (prunedUrls.isEmpty()) return;
        try {
            AppLibrary lib = AppLibrary.get(activity);
            for (String u : prunedUrls) lib.clearPendingByUrl(u);
        } catch (Throwable ignored) {
            // 清台账失败也不能影响历史本身
        } finally {
            prunedUrls.clear();
        }
    }

    /**
     * 本地文件没了 → 记录也跟着没（按 uri 定点核对）。
     *
     * ═══ 要求 ═══
     *
     * 用户在文件管理器里删掉文件，下载管理里那条记录也要跟着消失；
     * 反过来记录里有、磁盘上也确实有，就不能乱删。
     *
     * ═══ 为什么这次敢做（以前这套反复出事）═══
     *
     * 以前是「按文件名拼路径去找」：拼错了就以为文件不在了，
     * 于是把整份历史清空 —— 用户看到的就是「记录莫名其妙全没了」。
     *
     * 现在每条成功记录都带着**确切落盘位置**（uri，见 queryFinalUri），
     * 判断方式从「猜它在哪」变成「问它在不在」：
     *
     *     uriAlive(uri)  →  content:// 走 ContentResolver 查询
     *                       绝对路径  走 File.exists()
     *
     * 定点查询，不存在「拼错路径」这回事。
     *
     * ═══ 安全网 ═══
     *
     *   1) uri 为空的记录**不参与剔除**。老版本下载的记录没有 uri，
     *      无从判断它在不在 —— 宁可留着，也不能因为查不到就删。
     *   2) 失败记录（ok=false）不动：它本来就没有文件，留着是给「重试」用的。
     *   3) 带 uri 的记录**全部**被判成「不在了」时，一律不删。
     *      几乎不可能是真删光了，更可能是查询整体失效
     *      （ROM 的 MediaProvider 抽风 / 存储没挂载）。
     *      保住数据比「看起来同步」重要。
     *
     * @return 是否发生过剔除（调用方据此决定是否存盘）
     */
    private boolean pruneMissingByUriLocked() {
        if (dlHistory.length() == 0) return false;
        long now = System.currentTimeMillis();
        if (now - lastUriCheckAt < URI_CHECK_GAP_MS) return false;
        lastUriCheckAt = now;

        int total = 0;          // 带 uri 的成功记录数
        int dead = 0;           // 其中已被判「文件不在了」的
        boolean changed = false;
        for (int i = dlHistory.length() - 1; i >= 0; i--) {
            JSONObject o = dlHistory.optJSONObject(i);
            if (o == null) continue;
            if (!o.optBoolean("ok", false)) continue;      // 失败记录不动
            String uri = o.optString("uri", "");
            if (uri.isEmpty()) continue;                   // 没位置信息，不判断
            total++;
            if (fileReallyGone(o, uri)) dead++;
        }
        /* 安全网 3：全军覆没 = 查询本身不可信，一条都不删。

           ⚠️ 但必须有下限 —— 以前写成 total > 0 就生效，于是历史里
           **只有 1 条**时，用户把那个文件删掉，total=1 且 dead=1，
           直接被当成「查询失效」跳过剔除 —— 记录永远留着，用户看到的
           就是「本地明明删了，App 里还有」。

           少量记录全没了就是真没了，保护只在样本够多时才有意义。 */
        final int SAFETY_MIN = 3;
        if (total >= SAFETY_MIN && dead == total) {
            android.util.Log.w("githup",
                    "历史核对：全部 " + total + " 条都判为文件不存在，疑查询失效，跳过剔除");
            return false;
        }
        for (int i = dlHistory.length() - 1; i >= 0; i--) {
            JSONObject o = dlHistory.optJSONObject(i);
            if (o == null) continue;
            if (!o.optBoolean("ok", false)) continue;
            String uri = o.optString("uri", "");
            if (uri.isEmpty()) continue;
            if (!fileReallyGone(o, uri)) continue;
            String goneUrl = o.optString("url", "");
            if (!goneUrl.isEmpty()) prunedUrls.add(goneUrl);
            dlHistory.remove(i);            // 本地确实没了，记录跟着走
            changed = true;
        }
        return changed;
    }

    /**
     * 这条记录指向的文件是不是**真的没了**。
     *
     * ═══ 光看 uri 是不够的 ═══
     *
     * uri 是 MediaStore 的条目地址。用户在系统「最近下载」里把那条删掉，
     * 条目就没了 —— 但**文件本身还在磁盘上**。
     *
     * 只看 uri 的话，用户清一下系统的下载列表，我们这边就会把记录全删光，
     * 而文件好好地在 Download/githup/ 里躺着。
     *
     * ═══ 所以两步确认 ═══
     *
     *   1) uri 还活着            → 文件在，不删
     *   2) uri 死了，但按「落盘名 + 子目录」还能在磁盘上找到 → 文件在，不删
     *   3) uri 死了、路径也找不到                          → 确实没了，删
     */
    private boolean fileReallyGone(JSONObject o, String uri) {
        if (uriAlive(uri)) return false;
        String saved = o.optString("saved", "");
        if (saved.isEmpty()) saved = o.optString("name", "");
        if (saved.isEmpty()) return false;     // 连名字都没有，无从判断，不删
        String sub = o.optString("sub", "");
        return !downloadedFileExists(saved, sub);
    }

    /**
     * 手动核对：跳过节流，也忽略「全军覆没」那条安全网。
     *
     * 用户主动点的那一次，意图是明确的 —— 「我删了文件，把记录也清掉」。
     * 这时候再拿安全网拦着，用户只会觉得点了没反应。
     * 自动核对才需要保守，手动核对应该照做。
     */
    private int pruneMissingNow() {
        synchronized (dlHistory) {
            loadHistoryLocked();
            int removed = 0;
            for (int i = dlHistory.length() - 1; i >= 0; i--) {
                JSONObject o = dlHistory.optJSONObject(i);
                if (o == null) continue;
                if (!o.optBoolean("ok", false)) continue;   // 失败记录本来就没文件
                String uri = o.optString("uri", "");
                if (uri.isEmpty()) continue;                // 没位置信息，不判断
                if (!fileReallyGone(o, uri)) continue;
                String goneUrl = o.optString("url", "");
                if (!goneUrl.isEmpty()) prunedUrls.add(goneUrl);
                dlHistory.remove(i);
                removed++;
            }
            if (removed > 0) saveHistoryLocked();
            return removed;
        }
    }

    /** 历史核对节流：页面 800ms 轮询一次，不必每次都查 uri */
    private static final long URI_CHECK_GAP_MS = 5_000L;
    private volatile long lastUriCheckAt = 0;

    /** 下载历史（JSON 数组，最新在前），给「下载管理」页 */
    @JavascriptInterface
    public String downloadHistory() {
        String out;
        synchronized (dlHistory) {
            loadHistoryLocked();
            syncWithDiskLocked(false);
            /* 本地文件没了 → 记录也跟着没（见 pruneMissingByUriLocked） */
            if (pruneMissingByUriLocked()) saveHistoryLocked();
            out = dlHistory.toString();
        }
        /* 出了锁再联动清台账，别把两把锁套在一起 */
        releasePendingForPruned();
        return out;
    }

    /**
     * 下载管理页的操作入口。
     *
     * json: {"action":"open|delete|retry|cancel|clear",
     *        "name":"x.apk","id":12,"url":"https://…","install":true,"sha":"…"}
     *
     *  - cancel：取消进行中的任务（走 downloadStatus 里的 id）
     *  - open  ：打开已完成文件（APK 直接拉安装器，其它按类型交给系统）
     *  - delete：删文件 + 删记录
     *  - retry ：按记录的原始地址重新下载
     *  - clear ：只清记录，不动文件
     */
    @JavascriptInterface
    public void downloadAction(String json) {
        try {
            final JSONObject o = new JSONObject(json == null ? "{}" : json);
            activity.runOnUiThread(() -> runDlAction(o));
        } catch (Throwable ignored) { }
    }

    private void runDlAction(JSONObject o) {
        String act = o.optString("action", "");
        try {
            if ("cancel".equals(act)) {
                long id = o.optLong("id", -1);
                if (id == 0) return;

                /* 限速任务是负数 id（见 throttledSeq）—— 它不在 DownloadManager
                   里，得从自己那张表里找，并去中断下载线程。
                   之前这里写的是 id <= 0 直接 return，会把限速任务的取消整个吞掉：
                   用户点「取消」，进度条照转，因为压根没人理他。 */
                if (id < 0) {
                    TlTask t = throttledTasks.remove(id);
                    if (t != null) {
                        t.running = false;
                        ThrottledDownloader.Handle h = t.handle;
                        if (h != null) h.cancel();
                        Toast.makeText(activity, "已取消下载 " + t.filename,
                                Toast.LENGTH_SHORT).show();
                    } else {
                        Toast.makeText(activity, "已取消", Toast.LENGTH_SHORT).show();
                    }
                    return;
                }

                DlTask t = downloads.remove(id);
                autoInstalls.remove(id);
                expectedShas.remove(id);
                DownloadManager dm = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm != null) {
                    try { dm.remove(id); } catch (Throwable ignored) { }
                }
                Toast.makeText(activity, t == null ? "已取消"
                        : "已取消下载 " + t.filename, Toast.LENGTH_SHORT).show();
                return;
            }
            final String name = o.optString("name", "");

            /*
              ⚠️ 以前这里有一行：

                  if (name.isEmpty() || name.contains("/") || ...) return;

              它挡在 open / delete / retry / clear **所有分支之前**，而
              「清空记录」根本不带 name（clearHistory 只发 {action:'clear'}）
              → name="" → 直接 return → **清空永远执行不到**。

              用户点「清空历史」没反应，就是这个。

              这行校验本意是防路径穿越（open/delete 要用 name 拼路径），
              但它只该管**需要 name 的那几个分支**。现在把 clear 提到它前面，
              并把校验各自下沉到用到的地方。
            */
            if ("clear".equals(act)) {
                /*
                  要不要连本地文件一起删。

                  以前这里**只清记录不动文件**，理由是「清列表」和「删文件」
                  是两回事。真用起来这是个坑：记录一清，那些文件在 App 里就
                  再也找不到了 —— 没有记录，也就没有「删除」这个入口。
                  它们变成谁也管不了的孤儿，一直占着空间，
                  用户只能自己跑去文件管理器翻 Download/githup/。

                  表现就是「点了清空，App 里的没了，手机上的还在」。
                  所以给个选择，默认那一项连文件一起删。
                */
                final boolean purge = o.optBoolean("purgeFiles", false);

                /* 位置信息必须在清记录**之前**抓出来 —— 记录一清就找不着了 */
                final java.util.List<String[]> victims = new java.util.ArrayList<>();
                synchronized (dlHistory) {
                    loadHistoryLocked();
                    if (purge) {
                        for (int i = 0; i < dlHistory.length(); i++) {
                            JSONObject h = dlHistory.optJSONObject(i);
                            if (h == null) continue;
                            /* 失败记录本来就没有文件，别去删 */
                            if (!h.optBoolean("ok", false)) continue;
                            String sv = h.optString("saved", "");
                            if (sv.isEmpty()) sv = h.optString("name", "");
                            victims.add(new String[]{
                                    h.optString("uri", ""),
                                    String.valueOf(h.optLong("dlId", -1L)),
                                    sv,
                                    h.optString("sub", ""),
                                    h.optString("url", "")
                            });
                        }
                    }
                    while (dlHistory.length() > 0) dlHistory.remove(0);
                    /* 记一笔「用户主动清空过」：置位后不再自动把磁盘上的文件
                     * 扫回历史，否则「清空记录」点完又冒出来，等于白点。
                     *
                     * 用 commit()：这个值一旦没落盘，下次启动历史为空时会
                     * 被补回逻辑重新填满 —— 用户看到的就是「清空没作用」。 */
                    try {
                        activity.getSharedPreferences(PREF_DL, Context.MODE_PRIVATE)
                                .edit().putBoolean(SP_DL_CLEARED, true).commit();
                    } catch (Throwable ignored) { }
                    saveHistoryLocked();
                }

                /*
                  下载记录都没了，「下载完等着装」的那一行也就没有依托了 ——
                  文件是我们替用户暂存的，他清历史就等于说这次下载作废。
                  不清的话会留下一堆永远停在待安装、点开又找不到文件的幽灵行。

                  已经装上的行只清标记、保留台账（应用都装上了，这条有意义）；
                  没装上的整行删掉。
                */
                int[] cleared = null;
                try {
                    cleared = AppLibrary.get(activity).clearAllPending();
                } catch (Throwable ignored) { }

                final int pend = cleared == null ? 0 : (cleared[0] + cleared[1]);
                final String base = purge ? "已清空记录" : "已清空下载记录";

                if (!purge || victims.isEmpty()) {
                    Toast.makeText(activity,
                            base + (pend > 0 ? "，待安装已清掉 " + pend + " 项" : ""),
                            Toast.LENGTH_SHORT).show();
                    return;
                }

                /* 删文件放到线程池：几十条记录要逐个问 MediaStore，
                   放主线程会把界面卡住。 */
                pool.execute(() -> {
                    int removed = 0;
                    for (String[] v : victims) {
                        boolean gone = false;
                        /* 有确切位置就按它删，最准 */
                        if (!v[0].isEmpty()) {
                            try { gone = deleteByUri(v[0]); } catch (Throwable ignored) { }
                        }
                        if (!gone) {
                            long id = -1L;
                            try { id = Long.parseLong(v[1]); } catch (Throwable ignored) { }
                            try {
                                gone = deleteDownloadedFile(id, v[2], v[3]);
                            } catch (Throwable ignored) { }
                        }
                        if (gone) removed++;
                    }
                    final int n = removed;
                    activity.runOnUiThread(() -> {
                        StringBuilder sb = new StringBuilder(base);
                        sb.append("，已删除 ").append(n).append(" 个文件");
                        if (victims.size() > n) {
                            sb.append("（").append(victims.size() - n)
                              .append(" 个本来就找不到了）");
                        }
                        if (pend > 0) sb.append("，待安装已清掉 ").append(pend).append(" 项");
                        Toast.makeText(activity, sb.toString(), Toast.LENGTH_LONG).show();
                    });
                });
                return;
            }

            /* 下面几个分支都要用 name 定位文件，校验放在这里 */
            if (name.isEmpty() || name.contains("/") || name.contains("\\") || name.contains("..")) return;
            if ("open".equals(act)) {
                /* 存在性判断也要走 resolve()：以前用 fileFor() 拼公共目录路径，
                 * Android 10+ 下明明文件在、却报「文件不在了」，点了没反应。 */
                String saved = o.optString("saved", "");
                if (saved.isEmpty()) saved = name;
                /* 子目录也要带上：文件按来源分目录存放（Download/githup/release/…），
                 * 只按名字去根目录找永远找不到 → 弹「文件不在了」。 */
                String sub = o.optString("sub", "");
                /*
                  ═══ 优先用记录的**确切落盘位置**（uri）═══

                  有 uri 就直接用它 —— 那是下载完成时系统告诉我们的真实位置，
                  不必再拿 saved + sub 去拼路径猜。
                */
                String openUri = o.optString("uri", "");
                boolean haveUri = !openUri.isEmpty() && uriAlive(openUri);
                if (!haveUri && !downloadedFileExists(saved, sub)) {
                    Toast.makeText(activity, "文件不在了（可能已被删除）", Toast.LENGTH_SHORT).show();
                    return;
                }
                Uri u = haveUri ? android.net.Uri.parse(openUri)
                        : DownloadProvider.uriFor(activity.getPackageName(), saved, sub);
                if (saved.toLowerCase().endsWith(".apk")) {
                    openInstaller(u);
                } else {
                    Intent i = new Intent(Intent.ACTION_VIEW);
                    i.setDataAndType(u, DownloadProvider.mimeFor(saved));
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    try {
                        activity.startActivity(i);
                    } catch (Exception e) {
                        Toast.makeText(activity, "没有能打开这类文件的应用", Toast.LENGTH_SHORT).show();
                    }
                }
            } else if ("delete".equals(act)) {
                /* 按 DownloadManager 的下载 id 删（如果这条记录还带着 id），
                 * 以前那种 fileFor(name).delete() 在 Android 10+ 上删的是
                 * 沙箱里的影子路径，文件纹丝不动。 */
                long dlId = o.optLong("dlId", -1);
                /* 用落盘名定位真文件：撞名时被改成 foo-2.apk 的那一半，
                 * 只有 saved 指得对，原名会删错（甚至删到另一条记录的文件）。 */
                String saved = o.optString("saved", "");
                if (saved.isEmpty()) saved = name;
                /* 子目录要带上：文件按来源分目录存放（Download/githup/release/…），
                 * 不带的话只删得到根目录的同名文件，子目录里的那个删不掉 ——
                 * 用户点了删除，文件还在，下次同步又把它补回来。 */
                String sub = o.optString("sub", "");
                /*
                  有确切位置就按它删 —— 不会误伤同名文件，
                  也不会因为拼错路径而「删了但文件还在」。
                */
                String delUri = o.optString("uri", "");
                boolean gone = !delUri.isEmpty() && deleteByUri(delUri);
                if (!gone) gone = deleteDownloadedFile(dlId, saved, sub);
                removeHistoryLocked(dlId, saved);
                /*
                  单条删除同理：这一条历史没了，它对应的那次「下载完等安装」
                  也该跟着作废（和「清空全部」是同一个道理，只是范围小一点）。

                  按原始 URL 去台账里找 —— 历史记录里的 url 是下载时的原地址，
                  台账里记的 installed_url / latest_url 也是它，对得上。
                */
                try {
                    AppLibrary.get(activity).clearPendingByUrl(o.optString("url", ""));
                } catch (Throwable ignored) { }
                Toast.makeText(activity, gone ? "已删除文件和记录"
                                : "记录已删除，文件没能删掉（可能已被系统或其它应用占用）",
                        Toast.LENGTH_LONG).show();
            } else if ("retry".equals(act)) {
                String url = o.optString("url", "");
                if (url.isEmpty()) {
                    Toast.makeText(activity, "这条记录太老了，重试不了", Toast.LENGTH_SHORT).show();
                    return;
                }
                enqueueDownload(url, name, null, null,
                        o.optBoolean("install", false), o.optString("sha", ""));
            }
            /* clear 已在前面单独处理（它没有 name，不能走这里的校验） */
        } catch (Throwable ignored) { }
    }

    /**
     * 从构建产物 ZIP 里解压出 APK 并交给系统安装器。
     * 一个包里可能有多个 APK（ABI 分包等），取体积最大的那个，通常才是完整包。
     */
    private void extractAndInstall(Uri zipUri, String zipName, String originUrl) {
        File dir = new File(activity.getFilesDir(), ApkProvider.DIR);
        dir.mkdirs();
        // 清掉上次解压的残留，避免装到旧版本
        File[] old = dir.listFiles();
        if (old != null) {
            for (File f : old) {
                try { f.delete(); } catch (Exception ignored) { }
            }
        }
        java.util.List<File> found = new java.util.ArrayList<>();
        try (InputStream in = activity.getContentResolver().openInputStream(zipUri)) {
            if (in == null) throw new java.io.IOException("cannot open " + zipName);
            ZipInputStream zis = new ZipInputStream(new java.io.BufferedInputStream(in));
            ZipEntry e;
            int count = 0;
            while ((e = zis.getNextEntry()) != null && count < 8) {
                if (e.isDirectory()) continue;
                String n = e.getName();
                if (n == null || !n.toLowerCase().endsWith(".apk")) continue;
                File out = new File(dir, safeName(new File(n).getName()));
                if (writeEntry(zis, out) > 0) {
                    found.add(out);
                    count++;
                }
            }
        } catch (Throwable t) {
            /* 解压都失败了，自然谈不上装上 —— 撤回「正在装」 */
            notifyUpdateAborted("extract-failed");
            toast("解压失败：" + zipName);
            return;
        }
        if (found.isEmpty()) {
            /* 压缩包里没有 APK，安装环节还没开始就断了 */
            notifyUpdateAborted("zip-no-apk");
            toast("压缩包里没有找到 APK，文件已保存在下载目录");
            return;
        }
        File best = found.get(0);
        for (File f : found) {
            if (f.length() > best.length()) best = f;
        }
        /* 解压出来的 APK 也是「从 githup 装的」，同样入账 */
        try {
            AppLibrary.trackFromApk(activity, originUrl, best);
        } catch (Throwable ignored) { }
        Uri uri = ApkProvider.uriFor(
                activity.getPackageName() + ApkProvider.AUTHORITY_SUFFIX, best.getName());
        openInstaller(uri);
    }

    private long writeEntry(ZipInputStream zis, File out) throws java.io.IOException {
        try (java.io.FileOutputStream fos = new java.io.FileOutputStream(out)) {
            byte[] buf = new byte[64 * 1024];
            int len;
            long total = 0;
            while ((len = zis.read(buf)) > 0) {
                fos.write(buf, 0, len);
                total += len;
                // 防御性上限：单个 APK 500MB
                if (total > 500L * 1024 * 1024) throw new java.io.IOException("apk too large");
            }
            return total;
        }
    }

    /*
      ═══ 原生提示统一接入错误日志 ═══

      以前这里只是弹一句话，完全没有采集。而 JsBridge 里 12 处 toast()
      有 9 处是出错提示 —— 于是「用户看得见、日志里没有」：
      保存失败、解压失败、找不到 APK，全都不留痕迹。

      前端 UI.toast 早就接了日志（UI.logTrouble），但那是 WebView 里的
      另一套，跟原生 Toast 毫无关系。现在两边对称。

      改这一处即可覆盖全部调用点，因为它们都得经过这里。
    */
    private void toast(final String msg) {
        logToastOnce(msg);
        activity.runOnUiThread(() -> Toast.makeText(activity, msg, Toast.LENGTH_LONG).show());
    }

    /** 同一句只记一次：自动重试能把同一句刷上百遍，淹没真正有价值的首条 */
    private static final java.util.Set<String> LOGGED_TOASTS =
            java.util.Collections.synchronizedSet(new java.util.HashSet<String>());

    /**
     * 提示里像是出错的，顺手记一笔。
     *
     * <p>用词保守 —— 只认明确的出错词。「已保存到相册」这类正常
     * 反馈绝不能记成错误，否则日志会被成功提示刷满，比没有还糟。
     */
    private void logToastOnce(String msg) {
        if (msg == null || msg.isEmpty()) return;
        if (!looksLikeTrouble(msg)) return;
        if (!LOGGED_TOASTS.add(msg)) return;        // 同一句已记过
        try {
            LogBook.error(activity, "原生提示", msg);
        } catch (Throwable ignored) {
            /* 采集自己崩了绝不能影响 App 主流程 */
        }
    }

    private static final String[] TROUBLE_WORDS = {
            "失败", "出错", "错误", "异常", "不可用", "无法", "没能", "没成功",
            "超时", "中断", "拒绝", "找不到", "不存在", "已停止", "拦截", "阻止",
            "连不上", "没反应", "被限制", "已过期", "不完整"
    };

    private static boolean looksLikeTrouble(String msg) {
        for (String w : TROUBLE_WORDS) {
            if (msg.contains(w)) return true;
        }
        return false;
    }

    /** 用系统安装器打开 APK。Android 7.0+ 必须走 content:// 并授予临时读权限。 */
    private void openInstaller(Uri uri) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
            } else {
                i.setDataAndType(uri, "application/vnd.android.package-archive");
            }
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(i);
        } catch (Exception e) {
            /* 连安装器都拉不起来（ROM 屏蔽 / 没声明权限），这次更新等于没发生 */
            notifyUpdateAborted("installer-unavailable");
            Toast.makeText(activity, "请在下载目录中找到该 APK 并安装", Toast.LENGTH_LONG).show();
        }
    }

    private static String safeName(String n) {
        if (n == null || n.isEmpty()) return "download";
        return n.replaceAll("[\\\\/:*?\"<>|]", "_");
    }

    @JavascriptInterface
    public void haptic() {
        activity.runOnUiThread(() -> {
            try {
                Vibrator v = (Vibrator) activity.getSystemService(Context.VIBRATOR_SERVICE);
                if (v == null) return;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    v.vibrate(VibrationEffect.createOneShot(12, VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    v.vibrate(12);
                }
            } catch (Exception ignored) {
            }
        });
    }

    @JavascriptInterface
    public void clearCache() {
        activity.runOnUiThread(() -> webView.clearCache(true));
    }

    /**
     * 真实的安全区高度（像素），给前端当 --safe-t / --safe-b 用。
     *
     * ⚠️ 为什么必须从原生拿，不能只靠 CSS 的 env(safe-area-inset-top)：
     * Android WebView 对 safe-area-inset-* 的支持**不可靠** ——
     * 它只在特定条件下（viewport-fit=cover + 部分 WebView 版本）才返回非 0，
     * 而且返回的是「刘海高度」而不是「状态栏高度」，两者在大多数机型上并不相等。
     * 实测影响：本应用是 edge-to-edge（SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN），
     * WebView 铺满整个屏幕、含被状态栏盖住的那一条。前端如果拿不到状态栏高度，
     * 顶栏就会被状态栏压住一截，看起来「标题位置不对 / 上面空一大块」。
     *
     * 返回 [状态栏高度, 底部还需让出量, 左侧安全区, 右侧安全区, 导航栏模式]，
     * 单位都是设备像素，失败时退化成 [0,0,0,0,0]，前端会退回 CSS env()。
     *
     * ⚠️ 第 2 位不是「导航栏有多高」，是「页面自己还要再让多少」——
     *    这两者经常被弄混，而朴素样式下底栏离屏幕底边一大截就栽在这儿。
     *    取值逻辑见 bottomInsetPx()。
     *
     * 左右两个值是「适配市面所有机型」补上的：
     *   · 横屏时刘海/挖孔跑到屏幕左右两侧，内容会被挖孔切掉一块；
     *   · 曲面屏（部分魅族、华为）左右本来就有不可触控的弧面；
     *   · 某些 ROM（Flyme 的「隐藏刘海」、MIUI 的「屏幕顶部显示」）会把内容
     *     横向挤进系统区，各家行为不一致，只能量出来交给 CSS 处理。
     *
     * 第 5 位（导航栏模式）不参与排版，只写进 html[data-navmode] 供诊断：
     *   0=未知 / 1=三键 / 2=两键 / 3=手势 / 9=没有软导航栏。
     */
    @JavascriptInterface
    public String safeInsets() {
        int top = 0, left = 0, right = 0, mode = 0;
        try {
            Resources r = activity.getResources();
            int idTop = r.getIdentifier("status_bar_height", "dimen", "android");
            if (idTop > 0) top = r.getDimensionPixelSize(idTop);
            mode = navBarMode();

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                /* statusBars 的 top 是准的；左右两块要把 displayCutout
                   一起算进来 —— 只算 systemBars 的话横屏刘海那一条会漏掉。 */
                int[] s = probeSystemBar(top);
                top = s[0];
                left = s[1];
                right = s[2];
            }
        } catch (Throwable ignored) {
        }
        return "[" + top + "," + bottomInsetPx() + "," + left + "," + right + "," + mode + "]";
    }

    /** 探针三种结果：WebView 够不够得到屏幕最底边。 */
    private static final int REACH_UNKNOWN = 0;
    private static final int REACH_YES = 1;
    private static final int REACH_NO = 2;

    /**
     * 页面底部到底还要让出多少 —— 这是 --safe-b 唯一该拿的数。
     *
     * ⚠️ 旧实现踩了两个坑，而且都只在「一部分机器」上发作，所以一直是
     *    「有的手机上才离家出走」，难查也难复：
     *
     *   坑一：SDK < 30 那条分支直接读 navigation_bar_height 资源。
     *      那是 ROM 写死的上限值（常见 48dp）—— **跟这台机器现在到底画没画
     *      导航栏、画了多高，完全没有对应关系**：
     *        · 手势导航：屏幕底部只有一条细线，资源里照样是 48dp；
     *        · 实体 Home / mBack 的机子：压根没有软导航栏，资源里也照样 48dp。
     *      minSdk 是 24，Android 7~10 全部走这条分支 —— 中招的就是它们。
     *      同一份代码里上面还写着「手势导航下导航栏高度是很小的，不能写死
     *      48dp」，可那条约束只落实在 SDK >= 30 的支路上，else 里照旧写死。
     *
     *   坑二：重复让位。
     *      MainActivity 只声明了 LAYOUT_FULLSCREEN，**没有** LAYOUT_HIDE_NAVIGATION。
     *      换言之系统已经替我们把导航栏那条留白留出来了 —— WebView 本身的矩形
     *      就不含它。这种机器上再往前端塞一层 48dp，等于凭空多出一块，
     *      底栏当然对不上屏幕底边。
     *
     * 这里改成量：拿 WebView 自己在屏幕坐标里的下沿去比屏幕真实底边。
     *  · 够不到 → 系统已经留白了，页面自己**不用再让**，返回 0；
     *  · 够得到 → 页面确实铺到了屏幕底，那要看系统条这会儿有没有画出来，
     *    没画（全屏看视频、输入法改了 flags）返回 0，画了才返回它真实高度。
     *
     * 这套判据不依赖任何「照配置估算」的量，ROM 怎么改都一样成立。
     * 量不出来时同样返回 0 —— 宁可贴底，也不要让底栏飘在半空中。
     */
    private int bottomInsetPx() {
        try {
            int navPx = 0;
            boolean navVisible = true;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                WindowInsets ins = activity.getWindow().getDecorView().getRootWindowInsets();
                if (ins != null) {
                    navVisible = ins.isVisible(WindowInsets.Type.navigationBars());
                    navPx = ins.getInsets(WindowInsets.Type.navigationBars()).bottom;
                } else {
                    return 0;   // 连 insets 都没有，别猜
                }
            } else {
                int idBot = activity.getResources()
                        .getIdentifier("navigation_bar_height", "dimen", "android");
                if (idBot > 0) navPx = activity.getResources().getDimensionPixelSize(idBot);
            }
            return decideBottomInset(reachScreenBottom(), navPx, navVisible);
        } catch (Throwable ignored) {
            return 0;
        }
    }

    /**
     * 把「够不够得到 + 系统条多大 + 画没画」折成一个该让的数。
     * 抽成纯函数是为了能照着同一份判据写单测，没有别的意思。
     */
    static int decideBottomInset(int reach, int navPx, boolean navVisible) {
        if (navPx < 0) navPx = 0;
        switch (reach) {
            case REACH_NO:
                return 0;                       // 系统已留白，页面不再让一次
            case REACH_YES:
                return navVisible ? navPx : 0;  // 真铺到底：只在系统条露出来时才让
            default:
                return 0;                       // 量不出来就别猜
        }
    }

    /**
     * WebView 的下沿能不能碰到屏幕最底边。
     *
     * 用 getRealMetrics 拿的是**含系统装饰区**的真实屏幕高（getDefaultDisplay
     * 的另一组 METRICS 会被状态栏/导航栏扣掉，不能用），
     * getLocationOnScreen 拿的是 View 在屏幕坐标系里的位置 —— 两者同坐标系。
     *
     * 布局还没走完时宽高为 0，这时返回 UNKNOWN，绝不能当成「贴到底」。
     */
    private int reachScreenBottom() {
        View v = webView;
        if (v == null) v = activity.getWindow().getDecorView();
        if (v == null || v.getWidth() <= 0 || v.getHeight() <= 0) return REACH_UNKNOWN;
        int[] loc = new int[2];
        v.getLocationOnScreen(loc);
        DisplayMetrics dm = new DisplayMetrics();
        try {
            activity.getWindowManager().getDefaultDisplay().getRealMetrics(dm);
        } catch (Throwable t) {
            return REACH_UNKNOWN;
        }
        if (dm.heightPixels <= 0) return REACH_UNKNOWN;
        /* 留 1px 容差：某些 ROM 因为舍入会让 View 差一个像素够不到 */
        return (loc[1] + v.getHeight()) >= dm.heightPixels - 1 ? REACH_YES : REACH_NO;
    }

    @android.annotation.TargetApi(Build.VERSION_CODES.R)
    private int[] probeSystemBar(int fallbackTop) {
        int[] out = new int[]{fallbackTop, 0, 0};
        try {
            WindowInsets ins = activity.getWindow().getDecorView().getRootWindowInsets();
            if (ins == null) return out;
            out[0] = ins.getInsets(WindowInsets.Type.statusBars()).top;
            android.graphics.Insets side = ins.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            out[1] = side.left;
            out[2] = side.right;
        } catch (Throwable ignored) {
        }
        return out;
    }

    /**
     * 当前导航栏形态：0=未知 / 1=三键 / 2=两键 / 3=手势 / 9=没有软导航栏。
     *
     * config_navBarInteractionMode 是 AOSP 与各主流 ROM 都会写的一条内部常量
     * （0=三键 1=两键 2=手势），比 WindowInsets 更早可用，也不受「这会儿
     * 临时隐藏了没有」影响。取不到时退一步：ViewConfiguration 报告有实体
     * 菜单键的老机型没有软导航栏，归到 9。
     */
    private int navBarMode() {
        try {
            Resources r = activity.getResources();
            int id = r.getIdentifier("config_navBarInteractionMode", "integer", "android");
            if (id > 0) {
                switch (r.getInteger(id)) {
                    case 0: return 1;
                    case 1: return 2;
                    case 2: return 3;
                    default: return 0;
                }
            }
        } catch (Throwable ignored) {
        }
        try {
            if (ViewConfiguration.get(activity).hasPermanentMenuKey()) return 9;
        } catch (Throwable ignored) {
        }
        return 0;
    }

    @JavascriptInterface
    public void setStatusBar(String colorHex) {
        activity.runOnUiThread(() -> {
            try {
                /* ⚠️ 传进来的实色会被**忽略**，状态栏/导航栏一律保持透明。
                 *
                 * 原因：状态栏是盖在 WebView 之上的一条系统绘制区。给它上实色，
                 * 就等于在页面顶部贴了一条不透明的色带 —— 顶栏的毛玻璃再怎么调，
                 * 上面那一条永远是死白/死黑，看起来就是「标题被顶下去、上方空一块」。
                 * 透明之后露出来的是 WebView 里顶栏自己的玻璃，玻璃才能一直糊到
                 * 屏幕最顶上（iOS 就是这个行为）。
                 *
                 * 参数保留不删：前端还在按主题传 #ffffff / #010409，只是不再采用。
                 * 这里仍然按颜色算一次明暗，用来决定状态栏图标是深色还是浅色。 */
                int color = android.graphics.Color.parseColor(colorHex);
                boolean light = isLightColor(color);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    activity.getWindow().setStatusBarColor(android.graphics.Color.TRANSPARENT);
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    View decor = activity.getWindow().getDecorView();
                    int flags = decor.getSystemUiVisibility();
                    if (light) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    else flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    /* 保持 edge-to-edge：内容继续延伸到状态栏底下，
                       否则透明状态栏会让顶栏整体下移，又变成「上面空一块」。 */
                    flags |= View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE;
                    decor.setSystemUiVisibility(flags);
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    activity.getWindow().setNavigationBarColor(android.graphics.Color.TRANSPARENT);
                    View decor = activity.getWindow().getDecorView();
                    int flags = decor.getSystemUiVisibility();
                    if (light) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                    else flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                    decor.setSystemUiVisibility(flags);
                }
            } catch (Exception ignored) {
            }
        });
    }

    private static boolean isLightColor(int color) {
        double lum = (0.299 * android.graphics.Color.red(color)
                + 0.587 * android.graphics.Color.green(color)
                + 0.114 * android.graphics.Color.blue(color)) / 255.0;
        return lum > 0.6;
    }

    /**
     * 系统当前是否处于深色模式。
     *
     * 为什么需要这个接口：前端「跟随系统」原来只靠 CSS 的
     * prefers-color-scheme 媒体查询判断，但在 Android WebView 里这个查询
     * 并不可靠 —— 它受 WebSettings 的 force-dark / algorithmic-darkening
     * 影响，部分机型/WebView 版本下会一直返回 light，或者反过来一直返回
     * dark，导致「系统浅色、App 里却按深色渲染」这种错位。
     * Configuration.uiMode 是系统给的权威值，不受 WebView 配置干扰，
     * 所以把它作为「跟随系统」的唯一依据交给前端。
     */
    @JavascriptInterface
    public boolean systemDark() {
        try {
            int mode = activity.getResources().getConfiguration().uiMode
                    & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
            return mode == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        } catch (Exception e) {
            return false;
        }
    }

    @JavascriptInterface
    public String version() {
        try {
            return activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "1.0.0";
        }
    }

    @JavascriptInterface
    public void exit() {
        activity.runOnUiThread(() -> activity.finish());
    }

    /* ---------------- 应用库 ---------------- */

    private AppLibrary lib() {
        return AppLibrary.get(activity);
    }

    /** 台账全量（每行已并进本机真实状态）。 */
    @JavascriptInterface
    public String libList() {
        try {
            return lib().list();
        } catch (Throwable t) {
            return "[]";
        }
    }

    /** 枚举本机已装应用，供「关联」时挑选。需要 QUERY_ALL_PACKAGES 才完整。 */
    @JavascriptInterface
    public String libScan() {
        try {
            return lib().scan();
        } catch (Throwable t) {
            return "[]";
        }
    }

    @JavascriptInterface
    public boolean libAdd(String pkg, String owner, String repo, String name,
                          String tag, String asset, String url) {
        try {
            return lib().add(pkg, owner, repo, name, tag, asset, url);
        } catch (Throwable t) {
            return false;
        }
    }

    @JavascriptInterface
    public boolean libRemove(String pkg) {
        try {
            return lib().remove(pkg);
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 前端查完 releases/latest 之后回填「最新版」这一半。
     * 传进来的 json：{tag, vName, vCode, asset, url, size, notes}
     */
    @JavascriptInterface
    public boolean libSetLatest(String pkg, String json) {
        try {
            return lib().setLatest(pkg, json);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 装完了：把已装版本挪到最新那一档。 */
    @JavascriptInterface
    public boolean libMarkInstalled(String pkg, String tag, String vName, long vCode) {
        try {
            return lib().markInstalled(pkg, tag, vName, vCode);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 已下载、还没装上。 */
    @JavascriptInterface
    public boolean libSetPending(String pkg, boolean pending) {
        try {
            return lib().markPending(pkg, pending);
        } catch (Throwable t) {
            return false;
        }
    }

    /** key：ignore / pre / skipped / regex */
    @JavascriptInterface
    public boolean libSetFlag(String pkg, String key, String value) {
        try {
            return lib().setFlag(pkg, key, value);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 与 PackageManager 对账，返回 {dropped,resolved,changed}。 */
    @JavascriptInterface
    public String libSync() {
        try {
            return lib().sync();
        } catch (Throwable t) {
            return "{\"dropped\":0,\"resolved\":0,\"changed\":0}";
        }
    }

    @JavascriptInterface
    public String libExport() {
        try {
            return lib().exportJson();
        } catch (Throwable t) {
            return "[]";
        }
    }

    @JavascriptInterface
    public String libImport(String json) {
        try {
            return lib().importJson(json);
        } catch (Throwable t) {
            return "{\"imported\":0,\"skipped\":0,\"missing\":0}";
        }
    }

    /**
     * 下载并安装，同时记下「这个包来自哪个仓库」—— 装完自动进应用库。
     *
     * 这就是「在 githup 里下的应用会自动关联」的实现：下载时把
     * owner/repo/tag/asset 记在 URL 上，装之前读出 APK 包名，两者一合
     * 就落成台账一行。用户不用再手动填 owner/repo。
     */
    @JavascriptInterface
    public void installApkTracked(String url, String filename, String headersJson,
                                  String owner, String repo, String tag, String assetName,
                                  String category) {
        try {
            /* 带上 activity：来源要往本机落一份，不能只存内存（见
               AppLibrary.noteTrack 的注释 —— 进程被杀就全丢了）。 */
            AppLibrary.noteTrack(activity, url, owner, repo, tag, assetName);
        } catch (Throwable ignored) { }
        /* 走 7 参那个重载：参数位置写全，别让重载解析去猜。 */
        enqueueDownload(url, filename, headersJson, null, true, null, category);
    }

    /* ============================================================
     * 单文件直取：仓库里的文件不走 DownloadManager
     * ============================================================ */

    /** 直取的上限。超过就退回原来的通道（那本来就是为大文件准备的）。 */
    private static final long DIRECT_FETCH_MAX_BYTES = 8L * 1024 * 1024;

    /**
     * 这是不是「仓库里的单个文件」？
     *
     * 只认两类地址：
     *   raw.githubusercontent.com/...          最常见
     *   github.com/{o}/{r}/raw|blob/{ref}/...   网页地址转来的
     * 刻意**不认** releases/download（Release 附件）和 codeload（源码包）——
     * 那两类是大文件，正是要靠镜像救的，别抢。
     */
    private static boolean isRawFileUrl(String url) {
        if (url == null || url.isEmpty()) return false;
        String h = DownloadChannels.hostOf(url);
        if (h == null) return false;
        if ("raw.githubusercontent.com".equals(h)) return true;
        if (!"github.com".equals(h)) return false;
        String lc = url.toLowerCase(java.util.Locale.US);
        return lc.contains("/raw/") || lc.contains("/blob/");
    }

    /**
     * 直接把文件抓下来（在线程池里跑）。
     *
     * 为什么单独开这一条路：
     *   下载通道（DownloadManager + 第三方加速镜像）是为**大文件**准备的 ——
     *   Release 附件、源码包会 302 到对象存储，国内不少宽带下确实又慢又断，
     *   所以要靠镜像和自动换道去救。
     *
     *   但仓库里的单个文件根本不是同一个量级的东西：它走的是
     *   raw.githubusercontent.com，而 App 自己读列表、README、代码用的
     *   也是同一个域名、同一套原生网络栈 —— 那条路本来就是通的。
     *
     *   把一个几 KB 的 yml 送进 DownloadManager 再绕一圈第三方镜像，等于
     *   放着自家通畅的路不走，去挤一条为救急修的、随时可能限流或关停的路。
     *   用户看到的就是「下个小文件也慢得要死、还老失败，换网络也没用」——
     *   换网络当然没用，卡的不是用户的网，是那台第三方代理服务器。
     *
     * 所以单文件走原生栈直取：不镜像、不换道、不看 Star，秒完。
     */
    private void startDirectFileFetch(String url, String name, String headersJson,
                                      String category) {
        pool.execute(() -> {
            boolean ok = false;
            long bytes = 0;
            String saved = name;
            String reason = "";
            try {
                Map<String, String> headers = new HashMap<>();
                try {
                    if (headersJson != null && !headersJson.isEmpty()) {
                        JSONObject j = new JSONObject(headersJson);
                        java.util.Iterator<String> it = j.keys();
                        while (it.hasNext()) {
                            String k = it.next();
                            String v = j.optString(k, "");
                            if (!v.isEmpty()) headers.put(k, v);
                        }
                    }
                } catch (Throwable ignored) { }

                Http.RawResponse r = Http.requestRaw("GET", url, headers);
                if (r == null || r.code < 200 || r.code >= 300) {
                    reason = r == null ? "网络不通" : ("HTTP " + r.code);
                } else if (r.body == null || r.body.length == 0) {
                    reason = "内容是空的";
                } else {
                    bytes = r.body.length;
                    File tmp = new File(activity.getCacheDir(), safeName(name));
                    try (java.io.OutputStream out = new java.io.FileOutputStream(tmp)) {
                        out.write(r.body);
                    }
                    String[] outName = new String[1];
                    moveToPublicDownloads(tmp, name, category, outName);
                    if (outName[0] != null && !outName[0].isEmpty()) saved = outName[0];
                    try { tmp.delete(); } catch (Throwable ignored) { }
                    ok = true;
                }
            } catch (Throwable t) {
                reason = t.getMessage() == null ? "取不到" : t.getMessage();
            }

            final boolean fOk = ok;
            final long fBytes = bytes;
            final String fSaved = saved;
            final String fReason = reason;
            activity.runOnUiThread(() -> {
                /* 历史照常记一笔，下载管理页里能看到 */
                try {
                    JSONObject o = new JSONObject();
                    o.put("name", name);
                    o.put("saved", fSaved);
                    o.put("url", url);
                    o.put("dlId", -1);
                    o.put("ok", fOk);
                    o.put("bytes", fBytes);
                    o.put("time", System.currentTimeMillis());
                    o.put("install", false);
                    o.put("sha", "");
                    o.put("channel", "直取");
                    synchronized (dlHistory) {
                        loadHistoryLocked();
                        prependHistoryLocked(o);
                        dedupeLatestLocked();
                        while (dlHistory.length() > HISTORY_MAX) {
                            dlHistory.remove(dlHistory.length() - 1);
                        }
                        saveHistoryLocked();
                    }
                } catch (Throwable ignored) { }

                if (!fOk) {
                    Toast.makeText(activity,
                            "下载失败" + (fReason.isEmpty() ? "" : "：" + fReason),
                            Toast.LENGTH_SHORT).show();
                    return;
                }
                Toast.makeText(activity,
                        "已保存到 Download/" + DOWNLOAD_SUBDIR + "/" + fSaved,
                        Toast.LENGTH_SHORT).show();
            });
        });
    }

    /**
     * 用**已经下载好**的那个包直接拉起系统安装器，不再下一遍。
     *
     * 场景：用户在系统安装器上点了取消，回到应用库 —— 文件还在本地
     * （ApkProvider 目录里），再下一遍纯属浪费流量和时间。
     *
     * @return true 表示确实拉起了安装器；false 表示文件没了，调用方该重新下载。
     */
    @JavascriptInterface
    public boolean libInstallPending(String pkg) {
        if (pkg == null || pkg.isEmpty()) return false;
        try {
            String fileName = lib().pendingFile(pkg);
            if (fileName == null || fileName.isEmpty()) return false;
            Uri uri = ApkProvider.uriFor(
                    activity.getPackageName() + ApkProvider.AUTHORITY_SUFFIX, fileName);
            final Uri u = uri;
            activity.runOnUiThread(() -> openInstaller(u));
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 改「这一行装的是哪个包」—— 一个仓库发多个包名时用来纠正错绑。 */
    @JavascriptInterface
    public boolean libSetInstalledAsset(String pkg, String assetName) {
        try {
            return lib().setInstalledAsset(pkg, assetName);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 钉住变体（arm64 / foss 等），传 null 或空串表示不钉。 */
    @JavascriptInterface
    public boolean libSetVariant(String pkg, String variant) {
        try {
            return lib().setVariant(pkg, variant);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 高级过滤：asset 正则 + 是否退到更旧的 release。 */
    @JavascriptInterface
    public boolean libSetAdvanced(String pkg, String regex, boolean fallbackOlder) {
        try {
            return lib().setAdvanced(pkg, regex, fallbackOlder);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 对一批 asset 名试跑正则，返回匹配到的那些（存之前先核对）。 */
    @JavascriptInterface
    public String libPreviewMatch(String assetNamesJson, String regex) {
        try {
            return AppLibrary.previewMatch(new JSONArray(assetNamesJson), regex).toString();
        } catch (Throwable t) {
            return "[]";
        }
    }

    /** 下载完成、等待安装：记下文件路径，这一行就停在这。 */
    @JavascriptInterface
    public boolean libMarkPending(String pkg, String tag, String assetName, String filePath) {
        try {
            return lib().markPending(pkg, tag, assetName, filePath);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 用存过的匹配下载失败一次 —— 下次别再信它，重新查 release。 */
    @JavascriptInterface
    public boolean libNotePendingFailure(String pkg) {
        try {
            return lib().notePendingFailure(pkg);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 丢弃停放的安装（删文件 + 清状态）。 */
    @JavascriptInterface
    public boolean libDiscardPending(String pkg) {
        try {
            return lib().discardPending(pkg);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 停放的安装包还在不在。 */
    @JavascriptInterface
    public boolean libPendingFileExists(String pkg) {
        try {
            return lib().pendingFileExists(pkg);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 拉起应用。返回 false 说明没装 / 没有可启动的入口。 */
    @JavascriptInterface
    public boolean libOpen(String pkg) {
        try {
            Intent i = activity.getPackageManager().getLaunchIntentForPackage(pkg);
            if (i == null) return false;
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(i);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 设备主 ABI，如 arm64-v8a。
     * 一个仓库发多个 APK 时用它挑对架构 —— 光按体积挑会挑到错的那一个。
     */
    @JavascriptInterface
    public String libAbi() {
        try {
            String[] abis = android.os.Build.SUPPORTED_ABIS;
            return (abis != null && abis.length > 0) ? abis[0] : "";
        } catch (Throwable t) {
            return "";
        }
    }

    /**
     * 拉起系统卸载界面。
     *
     * ⚠️ targetSdk >= 28 起，用 ACTION_DELETE 必须在 manifest 里声明
     *    REQUEST_DELETE_PACKAGES。缺了它系统**静默忽略**这条 Intent ——
     *    不抛异常、不弹窗、什么都不发生，从 App 这头看 startActivity 明明
     *    成功了。komi 的 manifest 里有这条，所以它能弹出来。
     *
     * 所以这里做两件事：
     *   1. 用 resolveActivity 先确认真有 Activity 接得住；
     *   2. 接不住就退到系统「应用信息」页（在那儿也能卸载），并且
     *      **如实返回**是否真的弹出了卸载框 —— 不能给前端一个假的成功。
     *
     * @JavascriptInterface 跑在 JavaBridge 线程，startActivity 必须回主线程，
     * 和项目里 share() / openInApp() 一致。
     */
    @JavascriptInterface
    public boolean libUninstall(String pkg) {
        if (pkg == null || pkg.isEmpty()) return false;
        try {
            Intent del = new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + pkg));
            del.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            boolean ok = del.resolveActivity(activity.getPackageManager()) != null;
            activity.runOnUiThread(() -> {
                try {
                    if (ok) {
                        activity.startActivity(del);
                    } else {
                        // 没有能接 ACTION_DELETE 的：退到应用信息页
                        Intent info = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                                Uri.parse("package:" + pkg));
                        info.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        activity.startActivity(info);
                    }
                } catch (Throwable ignored) {
                }
            });
            return ok;
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 立刻核对一遍下载历史：本地文件已经不在的，记录也清掉。
     *
     * 用在「用户在文件管理器里删了文件，App 里还留着记录」这个场景。
     * 平时 downloadHistory() 会自己核对，但有 5 秒节流，而且有一条
     * 安全网会拦 —— 所以给个手动入口，让用户可以当场核一次。
     *
     * @return 清掉了几条
     */
    @JavascriptInterface
    public int pruneDownloadHistory() {
        try {
            int n = pruneMissingNow();
            /* 手动核对同样要联动：被剔掉那几条对应的待安装一并作废 */
            releasePendingForPruned();
            return n;
        } catch (Throwable t) {
            return 0;
        }
    }

    /** 有多少个应用可更新。纯本地查表，秒回。 */
    @JavascriptInterface
    public int libUpdateCount() {
        try {
            return lib().updateCount();
        } catch (Throwable t) {
            return 0;
        }
    }

    /** 台账里最早一次检查时间（毫秒）。前端据此做节流。 */
    @JavascriptInterface
    public long libOldestCheckedAt() {
        try {
            return lib().oldestCheckedAt();
        } catch (Throwable t) {
            return 0L;
        }
    }

    /**
     * 确认这个包真的不在了，就删掉台账里那一行。
     *
     * 为什么需要单独一个方法，而不是靠 libSync()：
     *   libSync() 带「防误删护栏」——扫描结果残缺时一个都不删（防的是
     *   Android 11+ 包可见性把整个应用库清空，komi 的 GH#748）。
     *   但**用户刚主动卸载**这个场景不该被护栏拦：人是自己点的卸载，
     *   卸载完这行还在，看起来就像没删掉。
     *
     * 所以这一条是「显式确认」路径：只针对这一个包名单点查一次，
     * 不在就删。护栏管自动扫描，这里管用户意图，两条路互不干扰。
     */
    @JavascriptInterface
    public boolean libRemoveIfGone(String pkg) {
        if (pkg == null || pkg.isEmpty()) return false;
        try {
            if (AppLibrary.probe(activity, pkg).present) return false;
            lib().remove(pkg);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }

}
