from zipfile import ZipFile
from lxml import etree
from pathlib import Path
import sys
p=Path(sys.argv[1]); out=Path(sys.argv[2])
with ZipFile(p) as z:
    root=etree.fromstring(z.read('word/document.xml'))
ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
lines=[]
paras=root.xpath('.//w:body/w:p',namespaces=ns)
for i,para in enumerate(paras):
    parts=[]
    for node in para.xpath('.//w:t | .//w:delText',namespaces=ns):
        text=node.text or ''
        in_del=bool(node.xpath('ancestor::w:del',namespaces=ns))
        in_ins=bool(node.xpath('ancestor::w:ins',namespaces=ns))
        tag='DEL' if in_del else ('INS' if in_ins else 'TXT')
        parts.append(f'[{tag}]{text}')
    s=''.join(parts)
    if s.strip(): lines.append(f'P{i}: {s}')
# tables
for ti,table in enumerate(root.xpath('.//w:body/w:tbl',namespaces=ns)):
    lines.append(f'TABLE {ti}')
    rows=table.xpath('./w:tr',namespaces=ns)
    for ri,row in enumerate(rows):
        cells=[]
        for cell in row.xpath('./w:tc',namespaces=ns):
            parts=[]
            for node in cell.xpath('.//w:t | .//w:delText',namespaces=ns):
                text=node.text or ''
                in_del=bool(node.xpath('ancestor::w:del',namespaces=ns))
                in_ins=bool(node.xpath('ancestor::w:ins',namespaces=ns))
                tag='DEL' if in_del else ('INS' if in_ins else 'TXT')
                parts.append(f'[{tag}]{text}')
            cells.append(''.join(parts))
        lines.append(f'R{ri}: ' + ' || '.join(cells))
out.write_text('\n'.join(lines),encoding='utf-8')
print(out)
