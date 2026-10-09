package com.hubmobile.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 开机自启：把通知栏的动态码恢复出来。
 *
 * 重启手机后通知会消失 —— 用户要的正是「随时能在通知栏看到码」，
 * 重启后就没了显然不算数。这里在开机完成时把服务重新拉起来把通知挂回去。
 *
 * 说明几点 ——
 *   · 只在「该显示」的情况下才做事：TotpService.sync 内部会先看
 *     功能是否开启（现在默认开启）以及有没有账户，没账户时一条通知都不挂；
 *   · 只注册 BOOT_COMPLETED，不监听乱七八糟的系统事件，
 *     尽量减少被系统判定为「后台耗电」的机会。
 *   · 部分国产 ROM（MIUI / EMUI / ColorOS 等）对自启动管得严，
 *     光有广播还不够，用户需要在系统设置里再允许一次。
 *
 *   早先这里读的是设置页那个「后台显示动态码」开关，开关已按用户要求删除，
 *   现在读的是同一个默认值。
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;   // 升级覆盖安装后也恢复一次，逻辑同上
        }
        try {
            TotpService.sync(context);
        } catch (Throwable ignored) {
            // 开机广播里任何异常都不能往外抛，否则会被系统记一笔
        }
        // 顺手把「关注的项目更新」检查的闹钟重新排上 —— 重启后不该就不提醒了
        try {
            RepoWatchReceiver.schedule(context);
        } catch (Throwable ignored) { }
    }
}
