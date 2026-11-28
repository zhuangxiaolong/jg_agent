# -*- coding: utf-8 -*-
import sys
from pptx import Presentation
from pptx.util import Emu

src = r"D:\WXWork\1688857876453191\Cache\File\2026-11\第二战区2027年度经营与交付升级方案_周六研讨版 (3).pptx"
prs = Presentation(src)
print("SIZE", prs.slide_width, prs.slide_height,
      prs.slide_width/914400, prs.slide_height/914400)
print("SLIDES", len(prs.slides))
print("LAYOUTS", [l.name for l in prs.slide_masters[0].slide_layouts])

def txt(shape, depth=0):
    pad = "  " * depth
    info = f"{pad}- {shape.shape_type} name={shape.name!r}"
    try:
        info += f" pos=({shape.left/914400:.2f},{shape.top/914400:.2f}) size=({shape.width/914400:.2f}x{shape.height/914400:.2f})"
    except Exception:
        pass
    print(info)
    if shape.has_text_frame:
        for p in shape.text_frame.paragraphs:
            t = "".join(r.text for r in p.runs)
            if t.strip():
                r0 = p.runs[0]
                col = None
                try:
                    if r0.font.color and r0.font.color.type is not None:
                        col = str(r0.font.color.rgb)
                except Exception:
                    pass
                print(f"{pad}    [{p.level}] {t!r} size={r0.font.size.pt if r0.font.size else None} bold={r0.font.bold} color={col} font={r0.font.name}")
    if shape.has_table:
        tbl = shape.table
        print(f"{pad}    TABLE {len(tbl.rows)}x{len(tbl.columns)}")
        for ri, row in enumerate(tbl.rows):
            cells = [c.text.replace("\n", "\\n") for c in row.cells]
            print(f"{pad}      r{ri}: {cells}")
    if shape.has_chart:
        print(f"{pad}    CHART {shape.chart.chart_type}")

for i, s in enumerate(prs.slides, 1):
    print(f"\n===== SLIDE {i} layout={s.slide_layout.name} =====")
    for sh in s.shapes:
        txt(sh)
