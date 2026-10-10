package app.dailycommit.vault;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * The phone's device copies of the master key, one per mode, each under a key the phone's key store
 * holds; the behaviour of tests/vault/fakePlugin.ts, made durable. The copies and the wrong-code
 * count live in one file, rewritten whole and renamed into place. The count is written before each
 * code is compared, so closing the app never gives a guess back, and the fifth wrong code deletes
 * the code's and the fingerprint's copies and keys. A new copy waits in memory beside the current
 * one and replaces it only once it has opened back to the very key it was made from.
 * Plain Java, so the JVM tests run it as it is.
 */
public final class VaultCore {

    public static final int MAX_CODE_TRIES = 5;
    public static final int KEY_BYTES = 32;
    static final String ALIAS_PREFIX = "dc.";
    private static final Pattern CODE = Pattern.compile("[0-9]{6,}");
    private static final byte[] CODE_INFO = "dc/owncode/v1".getBytes(StandardCharsets.UTF_8);

    public enum Mode {
        PHONE_LOCK("phone-lock", "A", KeyStoreLike.Kind.PHONE_LOCK),
        OWN_CODE("own-code", "B", KeyStoreLike.Kind.CODE),
        FINGERPRINT("fingerprint", "C", KeyStoreLike.Kind.FINGERPRINT);

        public final String id;
        final String letter;
        final KeyStoreLike.Kind kind;

        Mode(String id, String letter, KeyStoreLike.Kind kind) { this.id = id; this.letter = letter; this.kind = kind; }

        public static Mode of(String id) {
            for (Mode m : values()) if (m.id.equals(id)) return m;
            throw new IllegalArgumentException("no such mode");
        }

        byte[] aad() { return ("dc1/copy/" + id).getBytes(StandardCharsets.UTF_8); }
    }

    /** One use of a phone-lock or fingerprint key, waiting for the phone's prompt to allow its cipher. */
    public static final class Step {
        public final Mode mode;
        public final boolean enrol;
        /** for the prompt's CryptoObject */
        public final Cipher cipher;
        final String alias;
        final CopyFile.Copy copy;     // open: the copy being opened
        final boolean waiting;        // open: the new copy, not yet in the file
        final byte[] secret;          // enrol: the master key, zero-filled once used

        Step(Mode mode, boolean enrol, Cipher cipher, String alias, CopyFile.Copy copy, boolean waiting, byte[] secret) {
            this.mode = mode; this.enrol = enrol; this.cipher = cipher; this.alias = alias;
            this.copy = copy; this.waiting = waiting; this.secret = secret;
        }
    }

    public static final class Opened {
        public enum Kind { KEY, CANCELLED, MISSING }
        public final Kind kind;
        private final byte[] key;
        private Opened(Kind kind, byte[] key) { this.kind = kind; this.key = key; }
        static Opened key(byte[] key) { return new Opened(Kind.KEY, key); }
        static Opened cancelled() { return new Opened(Kind.CANCELLED, null); }
        static Opened missing() { return new Opened(Kind.MISSING, null); }
        /** the master key; the caller zero-fills it once it has crossed the bridge */
        public byte[] key() { return key; }
    }

    public static final class CodeCheck {
        public enum Kind { KEY, WRONG_CODE, MISSING }
        public final Kind kind;
        public final int triesLeft;
        private final byte[] key;
        private CodeCheck(Kind kind, int triesLeft, byte[] key) { this.kind = kind; this.triesLeft = triesLeft; this.key = key; }
        static CodeCheck key(byte[] key) { return new CodeCheck(Kind.KEY, 0, key); }
        static CodeCheck wrong(int triesLeft) { return new CodeCheck(Kind.WRONG_CODE, Math.max(triesLeft, 0), null); }
        static CodeCheck missing() { return new CodeCheck(Kind.MISSING, 0, null); }
        public byte[] key() { return key; }
    }

    private static final class Waiting {
        final CopyFile.Copy copy;
        final byte[] digest;
        Waiting(CopyFile.Copy copy, byte[] digest) { this.copy = copy; this.digest = digest; }
    }

    private final File dir;
    private final KeyStoreLike keys;
    private final SecureRandom random;
    /** new copies that haven't opened back yet; memory only, so a process that ends drops them */
    private final Map<Mode, Waiting> waiting = new EnumMap<>(Mode.class);

    public VaultCore(File dir, KeyStoreLike keys, SecureRandom random) {
        this.dir = dir;
        this.keys = keys;
        this.random = random;
        sweep();
    }

    /** The modes with a copy now, in a fixed order; the unlock choices come only from this. */
    public synchronized List<Mode> status() throws IOException {
        CopyFile.State state = CopyFile.read(dir);
        List<Mode> modes = new ArrayList<>();
        for (Mode m : Mode.values()) if (state.copies.containsKey(m)) modes.add(m);
        return modes;
    }

    /** The key alias a mode's copy uses now, or null; for the plugin's report of where the code key lives. */
    public synchronized String aliasOf(Mode mode) throws IOException {
        CopyFile.Copy copy = CopyFile.read(dir).copies.get(mode);
        return copy == null ? null : copy.alias;
    }

    /** Own code: the new copy is made at once (no prompt) and waits until verifyCode opens it. */
    public synchronized void enrolCode(byte[] masterKey, String code) throws GeneralSecurityException, IOException {
        checkKey(masterKey);
        if (code == null || !CODE.matcher(code).matches()) throw new IllegalArgumentException("a code is six or more digits");
        dropWaiting(Mode.OWN_CODE);
        String alias = nextAlias(Mode.OWN_CODE);
        keys.create(alias, KeyStoreLike.Kind.CODE);
        byte[] salt = randomBytes(16);
        byte[] iv = randomBytes(12);
        byte[] kek = null;
        try {
            kek = codeKey(alias, code, salt);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(kek, "AES"), new GCMParameterSpec(128, iv));
            cipher.updateAAD(Mode.OWN_CODE.aad());
            byte[] ct = cipher.doFinal(masterKey);
            waiting.put(Mode.OWN_CODE, new Waiting(new CopyFile.Copy(alias, iv, ct, salt), digest(masterKey)));
        } catch (GeneralSecurityException | RuntimeException e) {
            deleteQuietly(alias);
            throw e;
        } finally {
            if (kek != null) Arrays.fill(kek, (byte) 0);
        }
    }

    /** Phone lock or fingerprint: a new key, and the encrypt step the phone's prompt must allow. */
    public synchronized Step beginEnrol(Mode mode, byte[] masterKey) throws GeneralSecurityException, IOException {
        if (mode == Mode.OWN_CODE) throw new IllegalArgumentException("own-code is enrolled with its code");
        checkKey(masterKey);
        dropWaiting(mode);
        String alias = nextAlias(mode);
        keys.create(alias, mode.kind);
        try {
            return new Step(mode, true, keys.encrypter(alias), alias, null, false, masterKey.clone());
        } catch (GeneralSecurityException | RuntimeException e) {
            deleteQuietly(alias);
            throw e;
        }
    }

    /** The prompt allowed it: the new copy waits beside the current one until the next open of its mode. */
    public synchronized void finishEnrol(Step step) throws GeneralSecurityException {
        try {
            step.cipher.updateAAD(step.mode.aad());
            byte[] ct = step.cipher.doFinal(step.secret);
            waiting.put(step.mode, new Waiting(new CopyFile.Copy(step.alias, step.cipher.getIV(), ct, null), digest(step.secret)));
        } catch (GeneralSecurityException | RuntimeException e) {
            deleteQuietly(step.alias);
            throw e;
        } finally {
            Arrays.fill(step.secret, (byte) 0);
        }
    }

    /** The copy to open, a waiting new one first; null when there is none or its key is gone (Missing). */
    public synchronized Step beginOpen(Mode mode) throws GeneralSecurityException, IOException {
        if (mode == Mode.OWN_CODE) throw new IllegalArgumentException("own-code opens with verifyCode");
        Waiting w = waiting.get(mode);
        CopyFile.Copy copy = w != null ? w.copy : CopyFile.read(dir).copies.get(mode);
        if (copy == null) return null;
        try {
            return new Step(mode, false, keys.decrypter(copy.alias, copy.iv), copy.alias, copy, w != null, null);
        } catch (KeyStoreLike.KeyGone gone) {
            if (w != null) dropWaiting(mode);
            return null;                        // an invalidated key: Missing, and the copy stays until removed
        }
    }

    /** The prompt allowed it: the key, after which a waiting copy has replaced the old one. */
    public synchronized Opened finishOpen(Step step) throws GeneralSecurityException, IOException {
        byte[] key;
        try {
            step.cipher.updateAAD(step.mode.aad());
            key = step.cipher.doFinal(step.copy.ct);
        } catch (AEADBadTagException damaged) {
            if (step.waiting) dropWaiting(step.mode);
            return Opened.missing();
        } catch (GeneralSecurityException | RuntimeException e) {
            if (step.waiting) dropWaiting(step.mode);
            throw e;
        }
        if (key.length != KEY_BYTES) {
            Arrays.fill(key, (byte) 0);
            if (step.waiting) dropWaiting(step.mode);
            return Opened.missing();
        }
        if (!step.waiting) return Opened.key(key);
        Waiting w = waiting.remove(step.mode);
        if (w == null || w.copy != step.copy || !MessageDigest.isEqual(w.digest, digest(key))) {
            Arrays.fill(key, (byte) 0);
            if (w != null) deleteQuietly(w.copy.alias);
            return Opened.missing();
        }
        try {
            promote(step.mode, w.copy);
        } catch (IOException e) {
            Arrays.fill(key, (byte) 0);
            throw e;
        }
        return Opened.key(key);
    }

    /** The person backed out of the prompt, or it failed: a new key goes, a waiting copy goes, a current copy stays. */
    public synchronized Opened cancelled(Step step) {
        if (step.enrol) {
            Arrays.fill(step.secret, (byte) 0);
            deleteQuietly(step.alias);
        } else if (step.waiting) {
            dropWaiting(step.mode);
        }
        return Opened.cancelled();
    }

    /** Checks the own code and opens its copy. The count is written before the code is compared. */
    public synchronized CodeCheck verifyCode(String code) throws GeneralSecurityException, IOException {
        Waiting w = waiting.remove(Mode.OWN_CODE);
        if (w != null) {
            byte[] key = openCodeQuietly(w.copy, code);
            if (key == null || !MessageDigest.isEqual(w.digest, digest(key))) {
                if (key != null) Arrays.fill(key, (byte) 0);
                deleteQuietly(w.copy.alias);
                return CodeCheck.missing();          // the new code never took; the old one still opens
            }
            try {
                promote(Mode.OWN_CODE, w.copy);
            } catch (IOException e) {
                Arrays.fill(key, (byte) 0);
                throw e;
            }
            return CodeCheck.key(key);
        }
        CopyFile.State state = CopyFile.read(dir);
        CopyFile.Copy copy = state.copies.get(Mode.OWN_CODE);
        if (copy == null) return CodeCheck.missing();
        state.wrongTries += 1;
        CopyFile.write(dir, state);                   // counted, and on disk, before the code is compared
        byte[] key;
        try {
            key = openCode(copy, code);
        } catch (KeyStoreLike.KeyGone gone) {
            return CodeCheck.missing();
        }
        if (key == null) {
            int left = MAX_CODE_TRIES - state.wrongTries;
            if (left > 0) return CodeCheck.wrong(left);
            CopyFile.Copy finger = state.copies.remove(Mode.FINGERPRINT);
            state.copies.remove(Mode.OWN_CODE);
            dropWaiting(Mode.FINGERPRINT);
            CopyFile.write(dir, state);
            deleteQuietly(copy.alias);
            if (finger != null) deleteQuietly(finger.alias);
            return CodeCheck.wrong(0);
        }
        state.wrongTries = 0;
        try {
            CopyFile.write(dir, state);
        } catch (IOException e) {
            Arrays.fill(key, (byte) 0);
            throw e;
        }
        return CodeCheck.key(key);
    }

    /** Deletes a mode's copy, then its key. Throws if the copy couldn't be removed; removing a mode that isn't there does nothing. */
    public synchronized void remove(Mode mode) throws IOException {
        dropWaiting(mode);
        CopyFile.State state = CopyFile.read(dir);
        CopyFile.Copy copy = state.copies.remove(mode);
        if (copy == null) return;
        CopyFile.write(dir, state);                   // if this fails, the copy is still on the phone, and the caller is told
        deleteQuietly(copy.alias);                    // a key without its copy opens nothing; a refused one is swept at the next start
    }

    /** Deletes this app's keys that no copy uses: left by a process that ended mid-change, or refused once. */
    public synchronized void sweep() {
        try {
            Set<String> used = new HashSet<>();
            for (CopyFile.Copy c : CopyFile.read(dir).copies.values()) used.add(c.alias);
            for (Waiting w : waiting.values()) used.add(w.copy.alias);
            for (String alias : keys.aliases()) if (alias.startsWith(ALIAS_PREFIX) && !used.contains(alias)) deleteQuietly(alias);
        } catch (IOException | GeneralSecurityException | RuntimeException e) {
            // tried again at the next start
        }
    }

    private void promote(Mode mode, CopyFile.Copy copy) throws IOException {
        CopyFile.State state = CopyFile.read(dir);
        CopyFile.Copy old = state.copies.put(mode, copy);
        if (mode == Mode.OWN_CODE) state.wrongTries = 0;
        try {
            CopyFile.write(dir, state);               // the swap is this one rename
        } catch (IOException e) {
            deleteQuietly(copy.alias);
            throw e;
        }
        if (old != null && !old.alias.equals(copy.alias)) deleteQuietly(old.alias);
    }

    private String nextAlias(Mode mode) throws IOException {
        CopyFile.Copy current = CopyFile.read(dir).copies.get(mode);
        String first = ALIAS_PREFIX + mode.letter + ".0";
        return current != null && current.alias.equals(first) ? ALIAS_PREFIX + mode.letter + ".1" : first;
    }

    private byte[] codeKey(String alias, String code, byte[] salt) throws GeneralSecurityException {
        byte[] typed = code.getBytes(StandardCharsets.UTF_8);
        byte[] input = Arrays.copyOf(typed, typed.length + salt.length);
        System.arraycopy(salt, 0, input, typed.length, salt.length);
        byte[] mac = keys.hmac(alias, input);
        try {
            return Hkdf.sha256(mac, salt, CODE_INFO, KEY_BYTES);
        } finally {
            Arrays.fill(typed, (byte) 0);
            Arrays.fill(input, (byte) 0);
            Arrays.fill(mac, (byte) 0);
        }
    }

    /** The master key, or null for a wrong code; throws KeyGone if the code key is gone. */
    private byte[] openCode(CopyFile.Copy copy, String code) throws GeneralSecurityException {
        if (code == null) return null;
        byte[] kek = codeKey(copy.alias, code, copy.salt);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(kek, "AES"), new GCMParameterSpec(128, copy.iv));
            cipher.updateAAD(Mode.OWN_CODE.aad());
            byte[] key = cipher.doFinal(copy.ct);
            if (key.length == KEY_BYTES) return key;
            Arrays.fill(key, (byte) 0);
            return null;
        } catch (AEADBadTagException wrong) {
            return null;
        } finally {
            Arrays.fill(kek, (byte) 0);
        }
    }

    private byte[] openCodeQuietly(CopyFile.Copy copy, String code) {
        try {
            return openCode(copy, code);
        } catch (GeneralSecurityException | RuntimeException e) {
            return null;
        }
    }

    private void dropWaiting(Mode mode) {
        Waiting w = waiting.remove(mode);
        if (w != null) deleteQuietly(w.copy.alias);
    }

    private void deleteQuietly(String alias) {
        try {
            keys.delete(alias);
        } catch (GeneralSecurityException | RuntimeException e) {
            // swept at the next start
        }
    }

    private static void checkKey(byte[] masterKey) {
        if (masterKey == null || masterKey.length != KEY_BYTES) throw new IllegalArgumentException("a master key is 32 bytes");
    }

    private byte[] randomBytes(int n) {
        byte[] b = new byte[n];
        random.nextBytes(b);
        return b;
    }

    private static byte[] digest(byte[] bytes) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(bytes);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }
}
