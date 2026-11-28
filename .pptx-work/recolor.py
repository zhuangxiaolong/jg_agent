# -*- coding: utf-8 -*-
"""把配色整体切换到 #009C4D 品牌绿色板。"""
import io
import re
import collections

PATH = r"D:\jinggong-agent\.pptx-work\build_deck.py"
src = io.open(PATH, encoding="utf-8").read()

counts = collections.Counter(re.findall(r'"([0-9A-F]{6})"', src))
print("before:", len(counts), "distinct colors")

# 原色 -> 新色（同一色板家族）
MAP = {
    # 深色基底：深藏青 -> 深森林绿
    "10283F": "0B2A1C",
    "17364E": "143C28",
    "1B3A52": "1C4A32",
    # 主色：青绿 -> 品牌绿
    "138C8C": "009C4D",
    # 信息色：蓝 -> 深绿
    "246B9E": "00703A",
    # 提示色：橙 -> 琥珀
    "D58A32": "B8791C",
    # 正向色：绿 -> 青绿
    "208568": "00806E",
    # 风险色：砖红
    "C65D56": "B23A2E",
    # 中性色：蓝灰 -> 绿灰
    "687B8C": "63766B",
    "243746": "1B2E24",
    "DCE4EB": "DAE6DF",
    "F0F4F7": "F2F7F4",
    "E8F4F1": "E6F4EC",
    "FBF2E6": "FBF4E6",
    "9AA9B6": "9AAFA1",
    "5B7186": "5B7264",
    # 深色底上的浅色文字 / 线
    "8AD0CC": "8ADFB0",
    "B9CAD7": "BFD6C8",
    "84C8C4": "7FD3A4",
    "3A617B": "35604A",
    "B8CBD8": "BCD3C4",
    "9BB0BF": "9FB8A8",
    # 浅色填充
    "E4EFF4": "E3F0E8",
    "FBEFE1": "FAF0DF",
    "EDF1F4": "EBF2ED",
    "FBFCFD": "FBFDFB",
    "FAFCFD": "FAFCFB",
}

missed = [k for k in counts if k not in MAP]
for old, new in MAP.items():
    src = src.replace('"%s"' % old, '"%s"' % new)

# 页眉小标签改用更深的绿，保证 9pt 小字可读
src = src.replace('text(s, 0.72, 0.31, 6.0, 0.24, kicker, size=9, bold=True, color=BRAND)',
                  'text(s, 0.72, 0.31, 6.0, 0.24, kicker, size=9, bold=True, color="00753C")')

io.open(PATH, "w", encoding="utf-8").write(src)
print("replaced:", len(MAP), "missed:", missed)
