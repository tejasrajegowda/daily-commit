package app.dailycommit.vault;

import java.util.Base64;
import java.util.regex.Pattern;

/** Bytes as base64url without padding, the one form used on both sides of the bridge (vault/encoding.ts). */
public final class Codec {
    private static final Pattern URL = Pattern.compile("[A-Za-z0-9_-]*");
    private Codec() {}
    public static String toBase64url(byte[] bytes) { return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes); }
    public static byte[] fromBase64url(String text) {
        if (text == null || !URL.matcher(text).matches() || text.length() % 4 == 1) throw new IllegalArgumentException("not base64url");
        return Base64.getUrlDecoder().decode(text);
    }
}
