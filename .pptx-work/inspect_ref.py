# -*- coding: utf-8 -*-
"""检查参考稿《2027年部门工作规划-综合管理组-终稿.pptx》的版式与字号。"""
import io
import sys
from pptx import Presentation
from lxml import etree

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SRC = r"C:\Users\Administrator\Desktop\2027年部门工作规划-综合管理组-终稿.pptx"
prs = Presentation(SRC)
print("SIZE", prs.slide_width / 914400, prs.slide_height / 914400, "SLIDES", len(prs.slides))
print("LAYOUTS", [l.name for l in prs.slide_masters[0].slide_layouts])


def fillinfo(sh):
    try:
        f = sh.fill
        t = str(f.type)
        if "SOLID" in t:
            try:
                return "solid #" + str(f.fore_color.rgb)
            except Exception:
                return "solid theme"
        return t
    except Exception:
        return "-"


for idx in (0, 1, 2, 3, 9, 14, 15):
    if idx >= len(prs.slides):
        continue
    s = prs.slides[idx]
    print(f"\n===== SLIDE {idx+1} layout={s.slide_layout.name} =====")
    for sh in s.shapes:
        pos = ""
        try:
            pos = "(%.3f,%.3f) %.2fx%.2f" % (sh.left / 914400, sh.top / 914400,
                                             sh.width / 914400, sh.height / 914400)
        except Exception:
            pass
        print(f"- {sh.shape_type} {sh.name!r} {pos} fill={fillinfo(sh)}")
        if sh.has_text_frame:
            for p in sh.text_frame.paragraphs:
                t = "".join(r.text for r in p.runs)
                if not t.strip():
                    continue
                r0 = p.runs[0]
                col = ""
                try:
                    if r0.font.color and r0.font.color.type is not None:
                        col = str(r0.font.color.rgb)
                except Exception:
                    pass
                print("    %r sz=%s b=%s c=%s align=%s" % (
                    t, r0.font.size.pt if r0.font.size else None, r0.font.bold, col, p.alignment))
        if sh.has_table:
            tbl = sh.table
            print("    TABLE %dx%d" % (len(tbl.rows), len(tbl.columns)))
            for ri, row in enumerate(tbl.rows):
                print("      r%d: %s" % (ri, " | ".join(c.text.replace("\n", "/") for c in row.cells)))
        if sh.has_chart:
            print("    CHART", sh.chart.chart_type)
