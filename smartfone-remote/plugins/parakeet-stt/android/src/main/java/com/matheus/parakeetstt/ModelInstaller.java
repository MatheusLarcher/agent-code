package com.matheus.parakeetstt;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream;

/**
 * Downloads the Parakeet TDT 0.6B v3 int8 model (sherpa-onnx format) from the
 * sherpa-onnx GitHub releases and unpacks only the files the recognizer needs.
 *
 * The archive is decompressed while it streams in (no 487 MB temp file), into
 * a ".part" directory that is renamed only after every file is complete — so an
 * interrupted install never looks installed.
 */
final class ModelInstaller {

    static final String MODEL_NAME = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
    static final String MODEL_URL =
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/" + MODEL_NAME + ".tar.bz2";
    /** Size of the release asset (GitHub API, asr-models). Used for progress when the server omits it. */
    static final long MODEL_ARCHIVE_BYTES = 487170055L;
    /** SHA-256 digest GitHub reports for that asset; a re-upload upstream must be re-pinned here. */
    static final String MODEL_SHA256 = "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf";
    /** Unpacked size is ~670 MB; demand some headroom before starting. */
    static final long REQUIRED_FREE_BYTES = 800L * 1024 * 1024;
    static final String[] FILES = { "encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt" };

    interface Listener {
        void onProgress(long received, long total);
    }

    private final File root;
    private volatile boolean cancelled;
    private volatile HttpURLConnection conn;

    ModelInstaller(File filesDir) {
        this.root = new File(filesDir, "parakeet");
    }

    File modelDir() {
        return new File(root, MODEL_NAME);
    }

    boolean isInstalled() {
        File dir = modelDir();
        if (!new File(dir, ".complete").isFile()) return false;
        for (String f : FILES) if (!new File(dir, f).isFile()) return false;
        return true;
    }

    long installedBytes() {
        long sum = 0;
        for (String f : FILES) sum += new File(modelDir(), f).length();
        return sum;
    }

    void cancel() {
        cancelled = true;
        HttpURLConnection c = conn;
        if (c != null) c.disconnect();
    }

    void remove() {
        deleteTree(root);
    }

    /** Blocking; run off the main thread. Throws on failure or cancel (message is user-facing, pt-BR). */
    void install(Listener listener) throws IOException {
        cancelled = false;
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("Não foi possível criar a pasta do modelo.");
        if (root.getUsableSpace() < REQUIRED_FREE_BYTES) {
            throw new IOException("Espaço insuficiente: são necessários ~800 MB livres.");
        }
        File part = new File(root, MODEL_NAME + ".part");
        deleteTree(part);
        if (!part.mkdirs()) throw new IOException("Não foi possível criar a pasta temporária do modelo.");
        try {
            download(part, listener);
            for (String f : FILES) {
                if (!new File(part, f).isFile()) throw new IOException("Arquivo ausente no pacote do modelo: " + f);
            }
            if (!new File(part, ".complete").createNewFile()) throw new IOException("Falha ao finalizar o modelo.");
            File dest = modelDir();
            deleteTree(dest);
            if (!part.renameTo(dest)) throw new IOException("Falha ao mover o modelo para o destino.");
        } catch (IOException e) {
            deleteTree(part);
            if (cancelled) throw new IOException("Instalação cancelada.");
            throw e;
        } finally {
            conn = null;
        }
    }

    private void download(File part, Listener listener) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(MODEL_URL).openConnection();
        conn = c;
        c.setInstanceFollowRedirects(true); // github.com → objects.githubusercontent.com (https → https)
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        int code = c.getResponseCode();
        if (code != 200) throw new IOException("Download do modelo falhou (HTTP " + code + ").");
        long len = c.getContentLengthLong();
        final long total = len > 0 ? len : MODEL_ARCHIVE_BYTES;
        if (cancelled) throw new IOException("cancelled");

        MessageDigest sha;
        try {
            sha = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IOException("SHA-256 indisponível.", e);
        }
        try (InputStream raw = c.getInputStream();
             CountingStream counted = new CountingStream(
                     new DigestInputStream(new BufferedInputStream(raw, 1 << 16), sha), total, listener);
             BZip2CompressorInputStream bz = new BZip2CompressorInputStream(counted);
             TarArchiveInputStream tar = new TarArchiveInputStream(bz)) {
            byte[] buf = new byte[1 << 16];
            TarArchiveEntry e;
            while ((e = tar.getNextEntry()) != null) {
                if (cancelled) throw new IOException("cancelled");
                if (!e.isFile()) continue;
                String base = new File(e.getName()).getName();
                if (!isWanted(base)) continue; // skips test_wavs/ etc.
                File out = new File(part, base);
                try (OutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = tar.read(buf)) > 0) {
                        if (cancelled) throw new IOException("cancelled");
                        os.write(buf, 0, n);
                    }
                }
            }
            // Read the archive to its very end so the digest covers every byte.
            while (bz.read(buf) > 0) { /* tar trailer padding */ }
            while (counted.read(buf) > 0) { /* bytes after the bzip2 stream, if any */ }
        }
        if (!MODEL_SHA256.equals(hex(sha.digest()))) {
            throw new IOException("Download do modelo corrompido (SHA-256 não confere).");
        }
        if (listener != null) listener.onProgress(total, total);
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    private static boolean isWanted(String base) {
        for (String f : FILES) if (f.equals(base)) return true;
        return false;
    }

    static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /** Counts compressed bytes read from the network, reporting at most every ~1%. */
    private static final class CountingStream extends FilterInputStream {
        private final long total;
        private final Listener listener;
        private long count;
        private long lastReported;

        CountingStream(InputStream in, long total, Listener listener) {
            super(in);
            this.total = total;
            this.listener = listener;
        }

        @Override
        public int read() throws IOException {
            int b = super.read();
            if (b >= 0) advance(1);
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            int n = super.read(b, off, len);
            if (n > 0) advance(n);
            return n;
        }

        private void advance(long n) {
            count += n;
            if (listener != null && (count - lastReported >= total / 100 || count == total)) {
                lastReported = count;
                listener.onProgress(count, total);
            }
        }
    }
}
