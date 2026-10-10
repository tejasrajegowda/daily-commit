package app.dailycommit.shell;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.List;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class ShellFilesTest {

    @Rule public TemporaryFolder tmp = new TemporaryFolder();
    private ShellFiles files;

    private static byte[] b(int... v) {
        byte[] out = new byte[v.length];
        for (int i = 0; i < v.length; i++) out[i] = (byte) v[i];
        return out;
    }

    @Before public void start() { files = new ShellFiles(tmp.getRoot()); }

    @Test public void aWrittenFileReadsBackTheSame_atAnyDepthInsideTheRecordsFolders() throws IOException {
        files.write("backup/older/2026-01-05.dcbak", b(1, 2, 3));
        assertArrayEquals(b(1, 2, 3), files.read("backup/older/2026-01-05.dcbak"));
    }

    @Test public void aWriteReplacesTheWholeFile() throws IOException {
        files.write("backup/latest.dcbak", new byte[10]);
        files.write("backup/latest.dcbak", b(7));
        assertArrayEquals(b(7), files.read("backup/latest.dcbak"));
    }

    @Test public void aFileThatIsNotThereReadsAsNull() throws IOException {
        assertNull(files.read("backup/latest.dcbak"));
    }

    @Test public void renameMovesInOneStep_andReplacesTheTarget() throws IOException {
        files.write("backup/latest.dcbak", b(1));
        files.write("tmp/snapshot.dcbak", b(2));
        files.rename("tmp/snapshot.dcbak", "backup/latest.dcbak");
        assertArrayEquals(b(2), files.read("backup/latest.dcbak"));
        assertNull(files.read("tmp/snapshot.dcbak"));
    }

    @Test public void renamingAFileThatIsNotThereFails() {
        assertThrows(IOException.class, () -> files.rename("tmp/snapshot.dcbak", "backup/latest.dcbak"));
    }

    @Test public void listGivesOnlyTheFilesDirectlyInside_sorted() throws IOException {
        files.write("backup/latest.dcbak", b(1));
        files.write("backup/older/2026-01-06.dcbak", b(2));
        files.write("backup/older/2026-01-05.dcbak", b(3));
        assertEquals(List.of("latest.dcbak"), files.list("backup"));
        assertEquals(List.of("2026-01-05.dcbak", "2026-01-06.dcbak"), files.list("backup/older"));
    }

    @Test public void aFolderThatIsNotThereListsEmpty_andRemovingAFileThatIsNotThereDoesNothing() throws IOException {
        assertEquals(List.of(), files.list("safety"));
        files.remove("safety/x.dcbak");
    }

    @Test public void removeDeletesTheFile() throws IOException {
        files.write("backup/older/2026-01-05.dcbak", b(1));
        files.remove("backup/older/2026-01-05.dcbak");
        assertNull(files.read("backup/older/2026-01-05.dcbak"));
    }

    @Test public void aHalfWrittenFileFromACrashIsNeverListed_andTheNextWriteReplacesIt() throws IOException {
        File part = new File(tmp.getRoot(), "backup/latest.dcbak.part");
        part.getParentFile().mkdirs();
        Files.write(part.toPath(), b(9, 9));
        assertEquals(List.of(), files.list("backup"));
        files.write("backup/latest.dcbak", b(1));
        assertEquals(List.of("latest.dcbak"), files.list("backup"));
        assertFalse(part.exists());
    }

    @Test public void pathsOutsideTheRecordsFoldersAreRefused() {
        for (String bad : Arrays.asList(null, "", "../x", "/backup/x", "backup/../../x", "backup/..", "backup/./x", "cache/x",
            "backup\\x", "Backup/x", "backup/", "backup/x.part", "shared_prefs/x.xml")) {
            assertThrows(String.valueOf(bad), IllegalArgumentException.class, () -> files.write(bad, b(1)));
        }
        assertThrows(IllegalArgumentException.class, () -> files.read("backup"));      // a folder is not a file
        assertThrows(IllegalArgumentException.class, () -> files.list("../"));
    }

    @Test public void readAtMostRefusesAStreamLargerThanTheLimit() throws IOException {
        assertArrayEquals(b(1, 2, 3), ShellFiles.readAtMost(new ByteArrayInputStream(b(1, 2, 3)), 3));
        assertNull(ShellFiles.readAtMost(new ByteArrayInputStream(b(1, 2, 3, 4)), 3));
    }
}
