package com.hubmobile.app;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * 局域网同步引擎（手机端）。
 *
 * ═══ 业务规则（这是整个功能的灵魂，改代码前先读这段） ═══
 *
 *   1. 手机 → 电脑 推送数据：电脑端**免确认**直接收。
 *      理由：手机是用户随身的主控设备，用户在手机上主动发起的同步，
 *      本身就是一次明确授权，再让电脑端点一次确认纯属多余。
 *
 *   2. 电脑 → 手机 推送数据：手机端**必须弹确认**，用户点了同意才落盘。
 *      理由：电脑可能是公共/办公机器，不能让它无声无息改写手机里的
 *      令牌和密钥。
 *
 *   3. 手机 拉取 电脑的数据：电脑端**必须确认**。
 *      理由：电脑上可能存着别的工作资料，手机不能随手就把整份数据搬走。
 *
 *   归纳起来一句话：**除了「手机主动推给电脑」这一条，其余所有方向
 *   都需要接收端（或数据持有端）确认**。规则集中在 needApproval() 里，
 *   改策略只动那一个方法。
 *
 * ═══ 通道 ═══
 *
 *   走裸 TCP + 自建帧协议，不走 HTTP。原因是应用的网络安全配置把明文
 *   流量整个关掉了，而局域网内又没有可信证书；裸 Socket 不受该策略
 *   约束，加密由 LanCrypto 自己做（AES-256-GCM）。
 *
 *   发现用 UDP 广播；配对用 6 位 PIN + PBKDF2 派生密钥把长期 PSK 加密
 *   送过去，之后再显示 4 字符短认证串让用户肉眼比对防中间人。
 */
public final class LanSync {

    private static final String TAG = "LanSync";

    /** 发现用的 UDP 端口，两端必须一致。 */
    private static final int DISCOVER_PORT = 45678;
    /** 广播 magic，避免跟局域网里别的程序撞车。 */
    private static final String MAGIC = "GHSYNC1";
    /** 帧最大 8MB，防止恶意超大包把内存打爆。 */
    private static final int MAX_FRAME = 8 * 1024 * 1024;
    /** 等待用户审批的超时。 */
    private static final long APPROVE_TIMEOUT_MS = 120_000;
    /** 配对码有效时长。 */
    private static final long PAIR_WINDOW_MS = 5 * 60_000;
    /** 配对码最多错几次，超了就作废（防暴力枚举 6 位 PIN）。 */
    private static final int PAIR_MAX_TRY = 5;

    private static final String PREF = "githup_lan";
    private static final String PREF_PEERS = "peers";
    private static final String PREF_ID = "device_id";
    private static final String PREF_NAME = "device_name";

    private final Activity activity;
    private ExecutorService pool;
    private ServerSocket server;
    private DatagramSocket udp;
    private WifiManager.MulticastLock mcLock;

    private int port;
    private volatile boolean running;

    /** 已配对设备：deviceId -> Peer */
    private final Map<String, Peer> peers = new ConcurrentHashMap<>();
    /** 发现到的（含未配对）设备：deviceId -> Found，带过期时间 */
    private final Map<String, Found> found = new ConcurrentHashMap<>();
    /** 等待用户审批的请求：reqId -> Pending */
    private final Map<String, Pending> pending = new ConcurrentHashMap<>();

    /** 当前配对会话（手机端生成 PIN，等电脑端来认领） */
    private volatile PairSession pairSession;

    private WebViewSink sink;

    /** JS 回调发射口，由 JsBridge 注入。 */
    public interface WebViewSink {
        void runJs(String js);
    }

    public LanSync(Activity a, WebViewSink sink) {
        this.activity = a;
        this.sink = sink;
        loadPeers();
    }

    /* ============================================================
     * 设备身份
     * ============================================================ */

    String deviceId() {
        SharedPreferences sp = sp();
        String id = sp.getString(PREF_ID, null);
        if (id == null) {
            id = LanCrypto.hex(LanCrypto.random(8));
            sp.edit().putString(PREF_ID, id).apply();
        }
        return id;
    }

    String deviceName() {
        SharedPreferences sp = sp();
        String n = sp.getString(PREF_NAME, null);
        if (n == null) {
            n = Build.MODEL == null ? "githup" : Build.MODEL;
            sp.edit().putString(PREF_NAME, n).apply();
        }
        return n;
    }

    void setDeviceName(String n) {
        sp().edit().putString(PREF_NAME, n).apply();
    }

    /** 本机类型。手机端恒为 phone —— 审批规则靠它判断方向。 */
    private String deviceType() {
        return "phone";
    }

    private SharedPreferences sp() {
        return activity.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    /* ============================================================
     * 已配对设备
     * ============================================================ */

    static final class Peer {
        String id;
        String name;
        String type;      // phone / pc
        String host;      // 最后一次看到的 IP
        int port;
        byte[] psk;       // 长期共享密钥
        long pairedAt;
    }

    private void loadPeers() {
        try {
            String raw = sp().getString(PREF_PEERS, "[]");
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                Peer p = new Peer();
                p.id = o.optString("id", "");
                p.name = o.optString("name", "");
                p.type = o.optString("type", "pc");
                p.host = o.optString("host", "");
                p.port = o.optInt("port", 0);
                p.psk = LanCrypto.unb64(o.optString("psk", ""));
                p.pairedAt = o.optLong("at", 0);
                if (!p.id.isEmpty() && p.psk != null && p.psk.length == 32) {
                    peers.put(p.id, p);
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "读取配对列表失败", t);
        }
    }

    private void savePeers() {
        try {
            JSONArray arr = new JSONArray();
            for (Peer p : peers.values()) {
                JSONObject o = new JSONObject();
                o.put("id", p.id);
                o.put("name", p.name);
                o.put("type", p.type);
                o.put("host", p.host);
                o.put("port", p.port);
                o.put("psk", LanCrypto.b64(p.psk));
                o.put("at", p.pairedAt);
                arr.put(o);
            }
            sp().edit().putString(PREF_PEERS, arr.toString()).apply();
        } catch (Throwable t) {
            Log.w(TAG, "保存配对列表失败", t);
        }
    }

    void removePeer(String id) {
        peers.remove(id);
        savePeers();
    }

    /* ============================================================
     * 启停
     * ============================================================ */

    synchronized boolean start() {
        if (running) return true;
        try {
            pool = Executors.newCachedThreadPool();
            server = new ServerSocket(0);          // 端口交给系统分配
            port = server.getLocalPort();

            udp = new DatagramSocket(DISCOVER_PORT);
            udp.setBroadcast(true);

            // 不加这个锁，很多手机的 Wi-Fi 会把 UDP 广播直接丢掉，
            // 表现为「电脑搜不到手机」。
            try {
                WifiManager wm = (WifiManager) activity.getApplicationContext()
                        .getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    mcLock = wm.createMulticastLock("githup-lan");
                    mcLock.setReferenceCounted(false);
                    mcLock.acquire();
                }
            } catch (Throwable ignored) {
                // 没有 Wi-Fi 管理器（以太网/热点场景）也能继续，只是发现可能慢一点
            }

            running = true;
            pool.execute(this::acceptLoop);
            pool.execute(this::discoverLoop);
            pool.execute(this::sweepLoop);
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "启动失败", t);
            stop();
            return false;
        }
    }

    synchronized void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (Throwable ignored) { }
        try { if (udp != null) udp.close(); } catch (Throwable ignored) { }
        try { if (mcLock != null && mcLock.isHeld()) mcLock.release(); } catch (Throwable ignored) { }
        if (pool != null) pool.shutdownNow();
        server = null;
        udp = null;
        pool = null;
    }

    boolean isRunning() { return running; }

    /* ============================================================
     * 发现：UDP 广播
     * ============================================================ */

    static final class Found {
        String id, name, type, host;
        int port;
        boolean paired;
        long seenAt;
    }

    private void discoverLoop() {
        byte[] buf = new byte[2048];
        while (running) {
            try {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                udp.receive(p);
                String s = new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8);
                handleBeacon(s, p.getAddress());
            } catch (Throwable t) {
                if (!running) break;
            }
        }
    }

    private void handleBeacon(String s, InetAddress addr) {
        try {
            if (!s.startsWith(MAGIC + "|")) return;
            JSONObject o = new JSONObject(s.substring(MAGIC.length() + 1));
            String id = o.optString("id", "");
            if (id.isEmpty() || id.equals(deviceId())) return;   // 忽略自己

            Found f = new Found();
            f.id = id;
            f.name = o.optString("name", "未知设备");
            f.type = o.optString("type", "pc");
            f.port = o.optInt("port", 0);
            f.host = addr.getHostAddress();
            f.paired = peers.containsKey(id);
            f.seenAt = System.currentTimeMillis();
            found.put(id, f);

            // 已配对的设备地址可能变了（路由器重新分配 IP），顺手更新
            Peer p = peers.get(id);
            if (p != null && (!f.host.equals(p.host) || f.port != p.port)) {
                p.host = f.host;
                p.port = f.port;
                savePeers();
            }
            emitFound();
        } catch (Throwable ignored) {
            // 局域网里杂音很多，非本协议的数据包直接丢掉
        }
    }

    /** 主动喊一声：既是让别人发现自己，也能刷新别人的地址。 */
    void announce() {
        if (!running) return;
        pool.execute(() -> {
            try {
                JSONObject o = new JSONObject();
                o.put("id", deviceId());
                o.put("name", deviceName());
                o.put("type", deviceType());
                o.put("port", port);
                byte[] data = (MAGIC + "|" + o.toString()).getBytes(StandardCharsets.UTF_8);
                DatagramSocket s = new DatagramSocket();
                s.setBroadcast(true);
                s.send(new DatagramPacket(data, data.length,
                        InetAddress.getByName("255.255.255.255"), DISCOVER_PORT));
                s.close();
            } catch (Throwable t) {
                Log.w(TAG, "广播失败", t);
            }
        });
    }

    private void sweepLoop() {
        while (running) {
            try {
                Thread.sleep(3000);
                // 45 秒没再喊过的设备认为已离线
                long now = System.currentTimeMillis();
                boolean changed = false;
                Iterator<Map.Entry<String, Found>> it = found.entrySet().iterator();
                while (it.hasNext()) {
                    if (now - it.next().getValue().seenAt > 45_000) {
                        it.remove();
                        changed = true;
                    }
                }
                if (changed) emitFound();
                announce();
            } catch (Throwable t) {
                if (!running) break;
            }
        }
    }

    /* ============================================================
     * 接收：TCP 服务端
     * ============================================================ */

    private void acceptLoop() {
        while (running) {
            try {
                Socket s = server.accept();
                pool.execute(() -> handleConn(s));
            } catch (Throwable t) {
                if (!running) break;
            }
        }
    }

    /** 帧格式：4 字节大端长度 + UTF-8 JSON */
    private static String readFrame(DataInputStream in) throws IOException {
        int n = in.readInt();
        if (n <= 0 || n > MAX_FRAME) throw new IOException("非法帧长度: " + n);
        byte[] b = new byte[n];
        in.readFully(b);
        return new String(b, StandardCharsets.UTF_8);
    }

    private static void writeFrame(DataOutputStream out, String json) throws IOException {
        byte[] b = json.getBytes(StandardCharsets.UTF_8);
        out.writeInt(b.length);
        out.write(b);
        out.flush();
    }

    private void handleConn(Socket s) {
        try {
            s.setSoTimeout(30_000);
            DataInputStream in = new DataInputStream(s.getInputStream());
            DataOutputStream out = new DataOutputStream(s.getOutputStream());
            String req = readFrame(in);
            String resp = dispatch(req, s.getInetAddress().getHostAddress());
            writeFrame(out, resp);
        } catch (Throwable t) {
            Log.w(TAG, "处理连接出错", t);
        } finally {
            try { s.close(); } catch (Throwable ignored) { }
        }
    }

    /** 收到一帧，返回应答。这里是审批规则的落地处。 */
    private String dispatch(String req, String remoteHost) {
        try {
            JSONObject o = new JSONObject(req);
            String type = o.optString("type", "");
            JSONObject from = o.optJSONObject("from");
            String peerId = from == null ? "" : from.optString("id", "");
            String peerType = from == null ? "pc" : from.optString("type", "pc");
            String peerName = from == null ? "未知设备" : from.optString("name", "未知设备");

            switch (type) {
                case "ping":
                    return ok(new JSONObject().put("pong", true));

                case "pair-claim":
                    return onPairClaim(o, peerId, peerName, peerType, remoteHost);

                case "push":
                    return onPush(o, peerId, peerName, peerType);

                case "pull":
                    return onPull(o, peerId, peerName, peerType);

                default:
                    return err("未知请求类型：" + type);
            }
        } catch (Throwable t) {
            return err(t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage());
        }
    }

    /* ---------------- 请求：配对 ---------------- */

    /**
     * 配对握手。对方用 PIN 派生的 KE 解密我加密送出的 PSK。
     * PIN 错了就解不开 —— 记一次失败，攒够 5 次作废本次配对码。
     */
    private String onPairClaim(JSONObject o, String peerId, String peerName,
                               String peerType, String remoteHost) {
        PairSession ps = pairSession;
        if (ps == null || System.currentTimeMillis() - ps.bornAt > PAIR_WINDOW_MS) {
            pairSession = null;
            return err("当前没有正在等待的配对，请在手机上重新生成配对码");
        }
        if (ps.tries >= PAIR_MAX_TRY) {
            pairSession = null;
            return err("配对码错误次数过多，已作废，请重新生成");
        }

        try {
            byte[] ke = LanCrypto.pinKey(ps.pin, deviceId() + "|" + peerId);
            String sealedPsk = o.optString("psk", "");
            // 试探性解密：解不开说明 PIN 不对
            byte[] psk = LanCrypto.open(ke, sealedPsk);
            if (psk.length != 32) throw new IllegalArgumentException("密钥长度异常");
            ps.tries++;

            // 对方必须回一个用 PSK 签的确认，证明它真的拿到了 PSK
            String proof = o.optString("proof", "");
            byte[] okFlag = LanCrypto.open(psk, proof);
            if (!"githup-pair-ok".equals(new String(okFlag, StandardCharsets.UTF_8))) {
                throw new IllegalArgumentException("配对校验未通过");
            }

            Peer p = new Peer();
            p.id = peerId;
            p.name = peerName;
            p.type = peerType;
            p.host = remoteHost;
            p.port = o.optInt("port", 0);
            p.psk = psk;
            p.pairedAt = System.currentTimeMillis();
            peers.put(peerId, p);
            savePeers();

            pairSession = null;
            JSONObject r = new JSONObject();
            r.put("paired", true);
            r.put("sas", LanCrypto.sas(psk));
            r.put("myName", deviceName());
            emit("window.LanSync.onPaired(" + q(peerId) + "," + q(peerName) + ","
                    + q(LanCrypto.sas(psk)) + ")");
            emitFound();
            return ok(r);
        } catch (Throwable t) {
            PairSession cur = pairSession;
            if (cur != null) cur.tries++;
            return err("配对失败：" + (t.getMessage() == null ? "配对码不正确" : t.getMessage()));
        }
    }

    /* ---------------- 请求：对方推给我 ---------------- */

    private String onPush(JSONObject o, String peerId, String peerName, String peerType) {
        Peer p = peers.get(peerId);
        if (p == null) return err("未配对的设备，请先配对");

        byte[] psk = p.psk;
        JSONObject payload;
        try {
            byte[] body = LanCrypto.open(psk, o.optString("body", ""));
            payload = new JSONObject(new String(body, StandardCharsets.UTF_8));
        } catch (Throwable t) {
            return err("数据解密失败：" + t.getMessage());
        }

        // ★ 规则 2：电脑推给手机 —— 必须手机端确认
        boolean need = needApproval("push", peerType);
        if (need) {
            boolean granted = askUser("push", peerId, peerName, payload);
            if (!granted) return err("用户拒绝了这次同步");
        }

        applyPayload(payload);
        emit("window.LanSync.onSyncDone(" + q("in") + "," + q(peerName) + ","
                + q(describe(payload)) + ")");

        // JSONObject.put 会抛受检异常，而 ok() 没声明 throws，
        // 所以这里先自己收掉 —— 直接塞进参数列表编译不过去。
        JSONObject done = new JSONObject();
        try { done.put("applied", true); } catch (Throwable ignored) { }
        return ok(done);
    }

    /* ---------------- 请求：对方拉我的 ---------------- */

    private String onPull(JSONObject o, String peerId, String peerName, String peerType) {
        Peer p = peers.get(peerId);
        if (p == null) return err("未配对的设备，请先配对");

        // ★ 规则 3：手机来拉电脑的数据 —— 电脑端必须确认。
        // 手机端这里是对称处理：别人来拉我的数据，一律先问我。
        boolean need = needApproval("pull", peerType);
        if (need) {
            JSONObject hint = new JSONObject();
            try {
                hint.put("items", new JSONArray().put("本机全部可同步数据"));
            } catch (Throwable ignored) { }
            boolean granted = askUser("pull", peerId, peerName, hint);
            if (!granted) return err("用户拒绝了这次同步");
        }

        try {
            JSONObject data = collect(null);
            byte[] body = data.toString().getBytes(StandardCharsets.UTF_8);
            JSONObject r = new JSONObject();
            r.put("body", LanCrypto.seal(p.psk, body));
            emit("window.LanSync.onSyncDone(" + q("out") + "," + q(peerName) + ","
                    + q(describe(data)) + ")");
            return ok(r);
        } catch (Throwable t) {
            return err("采集数据失败：" + t.getMessage());
        }
    }

    /**
     * 审批规则集中在这里。
     *
     * @param action "push"（对方推给我） / "pull"（对方拉我的）
     * @param peerType 对方设备类型
     */
    private boolean needApproval(String action, String peerType) {
        String me = deviceType();
        if ("push".equals(action)) {
            // 手机 → 电脑：免确认（用户在手机上主动发起即授权）
            if ("phone".equals(peerType) && "pc".equals(me)) return false;
            // 电脑 → 手机：必须手机确认
            if ("pc".equals(peerType) && "phone".equals(me)) return true;
            return true;
        }
        // pull：数据持有方一律确认，避免被静默搬走
        return true;
    }

    /* ============================================================
     * 审批：弹给前端，等用户点
     * ============================================================ */

    static final class Pending {
        final CountDownLatch latch = new CountDownLatch(1);
        volatile boolean granted;
    }

    private boolean askUser(String action, String peerId, String peerName, JSONObject payload) {
        String reqId = LanCrypto.hex(LanCrypto.random(8));
        Pending pd = new Pending();
        pending.put(reqId, pd);

        try {
            JSONObject info = new JSONObject();
            info.put("reqId", reqId);
            info.put("action", action);
            info.put("peerId", peerId);
            info.put("peerName", peerName);
            info.put("items", describe(payload));
            emit("window.LanSync.onApprove(" + q(info.toString()) + ")");
        } catch (Throwable t) {
            pending.remove(reqId);
            return false;
        }

        try {
            // 注意：这里阻塞的是 socket 处理线程，用户在前端点按钮后解锁
            if (!pd.latch.await(APPROVE_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                pending.remove(reqId);
                return false;
            }
        } catch (InterruptedException e) {
            pending.remove(reqId);
            return false;
        }
        boolean g = pd.granted;
        pending.remove(reqId);
        return g;
    }

    /** 前端用户点了「同意/拒绝」。 */
    boolean answer(String reqId, boolean granted) {
        Pending pd = pending.get(reqId);
        if (pd == null) return false;
        pd.granted = granted;
        pd.latch.countDown();
        return true;
    }

    /* ============================================================
     * 主动发送
     * ============================================================ */

    /** 向已配对设备推送。payloadJson 由前端组装（含 localStorage 里的数据）。 */
    String push(String peerId, String payloadJson) {
        Peer p = peers.get(peerId);
        if (p == null) return fail("未配对的设备");
        try {
            JSONObject data = mergeNative(new JSONObject(payloadJson));
            JSONObject o = new JSONObject();
            o.put("type", "push");
            o.put("from", me());
            o.put("body", LanCrypto.seal(p.psk, data.toString().getBytes(StandardCharsets.UTF_8)));
            JSONObject r = send(p, o);
            if (r != null && r.optBoolean("ok", false)) {
                emit("window.LanSync.onSyncDone(" + q("out") + "," + q(p.name) + ","
                        + q(describe(data)) + ")");
                return okMsg("已推送到 " + p.name);
            }
            return fail(r == null ? "连接失败" : r.optString("msg", "对方拒绝"));
        } catch (Throwable t) {
            return fail(t.getMessage());
        }
    }

    /** 从已配对设备拉取。电脑端会弹确认（规则 3）。 */
    String pull(String peerId) {
        Peer p = peers.get(peerId);
        if (p == null) return fail("未配对的设备");
        try {
            JSONObject o = new JSONObject();
            o.put("type", "pull");
            o.put("from", me());
            JSONObject r = send(p, o);
            if (r == null) return fail("连接失败");
            if (!r.optBoolean("ok", false)) return fail(r.optString("msg", "对方拒绝"));

            byte[] body = LanCrypto.open(p.psk, r.optString("body", ""));
            JSONObject data = new JSONObject(new String(body, StandardCharsets.UTF_8));
            applyPayload(data);
            emit("window.LanSync.onSyncDone(" + q("in") + "," + q(p.name) + ","
                    + q(describe(data)) + ")");
            return okMsg("已从 " + p.name + " 同步");
        } catch (Throwable t) {
            return fail(t.getMessage());
        }
    }

    /** 配对：本端生成 PSK，对方用 PIN 派生的密钥解密后回一个证明。 */
    String pair(String peerId, String pin) {
        Peer p = peers.get(peerId);
        if (p == null) return fail("未找到该设备");
        try {
            byte[] psk = LanCrypto.random(32);
            byte[] ke = LanCrypto.pinKey(pin, p.id + "|" + deviceId());
            JSONObject o = new JSONObject();
            o.put("type", "pair-claim");
            o.put("from", me());
            o.put("port", port);
            // 本端是「认领方」，展示方是对方 —— salt 用对方在前，与
            // onPairClaim 里那条规则互为镜像，两边必须一致。
            o.put("psk", LanCrypto.seal(ke, psk));
            o.put("proof", LanCrypto.seal(psk, "githup-pair-ok".getBytes(StandardCharsets.UTF_8)));
            JSONObject r = send(p, o);
            if (r == null) return fail("连接失败");
            if (!r.optBoolean("ok", false)) return fail(r.optString("msg", "配对失败"));

            p.psk = psk;
            p.pairedAt = System.currentTimeMillis();
            savePeers();
            emitFound();
            emit("window.LanSync.onPaired(" + q(p.id) + "," + q(p.name) + ","
                    + q(LanCrypto.sas(psk)) + ")");
            return okMsg("配对成功，短认证串 " + LanCrypto.sas(psk));
        } catch (Throwable t) {
            return fail(t.getMessage());
        }
    }

    private JSONObject send(Peer p, JSONObject o) {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(p.host, p.port), 8000);
            s.setSoTimeout(60_000);
            DataOutputStream out = new DataOutputStream(s.getOutputStream());
            DataInputStream in = new DataInputStream(s.getInputStream());
            writeFrame(out, o.toString());
            return new JSONObject(readFrame(in));
        } catch (Throwable t) {
            Log.w(TAG, "发送失败", t);
            return null;
        }
    }

    /* ============================================================
     * 数据：采集与应用
     * ============================================================ */

    /**
     * 可同步的数据项。与前端 lan-sync.js 里的 ITEMS 保持一致。
     * token 和 totp 是最高敏感级，settings / starlists 次之。
     */
    private static final String K_TOKEN = "gh_token";
    private static final String K_TOTP = "totp_accounts_cache";

    /** 把原生侧掌管的数据（令牌、TOTP）并进前端给的 payload。 */
    private JSONObject mergeNative(JSONObject in) {
        try {
            if (!in.has("token")) {
                String t = SecurePrefs.get(activity, K_TOKEN, "");
                in.put("token", t == null ? "" : t);
            }
            if (!in.has("settings")) {
                in.put("settings", hubPrefsSnapshot());
            }
            if (!in.has("totp")) {
                in.put("totp", activity.getSharedPreferences("hub_prefs", Context.MODE_PRIVATE)
                        .getString(K_TOTP, "[]"));
            }
        } catch (Throwable ignored) { }
        return in;
    }

    /** 采集本机数据（响应对方的 pull）。 */
    private JSONObject collect(String only) {
        JSONObject d = new JSONObject();
        try {
            d.put("token", SecurePrefs.get(activity, K_TOKEN, ""));
            d.put("settings", hubPrefsSnapshot());
            d.put("totp", activity.getSharedPreferences("hub_prefs", Context.MODE_PRIVATE)
                    .getString(K_TOTP, "[]"));
            d.put("from", me());
            d.put("at", System.currentTimeMillis());
        } catch (Throwable ignored) { }
        return d;
    }

    private JSONObject hubPrefsSnapshot() {
        JSONObject o = new JSONObject();
        try {
            Map<String, ?> all = activity.getSharedPreferences("hub_prefs", Context.MODE_PRIVATE).getAll();
            for (Map.Entry<String, ?> e : all.entrySet()) {
                // TOTP 单独走 totp 字段，不在 settings 里重复
                if (K_TOTP.equals(e.getKey())) continue;
                if (e.getValue() instanceof String) o.put(e.getKey(), e.getValue());
            }
        } catch (Throwable ignored) { }
        return o;
    }

    /** 落地对方推来的数据。敏感项只在有值时覆盖，避免被空串清空。 */
    private void applyPayload(JSONObject d) {
        try {
            String token = d.optString("token", null);
            if (token != null && !token.isEmpty()) {
                SecurePrefs.put(activity, K_TOKEN, token);
            }
            JSONObject settings = d.optJSONObject("settings");
            if (settings != null) {
                SharedPreferences.Editor ed =
                        activity.getSharedPreferences("hub_prefs", Context.MODE_PRIVATE).edit();
                Iterator<String> it = settings.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    if (K_TOTP.equals(k)) continue;
                    ed.putString(k, settings.optString(k, ""));
                }
                ed.apply();
            }
            String totp = d.optString("totp", null);
            if (totp != null && !totp.isEmpty()) {
                activity.getSharedPreferences("hub_prefs", Context.MODE_PRIVATE)
                        .edit().putString(K_TOTP, totp).apply();
            }
            // localStorage 里那份（Star 列表等）交给前端自己写
            emit("window.LanSync.onApply(" + q(d.toString()) + ")");
        } catch (Throwable t) {
            Log.w(TAG, "应用数据失败", t);
        }
    }

    private JSONObject me() {
        JSONObject o = new JSONObject();
        try {
            o.put("id", deviceId());
            o.put("name", deviceName());
            o.put("type", deviceType());
            o.put("port", port);
        } catch (Throwable ignored) { }
        return o;
    }

    /* ============================================================
     * 配对码（手机端展示，电脑端输入）
     * ============================================================ */

    static final class PairSession {
        final String pin;
        final long bornAt;
        int tries;

        PairSession(String pin) {
            this.pin = pin;
            this.bornAt = System.currentTimeMillis();
        }
    }

    String newPairCode() {
        String pin = LanCrypto.newPin();
        pairSession = new PairSession(pin);
        return pin;
    }

    /** 给前端渲染二维码用：包含设备 ID / 名字 / 地址信息。 */
    String pairEnvelope() {
        JSONObject o = new JSONObject();
        try {
            PairSession ps = pairSession;
            o.put("id", deviceId());
            o.put("name", deviceName());
            o.put("type", deviceType());
            o.put("pin", ps == null ? "" : ps.pin);
            o.put("port", port);
        } catch (Throwable ignored) { }
        return o.toString();
    }

    /* ============================================================
     * 对外查询
     * ============================================================ */

    String peersJson() {
        JSONArray arr = new JSONArray();
        try {
            for (Peer p : peers.values()) {
                JSONObject o = new JSONObject();
                o.put("id", p.id);
                o.put("name", p.name);
                o.put("type", p.type);
                o.put("host", p.host);
                o.put("port", p.port);
                o.put("at", p.pairedAt);
                arr.put(o);
            }
        } catch (Throwable ignored) { }
        return arr.toString();
    }

    String foundJson() {
        JSONArray arr = new JSONArray();
        try {
            for (Found f : found.values()) {
                JSONObject o = new JSONObject();
                o.put("id", f.id);
                o.put("name", f.name);
                o.put("type", f.type);
                o.put("host", f.host);
                o.put("port", f.port);
                o.put("paired", f.paired);
                arr.put(o);
            }
        } catch (Throwable ignored) { }
        return arr.toString();
    }

    private String describe(JSONObject payload) {
        List<String> items = new ArrayList<>();
        if (payload == null) return "无";
        if (payload.optString("token", "").length() > 0) items.add("登录令牌");
        if (payload.has("settings")) items.add("应用设置");
        if (payload.has("starlists")) items.add("Star 列表");
        if (payload.optString("totp", "").length() > 2) items.add("TOTP 密钥");
        return items.isEmpty() ? "空数据" : String.join("、", items);
    }

    /* ============================================================
     * 工具
     * ============================================================ */

    /**
     * 应答帧。
     *
     * 注意这里返回的是 String 而不是 JSONObject —— 帧线上跑的本来就是
     * JSON 文本，直接返回文本省掉每一步的 toString，也避免有人在
     * 返回 String 的方法里忘了转。（第一版就是这里写成 JSONObject，
     * 编译器报了 15 个 incompatible types。）
     */
    private static String ok(JSONObject data) {
        try {
            return new JSONObject()
                    .put("ok", true)
                    .put("data", data == null ? new JSONObject() : data)
                    .toString();
        } catch (Throwable t) {
            return "{\"ok\":true}";
        }
    }

    private static String err(String msg) {
        try {
            return new JSONObject().put("ok", false).put("msg", msg).toString();
        } catch (Throwable t) {
            return "{\"ok\":false}";
        }
    }

    private static String okMsg(String msg) {
        try {
            return new JSONObject().put("ok", true).put("msg", msg).toString();
        } catch (Throwable t) {
            return "{\"ok\":true}";
        }
    }

    private static String fail(String msg) {
        try {
            return new JSONObject().put("ok", false).put("msg", msg).toString();
        } catch (Throwable t) {
            return "{\"ok\":false,\"msg\":\"失败\"}";
        }
    }

    /** JSON 字符串字面量转义，保证拼进 JS 后不会被注入。 */
    private static String q(String s) {
        return JSONObject.quote(String.valueOf(s == null ? "" : s));
    }

    private void emit(String js) {
        if (sink != null) sink.runJs(js);
    }

    private void emitFound() {
        emit("window.LanSync.onDevices(" + q(foundJson()) + ")");
    }
}
