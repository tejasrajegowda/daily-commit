package app.dailycommit.vault;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public class CodecTest {
    @Test public void base64urlWithoutPadding_asVaultEncodingTs() {
        byte[] b = { (byte) 0xfb, (byte) 0xff };
        assertEquals("-_8", Codec.toBase64url(b));
        assertArrayEquals(b, Codec.fromBase64url("-_8"));
        assertEquals("", Codec.toBase64url(new byte[0]));
    }

    @Test public void standardBase64AndPaddingAreRefused() {
        assertThrows(IllegalArgumentException.class, () -> Codec.fromBase64url("+/8="));
        assertThrows(IllegalArgumentException.class, () -> Codec.fromBase64url("abcde"));
        assertThrows(IllegalArgumentException.class, () -> Codec.fromBase64url(null));
    }
}
