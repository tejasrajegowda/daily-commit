package app.dailycommit.vault;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.EnumMap;
import java.util.Map;
import java.util.zip.CRC32;

/**
 * The copies file: every current copy and the wrong-code count, rewritten whole and renamed into place.
 * Big-endian: magic "DCV1", the wrong-code count, one record per copy, then the CRC32 of every byte before it
 * stored as a long. A damaged file (bad magic, which is the version, or a bad CRC or a truncated record) is
 * moved aside to copies.bad and counts as no copies. It is never deleted.
 */
final class CopyFile {
    static final String NAME = "copies.bin", TEMP = "copies.tmp", ASIDE = "copies.bad";
    static final int MAGIC = 0x44435631;             // "DCV1"

    static final class Copy {
        final String alias; final byte[] iv; final byte[] ct; final byte[] salt;   // salt: own-code only, else null
        Copy(String alias, byte[] iv, byte[] ct, byte[] salt) {
            this.alias = alias;
            this.iv = iv;
            this.ct = ct;
            this.salt = salt;
        }
    }

    static final class State {
        int wrongTries;
        final EnumMap<VaultCore.Mode, Copy> copies = new EnumMap<>(VaultCore.Mode.class);
    }

    private CopyFile() {}

    /** No file: an empty state. A damaged file: moved aside to copies.bad, and an empty state. */
    static State read(File dir) throws IOException {
        File file = new File(dir, NAME);
        if (!file.isFile()) return new State();
        byte[] all = Files.readAllBytes(file.toPath());
        try {
            return decode(all);
        } catch (IllegalArgumentException damaged) {
            moveAside(file, new File(dir, ASIDE));
            return new State();
        }
    }

    /** copies.tmp written and synced, then renamed over copies.bin in one step; the folder synced where the system allows. */
    static void write(File dir, State state) throws IOException {
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("vault folder");
        byte[] bytes = encode(state);
        File tmp = new File(dir, TEMP);
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(bytes);
            out.getChannel().force(true);
        }
        Files.move(tmp.toPath(), new File(dir, NAME).toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        try (FileChannel channel = FileChannel.open(dir.toPath(), StandardOpenOption.READ)) {
            channel.force(true);
        } catch (IOException ignored) {
            // Windows refuses to sync a folder; Linux allows it.
        }
    }

    private static byte[] encode(State state) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        DataOutputStream data = new DataOutputStream(buf);
        data.writeInt(MAGIC);
        data.writeInt(state.wrongTries);
        data.writeByte(state.copies.size());
        for (Map.Entry<VaultCore.Mode, Copy> entry : state.copies.entrySet()) {
            Copy copy = entry.getValue();
            data.writeUTF(entry.getKey().id);
            data.writeUTF(copy.alias);
            data.writeShort(copy.iv.length);
            data.write(copy.iv);
            data.writeInt(copy.ct.length);
            data.write(copy.ct);
            if (copy.salt == null) {
                data.writeShort(0);
            } else {
                data.writeShort(copy.salt.length);
                data.write(copy.salt);
            }
        }
        data.flush();
        byte[] body = buf.toByteArray();
        CRC32 crc = new CRC32();
        crc.update(body);
        data.writeLong(crc.getValue());
        data.flush();
        return buf.toByteArray();
    }

    private static State decode(byte[] all) {
        if (all.length < 17) throw new IllegalArgumentException("short");
        int bodyLen = all.length - Long.BYTES;
        CRC32 crc = new CRC32();
        crc.update(all, 0, bodyLen);
        long stored = 0;
        for (int i = 0; i < Long.BYTES; i++) stored = (stored << 8) | (all[bodyLen + i] & 0xffL);
        if (stored != crc.getValue()) throw new IllegalArgumentException("crc");
        DataInputStream in = new DataInputStream(new ByteArrayInputStream(all, 0, bodyLen));
        try {
            if (in.readInt() != MAGIC) throw new IllegalArgumentException("magic");
            State state = new State();
            state.wrongTries = in.readInt();
            int count = in.readUnsignedByte();
            for (int i = 0; i < count; i++) {
                VaultCore.Mode mode = VaultCore.Mode.of(in.readUTF());
                String alias = in.readUTF();
                byte[] iv = readExact(in, in.readUnsignedShort(), bodyLen);
                int ctLen = in.readInt();
                if (ctLen < 0) throw new IllegalArgumentException("ct");
                byte[] ct = readExact(in, ctLen, bodyLen);
                int saltLen = in.readUnsignedShort();
                byte[] salt = saltLen == 0 ? null : readExact(in, saltLen, bodyLen);
                state.copies.put(mode, new Copy(alias, iv, ct, salt));
            }
            if (in.read() != -1) throw new IllegalArgumentException("trailing");
            return state;
        } catch (IOException truncated) {
            throw new IllegalArgumentException("truncated");
        }
    }

    private static byte[] readExact(DataInputStream in, int length, int limit) throws IOException {
        if (length < 0 || length > limit) throw new IllegalArgumentException("length");
        byte[] bytes = new byte[length];
        in.readFully(bytes);
        return bytes;
    }

    /** The damaged file moves aside. Replacing an older aside keeps the newest damaged bytes. */
    private static void moveAside(File file, File aside) throws IOException {
        Files.move(file.toPath(), aside.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
    }
}
