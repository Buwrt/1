package com.hubmobile.app;

/* 自动生成，不要手改。由 tools/gen-guard.py 用官方私钥生成。 */
final class GuardKeys {
    private GuardKeys() { }

    /** 官方证书指纹（小写十六进制）。改它 → ring2 验签不过。 */
    static final String CERT_SHA256 = "863dd1cd3752e59165e152bc4ab35fde478fcd296d724a6bc58cec0368184927";

    /** 官方公钥（SubjectPublicKeyInfo DER 的 base64）。用来验下面这份签名。 */
    static final String PUBKEY_B64 = "MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAoXqXbnGAemjOqdbv5UFghBhiBUkDiN1/MeN2+F4SlpLKXtot4JR0+UPgZGNSx6CItLtJoJb+gq6CFQHVRGckqQ999FR1U9QUkvLyF6t5Hyd4YHEXrnuvShUnlWFxTFxzZXA3yrVz/sGr1v/Qf7LmhG6etFc87H7BOigo80jrcECKqf6URIevU0Xz5vN7IpxvKo9dG59O9ZfHvqnj42YJhfjbACOvqaQH0+Q1X/I2QlrroFa8RcGQRa0J2cOETTbh5bNE52r8QY5FmXTFjwHP5w3CO6Mkd9dq1itRii6+ku271iSpqKuVAtC3kOVIegzT9/RBlli60ToLUAIlNjkTUOUSMtaSPQzUc2NJ4s/eiR8A5+dYV5piCLssCVrtudryVKBWpFCdIyzFNz4a1t1avd0xUTLjD8OWWnj+RoUr3ZAX80UJiCKNwgDVJrnblGCCDS7I+kcUHE9a+f4hZqHCrUFGt1WBkfqbkEL9qhtY2G1ik8S92hBYHa4GGj+5jQzV6fPSpaEowQiAb2HHyrJaRpZYX/aq5HeDjVlM3P2oxfOuXpljTzrqgvzAc3c8b1AfSgXsRHX6fyJbLbvmJ0li9ZtiknoPJd42ALh5LhGAEUpmLfbEjLnpkuqj3UouKFQOyH/eCRBSisZAuZuFjke8s1iD4WJyWfHeezcjwPDOggkCAwEAAQ==";

    /** 官方私钥对「整条链期望值」的签名。没有私钥就伪造不出来。 */
    static final String CHAIN_SIG_B64 = "d/LufR274A/q/OX0m+clVhcrBYbK+miJMjzst+YUgDp3zQFCNjAXst3yFx65A4T2dLckyFY0nyoNq5Ul7314abcEDyWzg1NygsNc7c9FxnRUIwJ4soY6H6Ou88QvtDsl3WN4h8NS0nYPieTbMvmT9v8RnQLIH7eGsp2YUxNE9Ei+MkQP1giqrxAIi9SuE71Nogf69kS5/Z8MplrGX8x6XLZeFh9mvoVLj5KM6kiemMo5JFBKkb//J2anobvvUwfB7w7iDMxlAf6OPLFNzx+1dWLy5kjDVRiKOOuWFaAx3cji4MjRS6Vatn8QVvg2JNikYsMDIrAalxmOMQmvdsGpt8rT0AitoQlLPn38ABdVTGI8FBOFYfmWHPvpzs5Mt5x2nB2tG8lV3qqcT4J8oIZijFUmoKIXCCkDmpvv4/7oxlKMC5yzrZ0IWEKi7BwBNoDLptml8Bqjv3oU9sZEEvllhnG8Y2p04ztOcHycpMlNhtqLyjc5OsZq17O5DNOcv0TFFRj/KESZRK3fqDtpfd3llYFN2nUEcQbNBmNsPAUhGwXOlWoeYupYOBVnUEyxjqcZpoRo4ajEtu6By5VvfbzQKiPtRti3GduSNdVTghy7yGPHcC+GYMoxcUAhHaxUQa11JFvDsOCJHeju1onOOVCe/pFIB6CkVUFNWdnuMmXw0QE=";

    /** 链的种子（参与每一环 token 推导） */
    static final String SEED = "githup-guard-chain-v1";

    /** 每一环的期望 token，顺序即 1→2→3→4→5 */
    static final String[] CHAIN = new String[] {
        "c9efb2a31cd5605ee61529c1822814233368882d9e0bf4b742de5e718083b08a",
        "9a37082a545da5932711cb34b67ec5ef8b0d2208b23ec7be5861862ac312528f",
        "d89f189cc9ae98487a1c7a30b351943b57eafe00af5f02faab956d2be21545a7",
        "dc8d353c1ac6eb7c306f187074b3efa4f6fe84c907bb68bd5062b62534783f79",
        "907340c7704492a6db648977111aaac16603294bd9cc6e31a25dc00b29062241",
    };

    static final String PKG = "com.hubmobile.app";
    static final String APP_CLASS = "com.hubmobile.app.App";
    static final String LABEL = "githup";
    static final String VERSION_NAME = "1.2.15";
    static final int VERSION_CODE = 1002015;

    /** 官方下载地址（被认定篡改后，直接把用户送到这里） */
    static final String OFFICIAL_URL =
            "https://github.com/Buwrt/githup/releases/download/v1.2.15/githup-1.2.15.apk";
    static final String OFFICIAL_HOME = "https://github.com/Buwrt/githup";
}
