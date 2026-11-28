# -*- coding: utf-8 -*-
"""把封底移到附录之后（附录在前、封底收尾）。"""
import io

P = r"D:\jinggong-agent\.pptx-work\build_deck.py"
s = io.open(P, encoding="utf-8").read()

a = s.index("# =====================================================================\n# 18 封底")
b = s.index("# =====================================================================\n# 14 附录")
c = s.index("# ---- 按规范压缩标题区后，内容整体上移 ----")

closing = s[a:b]
appendix = s[b:c]
s = s[:a] + appendix + closing + s[c:]
io.open(P, "w", encoding="utf-8").write(s)
print("reordered", len(appendix), len(closing))
