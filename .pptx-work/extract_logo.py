# -*- coding: utf-8 -*-
"""从参考稿中提取右上角 Logo，供本项目复用。"""
import io
import sys
from pptx import Presentation

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SRC = r"C:\Users\Administrator\Desktop\2027年部门工作规划-综合管理组-终稿.pptx"
OUT = r"D:\jinggong-agent\.pptx-work\logo.png"

prs = Presentation(SRC)
for idx in (1, 2, 3):
    for sh in prs.slides[idx].shapes:
        if sh.shape_type == 13 or sh.__class__.__name__ == "Picture":
            img = sh.image
            with open(OUT, "wb") as f:
                f.write(img.blob)
            print("saved", OUT, img.size, img.ext, "from slide", idx + 1,
                  sh.left / 914400, sh.top / 914400, sh.width / 914400, sh.height / 914400)
            sys.exit(0)
print("no picture found")
