from rembg import remove, new_session
from PIL import Image
from pathlib import Path
import os
src=Path(r'D:\pi-workspace\生成物\图片\2026-09-27')
out=Path(r'D:\pi-web\output\imagegen\portrait-poses-diagnostic-20260927-u2net'); out.mkdir(parents=True,exist_ok=True)
sess=new_session('u2net', model_path=r'D:\pi-web\models\u2net.onnx')
for p in sorted(src.glob('小语立绘-*.png')):
    im=Image.open(p).convert('RGBA')
    print('processing',p.name,flush=True)
    res=remove(im,session=sess,alpha_matting=True,alpha_matting_foreground_threshold=240,alpha_matting_background_threshold=10,alpha_matting_erode_size=5)
    q=out/(p.stem+'.webp'); res.save(q,'WEBP',quality=95,method=6)
    print('saved',q,flush=True)
