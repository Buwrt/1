package com.hubmobile.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 把导出的错误日志交给系统分享面板。
 *
 * 和 ApkProvider 是同一个套路：日志文件在应用私有目录里，
 * Android 7.0 起禁止把 file:// 直接抛给外部应用（FileUriExposedException），
 * 而分享/发邮件这类动作必须让别的应用能读到这个文件。
 * 官方解法是 FileProvider，但那要引入 androidx.core；这里用几十行
 * ContentProvider 达到同样效果，整个项目保持零第三方依赖。
 *
 * 暴露范围 ——
 *   只暴露 filesDir/exports/ 这一个目录，且路径只取 URI 的最后一段
 *   （不含分隔符），因此不存在路径穿越风险。
 *
 * 为什么不用 DownloadProvider ——
 *   它的解析依赖 DownloadManager 的记录表，而这是我们自己生成的文件，
 *   没有对应记录，openFile 必然失败。不能复用。
 */
public class LogProvider extends ContentProvider {

    /** 与 AndroidManifest 中 authorities 的后缀保持一致。 */
    static final String AUTHORITY_SUFFIX = ".logs";
    static final String DIR = "exports";

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
        return "text/plain";
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
