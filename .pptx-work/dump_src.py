# -*- coding: utf-8 -*-
import io, sys
from pptx import Presentation

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

src = r"D:\WXWork\1688857876453191\Cache\File\2026-11\第二战区2027年度经营与交付升级方案_周六研讨版 (3).pptx"
prs = Presentation(src)
out = []
P = out.append
P(f"SIZE {prs.slide_width/914400:.3f} x {prs.slide_height/914400:.3f}")
P(f"SLIDES {len(prs.slides)}")
P(f"LAYOUTS {[l.name for l in prs.slide_masters[0].slide_layouts]}")

for i, s in enumerate(prs.slides, 1):
    P(f"\n===== SLIDE {i} layout={s.slide_layout.name} =====")
    for sh in s.shapes:
        pos = ""
        try:
            pos = f"({sh.left/914400:.2f},{sh.top/914400:.2f}) {sh.width/914400:.2f}x{sh.height/914400:.2f}"
        except Exception:
            pass
        P(f"- {sh.shape_type} {sh.name!r} {pos}")
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
                P(f"    [{p.level}] {t!r} sz={r0.font.size.pt if r0.font.size else None} b={r0.font.bold} c={col}")
        if sh.has_table:
            tbl = sh.table
            P(f"    TABLE {len(tbl.rows)}x{len(tbl.columns)}")
            for ri, row in enumerate(tbl.rows):
                P(f"      r{ri}: " + " | ".join(c.text.replace("\n", "/") for c in row.cells))
        if sh.has_chart:
            ch = sh.chart
            P(f"    CHART {ch.chart_type}")
            for pl in ch.plots:
                P(f"      cats={list(pl.categories)}")
                for se in pl.series:
                    P(f"      series {se.name}: {list(se.values)}")

with open(r"D:\jinggong-agent\.pptx-work\src_dump.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(out))
print("ok", len(out))
