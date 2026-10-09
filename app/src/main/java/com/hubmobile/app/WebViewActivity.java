package com.hubmobile.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * 应用内浏览器。
 * 用于在 App 内部打开 GitHub 页面（如「创建访问令牌」），
 * 与主界面共享 Cookie，用户登录态可复用。
 */
public class WebViewActivity extends Activity {

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_TITLE = "title";

    private WebView webView;
    /** 当前地址：渲染进程崩溃后重建要用它把页面拉回来 */
    private String currentUrl;
    private ProgressBar bar;
    private TextView titleView;
    private TextView urlView;
    private FrameLayout wrap;
    // 视频全屏（同 MainActivity：不接回调，点全屏按钮就没反应）
    private View customView;
    private WebChromeClient.CustomViewCallback customCb;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);


        String url = getIntent().getStringExtra(EXTRA_URL);
        String title = getIntent().getStringExtra(EXTRA_TITLE);
        if (TextUtils.isEmpty(title)) title = "浏览器";
        if (TextUtils.isEmpty(url)) { finish(); return; }

        // ---- 顶部工具条 ----
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);

        LinearLayout bar1 = new LinearLayout(this);
        bar1.setOrientation(LinearLayout.HORIZONTAL);
        bar1.setGravity(Gravity.CENTER_VERTICAL);
        bar1.setBackgroundColor(0xFF1F2328);
        int pad = dp(12);
        bar1.setPadding(pad, dp(10), pad, dp(10));

        TextView close = new TextView(this);
        close.setText("✕");
        close.setTextColor(Color.WHITE);
        close.setTextSize(18);
        close.setPadding(dp(8), dp(4), dp(16), dp(4));
        close.setOnClickListener(v -> finish());
        bar1.addView(close);

        LinearLayout titles = new LinearLayout(this);
        titles.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        titles.setLayoutParams(tp);

        titleView = new TextView(this);
        titleView.setText(title);
        titleView.setTextColor(Color.WHITE);
        titleView.setTextSize(14);
        titleView.setSingleLine(true);
        titleView.setEllipsize(TextUtils.TruncateAt.END);
        titles.addView(titleView);

        urlView = new TextView(this);
        urlView.setTextColor(0xFFB0B7BF);
        urlView.setTextSize(10);
        urlView.setSingleLine(true);
        urlView.setEllipsize(TextUtils.TruncateAt.END);
        urlView.setText(url);
        titles.addView(urlView);

        bar1.addView(titles);

        TextView external = new TextView(this);
        external.setText("↗");
        external.setTextColor(Color.WHITE);
        external.setTextSize(16);
        external.setPadding(dp(16), dp(4), dp(4), dp(4));
        external.setOnClickListener(v -> {
            try {
                Intent i = new Intent(Intent.ACTION_VIEW,
                        android.net.Uri.parse(webView.getUrl()));
                startActivity(i);
            } catch (Exception ignored) { }
        });
        bar1.addView(external);

        root.addView(bar1, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setVisibility(View.GONE);
        root.addView(bar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(2)));

        // ---- WebView ----
        /* 整套配置收在 makeWebView() 里：渲染进程被回收之后要按同一套规格
         * 再做一个顶上去，写两遍必然某一边漏一样。 */
        webView = makeWebView();

        wrap = new FrameLayout(this);
        wrap.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(wrap, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
        currentUrl = url;
        webView.loadUrl(url);
    }

    /** 配好一个完整的 WebView（首次进入和崩溃后重建都走这一条路） */
    private WebView makeWebView() {
        WebView webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        }
        CookieManager.getInstance().setAcceptCookie(true);
        /* 同 MainActivity：关掉 WebView 的算法深色化。
           这里的页面是我们自己排版的（README / issue 等），深色由 CSS 自己管，
           让 WebView 再反色一次只会把配色弄乱。 */
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                s.setAlgorithmicDarkeningAllowed(false);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                s.setForceDark(WebSettings.FORCE_DARK_OFF);
            }
        } catch (Throwable ignored) {
        }

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (bar == null) return;
                bar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
                bar.setProgress(newProgress);
            }

            @Override
            public void onReceivedTitle(WebView view, String t) {
                if (titleView != null && !TextUtils.isEmpty(t)) titleView.setText(t);
            }
            @Override
            public void onShowCustomView(View v, CustomViewCallback cb) {
                if (customView != null) { cb.onCustomViewHidden(); return; }
                customView = v;
                customCb = cb;
                if (webView != null) webView.setVisibility(View.GONE);
                if (wrap != null) {
                    wrap.addView(v, new FrameLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT));
                }
                getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String u = request.getUrl().toString();
                // 站内链接继续在内置浏览器打开
                if (u.startsWith("http://") || u.startsWith("https://")) return false;
                return true;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String u) {
                return !(u.startsWith("http://") || u.startsWith("https://"));
            }

            /**
             * 渲染进程没了（为什么一定要接这个回调，见 MainActivity 同名方法
             * 里的说明）。这里按同一套规格换一个新的 WebView 重新打开当前
             * 地址；实在起不来就直接收掉，不留一张不会动的图。
             */
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                return onRendererGone(view);
            }

            @Override
            public void onPageFinished(WebView view, String u) {
                if (urlView != null) urlView.setText(u);
                // 记下来：崩溃重建时要回到当时正在看的那一页，而不是最初的地址
                if (!TextUtils.isEmpty(u)) currentUrl = u;
            }
        });

        return webView;
    }

    private boolean onRendererGone(WebView dead) {
        try {
            WebView fresh = makeWebView();
            if (wrap == null) return true;
            wrap.removeView(dead);
            wrap.addView(fresh, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            webView = fresh;
            if (!TextUtils.isEmpty(currentUrl)) fresh.loadUrl(currentUrl);
            try { dead.destroy(); } catch (Throwable ignored) { }
        } catch (Throwable t) {
            finish();
        }
        return true;
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {           // 视频全屏中：先退出全屏
            exitFullscreen();
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    private void exitFullscreen() {
        if (customView == null) return;
        View v = customView;
        customView = null;
        if (v.getParent() instanceof ViewGroup) ((ViewGroup) v.getParent()).removeView(v);
        if (customCb != null) customCb.onCustomViewHidden();
        customCb = null;
        if (webView != null) webView.setVisibility(View.VISIBLE);
        getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
