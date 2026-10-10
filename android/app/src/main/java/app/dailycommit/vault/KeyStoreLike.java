package app.dailycommit.vault;

import java.security.GeneralSecurityException;
import java.util.Set;
import javax.crypto.Cipher;

/** The phone's key store, as VaultCore uses it. AndroidKeys is the real one; the JVM tests use FakeKeys. */
public interface KeyStoreLike {

    enum Kind { PHONE_LOCK, CODE, FINGERPRINT }

    /** Makes a new key under this alias, replacing any key there. A CODE key goes into StrongBox where the phone has one. */
    void create(String alias, Kind kind) throws GeneralSecurityException;

    /** The aliases of the keys this app made (they start with "dc."). */
    Set<String> aliases() throws GeneralSecurityException;

    /** Deletes a key; throws if the store refuses. Deleting a key that isn't there does nothing. */
    void delete(String alias) throws GeneralSecurityException;

    /** An AES-GCM cipher ready to encrypt; a PHONE_LOCK or FINGERPRINT one works only once the phone's prompt allows it. */
    Cipher encrypter(String alias) throws GeneralSecurityException;

    /** The same, to decrypt a copy made with this IV. */
    Cipher decrypter(String alias, byte[] iv) throws GeneralSecurityException;

    /** HMAC-SHA256 under a CODE key. */
    byte[] hmac(String alias, byte[] data) throws GeneralSecurityException;

    /** The key is missing, or the phone stopped honouring it (a new fingerprint, the screen lock removed). */
    final class KeyGone extends GeneralSecurityException {
        public KeyGone(String alias) { super("key gone: " + alias); }
    }
}
