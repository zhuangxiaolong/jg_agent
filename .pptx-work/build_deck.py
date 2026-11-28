# -*- coding: utf-8 -*-
"""生成《第二战区2027年度经营目标拆解与交付承接方案》汇报稿。"""
import os
from lxml import etree
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR, MSO_AUTO_SIZE
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn

# ---------- 配色（《2027年部门工作规划》视觉规范 · 绿色同色系） ----------
# 品牌锚点 #00B050；内容页用更沉稳的 #0B7A3B / #075C2A
BRAND = "00B050"      # 品牌主绿：封面绿带、目录序号、细线、封底副口号
NAVY = "075C2A"       # 深绿：内页大标题、表头、大数字
INKBG = "12301F"      # 深绿近黑：底部说明条、强调底
GREEN = "0B7A3B"      # 内容主绿：强调条、表头、图元
LIGHTG = "8FC5A6"     # 浅绿：说明条左条、连接线
MINT = "E8F5EC"       # 淡绿：页码胶囊、浅底
LIGHT = "F4F9F6"      # 极浅绿：卡片/表格浅底
INK = "16301F"        # 墨绿正文
INK2 = "1A2B22"       # 目录项文字
GRAY = "5F7768"       # 辅助灰：说明、页脚
BORDER = "DDEDE4"     # 分隔线
LINE2 = "E5EFE9"      # 页脚线
WHITE = "FFFFFF"
MUTED = "8FA396"
PALE = "5F7768"
KICK = "0B7A3B"

# 兼容旧变量名（正文里还在用）
TEAL = GREEN; BLUE = NAVY; ORANGE = BRAND; RED = NAVY; NAVY2 = INK; NAVY3 = INKBG
CREAM = LIGHT

FONT_LATIN = "Microsoft YaHei"
FONT_EA = "微软雅黑"
LOGO = r"D:\jinggong-agent\.pptx-work\logo.png"

prs = Presentation()
prs.slide_width = Inches(13.333)
prs.slide_height = Inches(7.5)
BLANK = prs.slide_layouts[6]


def rgb(h):
    return RGBColor.from_string(h)


def _set_ea(run, font=FONT_EA):
    rPr = run._r.get_or_add_rPr()
    latin = rPr.find(qn("a:latin"))
    ea = rPr.find(qn("a:ea"))
    if ea is None:
        ea = etree.SubElement(rPr, qn("a:ea"))
        if latin is not None:
            latin.addnext(ea)
    ea.set("typeface", font)
    cs = rPr.find(qn("a:cs"))
    if cs is None:
        cs = etree.SubElement(rPr, qn("a:cs"))
        ea.addnext(cs)
    cs.set("typeface", font)


def text(slide, x, y, w, h, s, size=10, bold=False, color=GRAY,
         align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, spacing=1.25,
         space_after=0, italic=False):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = box.text_frame
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE
    tf.margin_left = 0; tf.margin_right = 0
    tf.margin_top = 0; tf.margin_bottom = 0
    tf.vertical_anchor = anchor
    for i, line in enumerate(str(s).split("\n")):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = spacing
        p.space_after = Pt(space_after)
        r = p.add_run()
        r.text = line
        r.font.name = FONT_LATIN
        r.font.size = Pt(size)
        r.font.bold = bold
        r.font.italic = italic
        r.font.color.rgb = rgb(color)
        _set_ea(r)
    return box


def rich(slide, x, y, w, h, parts, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.TOP, spacing=1.2):
    """parts: [[(text, size, bold, color), ...], ...] 每个子列表是一段"""
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = box.text_frame
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE
    tf.margin_left = 0; tf.margin_right = 0
    tf.margin_top = 0; tf.margin_bottom = 0
    tf.vertical_anchor = anchor
    for i, para in enumerate(parts):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = spacing
        for (t, sz, b, c) in para:
            r = p.add_run()
            r.text = t
            r.font.name = FONT_LATIN
            r.font.size = Pt(sz)
            r.font.bold = b
            r.font.color.rgb = rgb(c)
            _set_ea(r)
    return box


def rect(slide, x, y, w, h, fill=None, line=None, lw=0.75,
         shape=MSO_SHAPE.RECTANGLE, radius=None):
    s = slide.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
    s.shadow.inherit = False
    style = s._element.find(qn("p:style"))
    if style is not None:
        s._element.remove(style)
    if fill is None:
        s.fill.background()
    else:
        s.fill.solid()
        s.fill.fore_color.rgb = rgb(fill)
    if line is None:
        s.line.fill.background()
    else:
        s.line.color.rgb = rgb(line)
        s.line.width = Pt(lw)
    if radius is not None and shape == MSO_SHAPE.ROUNDED_RECTANGLE:
        try:
            s.adjustments[0] = radius
        except Exception:
            pass
    s.text_frame.word_wrap = True
    return s


def vline(slide, x, y, h, color, w=0.014):
    return rect(slide, x, y, w, h, fill=color)


def hline(slide, x, y, w, color, h=0.012):
    return rect(slide, x, y, w, h, fill=color)


PAGE = {"n": 0}
TOTAL = 19
CHROME = set()   # 页眉页脚元素，排版整体上移时跳过


def new_slide(kicker=None, title=None, sub=None):
    """对齐参考稿：白底、15.5pt 深绿标题、主绿细线、左小标题+右说明、右上 Logo、页码胶囊。"""
    s = prs.slides.add_slide(BLANK)
    chrome = [rect(s, 0, 0, 13.333, 7.5, fill=WHITE)]
    if title:
        chrome.append(text(s, 0.625, 0.104, 10.30, 0.29, title, size=15.5, bold=True,
                           color=NAVY, spacing=1.0))
    chrome.append(rect(s, 0, 0.479, 13.333, 0.020, fill=GREEN))
    chrome.append(rect(s, 0, 0.500, 13.333, 0.010, fill=BORDER))
    if kicker:
        chrome.append(text(s, 0.625, 0.600, 2.40, 0.30, kicker, size=14, bold=True,
                           color=NAVY, spacing=1.0))
    if sub:
        chrome.append(text(s, 3.05, 0.625, 9.60, 0.26, sub, size=11.2, color=GRAY, spacing=1.0))
    chrome.append(rect(s, 0.625, 0.938, 12.083, 0.010, fill=LINE2))
    chrome.append(s.shapes.add_picture(LOGO, Inches(11.312), Inches(0.083),
                                       Inches(1.354), Inches(0.333)))

    PAGE["n"] += 1
    chrome.append(rect(s, 0.625, 6.979, 12.083, 0.010, fill=LINE2))
    chrome.append(text(s, 0.625, 7.073, 8.4, 0.18,
                       "广东精工智能系统有限公司 ｜ 第二战区 2027 年度经营目标拆解",
                       size=10.5, color=GRAY))
    chrome.append(rect(s, 12.438, 7.042, 0.271, 0.229, fill=MINT))
    chrome.append(text(s, 12.438, 7.071, 0.271, 0.18, f"{PAGE['n']:02d}", size=10.5,
                       bold=True, color=NAVY, align=PP_ALIGN.CENTER))
    CHROME.update(sh.shape_id for sh in chrome if sh is not None)
    return s


def band(slide, x, y, w, h, fill=None, accent=None, label=None, body=None,
         label_size=10.5, body_size=11.5):
    """规范：底部深色说明条 #12301F + 左侧 6px #8FC5A6 强调条 + 白字。"""
    rect(slide, x, y, w, h, fill=INKBG)
    rect(slide, x, y, 0.0625, h, fill=LIGHTG)
    bs = 11.5 if len(str(body)) <= 80 else 10.5
    if label:
        text(slide, x + 0.24, y + (h - 0.22) / 2, 1.45, 0.22, label, size=10.5,
             bold=True, color=LIGHTG)
        text(slide, x + 1.74, y + 0.10, w - 1.96, h - 0.16, body, size=bs, bold=True,
             color=WHITE, anchor=MSO_ANCHOR.MIDDLE, spacing=1.2)
    else:
        text(slide, x + 0.28, y + 0.10, w - 0.52, h - 0.16, body, size=bs, bold=True,
             color=WHITE, anchor=MSO_ANCHOR.MIDDLE, spacing=1.2)


# =====================================================================
# 01 封面（对齐参考稿：上半白 → 中部品牌绿横带 → 下半白）
# =====================================================================
s = prs.slides.add_slide(BLANK)
PAGE["n"] += 1
rect(s, 0, 0, 13.333, 7.5, fill=WHITE)

# 绿带上方英文标签（字距拉开）
_lab = text(s, 0.625, 2.417, 9.6, 0.24, "SECOND WAR ZONE   ·   2027 BUSINESS PLAN",
            size=11.25, bold=True, color=BRAND)
_lab.text_frame.paragraphs[0].runs[0].font._rPr.set("spc", "300")

# 中部品牌绿横带 + 主标题
rect(s, 0, 2.792, 13.333, 1.380, fill=BRAND)
text(s, 0, 3.146, 13.333, 0.72, "第二战区 2027 年度经营规划", size=42, bold=True,
     color=WHITE, align=PP_ALIGN.CENTER, spacing=1.0)

# 横带下方信息
text(s, 0, 4.500, 13.333, 0.30, "广东精工智能系统有限公司 · 数字化工厂事业部",
     size=16.5, bold=True, color=INK, align=PP_ALIGN.CENTER, spacing=1.0)
text(s, 0, 4.917, 13.333, 0.24, "第二战区 ｜ 经营目标拆解与交付承接方案 ｜ 2,200 万元收款目标",
     size=12, color=GRAY, align=PP_ALIGN.CENTER, spacing=1.0)
text(s, 0, 5.281, 13.333, 0.24, "2026 年 11 月 ｜ 汇报人：庄小龙",
     size=12, color=GRAY, align=PP_ALIGN.CENTER, spacing=1.0)

# 底部模块导航
rect(s, 6.271, 5.750, 0.79, 0.030, fill=BRAND)
text(s, 0, 5.917, 13.333, 0.22, "目标拆解  ·  达成路径  ·  FDE 打法  ·  研讨安排",
     size=11.25, color=GRAY, align=PP_ALIGN.CENTER, spacing=1.0)


# =====================================================================
# 02 目录（对齐参考稿：绿色标题块 + 灰底条目条 + 上下品牌绿线 + 右上 Logo）
# =====================================================================
s = prs.slides.add_slide(BLANK)
PAGE["n"] += 1
rect(s, 0, 0, 13.333, 7.5, fill=WHITE)
rect(s, 0, 0.500, 13.333, 0.020, fill=BRAND)
rect(s, 0.625, 6.490, 12.083, 0.030, fill=BRAND)
s.shapes.add_picture(LOGO, Inches(11.312), Inches(0.125), Inches(1.354), Inches(0.333))

rect(s, 0.625, 0.625, 1.380, 0.440, fill=BRAND)
text(s, 0.625, 0.719, 1.380, 0.26, "目 录", size=15, bold=True, color=WHITE, align=PP_ALIGN.CENTER)

toc = [
    ("01", "经营目标", "2,200 万怎么拆：口径、三组、15 个承接单元"),
    ("02", "达成路径", "四本账现金来源 + 20 个新签项目的签约节奏"),
    ("03", "交付打法", "全员 FDE 化、一条龙交付、AI 直连代码"),
    ("04", "研讨安排", "周六日议程与需要拍板的 6 件事"),
]
for i, (no, name, desc) in enumerate(toc):
    y = 1.604 + i * 0.865
    rect(s, 0.625, y, 9.79, 0.56, fill="DDEDE4")
    text(s, 0.625, y + 0.06, 0.65, 0.38, no, size=22.5, bold=True, color=BRAND, spacing=1.0)
    text(s, 1.562, y + 0.09, 3.0, 0.31, name, size=18.75, bold=True, color=INK2, spacing=1.0)
    text(s, 4.90, y + 0.17, 5.2, 0.24, desc, size=11.25, color=GRAY, spacing=1.0)

text(s, 0.625, 6.688, 12.083, 0.20,
     "经营目标 → 达成路径 → 交付打法 → 研讨安排——一页看懂 2,200 万怎么完成",
     size=11.25, color=BRAND, align=PP_ALIGN.CENTER)


# =====================================================================
# 02 一页看懂
# =====================================================================
s = new_slide("核心结论", "2,200 万怎么完成：四本账拢现金，一条龙提速度",
              "数字已经拆到人；本方案回答“怎么完成”：四类现金来源逐个落项目、落月份，用交付提速把回款往前拉。")

kpis = [
    ("2,200", "万", "战区收款目标", "软件 2,100 万 + 硬件利润 100 万", GREEN),
    ("3", "个", "交付组", "760 / 770 / 670 万，各 5 个单元", NAVY),
    ("15", "个", "承接单元", "13 名主责 FDE + 2 个待补岗", BRAND),
    ("20", "个", "新签项目测算", "约 2,014 万合同额，当年回款 1,432 万", INKBG),
]
cw, gap = 2.83, 0.24
for i, (num, unit, label, note, col) in enumerate(kpis):
    x = 0.72 + i * (cw + gap)
    rect(s, x, 1.62, cw, 1.86, fill=LIGHT, line=BORDER)
    rect(s, x, 1.62, cw, 0.055, fill=col)
    text(s, x + 0.26, 1.86, cw - 0.4, 0.24, label, size=10.5, bold=True, color=INK)
    rich(s, x + 0.24, 2.16, cw - 0.35, 0.62,
         [[(num, 30, True, col), (" " + unit, 12, True, col)]])
    text(s, x + 0.26, 2.94, cw - 0.45, 0.42, note, size=8.8, color=GRAY, spacing=1.25)

text(s, 0.74, 3.70, 6.2, 0.28, "三级承接结构", size=13, bold=True, color=NAVY)

levels = [
    ("01  战区", "庄小龙 ｜ 整体经营与资源", "2,200 万", 11.40, NAVY),
    ("02  交付组", "760 ｜ 770 ｜ 670，三组各 5 个单元", "3 个组", 8.30, TEAL),
    ("03  承接单元", "15 个主责 FDE，单元目标 100—180 万", "15 个单元", 6.20, BLUE),
]
y = 4.06
for i, (lv, who, right, w, col) in enumerate(levels):
    x = 0.74 + (11.86 - w) / 2
    if i == 0:
        rect(s, x, y, w, 0.60, fill=NAVY)
        text(s, x + 0.22, y + 0.19, 1.2, 0.24, lv, size=10.5, bold=True, color="7FD3A4")
        text(s, x + 1.52, y + 0.19, 3.6, 0.24, who, size=10, color="BFD6C8")
        text(s, x + w - 1.80, y + 0.14, 1.55, 0.30, right, size=13.5, bold=True, color=WHITE, align=PP_ALIGN.RIGHT)
    else:
        rect(s, x, y, w, 0.60, fill=LIGHT)
        vline(s, x, y, 0.60, col, 0.05)
        text(s, x + 0.22, y + 0.19, 1.2, 0.24, lv, size=10.5, bold=True, color=col)
        text(s, x + 1.52, y + 0.20, w - 3.45, 0.24, who, size=9.2, color=INK)
        text(s, x + w - 1.78, y + 0.16, 1.52, 0.28, right, size=10.5, bold=True, color=col, align=PP_ALIGN.RIGHT)
    y += 0.68

band(s, 0.74, 6.24, 11.86, 0.66, label=None,
     body="四条现金来源：存量清收 → 里程碑回款 → 新签抢单 → 硬件毛利；交付提速做放大，15 个单元逐一对项目、对月份。")


# =====================================================================
# 03 目标口径
# =====================================================================
s = new_slide("目标口径", "2,200 万的口径：软件按收款、硬件只算利润",
              "两个口径不能混着考核：软件看客户回款，硬件只看项目利润。战区合计 2,200 万，但考核表必须分列。")

rect(s, 0.72, 1.64, 4.55, 2.20, fill=NAVY)
text(s, 1.00, 1.86, 3.6, 0.26, "第二战区 2027 年收款目标", size=12, color="BCD3C4")
rich(s, 0.98, 2.18, 4.0, 0.86, [[("2,200", 52, True, WHITE), ("  万元", 13, False, "BCD3C4")]])
text(s, 1.00, 3.24, 3.9, 0.40, "战区司令：庄小龙 ｜ 三个交付组承接", size=9.6, color="9FB8A8")

rect(s, 5.55, 1.64, 3.42, 2.20, fill=LIGHT, line=BORDER)
rect(s, 5.55, 1.64, 3.42, 0.055, fill=TEAL)
text(s, 5.80, 1.86, 2.9, 0.24, "软件收款", size=11, bold=True, color=INK)
rich(s, 5.78, 2.16, 2.9, 0.66, [[("2,100", 34, True, TEAL), ("  万", 12, True, TEAL)]])
text(s, 5.80, 2.90, 2.9, 0.22, "占战区目标 95.5%", size=10, bold=True, color=GRAY)
text(s, 5.80, 3.22, 2.95, 0.50, "按客户回款确认，主考核口径", size=9.2, color=GRAY, spacing=1.2)

rect(s, 9.15, 1.64, 3.43, 2.20, fill=LIGHT, line=BORDER)
rect(s, 9.15, 1.64, 3.43, 0.055, fill=ORANGE)
text(s, 9.40, 1.86, 2.9, 0.24, "硬件利润", size=11, bold=True, color=INK)
rich(s, 9.38, 2.16, 2.9, 0.66, [[("100", 34, True, ORANGE), ("  万", 12, True, ORANGE)]])
text(s, 9.40, 2.90, 2.9, 0.22, "占战区目标 4.5%｜仅计利润", size=10, bold=True, color=GRAY)
text(s, 9.40, 3.22, 2.95, 0.50, "只算毛利，不折算硬件收入", size=9.2, color=GRAY, spacing=1.2)

# 结构条
text(s, 0.74, 4.12, 3.0, 0.24, "目标构成", size=11, bold=True, color=NAVY)
bar_x, bar_w = 0.74, 11.84
rect(s, bar_x, 4.46, bar_w, 0.52, fill=LIGHT)
rect(s, bar_x, 4.46, bar_w * 0.9545, 0.52, fill=TEAL)
rect(s, bar_x + bar_w * 0.9545, 4.46, bar_w * 0.0455, 0.52, fill=ORANGE)
text(s, bar_x + 0.22, 4.57, 6.0, 0.28, "软件 2,100 万 ｜ 95.5%", size=11.5, bold=True, color=WHITE)
text(s, bar_x + bar_w - 2.6, 4.18, 2.55, 0.24, "硬件 100 万 ｜ 4.5%", size=8.8, bold=True, color=ORANGE, align=PP_ALIGN.RIGHT)

notes = [
    ("软件", "按客户回款确认，是本方案的主考核口径；签约、验收、回款三个节点要分表跟踪。"),
    ("硬件", "只计利润、不计收入；必须单项目核算毛利，避免“冲了收入、没有利润”。"),
    ("合并", "两者口径不同，考核表分列列示；不做简单相加后按同一比例考核。"),
]
y = 5.18
for lab, body in notes:
    text(s, 0.76, y + 0.04, 0.62, 0.26, lab, size=10, bold=True, color=TEAL)
    text(s, 1.42, y, 10.9, 0.28, body, size=10.4, color=INK)
    y += 0.42

band(s, 0.74, 6.52, 11.85, 0.50, fill=CREAM, accent=ORANGE, label=None,
     body="待确认：硬件 100 万按哪个毛利率折算、是否含税、是否与软件同一回款节奏——周六上午第一项确认。",
     body_size=10)


# =====================================================================
# 04 三级拆解总览
# =====================================================================
s = new_slide("三级拆解", "战区 2,200 万 → 3 个交付组 → 15 个承接单元",
              "三组各 5 个单元，组间最大差 100 万（770 对 670），差在单元结构和实施配置，不在目标逻辑。")

rect(s, 0.72, 1.58, 11.86, 0.58, fill=NAVY)
text(s, 0.98, 1.72, 2.0, 0.28, "战区", size=10.5, bold=True, color="7FD3A4")
text(s, 2.60, 1.70, 3.2, 0.30, "第二战区 ｜ 司令 庄小龙", size=11, color=WHITE)
text(s, 10.20, 1.70, 2.2, 0.30, "2,200 万元", size=15, bold=True, color=WHITE, align=PP_ALIGN.RIGHT)

groups = [
    ("交付一组", "黄冬萍", "760", "34.5%", "5", "4", "152", BLUE, "标准项目守基本盘，何耀伟做进阶/多工厂"),
    ("交付二组", "刘泽林", "770", "35.0%", "5", "4", "154", TEAL, "MES+WMS 组合项目提客单价"),
    ("交付三组", "郑万东", "670", "30.5%", "5", "3", "134", ORANGE, "标准项目快跑，两个 100 万单元补强"),
]
cw = 3.80
for i, (name, lead, amt, share, units, impl, avg, col, note) in enumerate(groups):
    x = 0.72 + i * (cw + 0.23)
    rect(s, x, 2.40, cw, 2.62, fill=LIGHT, line=BORDER)
    rect(s, x, 2.40, cw, 0.06, fill=col)
    text(s, x + 0.24, 2.58, 1.8, 0.26, name, size=13, bold=True, color=NAVY)
    text(s, x + 0.24, 2.90, 1.9, 0.22, f"组长  {lead}", size=9.6, color=GRAY)
    rich(s, x + 0.22, 3.14, 2.6, 0.58, [[(amt, 30, True, col), ("  万", 11, True, GRAY)]])
    text(s, x + 2.62, 3.34, 0.95, 0.24, share, size=9.5, bold=True, color=col, align=PP_ALIGN.RIGHT)

    metrics = [("承接单元", units + " 个"), ("已配实施", impl + " 人"), ("组均单元", avg + " 万")]
    mx = x + 0.24
    for j, (k, v) in enumerate(metrics):
        text(s, mx + j * 1.14, 3.86, 1.10, 0.20, k, size=8.2, color=MUTED)
        text(s, mx + j * 1.14, 4.06, 1.10, 0.24, v, size=10.5, bold=True, color=INK)
    text(s, x + 0.24, 4.48, cw - 0.48, 0.44, note, size=8.6, color=GRAY, spacing=1.25)

# 汇总小卡
sums = [("15", "个", "承接单元", "13 名 PM + 2 个待补岗"),
        ("11", "人", "已配实施", "覆盖 15 个中的 11 个"),
        ("4", "个", "无专属实施", "组长兼任 1 + 个人 1 + 待补 2"),
        ("147", "万", "单元均值", "最高 180、最低 100")]
for i, (num, unit, label, note) in enumerate(sums):
    x = 0.72 + i * 2.99
    rect(s, x, 5.20, 2.86, 1.02, fill=LIGHT)
    rich(s, x + 0.18, 5.30, 1.3, 0.40, [[(num, 19, True, NAVY), (" " + unit, 9, True, GRAY)]])
    text(s, x + 0.18, 5.71, 2.4, 0.20, label, size=8.4, bold=True, color=GRAY)
    text(s, x + 0.18, 5.93, 2.52, 0.22, note, size=7.6, color=PALE)

band(s, 0.72, 6.40, 11.86, 0.54, fill=CREAM, accent=ORANGE, label=None,
     body="三组目标已到组、到人；下一步是把“单元目标”翻译成“项目 + 客户 + 月份”，否则 2,200 万只是一个数字。",
     body_size=10)


# =====================================================================
# 05 三级拆解总表
# =====================================================================
s = new_slide("拆解总表", "15 个承接单元：目标、来源、打法一页看清",
              "按战区拆解表整理；每个单元对应主责 FDE、目标和主要打法，实施人员与主责 FDE 按同行对应。")

data = [
    ("交付一组", "黄冬萍", "760", [
        ("王昶钧", "160", "温健康", "存量验收 + 进阶项目"),
        ("张新玉", "100", "刘志刚", "基础单模块，快进快出"),
        ("陈效江", "160", "肖锦熙", "标准 MES/WMS 项目"),
        ("何耀伟", "180", "杨立钧", "进阶 + 多工厂，战区最高"),
        ("黄冬萍", "160", "组长兼任", "组长直管，组内共享实施"),
    ]),
    ("交付二组", "刘泽林", "770", [
        ("刘泽林", "170", "李尚鸿", "组长直管 + 重点客户"),
        ("程海南", "150", "李芷妍", "标准项目 + 新人带教"),
        ("李隆", "150", "韦凯耀", "标准项目"),
        ("曹孟辉", "150", "郑剑凯", "标准项目"),
        ("周生魁", "150", "—", "标准项目，共享实施"),
    ]),
    ("交付三组", "郑万东", "670", [
        ("许桂渝", "150", "黄钇暾", "标准项目"),
        ("郑万东", "170", "韦光辉", "组长直管 + 重点客户"),
        ("霍小瀛", "150", "张誉鹏", "标准项目"),
        ("待补", "100", "—", "12 月 15 日前锁定主责 FDE"),
        ("待补", "100", "—", "12 月 15 日前锁定主责 FDE"),
    ]),
]

nrows = 16
shape = s.shapes.add_table(nrows, 6, Inches(0.72), Inches(1.60), Inches(11.86), Inches(5.2))
tbl = shape.table
tbl.first_row = True
tbl.horz_banding = False
widths = [0.62, 1.86, 1.90, 1.28, 1.46, 4.74]
for i, w in enumerate(widths):
    tbl.columns[i].width = Inches(w)
tbl.rows[0].height = Inches(0.40)
for r in range(1, nrows):
    tbl.rows[r].height = Inches(0.315)

headers = ["序号", "交付组长 / 组目标", "主责 FDE / 实施", "单元目标\n（万元）", "实施", "主要打法 / 来源"]
for c, h in enumerate(headers):
    cell = tbl.cell(0, c)
    cell.fill.solid(); cell.fill.fore_color.rgb = rgb(NAVY)
    cell.margin_left = Inches(0.08); cell.margin_right = Inches(0.06)
    cell.margin_top = Inches(0.02); cell.margin_bottom = Inches(0.02)
    cell.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf = cell.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER if c in (0, 3, 4) else PP_ALIGN.LEFT
    for k, line in enumerate(h.split("\n")):
        pp = p if k == 0 else tf.add_paragraph()
        pp.alignment = PP_ALIGN.CENTER if c in (0, 3, 4) else PP_ALIGN.LEFT
        r = pp.add_run(); r.text = line
        r.font.name = FONT_LATIN; r.font.size = Pt(9); r.font.bold = True
        r.font.color.rgb = rgb(WHITE); _set_ea(r)

row = 1
for gname, lead, total, units in data:
    start = row
    for k, (pm, amt, impl, note) in enumerate(units):
        vals = [str(row), None, pm, amt, impl, note]
        for c, v in enumerate(vals):
            if v is None:
                continue
            cell = tbl.cell(row, c)
            cell.fill.solid()
            cell.fill.fore_color.rgb = rgb(WHITE if (row % 2 == 1) else LIGHT)
            cell.margin_left = Inches(0.08); cell.margin_right = Inches(0.06)
            cell.margin_top = Inches(0.01); cell.margin_bottom = Inches(0.01)
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
            tf = cell.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            p.alignment = PP_ALIGN.CENTER if c in (0, 3, 4) else PP_ALIGN.LEFT
            r = p.add_run(); r.text = v
            r.font.name = FONT_LATIN
            _set_ea(r)
            if c == 2:
                r.font.size = Pt(9.6); r.font.bold = True; r.font.color.rgb = rgb(NAVY)
            elif c == 3:
                r.font.size = Pt(10.5); r.font.bold = True; r.font.color.rgb = rgb(TEAL)
            elif c == 4:
                r.font.size = Pt(9.2)
                r.font.color.rgb = rgb(RED if v in ("—", "组长兼任") else INK)
            elif c == 5:
                r.font.size = Pt(8.8); r.font.color.rgb = rgb(GRAY)
            elif c == 0:
                r.font.size = Pt(8.6); r.font.color.rgb = rgb(MUTED)
            else:
                r.font.size = Pt(9.2); r.font.color.rgb = rgb(INK)
        row += 1

    cell = tbl.cell(start, 1)
    cell.merge(tbl.cell(row - 1, 1))
    cell.fill.solid(); cell.fill.fore_color.rgb = rgb("E8F5EC")
    cell.vertical_anchor = MSO_ANCHOR.MIDDLE
    cell.margin_left = Inches(0.10); cell.margin_right = Inches(0.06)
    tf = cell.text_frame
    tf.word_wrap = True
    tf.paragraphs[0].alignment = PP_ALIGN.LEFT
    r = tf.paragraphs[0].add_run(); r.text = gname
    r.font.name = FONT_LATIN; r.font.size = Pt(10.5); r.font.bold = True
    r.font.color.rgb = rgb(NAVY); _set_ea(r)
    p2 = tf.add_paragraph(); p2.alignment = PP_ALIGN.LEFT
    r2 = p2.add_run(); r2.text = f"{lead} ｜ {total} 万"
    r2.font.name = FONT_LATIN; r2.font.size = Pt(9); r2.font.color.rgb = rgb(GRAY); _set_ea(r2)
    p3 = tf.add_paragraph(); p3.alignment = PP_ALIGN.LEFT
    r3 = p3.add_run(); r3.text = "5 个单元"
    r3.font.name = FONT_LATIN; r3.font.size = Pt(8.4); r3.font.color.rgb = rgb(MUTED); _set_ea(r3)

# 边框
def set_borders(cell, color=BORDER, w=0.6):
    tcPr = cell._tc.get_or_add_tcPr()
    for tag in ("a:lnL", "a:lnR", "a:lnT", "a:lnB"):
        for e in tcPr.findall(qn(tag)):
            tcPr.remove(e)
    for tag in ("a:lnL", "a:lnR", "a:lnT", "a:lnB"):
        ln = etree.Element(qn(tag))
        ln.set("w", str(int(w * 12700))); ln.set("cap", "flat"); ln.set("cmpd", "sng"); ln.set("algn", "ctr")
        fill = etree.SubElement(ln, qn("a:solidFill"))
        clr = etree.SubElement(fill, qn("a:srgbClr")); clr.set("val", color)
        dash = etree.SubElement(ln, qn("a:prstDash")); dash.set("val", "solid")
        tcPr.insert(0, ln)

for r_ in range(nrows):
    for c_ in range(6):
        set_borders(tbl.cell(r_, c_))

text(s, 0.72, 6.92, 11.86, 0.22,
     "15 个单元 = 2,200 万；新签项目测算 20 个、约 2,014 万合同额（详见「达成路径」页），签约与回款节奏按月过账。",
     size=8.8, bold=True, color=ORANGE)


# =====================================================================
# 06-08 三个交付组
# =====================================================================
group_defs = [
    dict(no="01", name="交付一组", lead="黄冬萍", total="760", color=BLUE, impl=4,
         kicker="交付一组 ｜ 760 万",
         title="一组：760 万，标准项目守住基本盘，进阶项目提客单价",
         sub="组均 152 万；打法：标准项目快速交付 + 何耀伟 180 万做进阶/多工厂，组长黄冬萍直管 160 万。",
         units=[("王昶钧", 160, "温健康", "存量验收 + 进阶项目"),
                ("张新玉", 100, "刘志刚", "基础单模块，快进快出"),
                ("陈效江", 160, "肖锦熙", "标准项目"),
                ("何耀伟", 180, "杨立钧", "进阶 + 多工厂，战区最高"),
                ("黄冬萍", 160, "组长兼任", "组长直管，共享实施")],
         note="打法：5 个单元全配主责；张新玉 100 万用基础模块全年跑 6—8 个短周期，何耀伟 180 万集中做多工厂进阶，提客单价。"),
    dict(no="02", name="交付二组", lead="刘泽林", total="770", color=TEAL, impl=4,
         kicker="交付二组 ｜ 770 万",
         title="二组：770 万战区最高，主攻 MES+WMS 组合项目",
         sub="组均 154 万；打法：组合项目提客单价，组长刘泽林直管 170 万重点客户。",
         units=[("刘泽林", 170, "李尚鸿", "组长直管 + 重点客户"),
                ("程海南", 150, "李芷妍", "标准项目 + 新人带教"),
                ("李隆", 150, "韦凯耀", "标准项目"),
                ("曹孟辉", 150, "郑剑凯", "标准项目"),
                ("周生魁", 150, "—", "标准项目，共享实施")],
         note="打法：770 万靠组合项目客单价撑起来；李芷妍 90 天带教快速上手，周生魁靠共享实施，5 个单元逐一对项目、对月份。"),
    dict(no="03", name="交付三组", lead="郑万东", total="670", color=ORANGE, impl=3,
         kicker="交付三组 ｜ 670 万",
         title="三组：670 万标准项目快跑，两个 100 万单元补强到位",
         sub="组均 134 万；打法：标准项目为主，2 个待补岗 12 月 15 日前锁定主责 FDE。",
         units=[("许桂渝", 150, "黄钇暾", "标准项目"),
                ("郑万东", 170, "韦光辉", "组长直管 + 重点客户"),
                ("霍小瀛", 150, "张誉鹏", "标准项目"),
                ("待补", 100, "—", "12 月 15 日前锁定主责 FDE"),
                ("待补", 100, "—", "12 月 15 日前锁定主责 FDE")],
         note="打法：标准项目快跑 + 两个 100 万单元补强；补人到位后 670 万由 5 个主责 FDE 各自对项目、对回款。"),
]

for g in group_defs:
    s = new_slide(g["kicker"], g["title"], g["sub"])
    col = g["color"]
    # 顶部汇总条
    rect(s, 0.72, 1.58, 11.86, 0.86, fill=LIGHT)
    vline(s, 0.72, 1.58, 0.86, col, 0.06)
    text(s, 0.98, 1.72, 2.4, 0.26, g["name"], size=13, bold=True, color=NAVY)
    text(s, 0.98, 2.06, 3.0, 0.22, f"组长  {g['lead']}", size=9.6, color=GRAY)
    facts = [("组目标", g["total"] + " 万"), ("承接单元", "5 个"),
             ("已配实施", f"{g['impl']} 人"), ("组均单元", {"760": "152", "770": "154", "670": "134"}[g["total"]] + " 万")]
    fx = 3.30
    for k, v in facts:
        text(s, fx, 1.70, 1.3, 0.20, k, size=8.2, color=MUTED)
        text(s, fx, 1.92, 1.4, 0.28, v, size=12, bold=True, color=INK)
        fx += 1.42
    rich(s, 9.75, 1.74, 2.6, 0.52, [[(g["total"], 26, True, col), ("  万元", 10, True, GRAY)]],
         align=PP_ALIGN.RIGHT)

    # 单元行
    y = 2.62
    text(s, 0.78, y - 0.02, 0.5, 0.20, "#", size=8, color=MUTED)
    text(s, 1.18, y - 0.02, 1.2, 0.20, "主责 FDE / 实施", size=8, color=MUTED)
    text(s, 2.55, y - 0.02, 3.0, 0.20, "单元目标（万元）", size=8, color=MUTED)
    text(s, 5.75, y - 0.02, 1.0, 0.20, "目标", size=8, color=MUTED)
    text(s, 6.80, y - 0.02, 1.3, 0.20, "实施", size=8, color=MUTED)
    text(s, 8.30, y - 0.02, 4.0, 0.20, "打法 / 来源", size=8, color=MUTED)
    y += 0.24

    maxv = 180.0
    for i, (pm, amt, impl, note) in enumerate(g["units"]):
        rect(s, 0.72, y, 11.86, 0.62, fill=(WHITE if i % 2 else "F4F9F6"), line=BORDER)
        text(s, 0.84, y + 0.19, 0.36, 0.22, f"{i+1:02d}", size=8.6, color=MUTED)
        is_tbd = pm == "待补"
        text(s, 1.18, y + 0.16, 1.28, 0.28, pm, size=12, bold=True,
             color=(RED if is_tbd else NAVY))
        # 进度条
        rect(s, 2.55, y + 0.23, 3.00, 0.16, fill="EBF2ED")
        rect(s, 2.55, y + 0.23, 3.00 * amt / maxv, 0.16, fill=col)
        text(s, 5.72, y + 0.14, 1.05, 0.30, str(amt), size=15, bold=True, color=(RED if is_tbd else col))
        impl_col = RED if impl in ("—", "组长兼任") else INK
        text(s, 6.80, y + 0.20, 1.40, 0.24, impl, size=9.6, bold=(impl not in ("—", "组长兼任")), color=impl_col)
        text(s, 8.28, y + 0.13, 4.15, 0.38, note, size=8.8, color=GRAY, spacing=1.2)
        y += 0.66

    band(s, 0.72, 6.28, 11.86, 0.62, label="打法要点", body=g["note"])


# =====================================================================
# 09 承接强度对比
# =====================================================================
def cell_style(cell, s, size=10, bold=False, color=INK, align=PP_ALIGN.CENTER, fill=WHITE):
    cell.fill.solid(); cell.fill.fore_color.rgb = rgb(fill)
    cell.margin_left = Inches(0.09); cell.margin_right = Inches(0.06)
    cell.margin_top = Inches(0.02); cell.margin_bottom = Inches(0.02)
    cell.vertical_anchor = MSO_ANCHOR.MIDDLE
    tf = cell.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.alignment = align
    r = p.add_run(); r.text = str(s)
    r.font.name = FONT_LATIN; r.font.size = Pt(size); r.font.bold = bold
    r.font.color.rgb = rgb(color); _set_ea(r)


s = new_slide("达成路径", "2,200 万的现金来源：四本账，逐笔可追溯",
              "把目标拆成四类现金来源，每类都有打法、责任人和回款月份；不留一笔“不确定”的金额。")

ledger = [
    ("01", "存量清收", "历史尾款 / 应收账款", "逐项目确认合同余额、已完成未签字、已签字未开票、已开票未到账。",
     "把“可能回款”变成可验证的客户动作，纳入月度过账。", NAVY),
    ("02", "在执行里程碑", "上线款 / 验收款 / 阶段款", "按合同节点倒排：蓝图确认、模块上线、试运行、验收、签字、开票、付款。",
     "每个节点对应证据 + 客户责任人 + 到账月份。", GREEN),
    ("03", "新签首款与阶段款", "预付款 / 启动款 / 节点款", "售前写清付款节点、交付边界、验收标准、客户决策链。",
     "签约即锁首款，Q1—Q4 按节奏推进（见下页）。", BRAND),
    ("04", "硬件利润", "100 万 · 只算毛利", "单项目核算毛利，报价与合同单列硬件毛利。",
     "低于毛利底线不签；冲收入不算数。", TEAL),
]
for i, (no, title_, metric, body_, action, col) in enumerate(ledger):
    x = 0.72 + (i % 2) * 6.06
    y = 1.62 + (i // 2) * 2.24
    rect(s, x, y, 5.80, 2.08, fill=LIGHT, line=BORDER)
    rect(s, x, y, 5.80, 0.05, fill=col)
    text(s, x + 0.22, y + 0.18, 0.5, 0.24, no, size=10, bold=True, color=col)
    text(s, x + 0.78, y + 0.16, 3.4, 0.28, title_, size=13.5, bold=True, color=NAVY)
    text(s, x + 0.78, y + 0.48, 4.6, 0.24, metric, size=9.4, bold=True, color=col)
    text(s, x + 0.22, y + 0.82, 5.36, 0.52, body_, size=9.2, color=GRAY, spacing=1.3)
    text(s, x + 0.22, y + 1.50, 5.36, 0.46, "动作：" + action, size=9.2, bold=True, color=INK, spacing=1.25)

band(s, 0.72, 6.22, 11.86, 0.62, label="落地原则",
     body="合同依据 + 付款条件 + 客户确认 + 责任人 + 到账日期；缺一项进机会池，不计入确定性预测。")


# =====================================================================
# 10 新签抢单：测算与节奏
# =====================================================================
s = new_slide("抢单节奏", "新签抢单：20 个项目、约 2,014 万合同额，Q2/Q3 是主战场",
              "按报价锚点组合测算：基础 30 万、标准 88 万、进阶 160 万、复杂 180 万；当年回款约 1,432 万，兑现率 71.1%。")

kpis11 = [("20", "个", "新签项目数"), ("2,014", "万", "合同额目标"),
          ("1,432", "万", "当年回款"), ("71.1%", "", "合同额兑现率")]
for i, (num, unit, label) in enumerate(kpis11):
    x = 0.72 + i * 3.00
    rect(s, x, 1.58, 2.86, 0.92, fill=LIGHT)
    rich(s, x + 0.20, 1.70, 2.5, 0.42, [[(num, 20, True, NAVY), (" " + unit, 9, True, GRAY)]])
    text(s, x + 0.20, 2.20, 2.5, 0.22, label, size=8.8, bold=True, color=GRAY)

hdr11 = ["项目类型", "数量", "参考单价", "合同额", "典型范围"]
rows11 = [
    ("基础 MES/WMS 单模块", "5 个", "30 万", "150 万", "基础报工、库存、标准单模块"),
    ("标准 MES/WMS 项目", "8 个", "88 万", "704 万", "单工厂标准范围，控制定制边界"),
    ("进阶 MES+WMS 组合", "5 个", "160 万", "800 万", "PCBA/SMT、物料追溯、生产仓储一体化"),
    ("复杂 / 多工厂", "2 个", "180 万", "360 万", "多产线、集团复制、复杂接口"),
    ("合计", "20 个", "—", "2,014 万", "其中 ≤100 万 13 个，>100 万 7 个"),
]
shape = s.shapes.add_table(6, 5, Inches(0.72), Inches(2.66), Inches(11.86), Inches(1.9))
t11 = shape.table
t11.first_row = True
t11.horz_banding = False
for i, w in enumerate([3.10, 1.20, 1.50, 1.60, 4.46]):
    t11.columns[i].width = Inches(w)
t11.rows[0].height = Inches(0.42)
for r in range(1, 6):
    t11.rows[r].height = Inches(0.30)
for c, h in enumerate(hdr11):
    cell_style(t11.cell(0, c), h, size=9.5, bold=True, color=WHITE, fill=NAVY)
for r, row in enumerate(rows11, start=1):
    last = (r == 5)
    for c, v in enumerate(row):
        fill = "E8F5EC" if last else (WHITE if r % 2 else LIGHT)
        color = NAVY if (last or c == 0) else INK
        bold = last or c == 0
        if c == 3:
            color = TEAL; bold = True
        cell_style(t11.cell(r, c), v, size=9.0, bold=bold, color=color,
                   align=PP_ALIGN.CENTER if c in (1, 2, 3) else PP_ALIGN.LEFT, fill=fill)
for r in range(6):
    for c in range(5):
        set_borders(t11.cell(r, c))

text(s, 0.74, 4.70, 5.0, 0.24, "签约与当年回款节奏", size=11, bold=True, color=NAVY)
quarters = [("Q1", "3 个", "206 万", "185 万"), ("Q2", "7 个", "794 万", "666 万"),
            ("Q3", "6 个", "628 万", "427 万"), ("Q4", "4 个", "386 万", "154 万")]
for i, (q, cnt, amt, back) in enumerate(quarters):
    x = 0.72 + i * 3.00
    rect(s, x, 5.02, 2.86, 1.00, fill=LIGHT, line=BORDER)
    vline(s, x, 5.02, 1.00, TEAL, 0.05)
    text(s, x + 0.20, 5.12, 0.6, 0.24, q, size=11, bold=True, color=NAVY)
    text(s, x + 0.20, 5.42, 2.5, 0.22, cnt + " ｜ 签约 " + amt, size=9.2, color=INK)
    text(s, x + 0.20, 5.68, 2.5, 0.22, "当年回款 " + back, size=8.6, color=TEAL)

band(s, 0.72, 6.18, 11.86, 0.60, label="关键条件",
     body="签约不是全年平均分布：Q1 避开春节低谷只排 3 个，Q2/Q3 扛主签约量；付款节点覆盖首款、里程碑、上线/验收款。")


# =====================================================================
# 11 保障机制
# =====================================================================
s = new_slide("承接机制", "目标怎么管：五张表、月度过账、组长负总责",
              "拆解只完成一半，另一半是每月把“目标—项目—人—回款”对一次账，偏差当月纠正。")

mech = [
    ("01", "目标表", "每个单元一张表：目标拆到项目、客户、签约月、验收月、回款月；没有项目的单元标红。", "各组长", TEAL),
    ("02", "人员表", "2 个待补岗 12 月锁定；李芷妍 90 天带教与备份；实施共享池规则与工时归属。", "郑万东", BLUE),
    ("03", "项目表", "1 主 1 辅；90 天验收清单；上线当天启动验收资料，不等客户催。", "三位组长", GREEN),
    ("04", "硬件表", "单项目毛利核算；报价、合同单列硬件毛利；低于底线由战区司令审批。", "庄小龙", ORANGE),
    ("05", "考核表", "组长对组目标负总责，PM 对单元目标负责；月度过账、季度复盘、年度兑现。", "庄小龙", RED),
]
y = 1.60
for _mi, (no, title_, body_, owner, col) in enumerate(mech):
    rect(s, 0.72, y, 11.86, 0.88, fill=(LIGHT if _mi % 2 == 0 else WHITE), line=BORDER)
    vline(s, 0.72, y, 0.88, col, 0.05)
    text(s, 0.95, y + 0.29, 0.5, 0.26, no, size=11, bold=True, color=col)
    text(s, 1.44, y + 0.26, 1.5, 0.30, title_, size=11.5, bold=True, color=NAVY)
    text(s, 3.10, y + 0.14, 7.3, 0.62, body_, size=9.3, color=GRAY, anchor=MSO_ANCHOR.MIDDLE, spacing=1.25)
    text(s, 10.55, y + 0.30, 1.85, 0.24, owner, size=9, bold=True, color=col, align=PP_ALIGN.RIGHT)
    y += 0.94

band(s, 0.72, 6.38, 11.86, 0.54, fill=CREAM, accent=ORANGE, label=None,
     body="月度节奏：每月 5 日前出三张表（签约、验收、回款），组长过账；季度末对目标完成率做一次红黄绿灯。",
     body_size=10)


# =====================================================================
# 12 交付打法：全面 FDE 化
# =====================================================================
s = new_slide("交付打法", "全面 FDE 化：一个人跟到底，简单需求 AI 直接改代码",
              "所有交付单元由 FDE 端到端负责，不再按“需求—开发—实施”分段传递；简单需求 FDE 用 AI 直接改，复杂需求才进开发组。")

changes = [
    ("01", "角色｜一人闭环", "PM 提需求 → 开发排期 → 实施上线，三段交接，出了问题互相等。",
     "一个 FDE 从现场诊断跟到上线验收，交付结果自己负责。", BLUE),
    ("02", "工具｜AI 直连代码", "改一个字段也要排期，等 1—2 周才能上线。",
     "简单需求 FDE 当场用 AI 改，1—3 天上线。", TEAL),
    ("03", "流程｜一条龙", "需求、开发、交付三本账，客户一个问题要转三个人。",
     "需求—开发—交付一条龙，交付与回款一起背。", ORANGE),
]
cw = 3.82
for i, (no, title_, now_, later_, col) in enumerate(changes):
    x = 0.72 + i * (cw + 0.20)
    rect(s, x, 1.60, cw, 2.44, fill=LIGHT, line=BORDER)
    rect(s, x, 1.60, cw, 0.055, fill=col)
    text(s, x + 0.24, 1.78, 0.5, 0.24, no, size=9.5, bold=True, color=col)
    text(s, x + 0.24, 2.02, cw - 0.4, 0.28, title_, size=13, bold=True, color=NAVY)
    text(s, x + 0.24, 2.46, 0.58, 0.22, "现在", size=8.2, bold=True, color=MUTED)
    text(s, x + 0.84, 2.44, cw - 1.08, 0.62, now_, size=8.7, color=PALE, spacing=1.3)
    text(s, x + 0.24, 3.14, 0.58, 0.22, "以后", size=8.2, bold=True, color=col)
    text(s, x + 0.84, 3.10, cw - 1.08, 0.80, later_, size=9.2, bold=True, color=INK, spacing=1.3)

rect(s, 0.72, 4.22, 11.86, 0.72, fill=NAVY)
vline(s, 0.72, 4.22, 0.72, TEAL, 0.055)
text(s, 1.00, 4.36, 11.3, 0.44, "FDE（人）× AI 直连代码（工具）× 一条龙（流程）  =  24 名 FDE 全员上场，15 个单元小组",
     size=13.5, bold=True, color=WHITE, spacing=1.1)

text(s, 0.74, 5.14, 3.0, 0.26, "三条前提", size=11.5, bold=True, color=NAVY)
pres = [("不新增编制", "在现有 13 名 PM + 11 名实施内重组，2 个待补岗优先内部调配", TEAL),
        ("不推倒重来", "MES/WMS 产品与项目流程不变，只改“谁来做、怎么做”", BLUE),
        ("不降低标准", "AI 改的代码同样过人审、测试、灰度、回滚四道门禁", ORANGE)]
for i, (t_, d_, col) in enumerate(pres):
    x = 0.72 + i * 3.98
    rect(s, x, 5.44, 3.84, 1.00, fill=LIGHT)
    vline(s, x, 5.44, 1.00, col, 0.05)
    text(s, x + 0.20, 5.56, 2.0, 0.24, t_, size=10, bold=True, color=col)
    text(s, x + 0.20, 5.84, 3.50, 0.52, d_, size=8.4, color=GRAY, spacing=1.3)


# =====================================================================
# 13 全员 FDE 化
# =====================================================================
s = new_slide("组织承接", "全员 FDE 化：24 名交付人员都是 FDE，15 个单元由 FDE 小组承接",
              "13 名项目经理 + 11 名实施全部是 FDE，都要能改代码、能端到端交付；差别只在主责与协同，不在身份。")

rect(s, 0.72, 1.58, 11.86, 0.54, fill=LIGHT)
text(s, 0.96, 1.70, 11.4, 0.28,
     "24 名现有交付人员全部 FDE 化：13 名主责 FDE + 11 名协同 FDE；补齐 2 个待补岗后形成 15 个 FDE 小组 ｜ 人均 92 万",
     size=9.8, bold=True, color=NAVY)

rows13 = [
    ("L3 复杂场景", "3", "520", "何耀伟 180 ｜ 刘泽林 170 ｜ 郑万东 170", "每人 1 名（3 人）"),
    ("L2 标准项目", "9", "1,380", "160 档 3 人 ｜ 150 档 6 人", "每 1—2 个单元 1 名（6 人）"),
    ("L1 基础模块", "3", "300", "张新玉 100 ｜ 待补 2 名", "2 个单元共享 1 名（2 人）"),
    ("合计", "15", "2,200", "15 名（含 2 个待补）", "11 名协同 FDE"),
]
shape = s.shapes.add_table(5, 5, Inches(0.72), Inches(2.24), Inches(11.86), Inches(2.48))
t13 = shape.table
t13.first_row = True
t13.horz_banding = False
for i, w in enumerate([2.20, 1.10, 1.50, 4.20, 2.86]):
    t13.columns[i].width = Inches(w)
t13.rows[0].height = Inches(0.48)
for r in range(1, 5):
    t13.rows[r].height = Inches(0.50)

hdr13 = ["单元等级", "单元数", "金额（万）", "主责 FDE（15 名）", "协同 FDE（11 名）"]
for c, h in enumerate(hdr13):
    cell_style(t13.cell(0, c), h, size=9.6, bold=True, color=WHITE, fill=NAVY,
               align=PP_ALIGN.CENTER if c in (1, 2) else PP_ALIGN.LEFT)
for r, row in enumerate(rows13, start=1):
    total_row = (r == 4)
    for c, v in enumerate(row):
        fill = "E8F5EC" if total_row else (WHITE if r % 2 else "F4F9F6")
        bold = total_row or c == 0
        if total_row:
            color = NAVY
        elif c == 0:
            color = NAVY
        elif c == 2:
            color = TEAL
        else:
            color = INK
        size = 10.5 if c == 2 else (9.8 if c == 0 else 9.0)
        cell_style(t13.cell(r, c), v, size=size, bold=bold, color=color,
                   align=PP_ALIGN.CENTER if c in (1, 2) else PP_ALIGN.LEFT, fill=fill)
for r in range(5):
    for c in range(5):
        set_borders(t13.cell(r, c))

cards13 = [
    ("主责 FDE（15 名）", "对单元目标、验收和回款负责，带 1—2 名协同 FDE；现有 13 名项目经理担任，实施达到 L2 也可带单元。", BLUE),
    ("协同 FDE（11 名）", "对模块配置、开发、测试和上线负责，同时跟 1—2 个单元；由现有 11 名实施担任，不是“助理”。", TEAL),
]
for i, (t_, d_, col) in enumerate(cards13):
    x = 0.72 + i * 6.05
    rect(s, x, 4.86, 5.81, 1.00, fill=LIGHT, line=BORDER)
    vline(s, x, 4.86, 1.00, col, 0.055)
    text(s, x + 0.22, 4.98, 4.0, 0.24, t_, size=10.5, bold=True, color=col)
    text(s, x + 0.22, 5.26, 5.42, 0.52, d_, size=8.6, color=GRAY, spacing=1.3)

band(s, 0.72, 6.02, 11.86, 0.64, fill=CREAM, accent=ORANGE,
     label="认证与边界", body="全员先过 L1 认证，主责 FDE 需 L2 及以上，不认证不上岗；FDE 不替代合同与回款责任（组长负总责），共用代码仍归开发组治理。",
     label_size=8.8, body_size=9.2)


# =====================================================================
# 14 需求—开发—交付一条龙
# =====================================================================
s = new_slide("交付流程", "需求—开发—交付一条龙：三级分流，简单需求不进开发排期",
              "按改动复杂度分流：配置、简单代码、复杂开发；三级都由同一个 FDE 对结果负责。")

funnel = [
    ("L1", "配置类", "40%", ["参数、表单、报表、权限、流程配置", "FDE 独立完成", "0.5—2 天", "配置评审 + 测试用例"], BLUE),
    ("L2", "简单代码", "40%", ["接口对接、字段与逻辑调整、简单报表、脚本", "FDE + AI 直接改代码", "1—3 天", "四道门禁（人审/测试/灰度/回滚）"], TEAL),
    ("L3", "复杂开发", "20%", ["新模块、核心流程改造、多系统集成、性能问题", "FDE 提需求 → 开发组排期", "按开发排期", "架构评审 + 版本发布"], ORANGE),
]
for i, (lv, name, pct, rows, col) in enumerate(funnel):
    x = 0.72 + i * 3.98
    rect(s, x, 1.60, 3.84, 3.34, fill=LIGHT, line=BORDER)
    rect(s, x, 1.60, 3.84, 0.055, fill=col)
    text(s, x + 0.22, 1.78, 0.6, 0.26, lv, size=10, bold=True, color=col)
    text(s, x + 0.80, 1.76, 2.0, 0.28, name, size=13, bold=True, color=NAVY)
    text(s, x + 2.55, 1.80, 1.05, 0.24, "目标 " + pct, size=8.8, bold=True, color=col, align=PP_ALIGN.RIGHT)
    labels = ["典型需求", "谁来做", "时效", "门禁"]
    yy = 2.26
    for lb, v in zip(labels, rows):
        text(s, x + 0.22, yy, 3.4, 0.20, lb, size=7.8, bold=True, color=MUTED)
        text(s, x + 0.22, yy + 0.20, 3.44, 0.46, v, size=8.8, color=INK, spacing=1.25)
        yy += 0.68

text(s, 0.74, 5.10, 6.0, 0.24, "一条龙的五个节点：同一个 FDE 从诊断跟到回款", size=10.5, bold=True, color=NAVY)
nodes = ["现场诊断", "原型验证", "配置 / 开发", "上线验收", "验收回款"]
for i, n_ in enumerate(nodes):
    x = 0.72 + i * 2.375
    head = i in (0, 4)
    rect(s, x, 5.42, 2.14, 0.62, fill=(NAVY if head else LIGHT))
    text(s, x + 0.06, 5.58, 2.02, 0.30, n_, size=10.5, bold=True,
         color=(WHITE if head else NAVY), align=PP_ALIGN.CENTER)
    if i < 4:
        text(s, x + 2.14, 5.54, 0.24, 0.30, "›", size=15, bold=True, color=MUTED, align=PP_ALIGN.CENTER)

band(s, 0.72, 6.22, 11.86, 0.58, fill=CREAM, accent=ORANGE, label=None,
     body="40 / 40 / 20 是首年规划值，按季度实际改单量校准；L2 比例越高，对门禁和测试的要求越高。",
     body_size=9.8)


# =====================================================================
# 15 AI 直连代码：授权与门禁
# =====================================================================
s = new_slide("质量与授权", "AI 直连代码：手放开，四道门禁不能省",
              "简单需求由 FDE 用 AI 直接改代码，前提是需求准入、权限分级、四道门禁和红线清单同时成立。")

rect(s, 0.72, 1.60, 3.46, 3.52, fill=LIGHT, line=BORDER)
text(s, 0.94, 1.76, 3.0, 0.26, "权限四级", size=11.5, bold=True, color=NAVY)
levels = [("01", "沙箱环境", "自由改、自由删，随便试", BLUE),
          ("02", "特性分支", "FDE 自建分支，可提交", TEAL),
          ("03", "预发验证", "必须过测试与业务验证", GREEN),
          ("04", "生产发布", "双人复核，按窗口发布", ORANGE)]
yy = 2.14
for no, n_, d_, col in levels:
    text(s, 0.94, yy, 0.36, 0.22, no, size=8.6, bold=True, color=col)
    text(s, 1.32, yy - 0.02, 2.6, 0.24, n_, size=9.8, bold=True, color=INK)
    text(s, 1.32, yy + 0.24, 2.62, 0.42, d_, size=8.2, color=GRAY, spacing=1.2)
    yy += 0.72

rect(s, 4.34, 1.60, 4.34, 3.52, fill=LIGHT)
text(s, 4.58, 1.76, 3.9, 0.26, "四道门禁（每道都要留证据）", size=11.5, bold=True, color=NAVY)
gates = [("人审", "AI 生成的每一行，FDE 要能说明为什么这么改"),
         ("测试", "用例真实执行，不允许“无日志标记通过”"),
         ("灰度", "先 1 家客户 / 1 个车间，观察 3 天"),
         ("回滚", "24 小时内可回滚，保留完整变更记录")]
yy = 2.14
for g, d_ in gates:
    text(s, 4.58, yy + 0.02, 0.62, 0.22, g, size=9.4, bold=True, color=TEAL)
    text(s, 5.26, yy - 0.02, 3.22, 0.62, d_, size=8.4, color=INK, spacing=1.25)
    yy += 0.72

rect(s, 8.86, 1.60, 3.72, 3.52, fill=LIGHT, line=BORDER)
rect(s, 8.86, 1.60, 3.72, 0.055, fill=RED)
text(s, 9.08, 1.76, 3.2, 0.26, "红线：必须开发组评审", size=11.5, bold=True, color=RED)
reds = ["核心过站、结算、财务逻辑", "数据库结构变更", "跨客户共用代码与公共组件", "性能、安全、并发相关改动"]
yy = 2.18
for r_ in reds:
    text(s, 9.08, yy + 0.02, 0.26, 0.22, "—", size=9, bold=True, color=RED)
    text(s, 9.38, yy - 0.02, 3.00, 0.48, r_, size=8.8, color=INK, spacing=1.25)
    yy += 0.66

rect(s, 0.72, 5.30, 11.86, 0.86, fill=NAVY)
text(s, 0.96, 5.46, 1.4, 0.24, "月度看四个数", size=9.4, bold=True, color="7FD3A4")
metrics = [("AI 代码占比", "改单中由 AI 生成的比例"), ("一次通过率", "提交即通过测试的比例"),
           ("返工率", "上线 30 天内返工占比"), ("线上故障数", "由变更引起的故障数")]
for i, (m, d_) in enumerate(metrics):
    x = 2.42 + i * 2.56
    text(s, x, 5.44, 2.4, 0.26, m, size=10, bold=True, color=WHITE)
    text(s, x, 5.70, 2.4, 0.22, d_, size=7.8, color="BFD6C8")

band(s, 0.72, 6.34, 11.86, 0.56, fill=CREAM, accent=ORANGE, label=None,
     body="放开的是“简单需求不用等排期”，收紧的是“改了什么必须说得清、测得到、退得回”。", body_size=9.8)


# =====================================================================
# 16 周末议程
# =====================================================================
s = new_slide("研讨安排", "周六、周日两天，需要拍板 6 件事",
              "议程围绕“定人、定项目、定机制”设计；每半天必须有一个可交付的结论，不做纯讨论。")

text(s, 0.74, 1.58, 3.6, 0.26, "两天议程", size=11.5, bold=True, color=NAVY)
agenda = [
    ("周六 11/28", "09:00—12:00", "目标与口径", "确认 2,200 万拆分、软件/硬件口径、三组与单元目标", BLUE),
    ("周六 11/28", "14:00—17:30", "人与资源", "2 个待补岗人选、李芷妍安排、4 个无实施单元的配置", TEAL),
    ("周日 11/29", "09:00—12:00", "项目清单", "15 个单元逐一对客户、对项目、对签约与回款月份", GREEN),
    ("周日 11/29", "14:00—16:30", "机制与考核", "月度过账、季度复盘、奖惩办法与签约节奏", ORANGE),
]
y = 1.92
for date, tm, topic, out, col in agenda:
    rect(s, 0.74, y, 5.45, 1.02, fill=LIGHT, line=BORDER)
    vline(s, 0.74, y, 1.02, col, 0.05)
    text(s, 0.96, y + 0.14, 1.35, 0.22, date, size=9, bold=True, color=col)
    text(s, 2.32, y + 0.14, 1.35, 0.22, tm, size=8.4, color=MUTED)
    text(s, 0.96, y + 0.42, 4.9, 0.26, topic, size=11.5, bold=True, color=NAVY)
    text(s, 0.96, y + 0.70, 5.05, 0.26, out, size=8.2, color=GRAY)
    y += 1.10

text(s, 6.55, 1.58, 4.6, 0.26, "需要拍板的 6 件事", size=11.5, bold=True, color=NAVY)
decisions = [
    ("01", "目标口径", "软件 2,100 万按回款、硬件 100 万按利润，分列考核", "庄小龙"),
    ("02", "2 个待补岗", "12 月 15 日前定人，定不了就重分 200 万", "郑万东"),
    ("03", "FDE 转型范围", "24 人全部 FDE 化，还是先试点 6 人", "庄小龙"),
    ("04", "AI 代码授权", "L2 简单需求放开到什么边界、谁签字", "开发组长"),
    ("05", "项目清单", "15 个单元对应项目，Q1 前锁定 60% 合同额", "全体 PM"),
    ("06", "考核办法", "组长负总责、月度过账、季度复盘", "庄小龙"),
]
y = 1.92
for no, title_, body_, owner in decisions:
    rect(s, 6.55, y, 6.03, 0.70, fill=LIGHT, line=BORDER)
    text(s, 6.74, y + 0.10, 0.42, 0.22, no, size=9, bold=True, color=TEAL)
    text(s, 7.22, y + 0.08, 2.2, 0.24, title_, size=10.5, bold=True, color=NAVY)
    text(s, 7.22, y + 0.36, 4.0, 0.30, body_, size=8.2, color=GRAY)
    text(s, 11.20, y + 0.24, 1.2, 0.24, owner, size=8, bold=True, color=TEAL, align=PP_ALIGN.RIGHT)
    y += 0.73

band(s, 0.74, 6.46, 11.84, 0.44, fill=LIGHT, accent=NAVY, label=None,
     body="会前准备：三位组长 11/27 前提交 15 个单元的项目清单初稿，无项目的单元标红带到会上。",
     body_size=9.2)


# =====================================================================
# 14 附录
# =====================================================================
s = new_slide("附录", "口径说明与待确认事项",
              "所有数字都可以回溯到拆解表或简单计算；标注“待确认”的，需要在会上给定口径。")

rect(s, 0.72, 1.60, 7.20, 4.60, fill=LIGHT, line=BORDER)
text(s, 0.98, 1.78, 3.0, 0.26, "口径说明", size=12, bold=True, color=NAVY)
items = [
    ("数据来源", "战区目标拆解表（2026-11-26 提供）：2,200 万 = 软件 2,100 万 + 硬件利润 100 万。"),
    ("单元构成", "15 个承接单元 = 13 名项目经理 + 2 个待补岗；三组各 5 个单元。"),
    ("占比", "单元或组目标 ÷ 2,200 万；组均 = 组目标 ÷ 5 个单元。"),
    ("实施负荷", "组目标 ÷ 已配实施人数，仅用于横向比较负荷，不作为个人考核指标。"),
    ("硬件口径", "100 万为利润口径，未折算为硬件收入；如需折算，按实际毛利率另行测算。"),
    ("实施对应", "实施人员与项目经理按拆解表同行整理；如有调整，以组长确认为准。"),
]
y = 2.14
for k, v in items:
    text(s, 0.98, y + 0.02, 1.05, 0.24, k, size=8.8, bold=True, color=TEAL)
    text(s, 2.06, y, 5.62, 0.46, v, size=8.8, color=INK, spacing=1.3)
    y += 0.62

rect(s, 8.22, 1.60, 4.36, 4.60, fill=MINT)
text(s, 8.46, 1.78, 3.4, 0.26, "待确认（会上定口径）", size=12, bold=True, color=ORANGE)
todo = [
    "硬件 100 万的毛利率、是否含税",
    "2 个待补岗：外招还是内部调配",
    "李芷妍是否留用、如何带教",
    "软件 2,100 万的签约/验收/回款结构",
    "考核是否单独设硬件利润分成",
]
y = 2.18
for i, t_ in enumerate(todo, 1):
    text(s, 8.46, y, 0.34, 0.24, f"{i}", size=8.8, bold=True, color=ORANGE)
    text(s, 8.80, y, 3.50, 0.52, t_, size=9.2, color=INK, spacing=1.3)
    y += 0.62

text(s, 8.46, 5.50, 3.85, 0.40, "以上 5 项未定，2,200 万无法进入考核。", size=9.2, bold=True, color=ORANGE, spacing=1.25)

band(s, 0.72, 6.34, 11.86, 0.56, fill=LIGHT, accent=NAVY, label=None,
     body="本稿为研讨稿：目标与单元数据来自战区拆解表，占比、负荷等为派生计算；项目清单与季度节奏尚未填充，需周六、周日会上补齐。",
     body_size=9.6)


# =====================================================================
# 18 封底（规范：白底、39pt 深绿主口号、18pt 品牌绿副口号）
# =====================================================================
s = prs.slides.add_slide(BLANK)
PAGE["n"] += 1
rect(s, 0, 0, 13.333, 7.5, fill=WHITE)
rect(s, 0, 0.42, 13.333, 0.016, fill=BRAND)

text(s, 0.60, 1.86, 12.13, 1.24, "2,200 万，拆到 15 个单元，\n盯到 12 个月。", size=36, bold=True,
     color=INK, align=PP_ALIGN.CENTER, spacing=1.35)
text(s, 0.60, 3.62, 12.13, 0.40, "目标已经拆到人，接下来是项目清单和一套新打法。", size=18, bold=True,
     color=BRAND, align=PP_ALIGN.CENTER)

rect(s, 5.86, 4.52, 1.60, 0.012, fill=BORDER)
text(s, 0.60, 4.78, 12.13, 0.28, "周六定人：2 个待补岗锁定 + 实施共享池方案",
     size=12, color=GRAY, align=PP_ALIGN.CENTER)
text(s, 0.60, 5.16, 12.13, 0.28, "周日定项目：15 个单元逐一对客户、对月份、对回款",
     size=12, color=GRAY, align=PP_ALIGN.CENTER)

text(s, 0.60, 6.05, 12.13, 0.26, "第二战区 ｜ 2026 年 11 月", size=12, color=GRAY, align=PP_ALIGN.CENTER)
text(s, 0.60, 6.42, 12.13, 0.26, "感谢聆听 · 为 2027 加油", size=12, color=BRAND, align=PP_ALIGN.CENTER)


# ---- 按规范压缩标题区后，内容整体上移 ----
_SKIP = {0, 1, len(prs.slides) - 1}
for _idx, _sl in enumerate(prs.slides):
    if _idx in _SKIP:
        continue
    for _sh in _sl.shapes:
        if _sh.shape_id in CHROME:
            continue
        _sh.top = int(_sh.top - Inches(0.40))

OUT = r"D:\jinggong-agent\deliverables\第二战区2027年度经营目标拆解与交付承接方案_汇报稿.pptx"
os.makedirs(os.path.dirname(OUT), exist_ok=True)
prs.save(OUT)
print("saved", OUT, "slides", len(prs.slides))
