package app.dailycommit.shell;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The record's private files (record/files.ts: snapshots, their temporary files, safety and
 * pre-upgrade copies), under filesDir. Paths are relative, use "/", and stay inside the four folders
 * the record uses. Every write goes to "<name>.part", is synced, and is renamed into place.
 */
public final class ShellFiles {
    static final Set<String> FOLDERS = Set.of("backup", "tmp", "safety", "preupgrade");
    private static final Pattern PATH = Pattern.compile("[a-z]+(/[A-Za-z0-9._-]+)*");

    private final File root;

    public ShellFiles(File root) {
        this.root = root;
    }

    /** writes the whole file, replacing any file at that path */
    public void write(String path, byte[] bytes) throws IOException {
        if (bytes == null) throw new IllegalArgumentException("bytes");
        File file = place(path, false);
        File parent = file.getParentFile();
        if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("folder");
        File part = new File(parent, file.getName() + ".part");
        try (FileOutputStream out = new FileOutputStream(part)) {
            out.write(bytes);
            out.getFD().sync();
        }
        Files.move(part.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        syncFolder(parent);
    }

    /** the whole file, or null if there is none */
    public byte[] read(String path) throws IOException {
        File file = place(path, false);
        if (!file.isFile()) return null;
        return Files.readAllBytes(file.toPath());
    }

    /** moves a file in one step, replacing any file at `to`; throws if `from` isn't there */
    public void rename(String from, String to) throws IOException {
        File source = place(from, false);
        File target = place(to, false);
        File parent = target.getParentFile();
        if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("folder");
        Files.move(source.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        syncFolder(parent);
        File sourceParent = source.getParentFile();
        if (!sourceParent.equals(parent)) syncFolder(sourceParent);
    }

    /** the names of the files directly inside a folder, sorted, without unfinished ".part" files; empty if there is no such folder */
    public List<String> list(String dir) throws IOException {
        File folder = place(dir, true);
        if (!folder.isDirectory()) return List.of();
        File[] children = folder.listFiles();
        if (children == null) throw new IOException("list");
        List<String> names = new ArrayList<>();
        for (File child : children) {
            if (child.isFile() && !child.getName().endsWith(".part")) names.add(child.getName());
        }
        Collections.sort(names);
        return names;
    }

    /** deletes a file; one that isn't there is nothing to do */
    public void remove(String path) throws IOException {
        Files.deleteIfExists(place(path, false).toPath());
    }

    /** reads at most `limit` bytes; null if the stream holds more (a picked file too large to be a backup) */
    public static byte[] readAtMost(InputStream in, int limit) throws IOException {
        if (in == null || limit < 0) throw new IllegalArgumentException("limit");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int seen = 0;
        while (seen <= limit) {
            int want = (int) Math.min(buf.length, (long) limit - seen + 1);
            int n = in.read(buf, 0, want);
            if (n < 0) break;
            if (n == 0) continue;
            if (n > limit - seen) return null;
            out.write(buf, 0, n);
            seen += n;
        }
        return out.toByteArray();
    }

    private File place(String path, boolean folder) throws IOException {
        if (path == null || !PATH.matcher(path).matches()) throw new IllegalArgumentException("path");
        String[] parts = path.split("/", -1);
        if (!FOLDERS.contains(parts[0]) || (!folder && parts.length < 2)) throw new IllegalArgumentException("path");
        for (String part : parts) {
            if (onlyDots(part) || part.endsWith(".part")) throw new IllegalArgumentException("path");
        }
        File file = root;
        for (String part : parts) file = new File(file, part);
        String rootPath = root.getCanonicalPath();
        String prefix = rootPath.endsWith(File.separator) ? rootPath : rootPath + File.separator;
        if (!file.getCanonicalPath().startsWith(prefix)) throw new IllegalArgumentException("path");
        return file;
    }

    private static boolean onlyDots(String part) {
        for (int i = 0; i < part.length(); i++) {
            if (part.charAt(i) != '.') return false;
        }
        return true;
    }

    /** The folder synced where the system allows, as CopyFile does after a rename into place. */
    private static void syncFolder(File dir) {
        try (FileChannel channel = FileChannel.open(dir.toPath(), StandardOpenOption.READ)) {
            channel.force(true);
        } catch (IOException ignored) {
            // Windows refuses to sync a folder; Linux allows it.
        }
    }
}
