package com.example.totp;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 主界面：显示 6 位验证码 + 30 秒倒计时进度条，可开启/关闭通知栏常驻显示。
 * 与通知读同一份数据（TOTPService.currentCode / currentSeconds），界面与通知数字永远一致。
 */
public class MainActivity extends Activity {

    private TextView tvCode;
    private TextView tvSeconds;
    private ProgressBar progressBar;
    private EditText etSecret;
    private Button btnNotify;
    private Button btnCopy;
    private Button btnSave;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable uiTicker = new Runnable() {
        @Override
        public void run() {
            updateCode();
            handler.postDelayed(this, 200);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(buildLayout());
        etSecret.setText(Prefs.getSecret(this));
        askNotificationPermission();
    }

    /** 纯代码构建界面（不依赖布局 XML，便于直接编译） */
    private View buildLayout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#F5F6F8"));
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        root.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("GitHub 两步验证器");
        title.setTextSize(20);
        title.setTextColor(Color.parseColor("#1F2328"));
        title.setGravity(Gravity.CENTER);
        root.addView(title);

        tvCode = new TextView(this);
        tvCode.setTextSize(46);
        tvCode.setTextColor(Color.parseColor("#0969DA"));
        tvCode.setGravity(Gravity.CENTER);
        tvCode.setPadding(0, pad, 0, 0);
        root.addView(tvCode);

        tvSeconds = new TextView(this);
        tvSeconds.setTextSize(14);
        tvSeconds.setTextColor(Color.parseColor("#656D76"));
        tvSeconds.setGravity(Gravity.CENTER);
        root.addView(tvSeconds);

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(30);
        root.addView(progressBar);

        btnCopy = new Button(this);
        btnCopy.setText("复制验证码");
        btnCopy.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                cm.setPrimaryClip(ClipData.newPlainText("totp", tvCode.getText()));
                Toast.makeText(MainActivity.this, "已复制：" + tvCode.getText(), Toast.LENGTH_SHORT).show();
            }
        });
        root.addView(btnCopy);

        btnNotify = new Button(this);
        btnNotify.setText("开启通知栏常驻显示");
        btnNotify.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Intent i = new Intent(MainActivity.this, TOTPService.class);
                i.setAction(TOTPService.ACTION_START);
                i.putExtra(TOTPService.EXTRA_SECRET, etSecret.getText().toString());
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(i);
                } else {
                    startService(i);
                }
                Toast.makeText(MainActivity.this, "通知已开启，下拉查看验证码与倒计时", Toast.LENGTH_SHORT).show();
            }
        });
        root.addView(btnNotify);

        Button btnStop = new Button(this);
        btnStop.setText("关闭通知");
        btnStop.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Intent i = new Intent(MainActivity.this, TOTPService.class);
                i.setAction(TOTPService.ACTION_STOP);
                startService(i);
                Toast.makeText(MainActivity.this, "通知已关闭", Toast.LENGTH_SHORT).show();
            }
        });
        root.addView(btnStop);

        TextView tip = new TextView(this);
        tip.setText("GitHub 两步验证密钥（Base32）");
        tip.setTextSize(13);
        tip.setTextColor(Color.parseColor("#656D76"));
        tip.setPadding(0, pad, 0, 0);
        root.addView(tip);

        etSecret = new EditText(this);
        etSecret.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        etSecret.setSingleLine(true);
        root.addView(etSecret);

        btnSave = new Button(this);
        btnSave.setText("保存密钥");
        btnSave.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Prefs.setSecret(MainActivity.this, etSecret.getText().toString());
                Toast.makeText(MainActivity.this, "已保存", Toast.LENGTH_SHORT).show();
            }
        });
        root.addView(btnSave);

        return root;
    }

    /** 刷新界面上的验证码与倒计时（与通知同源） */
    private void updateCode() {
        String code = TOTPService.generateTOTP(Prefs.getSecret(this));
        int left = 30 - (int) ((System.currentTimeMillis() / 1000) % 30);
        tvCode.setText(code);
        tvSeconds.setText(left + " 秒后刷新");
        progressBar.setProgress(30 - left);
        TOTPService.currentCode = code;
    }

    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        handler.post(uiTicker);
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacks(uiTicker);
    }
}
