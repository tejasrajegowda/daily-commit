package app.dailycommit.vault;

import java.security.AlgorithmParameters;
import java.security.GeneralSecurityException;
import java.security.Key;
import java.security.Provider;
import java.security.SecureRandom;
import java.security.spec.AlgorithmParameterSpec;
import javax.crypto.Cipher;
import javax.crypto.CipherSpi;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * A decryptor that succeeds and hands back one fixed array, so a test can open a waiting
 * copy to bytes it was not sealed from. A real cipher would reject those bytes at the tag.
 */
final class FixedDecrypt {
    private static byte[] pending;

    private FixedDecrypt() {}

    static Cipher cipher(byte[] plain, SecretKey key, byte[] iv) throws GeneralSecurityException {
        pending = plain.clone();
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding", new Hold());
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
            return cipher;
        } finally {
            pending = null;
        }
    }

    /** The bytes the next cipher should return. Public so the cipher service can be built. */
    public static final class Spi extends CipherSpi {
        private final byte[] plain;

        public Spi() {
            plain = pending.clone();
        }

        @Override protected void engineSetMode(String mode) {}
        @Override protected void engineSetPadding(String padding) {}
        @Override protected int engineGetBlockSize() { return 16; }
        @Override protected int engineGetOutputSize(int inputLen) { return plain.length; }
        @Override protected byte[] engineGetIV() { return null; }
        @Override protected AlgorithmParameters engineGetParameters() { return null; }
        @Override protected void engineInit(int opmode, Key key, SecureRandom random) {}

        @Override protected void engineInit(int opmode, Key key, AlgorithmParameterSpec params, SecureRandom random) {}

        @Override protected void engineInit(int opmode, Key key, AlgorithmParameters params, SecureRandom random) {}

        @Override protected byte[] engineUpdate(byte[] input, int offset, int len) { return null; }

        @Override protected int engineUpdate(byte[] input, int offset, int len, byte[] output, int outputOffset) { return 0; }

        @Override protected byte[] engineDoFinal(byte[] input, int offset, int len) { return plain.clone(); }

        @Override protected int engineDoFinal(byte[] input, int offset, int len, byte[] output, int outputOffset) {
            System.arraycopy(plain, 0, output, outputOffset, plain.length);
            return plain.length;
        }

        @Override protected void engineUpdateAAD(byte[] src, int offset, int len) {}
    }

    @SuppressWarnings("deprecation")
    private static final class Hold extends Provider {
        Hold() {
            super("dc-fixed-decrypt", 1.0, "test");
            put("Cipher.AES", Spi.class.getName());
        }
    }
}
