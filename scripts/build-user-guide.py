"""从同一份 Markdown 生成可离线阅读的网页和开发人员 PDF 手册。"""
import html
import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Preformatted

ROOT = Path(__file__).resolve().parents[1]
VERSION = '0.6.6'
SOURCE = ROOT / 'docs' / f'使用说明-{VERSION}.md'
OUTPUT = ROOT / 'release-v066'
OUTPUT.mkdir(exist_ok=True)
stem = f'精工 Agent {VERSION} 开发人员使用说明'
text = SOURCE.read_text(encoding='utf-8')
parts = re.split(r'^## (.+)$', text, flags=re.M)
intro = parts[0].split('\n', 2)[2].strip()
sections = [(parts[i], parts[i + 1].strip()) for i in range(1, len(parts), 2)]


def blocks(body):
    lines = body.splitlines()
    index = 0
    while index < len(lines):
        if not lines[index].strip():
            index += 1
            continue
        if lines[index].startswith('```'):
            index += 1
            code_lines = []
            while index < len(lines) and not lines[index].startswith('```'):
                code_lines.append(lines[index])
                index += 1
            index += 1
            yield 'code', '\n'.join(code_lines)
            continue
        paragraph = []
        while index < len(lines) and lines[index].strip() and not lines[index].startswith('```'):
            paragraph.append(lines[index])
            index += 1
        if re.match(r'^\d+\. ', paragraph[0]):
            for line in paragraph:
                yield 'step', line
        else:
            yield 'p', ' '.join(paragraph)


nav = ''.join(f'<a href="#part-{i}">{html.escape(title)}</a>' for i, (title, _) in enumerate(sections, 1))
body = ''
for i, (title, content) in enumerate(sections, 1):
    body += f'<section id="part-{i}"><h2>{html.escape(title)}</h2>'
    for kind, value in blocks(content):
        if kind == 'code':
            body += f'<pre><code>{html.escape(value)}</code></pre>'
        else:
            body += f'<p class="{kind}">{html.escape(value)}</p>'
    body += '</section>'
document = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{stem}</title>
<style>
*{{box-sizing:border-box}}html{{scroll-behavior:smooth}}body{{margin:0;background:#f3f5f5;color:#26312e;font:15px/1.9 "Microsoft YaHei",sans-serif}}
header{{background:#172a23;color:#fff;padding:38px max(24px,calc((100vw - 1120px)/2))}}header small{{color:#a8d4bb;letter-spacing:2px}}h1{{font-size:30px;line-height:1.5;margin:8px 0}}header p{{color:#c9d6d0;margin:8px 0}}
.layout{{display:grid;grid-template-columns:240px minmax(0,1fr);gap:26px;max-width:1120px;margin:26px auto;padding:0 18px}}nav{{position:sticky;top:20px;align-self:start}}nav a{{display:block;padding:10px 12px;color:#476153;text-decoration:none;border-left:2px solid #dbe4df;font-size:13px}}nav a:hover{{background:#e0eae4;color:#175d3c;border-color:#37835b}}
section{{background:white;padding:24px 30px;margin-bottom:20px;border:1px solid #e1e7e4;border-radius:8px;scroll-margin-top:18px}}h2{{font-size:21px;line-height:1.6;color:#20543a;margin:0 0 16px}}p{{margin:12px 0;overflow-wrap:anywhere}}.step{{padding-left:12px;border-left:3px solid #d5e8db}}
pre{{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf3ef;border:1px solid #d7e2db;border-radius:5px;padding:15px;color:#254c36;line-height:1.9}}code{{font-family:"Microsoft YaHei",sans-serif;font-size:14px}}footer{{text-align:center;color:#77877e;font-size:12px;padding:12px 20px 30px}}button{{padding:7px 14px;border:1px solid #94b2a0;border-radius:4px;color:white;background:transparent;font:inherit;cursor:pointer}}
@media(max-width:800px){{.layout{{display:block}}nav{{position:static;margin-bottom:20px}}nav a{{padding:5px 10px}}section{{padding:18px}}h1{{font-size:24px}}}}
@media print{{body{{background:white;font-size:11pt}}header{{background:white;color:#172a23;padding:0 0 20px}}header p{{color:#52675c}}button,nav{{display:none}}.layout{{display:block;margin:0;padding:0}}section{{border:0;padding:0;break-before:page}}section:first-child{{break-before:auto}}footer{{display:none}}}}
</style></head><body><header><small>精工研发 · 战区开发使用指南</small><h1>精工 Agent {VERSION}<br>开发人员使用说明</h1><p>{html.escape(intro)}</p><button onclick="window.print()">打印 / 保存 PDF</button></header><div class="layout"><nav aria-label="使用说明目录">{nav}</nav><main>{body}</main></div><footer>精工 Agent {VERSION} · 2026-11-06 · 可离线打开</footer></body></html>'''
(OUTPUT / f'{stem}.html').write_text(document, encoding='utf-8')

pdfmetrics.registerFont(TTFont('YaHei', 'C:/Windows/Fonts/msyh.ttc', subfontIndex=0))
pdfmetrics.registerFont(TTFont('YaHeiBold', 'C:/Windows/Fonts/msyhbd.ttc', subfontIndex=0))
pdfmetrics.registerFontFamily('YaHei', normal='YaHei', bold='YaHeiBold', italic='YaHei', boldItalic='YaHeiBold')
normal = ParagraphStyle('正文', fontName='YaHei', fontSize=10.5, leading=18, textColor=colors.HexColor('#2c3832'), alignment=TA_LEFT, wordWrap='CJK', spaceAfter=10)
heading = ParagraphStyle('章节', parent=normal, fontName='YaHeiBold', fontSize=17, leading=25, textColor=colors.HexColor('#20543a'), spaceAfter=18)
cover = ParagraphStyle('标题', parent=heading, fontSize=25, leading=35, spaceAfter=12)
caption = ParagraphStyle('副标题', parent=normal, fontSize=9, leading=15, textColor=colors.HexColor('#6b7e72'), spaceAfter=20)
code = ParagraphStyle('示例', parent=normal, fontSize=10, leading=18, backColor=colors.HexColor('#edf3ef'), borderPadding=12, spaceBefore=8, spaceAfter=16)
story = []
for i, (title, content) in enumerate(sections):
    if i:
        story.append(PageBreak())
    else:
        story.extend([Paragraph(f'精工 Agent {VERSION}<br/>开发人员使用说明', cover), Paragraph(html.escape(intro), caption)])
    story.append(Paragraph(html.escape(title), heading))
    for kind, value in blocks(content):
        if kind == 'code':
            story.append(Preformatted(value, code))
        else:
            story.append(Paragraph(html.escape(value), normal))


def page_chrome(canvas, doc):
    width, height = A4
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor('#d8e3dc'))
    canvas.line(43, height - 37, width - 43, height - 37)
    canvas.setFont('YaHei', 8)
    canvas.setFillColor(colors.HexColor('#718377'))
    canvas.drawString(43, height - 28, '精工 Agent 0.6.6  |  开发人员使用说明')
    canvas.line(43, 37, width - 43, 37)
    canvas.drawString(43, 24, '战区研发使用  ·  2026-11-07')
    canvas.drawRightString(width - 43, 24, f'第 {doc.page} 页')
    canvas.restoreState()


pdf = OUTPUT / f'{stem}.pdf'
SimpleDocTemplate(str(pdf), pagesize=A4, rightMargin=43, leftMargin=43, topMargin=56, bottomMargin=50, title=stem, author='精工研发').build(story, onFirstPage=page_chrome, onLaterPages=page_chrome)
print(pdf)
print(OUTPUT / f'{stem}.html')
