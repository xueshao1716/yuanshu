"""silk → wav（微信语音条解码）2026-10-28

pilk 的真实签名（实测）：
    pilk.encode(pcm_path, silk_path, tencent=True)
    pilk.decode(silk_path, pcm_path)
两者都按**文件路径**工作，不是 bytes。所以这里先解码到临时 pcm，再包成 wav。
"""
import sys
import json
import os
import tempfile
import wave


def convert(src: str, dst: str) -> dict:
    import pilk
    fd, pcm_path = tempfile.mkstemp(suffix=".pcm")
    os.close(fd)
    try:
        pilk.decode(src, pcm_path)
        with open(pcm_path, "rb") as f:
            pcm = f.read()
        if not pcm:
            raise RuntimeError("silk 解码为空")
        with wave.open(dst, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(24000)
            w.writeframes(pcm)
        return {"ok": True, "seconds": round(len(pcm) / 2 / 24000, 2), "pcm_bytes": len(pcm)}
    finally:
        try:
            os.unlink(pcm_path)
        except OSError:
            pass


if __name__ == "__main__":
    try:
        print(json.dumps(convert(sys.argv[1], sys.argv[2]), ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:300]}, ensure_ascii=False))
        sys.exit(0)
