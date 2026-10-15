package com.hubmobile.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.method.LinkMovementMethod;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * 被判定为「非官方包」时唯一能看到的界面。
 *
 * 只有两条路：下载官方版，或者退出。没有「继续使用」。
 * 返回键也直接退出 —— 不给他绕回主界面的机会。
 */
public class BlockedActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        int pad = (int) (24 * getResources().getDisplayMetrics().density);

        ScrollView sv = new ScrollView(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(pad, pad * 2, pad, pad);
        box.setGravity(Gravity.CENTER_HORIZONTAL);

        TextView title = new TextView(this);
        title.setText("这个安装包不是官方版本");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setTextColor(Color.parseColor("#E5534B"));
        title.setGravity(Gravity.CENTER_HORIZONTAL);
        box.addView(title);

        TextView why = new TextView(this);
        why.setText("\n" + reasonText());
        why.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        why.setLineSpacing(6, 1.2f);
        why.setTextColor(Color.parseColor("#CCFFFFFF"));
        box.addView(why);

        TextView tip = new TextView(this);
        tip.setText("\n为了保护你的 GitHub 账号与数据，githup 不会在非官方包上运行。"
                + "请下载官方安装包覆盖安装（不用卸载，数据不丢）。");
        tip.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        tip.setLineSpacing(6, 1.2f);
        tip.setTextColor(Color.parseColor("#99FFFFFF"));
        box.addView(tip);

        Button dl = new Button(this);
        dl.setText("下载官方版本");
        dl.setAllCaps(false);
        dl.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = pad * 2;
        dl.setLayoutParams(lp);
        dl.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { openOfficial(); }
        });
        box.addView(dl);

        Button home = new Button(this);
        home.setText("打开开源主页");
        home.setAllCaps(false);
        home.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp2.topMargin = pad / 2;
        home.setLayoutParams(lp2);
        home.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW,
                            Uri.parse(GuardKeys.OFFICIAL_HOME)));
                } catch (Throwable ignored) { }
            }
        });
        box.addView(home);

        Button quit = new Button(this);
        quit.setText("退出");
        quit.setAllCaps(false);
        quit.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        LinearLayout.LayoutParams lp3 = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp3.topMargin = pad / 2;
        quit.setLayoutParams(lp3);
        quit.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { exit(); }
        });
        box.addView(quit);

        TextView url = new TextView(this);
        url.setText("\n" + GuardKeys.OFFICIAL_HOME);
        url.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        url.setGravity(Gravity.CENTER_HORIZONTAL);
        url.setMovementMethod(LinkMovementMethod.getInstance());
        box.addView(url);

        sv.addView(box);
        sv.setBackgroundColor(Color.parseColor("#0D1117"));
        setContentView(sv);
    }

    private String reasonText() {
        String d = App.sBrokenDetail;
        if (d == null || d.isEmpty()) d = "安装包内容已被修改";
        return "检测到：" + d + "\n（校验点 " + (App.sBrokenRing == 0 ? "—" : "第 " + App.sBrokenRing + " 环")
                + (App.sBrokenCode == null || App.sBrokenCode.isEmpty() ? "" : "，代码 " + App.sBrokenCode) + "）";
    }

    private void openOfficial() {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(GuardKeys.OFFICIAL_URL)));
        } catch (Throwable ignored) { }
    }

    /** 返回键不给退回去 */
    @Override
    public void onBackPressed() { exit(); }

    private void exit() {
        finishAffinity();
        android.os.Process.killProcess(android.os.Process.myPid());
    }
}
