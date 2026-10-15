# githup 混淆规则
#
# 目标：让反编译出来的代码难以阅读、难以二次修改，同时不破坏任何运行逻辑。
#
# 原则：宁可少混淆几个类，也不能让 App 崩。凡是「名字会被外部按字符串调用」
# 的地方，一律保留名字。

# ---------------- 1. JS 桥：绝不能混淆 ----------------
# @JavascriptInterface 标注的方法，名字是硬编码在网页 JS 里的字符串
# （window.NativeBridge.appVersion() 等）。混淆了名字，前端就调不到，
# 整个 App 直接瘫痪。所以整个类连名字带方法全部保留。
-keep class com.hubmobile.app.JsBridge { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# ---------------- 2. 系统会按名字反射调用的组件 ----------------
# Activity / Application / Provider 等由 AndroidManifest.xml 按类名引用，
# 改名后系统找不到，会直接崩。
-keep public class * extends android.app.Activity
-keep public class * extends android.app.Application
-keep public class * extends android.app.Service
-keep public class * extends android.content.BroadcastReceiver
-keep public class * extends android.content.ContentProvider
-keep public class * extends android.webkit.WebViewClient
-keep public class * extends android.webkit.WebChromeClient

# ---------------- 3. 自定义 View 的构造函数 ----------------
# 布局/代码里按类名实例化，需要保留带 Context/AttributeSet 的构造。
-keepclasseswithmembers class * {
    public <init>(android.content.Context, android.util.AttributeSet);
}
-keepclasseswithmembers class * {
    public <init>(android.content.Context, android.util.AttributeSet, int);
}

# ---------------- 4. 枚举与方法名 ----------------
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}
# 别把方法名混淆成 a/b/c —— 那样虽然还能跑，但攻击者一个字节一个字节
# 读起来会轻松很多。保留方法名，代价是包大一点，值得。
-keepclassmembers class * {
    *** get*(...);
    *** set*(...);
    *** is*(...);
}

# ---------------- 5. 泛型与注解要留的签名信息 ----------------
-keepattributes Signature
-keepattributes *Annotation*
-keepattributes Exceptions
-keepattributes InnerClasses

# ---------------- 6. 序列化相关 ----------------
-keepclassmembers class * implements java.io.Serializable {
    static final long serialVersionUID;
    private static final java.io.ObjectStreamField[] serialPersistentFields;
    !static !transient <fields>;
    private void writeObject(java.io.ObjectOutputStream);
    private void readObject(java.io.ObjectInputStream);
    java.lang.Object writeReplace();
    java.lang.Object readResolve();
}

# ---------------- 7. 去掉日志，防止敏感信息被打日志 ----------------
-assumenosideeffects class android.util.Log {
    public static *** d(...);
    public static *** v(...);
    public static *** i(...);
}

# ---------------- 8. 报错信息别带源码行号 ----------------
# 反编译时行号会帮忙定位代码结构，去掉它能让逆向更费劲。
-renamesourcefileattribute SourceFile
-keepattributes SourceFile,LineNumberTable
