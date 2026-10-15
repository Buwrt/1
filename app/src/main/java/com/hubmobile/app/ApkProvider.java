package com.hubmobile.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 给系统安装器提供 APK 的临时读权限。
 *
 * 从 Actions 构建产物（ZIP）里解压出来的 APK 放在应用私有目录里，
 * 系统安装器读不到，Android 7.0 起又禁止把 file:// 直接抛给外部应用。
 * 官方解法是 FileProvider，但那要引入 androidx.core；这里用一个几十行的
 * ContentProvider 达到同样效果，保持整个项目零第三方依赖。
 *
 * 只暴露 filesDir/apks/ 这一个目录，且路径只取 URI 的最后一段（不含分隔
 * 符），因此不存在路径穿越风险。
 */
public class ApkProvider extends ContentProvider {

    /** 与 AndroidManifest 中 authorities 的后缀保持一致。 */
    static final String AUTHORITY_SUFFIX = ".apks";
    static final String DIR = "apks";

    static Uri uriFor(String authority, String fileName) {
        return Uri.parse("content://" + authority + "/" + fileName);
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (getContext() == null) throw new FileNotFoundException("no context");
        String name = uri.getLastPathSegment();
        if (name == null || name.isEmpty() || name.contains("/") || name.contains("..")) {
            throw new FileNotFoundException("bad name");
        }
        File dir = new File(getContext().getFilesDir(), DIR);
        File f = new File(dir, name);
        if (!f.exists()) throw new FileNotFoundException(f.getAbsolutePath());
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) {
        return "application/vnd.android.package-archive";
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
