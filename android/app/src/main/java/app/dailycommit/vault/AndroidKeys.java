package app.dailycommit.vault;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.StrongBoxUnavailableException;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Collections;
import java.util.Set;
import java.util.TreeSet;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.Mac;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The phone's key store. A (phone lock): AES-256-GCM, the fingerprint or the phone's PIN for every
 * use, kept when a fingerprint is added (adding one needs the PIN, which opens A anyway). B (own
 * code): HMAC-SHA256 with no prompt, in StrongBox where the phone has one, else the TEE. C
 * (fingerprint within own code): AES-256-GCM, a strong fingerprint for every use, invalidated
 * when a new fingerprint is added. A and C are invalidated if the screen lock is removed.
 */
final class AndroidKeys implements KeyStoreLike {
    private static final String STORE = "AndroidKeyStore";
    private final KeyStore store;

    AndroidKeys() throws GeneralSecurityException, IOException {
        store = KeyStore.getInstance(STORE);
        store.load(null);
    }

    @Override public void create(String alias, Kind kind) throws GeneralSecurityException {
        delete(alias);
        if (kind == Kind.CODE) {
            try {
                generateCodeKey(alias, true);
            } catch (StrongBoxUnavailableException noStrongBox) {
                generateCodeKey(alias, false);
            }
            return;
        }
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true);
        if (kind == Kind.PHONE_LOCK) {
            spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL)
                .setInvalidatedByBiometricEnrollment(false);
        } else {
            spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                .setInvalidatedByBiometricEnrollment(true);
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE);
        generator.init(spec.build());
        generator.generateKey();
    }

    private void generateCodeKey(String alias, boolean strongBox) throws GeneralSecurityException {
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, STORE);
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN).setIsStrongBoxBacked(strongBox).build());
        generator.generateKey();
    }

    @Override public Set<String> aliases() throws GeneralSecurityException {
        Set<String> ours = new TreeSet<>();
        for (String alias : Collections.list(store.aliases())) if (alias.startsWith(VaultCore.ALIAS_PREFIX)) ours.add(alias);
        return ours;
    }

    @Override public void delete(String alias) throws GeneralSecurityException {
        if (store.containsAlias(alias)) store.deleteEntry(alias);
    }

    private SecretKey key(String alias) throws GeneralSecurityException {
        SecretKey key = (SecretKey) store.getKey(alias, null);
        if (key == null) throw new KeyGone(alias);
        return key;
    }

    @Override public Cipher encrypter(String alias) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        try {
            cipher.init(Cipher.ENCRYPT_MODE, key(alias));
        } catch (KeyPermanentlyInvalidatedException e) {
            throw new KeyGone(alias);
        }
        return cipher;
    }

    @Override public Cipher decrypter(String alias, byte[] iv) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        try {
            cipher.init(Cipher.DECRYPT_MODE, key(alias), new GCMParameterSpec(128, iv));
        } catch (KeyPermanentlyInvalidatedException e) {
            throw new KeyGone(alias);
        }
        return cipher;
    }

    @Override public byte[] hmac(String alias, byte[] data) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        try {
            mac.init(key(alias));
        } catch (KeyPermanentlyInvalidatedException e) {
            throw new KeyGone(alias);
        }
        return mac.doFinal(data);
    }

    /** Where a key lives: "strongbox", "tee" or "software"; null if there is no such key. */
    String levelOf(String alias) {
        try {
            SecretKey key = (SecretKey) store.getKey(alias, null);
            if (key == null) return null;
            KeyInfo info = (KeyInfo) SecretKeyFactory.getInstance(key.getAlgorithm(), STORE).getKeySpec(key, KeyInfo.class);
            switch (info.getSecurityLevel()) {
                case KeyProperties.SECURITY_LEVEL_STRONGBOX: return "strongbox";
                case KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT: return "tee";
                default: return "software";
            }
        } catch (GeneralSecurityException | RuntimeException e) {
            return null;
        }
    }
}
