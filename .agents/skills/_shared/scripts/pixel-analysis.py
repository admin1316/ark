# -*- coding: utf-8 -*-
import sys
try:
    from PIL import Image
    import numpy as np
except ImportError:
    print('NO_PIL'); sys.exit(0)
p = sys.argv[1]
img = Image.open(p)
if img.mode == 'RGBA':
    bg = Image.new('RGB', img.size, (0,0,0)); bg.paste(img, mask=img.split()[3]); img = bg
else:
    img = img.convert('RGB')
arr = np.asarray(img).astype(float)
h, w, _ = arr.shape
lum = 0.299*arr[:,:,0] + 0.587*arr[:,:,1] + 0.114*arr[:,:,2]
dark = (lum < 30).mean()*100
mid = ((lum >= 30) & (lum < 150)).mean()*100
bright = (lum >= 150).mean()*100
mx = arr.max(axis=2); mn = arr.min(axis=2)
sat = np.where(mx>0, (mx-mn)/np.maximum(mx,1), 0)
r, g, b = arr[:,:,0], arr[:,:,1], arr[:,:,2]
warm = ((r > g + 15) & (r > b + 15)).mean()*100
cool = ((b > r + 15) & (b > g + 15)).mean()*100
# ===== 主体中央区测量（亮度锚定协议核心，判断"主体是否淹没在阴影"）=====
y0, y1 = int(h*0.2), int(h*0.8)
x0, x1 = int(w*0.2), int(w*0.8)
c = lum[y0:y1, x0:x1]
center_lum = c.mean()/2.55
center_dead = (c < 12).mean()*100
# 角落死黑（死黑允许区=角落，协议要求 <=10%）
corner = np.concatenate([
    lum[:int(h*0.15), :int(w*0.15)].ravel(),
    lum[:int(h*0.15), -int(w*0.15):].ravel(),
    lum[-int(h*0.15):, :int(w*0.15)].ravel(),
    lum[-int(h*0.15):, -int(w*0.15):].ravel()])
corner_dead = (corner < 12).mean()*100
print('尺寸: %dx%d' % (w, h))
print('平均亮度: %.1f%% (正常40-60)' % (lum.mean()/2.55))
print('暗部: %.1f%% | 中间调: %.1f%% | 亮部: %.1f%%' % (dark, mid, bright))
print('最亮5%%: %.1f (需>150有高光)' % np.percentile(lum, 95))
print('RGB: R=%.0f G=%.0f B=%.0f | 暖色%.1f%% 冷色%.1f%%' % (r.mean(), g.mean(), b.mean(), warm, cool))
print('饱和度: %.3f' % sat.mean())
# ===== 亮度锚定判定（量化标准，机器可执行）=====
verdict = []
if center_lum < 25:
    verdict.append('FAIL 中央主体亮度 %.1f 低于25，主体淹没在阴影，需提亮主光' % center_lum)
elif center_lum < 30:
    verdict.append('WARN 中央主体亮度 %.1f 偏低(25-30)，暗场景可接受但偏暗' % center_lum)
else:
    verdict.append('PASS 中央主体亮度 %.1f 达标(不低于25)' % center_lum)
if center_dead > 10:
    verdict.append('FAIL 中央死黑占比 %.1f 大于10，主体区出现死黑' % center_dead)
else:
    verdict.append('PASS 中央死黑占比 %.1f 合规(不高于10)' % center_dead)
if corner_dead > 10:
    verdict.append('FAIL 角落死黑占比 %.1f 大于10，死黑溢出角落' % corner_dead)
else:
    verdict.append('PASS 角落死黑占比 %.1f 合规(不高于10)' % corner_dead)
if np.percentile(lum, 95) < 150:
    verdict.append('FAIL 最亮5%%像素 %.0f 低于150，无高光点，画面发闷' % np.percentile(lum, 95))
else:
    verdict.append('PASS 最亮5%%像素 %.0f 达标(不低于150，有高光)' % np.percentile(lum, 95))
print('-- 亮度锚定判定 --')
for v in verdict:
    print(' ' + v)
