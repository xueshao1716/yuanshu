#!/usr/bin/env python3
"""Yuanshu local delivery checks. No network requests or browser claims."""
import argparse
import hashlib
import json
import sys
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urlsplit, unquote

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False
try:
    import cv2
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False


def outcome(result, status, message=None):
    result.update(status=status, valid=status == 'passed')
    if message:
        result['note' if status == 'unverified' else 'error'] = message
    return result


def base(filepath, kind):
    file = Path(filepath)
    result = dict(type=kind, path=str(file), exists=file.is_file(),
                  size_bytes=0, sha256='', status='failed', valid=False)
    if not file.is_file():
        return outcome(result, 'failed', '文件不存在或不是普通文件')
    result['size_bytes'] = file.stat().st_size
    with file.open('rb') as stream:
        result['sha256'] = hashlib.file_digest(stream, 'sha256').hexdigest()
    if not result['size_bytes']:
        outcome(result, 'failed', '文件为空')
    return result


def verify_image(filepath, expected_width=None, expected_height=None, expected_ratio=None):
    result = base(filepath, 'image')
    if not result['size_bytes']:
        return result
    if not HAS_PIL:
        return outcome(result, 'unverified', 'Pillow未安装，未验证图像')
    try:
        with Image.open(filepath) as image:
            image.verify()
        with Image.open(filepath) as image:
            for frame in range(getattr(image, 'n_frames', 1)):
                image.seek(frame)
                image.load()
            width, height = image.size
            result.update(dimensions=[width, height], aspect_ratio=width/height, format=image.format)
        if expected_width is not None and width != expected_width:
            raise ValueError(f'宽度{width}不符合期望{expected_width}')
        if expected_height is not None and height != expected_height:
            raise ValueError(f'高度{height}不符合期望{expected_height}')
        if expected_ratio is not None and abs(width/height-expected_ratio) > 0.001:
            raise ValueError(f'比例{width}:{height}不符合期望{expected_ratio}')
        result['scope'] = '完整解码及已指定的尺寸/比例；不代表审美验收'
        return outcome(result, 'passed')
    except Exception as error:
        return outcome(result, 'failed', str(error))


def verify_video(filepath):
    result = base(filepath, 'video')
    if not result['size_bytes']:
        return result
    if not HAS_CV2:
        return outcome(result, 'unverified', 'OpenCV未安装，未验证视频')
    cap = None
    try:
        cap = cv2.VideoCapture(str(filepath))
        if not cap.isOpened():
            raise ValueError('视频打不开')
        fps = cap.get(cv2.CAP_PROP_FPS)
        expected = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        decoded = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if frame is None or not frame.size:
                raise ValueError('空视频帧')
            decoded += 1
        if fps <= 0 or decoded == 0 or (expected > 0 and decoded < expected):
            raise ValueError(f'视频解码不完整：{decoded}/{expected}帧，fps={fps}')
        result.update(duration_sec=decoded/fps, fps=fps, frames=decoded,
                      scope='全帧解码；不包含音轨、剧情或目标时长验收')
        return outcome(result, 'passed')
    except Exception as error:
        return outcome(result, 'failed', str(error))
    finally:
        if cap is not None:
            cap.release()


class HtmlReferences(HTMLParser):
    def __init__(self):
        super().__init__()
        self.refs = []
        self.title = False
        self.doctype = False

    def handle_decl(self, decl):
        self.doctype |= decl.lower().startswith('doctype html')

    def handle_starttag(self, tag, attrs):
        self.title |= tag == 'title'
        attrs = dict(attrs)
        for key in (('src', 'href') if tag == 'link' else ('src',)):
            if attrs.get(key):
                self.refs.append(attrs[key])


def verify_html(filepath):
    result = base(filepath, 'html')
    if not result['size_bytes']:
        return result
    try:
        parser = HtmlReferences()
        parser.feed(Path(filepath).read_text(encoding='utf-8-sig'))
        missing = []
        for ref in set(parser.refs):
            url = urlsplit(ref)
            if url.scheme or url.netloc or not url.path or url.path.startswith('/'):
                continue
            if not (Path(filepath).parent / unquote(url.path)).is_file():
                missing.append(ref)
        result.update(missing_resources=missing, has_doctype=parser.doctype, has_title=parser.title)
        if missing or not parser.doctype or not parser.title:
            return outcome(result, 'failed', 'HTML基础结构不全或本地资源缺失')
        return outcome(result, 'unverified', '静态结构和直接本地引用已检查；尚未验证浏览器渲染、脚本、CSS引用及远端资源')
    except Exception as error:
        return outcome(result, 'failed', str(error))


def verify_file(filepath):
    result = base(filepath, 'file')
    if not result['size_bytes']:
        return result
    return outcome(result, 'unverified', '仅验证文件存在及摘要，未提供此格式验收器')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('target')
    parser.add_argument('--json', action='store_true')
    parser.add_argument('--width', type=int)
    parser.add_argument('--height', type=int)
    parser.add_argument('--ratio', type=float)
    args = parser.parse_args(argv)
    for value in (args.width, args.height, args.ratio):
        if value is not None and value <= 0:
            parser.error('期望尺寸和比例必须大于0')
    target = Path(args.target)
    files = sorted(p for p in target.rglob('*') if p.is_file()) if target.is_dir() else [target]
    results = []
    for file in files:
        try:
            ext = file.suffix.lower()
            if ext in ('.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'):
                result = verify_image(file, args.width, args.height, args.ratio)
            elif ext in ('.mp4', '.mov', '.avi', '.webm'):
                result = verify_video(file)
            elif ext in ('.html', '.htm'):
                result = verify_html(file)
            else:
                result = verify_file(file)
            results.append(result)
        except Exception as error:
            results.append(outcome(dict(path=str(file)), 'failed', str(error)))
    if not results:
        results = [outcome(dict(path=str(target)), 'failed', '目录为空，无可验收文件')]
    print(json.dumps(results, indent=2, ensure_ascii=False) if args.json else
          '\n'.join(f"{r['status']} | {r['path']} | {r.get('error') or r.get('note') or '通过声明范围内的验收'}" for r in results))
    return 0 if all(r['valid'] for r in results) else 1


if __name__ == '__main__':
    sys.exit(main())
