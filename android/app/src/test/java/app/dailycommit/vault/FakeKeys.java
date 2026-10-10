package app.dailycommit.vault;

import java.security.GeneralSecurityException;
import java.security.KeyStoreException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.Mac;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** A key store in memory, with the phone's failures on demand. */
final class FakeKeys implements KeyStoreLike {
    final Map<String, SecretKey> keys = new HashMap<>();
    final Set<String> invalid = new HashSet<>();        // a new fingerprint, or the screen lock removed
    final Set<String> refuseDelete = new HashSet<>();
    boolean powerCutInHmac;                             // the app is ended between the count and the compare
    /** This alias's decrypter succeeds and returns these bytes, whatever was sealed. */
    final Map<String, byte[]> lieDecrypt = new HashMap<>();
    final List<String> log = new ArrayList<>();

    @Override public void create(String alias, Kind kind) throws GeneralSecurityException {
        KeyGenerator generator = KeyGenerator.getInstance(kind == Kind.CODE ? "HmacSHA256" : "AES");
        if (kind != Kind.CODE) generator.init(256);
        keys.put(alias, generator.generateKey());
        invalid.remove(alias);
        log.add("create " + alias);
    }

    @Override public Set<String> aliases() { return new TreeSet<>(keys.keySet()); }

    @Override public void delete(String alias) throws GeneralSecurityException {
        if (refuseDelete.contains(alias)) throw new KeyStoreException("refused");
        keys.remove(alias);
        invalid.remove(alias);
        log.add("delete " + alias);
    }

    private SecretKey key(String alias) throws KeyGone {
        SecretKey k = keys.get(alias);
        if (k == null || invalid.contains(alias)) throw new KeyGone(alias);
        return k;
    }

    @Override public Cipher encrypter(String alias) throws GeneralSecurityException {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key(alias));
        return c;
    }

    @Override public Cipher decrypter(String alias, byte[] iv) throws GeneralSecurityException {
        SecretKey k = key(alias);
        byte[] lie = lieDecrypt.get(alias);
        if (lie != null) return FixedDecrypt.cipher(lie, k, iv);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, k, new GCMParameterSpec(128, iv));
        return c;
    }

    @Override public byte[] hmac(String alias, byte[] data) throws GeneralSecurityException {
        if (powerCutInHmac) throw new IllegalStateException("power cut");
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(key(alias));
        return mac.doFinal(data);
    }
}
