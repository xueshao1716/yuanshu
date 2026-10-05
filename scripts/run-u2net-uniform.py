from rembg import remove, new_session
from PIL import Image
from pathlib import Path
import numpy as np
sess=new_session('u2net', model_path=r'D:\pi-web\models\u2net.onnx')
out=Path(r'D:\pi-web\output\imagegen\portrait-poses-diagnostic-20260927-u2net-uniform'); out.mkdir(parents=True,exist_ok=True)
src=Path(r'D:\pi-web\output\imagegen\portrait-poses-diagnostic-20260927-uniform-v2')
names=['daydreaming','listening','reading','responding','resting','working']
for n in names:
 p=src/(n+'.png'); im=Image.open(p).convert('RGBA'); print('processing',n,flush=True)
 res=remove(im,session=sess,alpha_matting=True,alpha_matting_foreground_threshold=245,alpha_matting_background_threshold=5,alpha_matting_erode_size=3)
 res.save(out/(n+'.webp'),'WEBP',quality=95,method=6)
 print('saved',flush=True)
