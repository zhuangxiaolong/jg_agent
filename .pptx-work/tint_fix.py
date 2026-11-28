# -*- coding: utf-8 -*-
"""浅色填充统一到规范色：E8F5EC / F4F9F6。"""
import io

P = r"D:\jinggong-agent\.pptx-work\build_deck.py"
s = io.open(P, encoding="utf-8").read()
for a, b in [('"E3F0E8"', '"E8F5EC"'), ('"FAF0DF"', '"E8F5EC"'),
             ('"FBFDFB"', '"F4F9F6"'), ('"FAFCFB"', '"F4F9F6"')]:
    s = s.replace(a, b)
io.open(P, "w", encoding="utf-8").write(s)
print("ok")
