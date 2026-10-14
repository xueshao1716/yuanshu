package com.pixinyu.app;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/** Only app-created temporary files are writable through the download bridge. */
final class DownloadBuffer {
    final String id;
    final String mime;
    final String name;
    final File file;
    private final long expectedSize;
    private long written = 0L;
    private FileOutputStream output;
    private long lastTouched = System.currentTimeMillis();

    DownloadBuffer(File cacheDir, String id, String filename, String mime, long expectedSize) throws IOException {
        if (id == null || !id.matches("[A-Za-z0-9-]{1,80}")) throw new IllegalArgumentException("无效的下载编号");
        if (expectedSize < 0 || expectedSize > 536870912L) throw new IllegalArgumentException("单个文件最多支持 512 MB");
        this.id = id;
        this.mime = mime;
        this.expectedSize = expectedSize;
        String base = filename == null ? "" : filename;
        base = base.substring(base.lastIndexOf('/') + 1);
        base = base.substring(base.lastIndexOf('\\') + 1);
        base = base.replaceAll("[\\p{Cntrl}:*?\"<>|]", "_").trim();
        if (base.length() > 180) base = base.substring(0, 180);
        this.name = base.isEmpty() ? "download" : base;
        this.file = File.createTempFile("yuanshu-download-", ".tmp", cacheDir);
        this.output = new FileOutputStream(file);
    }

    long lastTouched() { return lastTouched; }

    void append(byte[] bytes) throws IOException {
        if (bytes.length > 65536 || written + bytes.length > expectedSize) throw new IllegalArgumentException("下载数据大小不匹配");
        if (output == null) throw new IllegalStateException("下载已结束");
        output.write(bytes);
        written += bytes.length;
        lastTouched = System.currentTimeMillis();
    }

    void finish() throws IOException {
        if (written != expectedSize) throw new IllegalStateException("文件尚未完整接收，请重新下载");
        if (output != null) output.close();
        output = null;
    }

    void close() {
        try { if (output != null) output.close(); } catch (IOException ignored) { }
        output = null;
        file.delete();
    }
}
