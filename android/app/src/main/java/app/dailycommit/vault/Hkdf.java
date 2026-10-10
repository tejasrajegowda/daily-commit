package app.dailycommit.vault;

import java.security.GeneralSecurityException;
import java.util.Arrays;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** HKDF-SHA256 (RFC 5869). */
final class Hkdf {
    private Hkdf() {}

    static byte[] sha256(byte[] ikm, byte[] salt, byte[] info, int length) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(salt.length == 0 ? new byte[32] : salt, "HmacSHA256"));
        byte[] prk = mac.doFinal(ikm);
        mac.init(new SecretKeySpec(prk, "HmacSHA256"));
        byte[] out = new byte[length];
        byte[] block = new byte[0];
        for (int i = 1, at = 0; at < length; i++) {
            mac.update(block);
            mac.update(info);
            mac.update((byte) i);
            block = mac.doFinal();
            int n = Math.min(block.length, length - at);
            System.arraycopy(block, 0, out, at, n);
            at += n;
        }
        Arrays.fill(prk, (byte) 0);
        Arrays.fill(block, (byte) 0);
        return out;
    }
}
