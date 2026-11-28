# -*- coding: utf-8 -*-
import io, sys
from pptx import Presentation
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

src = r"D:\WXWork\1688857876453191\Cache\File\2026-11\第二战区2027年度经营与交付升级方案_周六研讨版 (3).pptx"
prs = Presentation(src)

def fillinfo(sh):
    try:
        f = sh.fill
        t = str(f.type)
        if "SOLID" in t:
            c = f.fore_color
            try:
                return f"solid {c.rgb}"
            except Exception:
                return f"solid theme={c.theme_color} bright={c.brightness}"
        if "GRADIENT" in t:
            return "gradient stops=" + ",".join(
                f"{s.color.rgb if s.color.type==1 else s.color.theme_color}@{s.position}" for s in f.gradient_stops)
        return t
    except Exception as e:
        return f"err {e}"

for idx in (0, 1, 2, 8, 10):
    s = prs.slides[idx]
    print(f"\n=== slide {idx+1} ===")
    for sh in s.shapes:
        line = ""
        try:
            if sh.line.color and sh.line.color.type is not None:
                line = f" line={sh.line.color.rgb} w={sh.line.width}"
        except Exception:
            pass
        print(f"{sh.name} fill={fillinfo(sh)}{line}")
    print("bg:", s.background.fill.type if s.background else None)
