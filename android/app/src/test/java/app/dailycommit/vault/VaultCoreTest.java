package app.dailycommit.vault;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import app.dailycommit.vault.VaultCore.CodeCheck;
import app.dailycommit.vault.VaultCore.Mode;
import app.dailycommit.vault.VaultCore.Opened;
import app.dailycommit.vault.VaultCore.Step;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.List;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class VaultCoreTest {

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private static final String CODE = "24681357";
    private static final String NEW_CODE = "13572468";
    private static final byte[] KEY = bytes(1);
    private static final byte[] OTHER = bytes(2);

    private final FakeKeys keys = new FakeKeys();
    private File dir;
    private VaultCore core;

    private static byte[] bytes(int seed) {
        byte[] b = new byte[32];
        for (int i = 0; i < b.length; i++) b[i] = (byte) (seed * 31 + i);
        return b;
    }

    @Before public void start() {
        dir = new File(tmp.getRoot(), "vault");
        core = new VaultCore(dir, keys, new SecureRandom());
    }

    /** the app's process starting again: a new core with only what the phone saved (fakePlugin's restart()) */
    private void restart() { core = new VaultCore(dir, keys, new SecureRandom()); }

    /** opens a phone-lock or fingerprint copy, the phone's prompt allowing it */
    private Opened open(Mode mode) throws Exception {
        Step step = core.beginOpen(mode);
        return step == null ? Opened.missing() : core.finishOpen(step);
    }

    /** enrolMode's order: make the copy, then open it back */
    private void enrol(Mode mode, byte[] key) throws Exception {
        Step step = core.beginEnrol(mode, key);
        core.finishEnrol(step);
        Opened back = open(mode);
        assertEquals(Opened.Kind.KEY, back.kind);
        assertArrayEquals(key, back.key());
    }

    private void enrolCode(byte[] key, String code) throws Exception {
        core.enrolCode(key, code);
        CodeCheck back = core.verifyCode(code);
        assertEquals(CodeCheck.Kind.KEY, back.kind);
        assertArrayEquals(key, back.key());
    }

    private int wrong() throws Exception {
        CodeCheck check = core.verifyCode("00000000");
        assertEquals(CodeCheck.Kind.WRONG_CODE, check.kind);
        return check.triesLeft;
    }

    // fakePlugin status(): only the modes with a copy, in the order phone-lock, own-code, fingerprint
    @Test public void statusListsOnlyTheModesWithACopy_inTheFixedOrder() throws Exception {
        assertEquals(List.of(), core.status());
        enrol(Mode.FINGERPRINT, KEY);
        enrolCode(KEY, CODE);
        enrol(Mode.PHONE_LOCK, KEY);
        assertEquals(List.of(Mode.PHONE_LOCK, Mode.OWN_CODE, Mode.FINGERPRINT), core.status());
    }

    // native-only (Ruling): a new copy is offered once it has opened back, not at enrol
    @Test public void aNewCopyIsOfferedOnlyOnceItHasOpenedBack() throws Exception {
        core.finishEnrol(core.beginEnrol(Mode.PHONE_LOCK, KEY));
        assertEquals(List.of(), core.status());
        assertEquals(Opened.Kind.KEY, open(Mode.PHONE_LOCK).kind);
        assertEquals(List.of(Mode.PHONE_LOCK), core.status());
    }

    // fakePlugin unwrap(): the stored master key comes back
    @Test public void phoneLockOpensToTheKeyItWasGiven() throws Exception {
        enrol(Mode.PHONE_LOCK, KEY);
        restart();
        Opened opened = open(Mode.PHONE_LOCK);
        assertEquals(Opened.Kind.KEY, opened.kind);
        assertArrayEquals(KEY, opened.key());
    }

    // fakePlugin cancelNext(): Cancelled, and the copy is kept (devices.test "backing out of the phone's prompt changes nothing")
    @Test public void backingOutOfThePromptKeepsTheCopy() throws Exception {
        enrol(Mode.PHONE_LOCK, KEY);
        assertEquals(Opened.Kind.CANCELLED, core.cancelled(core.beginOpen(Mode.PHONE_LOCK)).kind);
        assertEquals(List.of(Mode.PHONE_LOCK), core.status());
        assertArrayEquals(KEY, open(Mode.PHONE_LOCK).key());
    }

    // fakePlugin opened(): no copy → Missing
    @Test public void withNoCopyAnOpenIsMissing() throws Exception {
        assertNull(core.beginOpen(Mode.PHONE_LOCK));
        assertNull(core.beginOpen(Mode.FINGERPRINT));
    }

    // fakePlugin invalidate(): Missing, and the copy stays listed until the app removes it
    @Test public void anInvalidatedKeyIsMissing_andItsCopyStaysListedUntilRemoved() throws Exception {
        enrolCode(KEY, CODE);
        enrol(Mode.FINGERPRINT, KEY);
        keys.invalid.add(core.aliasOf(Mode.FINGERPRINT));
        assertEquals(Opened.Kind.MISSING, open(Mode.FINGERPRINT).kind);
        assertEquals(List.of(Mode.OWN_CODE, Mode.FINGERPRINT), core.status());
        core.remove(Mode.FINGERPRINT);
        assertEquals(List.of(Mode.OWN_CODE), core.status());
        assertEquals(CodeCheck.Kind.KEY, core.verifyCode(CODE).kind);
    }

    // fakePlugin enrol() clears the invalid mark: enrolling again works
    @Test public void enrollingAgainAfterInvalidationWorks() throws Exception {
        enrol(Mode.FINGERPRINT, KEY);
        keys.invalid.add(core.aliasOf(Mode.FINGERPRINT));
        enrol(Mode.FINGERPRINT, KEY);
        assertArrayEquals(KEY, open(Mode.FINGERPRINT).key());
    }

    // fakePlugin enrol('own-code') without a code throws; native-only: six or more digits, and a 32-byte key
    @Test public void aCodeIsSixOrMoreDigits_andAMasterKeyIs32Bytes() {
        assertThrows(IllegalArgumentException.class, () -> core.enrolCode(KEY, null));
        assertThrows(IllegalArgumentException.class, () -> core.enrolCode(KEY, "12345"));
        assertThrows(IllegalArgumentException.class, () -> core.enrolCode(KEY, "12345a"));
        assertThrows(IllegalArgumentException.class, () -> core.enrolCode(new byte[31], CODE));
        assertThrows(IllegalArgumentException.class, () -> core.beginEnrol(Mode.PHONE_LOCK, new byte[33]));
        assertThrows(IllegalArgumentException.class, () -> core.beginEnrol(Mode.OWN_CODE, KEY));
    }

    // fakePlugin verifyCode(): no own-code copy → Missing, nothing counted
    @Test public void verifyCodeWithNoCodeCopyIsMissing_andCountsNothing() throws Exception {
        assertEquals(CodeCheck.Kind.MISSING, core.verifyCode(CODE).kind);
        enrolCode(KEY, CODE);
        assertEquals(4, wrong());
    }

    // fakePlugin: wrong codes count down; a right code resets the count (devices.test "a right code resets the count")
    @Test public void wrongCodesCountDown_andTheRightCodeResetsTheCount() throws Exception {
        enrolCode(KEY, CODE);
        assertEquals(4, wrong());
        assertEquals(3, wrong());
        assertEquals(2, wrong());
        assertEquals(1, wrong());
        CodeCheck right = core.verifyCode(CODE);
        assertEquals(CodeCheck.Kind.KEY, right.kind);
        assertArrayEquals(KEY, right.key());
        assertEquals(4, wrong());
    }

    // fakePlugin: the fifth wrong code deletes own-code and fingerprint (R3-4), and their keys (R3-3's finding)
    @Test public void theFifthWrongCodeDeletesTheCodeAndFingerprintCopiesAndKeys() throws Exception {
        enrol(Mode.PHONE_LOCK, KEY);
        enrolCode(KEY, CODE);
        enrol(Mode.FINGERPRINT, KEY);
        String codeAlias = core.aliasOf(Mode.OWN_CODE);
        String fingerAlias = core.aliasOf(Mode.FINGERPRINT);
        for (int left = 4; left >= 1; left--) assertEquals(left, wrong());
        assertEquals(0, wrong());
        assertEquals(List.of(Mode.PHONE_LOCK), core.status());
        assertFalse(keys.aliases().contains(codeAlias));
        assertFalse(keys.aliases().contains(fingerAlias));
        assertEquals(CodeCheck.Kind.MISSING, core.verifyCode(CODE).kind);
        assertArrayEquals(KEY, open(Mode.PHONE_LOCK).key());
    }

    // RF3, fakePlugin "saved before the code is compared": the app is ended between the count and the compare
    @Test public void theCountIsWrittenBeforeTheCodeIsCompared() throws Exception {
        enrolCode(KEY, CODE);
        keys.powerCutInHmac = true;
        assertThrows(IllegalStateException.class, () -> core.verifyCode("00000000"));
        keys.powerCutInHmac = false;
        restart();
        assertEquals(3, wrong());                     // the cut try was counted
    }

    // R3-3 (devices.test "the wrong-code count survives the app being closed")
    @Test public void theCountSurvivesARestart() throws Exception {
        enrolCode(KEY, CODE);
        enrol(Mode.FINGERPRINT, KEY);
        for (int left = 4; left >= 1; left--) assertEquals(left, wrong());
        restart();
        assertEquals(0, wrong());
        assertEquals(List.of(), core.status());
    }

    // fakePlugin restart(): copies, count and invalidation survive; nothing in flight does
    @Test public void aRestartKeepsTheCopies_butNotANewCopyStillWaiting() throws Exception {
        enrol(Mode.PHONE_LOCK, KEY);
        core.finishEnrol(core.beginEnrol(Mode.PHONE_LOCK, OTHER));     // made, never opened back
        restart();
        assertEquals(List.of(Mode.PHONE_LOCK), core.status());
        assertArrayEquals(KEY, open(Mode.PHONE_LOCK).key());
        assertEquals(1, keys.aliases().size());                         // the waiting copy's key was swept
    }

    // R3-1 (devices.test R3-1), native-only staging: a re-enrol backed out of keeps the old copy
    @Test public void reEnrollingPhoneLockAndBackingOutKeepsTheOldCopy() throws Exception {
        enrol(Mode.PHONE_LOCK, KEY);
        core.cancelled(core.beginEnrol(Mode.PHONE_LOCK, OTHER));        // backed out of the first prompt
        assertArrayEquals(KEY, open(Mode.PHONE_LOCK).key());
        core.finishEnrol(core.beginEnrol(Mode.PHONE_LOCK, OTHER));
        assertEquals(Opened.Kind.CANCELLED, core.cancelled(core.beginOpen(Mode.PHONE_LOCK)).kind);   // backed out of the second
        assertEquals(List.of(Mode.PHONE_LOCK), core.status());
        assertArrayEquals(KEY, open(Mode.PHONE_LOCK).key());
        assertEquals(1, keys.aliases().size());
    }

    // R3-1 for a code change: a new code that doesn't open back never takes, and the old code still opens
    @Test public void aCodeChangeThatDoesNotOpenBackKeepsTheOldCode() throws Exception {
        enrolCode(KEY, CODE);
        core.enrolCode(OTHER, NEW_CODE);
        assertEquals(CodeCheck.Kind.MISSING, core.verifyCode("99999999").kind);
        assertArrayEquals(KEY, core.verifyCode(CODE).key());
        assertEquals(CodeCheck.Kind.WRONG_CODE, core.verifyCode(NEW_CODE).kind);
    }

    // RF3: a rejected code change must not hand the counted guesses back
    @Test public void aRejectedCodeChangeLeavesTheWrongCodeCount() throws Exception {
        enrolCode(KEY, CODE);
        assertEquals(4, wrong());
        assertEquals(3, wrong());                       // two counted, three tries left
        core.enrolCode(OTHER, NEW_CODE);
        assertEquals(CodeCheck.Kind.MISSING, core.verifyCode("99999999").kind);
        assertEquals(2, CopyFile.read(dir).wrongTries);
        restart();
        assertEquals(2, wrong());                       // a new core, same folder, same two guesses
    }

    // a waiting copy that opens to some other key is dropped; the working copy stays
    @Test public void anOpenBackToADifferentKeyIsMissing_andTheOldCopyStays() throws Exception {
        enrol(Mode.PHONE_LOCK, KEY);
        String oldAlias = core.aliasOf(Mode.PHONE_LOCK);
        Step step = core.beginEnrol(Mode.PHONE_LOCK, KEY);
        core.finishEnrol(step);
        keys.lieDecrypt.put(step.alias, OTHER.clone());
        assertEquals(Opened.Kind.MISSING, open(Mode.PHONE_LOCK).kind);
        assertFalse(keys.aliases().contains(step.alias));
        assertArrayEquals(KEY, open(Mode.PHONE_LOCK).key());
        assertEquals(oldAlias, core.aliasOf(Mode.PHONE_LOCK));
    }

    // native-only: a swap replaces the copy and deletes the old key; a code change resets the count
    @Test public void aSwapReplacesTheCopyAndDeletesTheOldKey() throws Exception {
        enrol(Mode.PHONE_LOCK, KEY);
        String first = core.aliasOf(Mode.PHONE_LOCK);
        enrol(Mode.PHONE_LOCK, OTHER);
        assertFalse(keys.aliases().contains(first));
        assertArrayEquals(OTHER, open(Mode.PHONE_LOCK).key());
        enrolCode(KEY, CODE);
        wrong();
        wrong();
        enrolCode(OTHER, NEW_CODE);
        assertEquals(4, wrong());
    }

    // fakePlugin remove(): the copy and its key go; removing a mode that isn't there does nothing
    @Test public void removeDeletesTheCopyAndItsKey() throws Exception {
        core.remove(Mode.PHONE_LOCK);
        enrol(Mode.PHONE_LOCK, KEY);
        String alias = core.aliasOf(Mode.PHONE_LOCK);
        core.remove(Mode.PHONE_LOCK);
        assertEquals(List.of(), core.status());
        assertFalse(keys.aliases().contains(alias));
        assertNull(core.beginOpen(Mode.PHONE_LOCK));
    }

    // U3 R1 / R3: a copy that couldn't be removed is reported, and is still there
    @Test public void aRemoveThatCannotBeWrittenIsRefused_andTheCopyStays() throws Exception {
        enrol(Mode.PHONE_LOCK, KEY);
        File blocker = new File(dir, CopyFile.TEMP);
        assertTrue(blocker.mkdir());                   // the temp file can't be written
        assertThrows(IOException.class, () -> core.remove(Mode.PHONE_LOCK));
        Files.delete(blocker.toPath());
        assertEquals(List.of(Mode.PHONE_LOCK), core.status());
        assertArrayEquals(KEY, open(Mode.PHONE_LOCK).key());
    }

    // Ruling: a key the store refuses to delete still leaves the mode off, and goes at the next start
    @Test public void aKeyTheStoreRefusesToDelete_stillLeavesTheModeOff_andGoesAtTheNextStart() throws Exception {
        enrol(Mode.PHONE_LOCK, KEY);
        String alias = core.aliasOf(Mode.PHONE_LOCK);
        keys.refuseDelete.add(alias);
        core.remove(Mode.PHONE_LOCK);
        assertEquals(List.of(), core.status());
        assertTrue(keys.aliases().contains(alias));
        keys.refuseDelete.clear();
        restart();
        assertFalse(keys.aliases().contains(alias));
    }

    // native-only: a damaged file is no copies, kept aside
    @Test public void aDamagedCopiesFileMeansNoCopies_andIsKeptAside() throws Exception {
        enrol(Mode.PHONE_LOCK, KEY);
        File file = new File(dir, CopyFile.NAME);
        byte[] bytes = Files.readAllBytes(file.toPath());
        bytes[bytes.length / 2] ^= 1;
        Files.write(file.toPath(), bytes);
        assertEquals(List.of(), core.status());
        assertTrue(new File(dir, CopyFile.ASIDE).exists());
    }

    // RF2: nothing in the file is the key, the code, or the key as the bridge carries it
    @Test public void theCopiesFileHoldsNeitherTheKeyNorTheCode() throws Exception {
        enrol(Mode.PHONE_LOCK, KEY);
        enrolCode(KEY, CODE);
        byte[] file = Files.readAllBytes(new File(dir, CopyFile.NAME).toPath());
        for (byte[] secret : List.of(KEY, CODE.getBytes(StandardCharsets.UTF_8), Codec.toBase64url(KEY).getBytes(StandardCharsets.UTF_8)))
            assertEquals(-1, indexOf(file, secret));
    }

    // a code copy is useless without its key (a key store wiped by the phone): Missing, never an error
    @Test public void aCodeCopyWithoutItsKeyIsMissing() throws Exception {
        enrolCode(KEY, CODE);
        keys.keys.remove(core.aliasOf(Mode.OWN_CODE));
        assertEquals(CodeCheck.Kind.MISSING, core.verifyCode(CODE).kind);
    }

    private static int indexOf(byte[] haystack, byte[] needle) {
        outer:
        for (int i = 0; i + needle.length <= haystack.length; i++) {
            for (int j = 0; j < needle.length; j++) if (haystack[i + j] != needle[j]) continue outer;
            return i;
        }
        return -1;
    }
}
