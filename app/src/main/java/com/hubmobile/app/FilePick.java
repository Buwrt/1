package com.hubmobile.app;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.Locale;

/**
 * 文件选择结果的处理辅助：查询文件名 / 大小 / MIME，读取全部字节。
 * 用于「上传文件到仓库」与「上传 Release 附件（APK）」。
 */
final class FilePick {

    /** 文件选择请求码。 */
    static final int REQ_PICK = 4711;

    /** 文件夹选择请求码（ACTION_OPEN_DOCUMENT_TREE，选的是目录本身）。 */
    static final int REQ_PICK_FOLDER = 4713;

    /** 文件夹上传的文件数上限：防止一个几千文件的目录把 JSON 回执撑爆
     *  （evaluateJavascript 底层是 Binder IPC，单次事务约 1MB） */
    static final int MAX_TREE_FILES = 300;

    /** 目录递归的深度保险：GitHub 仓库本身也没这么深的合理目录 */
    static final int MAX_TREE_DEPTH = 12;

    /** 目录里枚举出的一个待上传文件。path 是**相对所选目录**的路径，
     *  保留子目录结构 —— 上传时它就是 GitHub 仓库里的路径。 */
    static final class TreeItem {
        String name;
        String path;
        String mime = "application/octet-stream";
        long size;
        String uri;
    }

    /** 仓库文件上传的体积上限：GitHub Contents API 对单文件建议不超过 100MB，
     *  但经 Base64 与 WebView 传递后开销较大，这里保守取 25MB。 */
    static final long MAX_CONTENTS_BYTES = 25L * 1024 * 1024;

    /** Release 附件上限：GitHub 官方为 2GB，这里限制在 200MB 以内避免内存问题。 */
    static final long MAX_ASSET_BYTES = 200L * 1024 * 1024;

    static final class Meta {
        String name = "";
        long size = 0;
        String mime = "application/octet-stream";
    }

    private FilePick() { }

    static Meta query(Context ctx, Uri uri) {
        Meta m = new Meta();
        ContentResolver cr = ctx.getContentResolver();
        Cursor c = null;
        try {
            c = cr.query(uri, null, null, null, null);
            if (c != null && c.moveToFirst()) {
                int nameIdx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeIdx = c.getColumnIndex(OpenableColumns.SIZE);
                if (nameIdx >= 0) m.name = c.getString(nameIdx);
                if (sizeIdx >= 0) m.size = c.getLong(sizeIdx);
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) { try { c.close(); } catch (Exception ignored) {} }
        }
        if (m.name == null || m.name.isEmpty()) {
            m.name = uri.getLastPathSegment() != null ? uri.getLastPathSegment() : "file";
        }
        if (m.size <= 0) {
            // 某些提供方不返回 size，退化为读取一次长度
            try {
                InputStream is = cr.openInputStream(uri);
                if (is != null) {
                    m.size = is.available();
                    is.close();
                }
            } catch (Exception ignored) { }
        }
        m.mime = mimeOf(cr, uri, m.name);
        return m;
    }

    /** 推断 MIME；对 APK 给出官方类型，便于 Release 附件正确识别。 */
    static String mimeOf(ContentResolver cr, Uri uri, String name) {
        String mime = null;
        try { mime = cr.getType(uri); } catch (Exception ignored) { }
        if (mime == null || mime.isEmpty()) {
            String lower = name.toLowerCase(Locale.US);
            if (lower.endsWith(".apk")) mime = "application/vnd.android.package-archive";
            else if (lower.endsWith(".aab")) mime = "application/octet-stream";
            else {
                String ext = MimeTypeMap.getFileExtensionFromUrl(lower);
                if (ext != null && !ext.isEmpty()) {
                    mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
                }
            }
        }
        if (mime == null || mime.isEmpty()) mime = "application/octet-stream";
        // APK 显式使用标准类型
        if (name.toLowerCase(Locale.US).endsWith(".apk")
                && !mime.startsWith("application/vnd.android")) {
            mime = "application/vnd.android.package-archive";
        }
        return mime;
    }

    static byte[] readAll(Context ctx, Uri uri) throws Exception {
        return readAll(ctx, uri, MAX_CONTENTS_BYTES);
    }

    /**
     * 读全部字节，**带硬上限**。
     *
     * 为什么要上限：这个方法把整个文件读进内存。以前 uploadBinary 直接调
     * 无上限的版本，用户挑一个 200MB 的附件进来，ByteArrayOutputStream
     * 扩容时的峰值内存是文件大小的两倍多 —— 低端机当场 OutOfMemoryError，
     * 表现就是「一上传就闪退」。
     *
     * @param maxBytes 允许的最大字节数；超出抛异常（给用户看得懂的话），
     *                 绝不读一半再放弃 —— 那样调用方拿到残包更麻烦
     */
    static byte[] readAll(Context ctx, Uri uri, long maxBytes) throws Exception {
        long size = sizeOf(ctx, uri);
        if (maxBytes > 0 && size > maxBytes) {
            throw new Exception("文件过大（" + human(size) + "），超过 " + human(maxBytes) + " 限制");
        }
        InputStream is = ctx.getContentResolver().openInputStream(uri);
        if (is == null) throw new Exception("无法读取文件");
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            long total = 0;
            int n;
            while ((n = is.read(buf)) != -1) {
                total += n;
                // sizeOf 可能探不准（有些提供方不报大小），边读边再核一遍
                if (maxBytes > 0 && total > maxBytes) {
                    throw new Exception("文件过大，超过 " + human(maxBytes) + " 限制");
                }
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        } finally {
            try { is.close(); } catch (Exception ignored) { }
        }
    }

    /** 流式 Base64 编码后的长度：ceil(n/3)*4，无换行 */
    static long base64Length(long rawBytes) {
        return ((rawBytes + 2) / 3) * 4;
    }

    /**
     * 把一个原始文件流**实时编码成 Base64** 的输入流。
     *
     * 为什么必须有它 ——
     *   仓库文件上传（Contents API）的请求体是一段 JSON，文件内容要以
     *   Base64 字符串嵌在里面。以前的流程是「整个文件读成 byte[] → 编成
     *   Base64 字符串 → 塞进一行 JS 用 evaluateJavascript 灌给前端 →
     *   前端再拼 JSON 发出去」。一个 25MB 的文件要过 33MB 的字符串，
     *   中转的每一步都在堆内存的悬崖边上 —— 中低端机上「一上传就闪退」
     *   的真身就是它。
     *
     * 现在原生直接拼 JSON 并流式发送：头（{"message":..,"content":"）→
     * 本编码流（文件边读边编）→ 尾（","branch":..}），内存占用恒定在
     * 几 KB，与文件大小无关。
     *
     * 编码按 3 字节一组转 4 字符，中间块必须是 3 的倍数（否则会提前出
     * padding），最后一块不足 3 字节时由编码器自动补 '='。
     */
    static InputStream base64Encoding(final InputStream in) {
        return new InputStream() {
            private final byte[] inBuf = new byte[3 * 4096];    // 3 的倍数
            private final byte[] outBuf = new byte[4 * 4096];   // 对应 inBuf/3*4
            private int outPos = 0, outLen = 0;
            private boolean eof = false;

            private void fill() throws java.io.IOException {
                if (outPos < outLen || eof) return;
                try {
                    int n = in.read(inBuf, 0, inBuf.length);
                    if (n < 0) {
                        eof = true;
                        outLen = 0;
                        return;
                    }
                    /* android.util.Base64 的六参 encode 是「块内自含 padding」的：
                     * 中间块长度必须是 3 的倍数，否则会提前产出错误的 '='。
                     * read 可能少给（网络流一次给几字节很常见），所以凑到
                     * 3 的倍数或流尽头为止 —— 到尽头的那块才允许带 padding。 */
                    while (n % 3 != 0) {
                        int extra = in.read(inBuf, n, inBuf.length - n);
                        if (extra < 0) break;   // 真到底了，这就是最后一块
                        n += extra;
                    }
                    /* android.util.Base64 没有「编码到指定数组」的重载，
                       四参版本返回新数组 —— 每 12KB 输入多分配 16KB，
                       对上传这种低频操作可忽略。 */
                    byte[] enc = android.util.Base64.encode(inBuf, 0, n,
                            android.util.Base64.NO_WRAP);
                    System.arraycopy(enc, 0, outBuf, 0, enc.length);
                    outLen = enc.length;
                    outPos = 0;
                    outPos = 0;
                } catch (Throwable t) {
                    if (t instanceof java.io.IOException) throw (java.io.IOException) t;
                    throw new java.io.IOException("Base64 编码失败", t);
                }
            }

            @Override public int read() throws java.io.IOException {
                byte[] one = new byte[1];
                int n = read(one, 0, 1);
                return n < 0 ? -1 : (one[0] & 0xff);
            }

            @Override public int read(byte[] b, int off, int len) throws java.io.IOException {
                if (len <= 0) return 0;
                fill();
                if (outPos >= outLen) return -1;   // eof
                int n = Math.min(len, outLen - outPos);
                System.arraycopy(outBuf, outPos, b, off, n);
                outPos += n;
                return n;
            }

            @Override public void close() throws java.io.IOException {
                in.close();
            }
        };
    }

    /**
     * 打开文件流（调用方负责关闭）。
     * 给 multipart 上传用 —— 大文件不能整个读进内存。
     */
    static InputStream open(Context ctx, Uri uri) throws Exception {
        InputStream is = ctx.getContentResolver().openInputStream(uri);
        if (is == null) throw new Exception("无法读取文件");
        return is;
    }

    /**
     * 递归枚举一个目录树里的全部文件（SAF）。
     *
     * 为什么需要它 —— 官网网页上传能拖整个文件夹，靠的是浏览器的目录
     * 上传能力：前端拿到目录后递归读出所有文件、逐个调 Contents API。
     * App 里的 ACTION_OPEN_DOCUMENT 只能多选文件（点文件夹是「进入」，
     * 不是「选中」），要补齐这个体验就得走 ACTION_OPEN_DOCUMENT_TREE
     * 拿到目录，再由这里把目录展开成文件清单。
     *
     * path 的来历：SAF 的 documentId 形如
     *   "primary:Download/abc/sub/x.txt"（treeDocId = "primary:Download/abc"）
     * 相对路径 = documentId 去掉 treeDocId 前缀 —— 上传时它就是
     * GitHub 仓库里的目标路径，子目录结构原样保留。
     *
     * 用**迭代栈**而不是递归：目录再深也不会把调用栈压穿。
     *
     * @param maxFiles 文件数上限（超出即停），防几千个文件的目录把
     *                 JSON 回执撑爆 Binder 的 1MB 事务限制
     */
    static java.util.List<TreeItem> listTree(Context ctx, Uri treeUri, int maxFiles) throws Exception {
        ContentResolver cr = ctx.getContentResolver();
        String treeDocId = DocumentsContract.getTreeDocumentId(treeUri);
        java.util.List<TreeItem> out = new java.util.ArrayList<>();

        // 栈元素 = [目录的 documentId, 相对该目录的路径前缀]
        java.util.ArrayDeque<String[]> stack = new java.util.ArrayDeque<>();
        stack.push(new String[]{treeDocId, ""});

        while (!stack.isEmpty() && out.size() < maxFiles) {
            String[] cur = stack.pop();
            String dirDocId = cur[0], relDir = cur[1];
            Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, dirDocId);
            Cursor c = null;
            try {
                c = cr.query(childrenUri, new String[]{
                        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                        DocumentsContract.Document.COLUMN_MIME_TYPE,
                        DocumentsContract.Document.COLUMN_SIZE}, null, null, null);
                if (c == null) continue;
                while (c.moveToNext() && out.size() < maxFiles) {
                    String docId = c.getString(0);
                    String name = c.getString(1);
                    String mime = c.getString(2);
                    long size = c.isNull(3) ? 0 : c.getLong(3);
                    if (name == null || name.isEmpty()) continue;

                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                        // 深度保险：超深目录直接放弃（GitHub 上也没人这么放）
                        int depth = relDir.isEmpty() ? 1 : relDir.split("/").length + 1;
                        if (depth <= MAX_TREE_DEPTH) {
                            stack.push(new String[]{docId,
                                    relDir.isEmpty() ? name : relDir + "/" + name});
                        }
                        continue;
                    }

                    TreeItem it = new TreeItem();
                    it.name = name;
                    it.path = relDir.isEmpty() ? name : relDir + "/" + name;
                    it.size = Math.max(0, size);
                    if (mime == null || mime.isEmpty()) {
                        mime = mimeFromName(name);
                    } else if (name.toLowerCase(Locale.US).endsWith(".apk")
                            && !mime.startsWith("application/vnd.android")) {
                        mime = "application/vnd.android.package-archive";
                    }
                    it.mime = mime;
                    it.uri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId).toString();
                    out.add(it);
                }
            } finally {
                if (c != null) { try { c.close(); } catch (Exception ignored) { } }
            }
        }
        return out;
    }

    /** 按文件名猜 MIME（清单里没给时的兜底） */
    static String mimeFromName(String name) {
        String lower = name == null ? "" : name.toLowerCase(Locale.US);
        if (lower.endsWith(".apk")) return "application/vnd.android.package-archive";
        String ext = MimeTypeMap.getFileExtensionFromUrl(lower);
        if (ext != null && !ext.isEmpty()) {
            String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            if (m != null && !m.isEmpty()) return m;
        }
        return "application/octet-stream";
    }

    /** 文件字节数；取不到时返回 0 */
    static long sizeOf(Context ctx, Uri uri) {        try {
            Meta m = query(ctx, uri);
            if (m != null && m.size > 0) return m.size;
        } catch (Throwable ignored) { }
        try {
            android.content.res.AssetFileDescriptor fd =
                    ctx.getContentResolver().openAssetFileDescriptor(uri, "r");
            if (fd != null) {
                long len = fd.getLength();
                fd.close();
                if (len > 0) return len;
            }
        } catch (Throwable ignored) { }
        return 0;
    }

    static String human(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format(Locale.US, "%.1f KB", bytes / 1024.0);
        return String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0));
    }

    /** 版本 >= 33 时不再需要 READ_EXTERNAL_STORAGE（改用分区媒体权限），此处仅作兼容判断。 */
    static boolean needsLegacyPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU;
    }
}
