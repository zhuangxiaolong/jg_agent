from zipfile import ZipFile
from lxml import etree
from pathlib import Path
import sys
p=Path(sys.argv[1]); out=Path(sys.argv[2])
with ZipFile(p) as z:
    root=etree.fromstring(z.read('word/document.xml'))
ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
lines=[]
for i,para in enumerate(root.xpath('.//w:body/w:p',namespaces=ns)):
    parts=[]
    for node in para.xpath('.//w:t | .//w:delText',namespaces=ns):
        if node.tag.endswith('delText') or node.xpath('ancestor::w:del',namespaces=ns):
            continue
        parts.append(node.text or '')
    s=''.join(parts)
    if s.strip(): lines.append(f'P{i}: {s}')
out.write_text('\n'.join(lines),encoding='utf-8')
