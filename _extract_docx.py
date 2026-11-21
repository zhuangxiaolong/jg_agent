from docx import Document
from pathlib import Path
import sys
p = Path(sys.argv[1])
out = Path(sys.argv[2])
doc = Document(str(p))
lines=[]
lines.append(f'PARAGRAPHS={len(doc.paragraphs)} TABLES={len(doc.tables)} SECTIONS={len(doc.sections)}')
for i, para in enumerate(doc.paragraphs):
    t=para.text.strip()
    if t:
        lines.append(f'P{i}: {t}')
for ti, table in enumerate(doc.tables):
    lines.append(f'\nTABLE {ti} rows={len(table.rows)} cols={len(table.columns)}')
    for ri,row in enumerate(table.rows):
        vals=[]
        for cell in row.cells:
            vals.append(' | '.join(x.text.replace('\n',' / ').strip() for x in cell.paragraphs))
        lines.append(f'R{ri}: ' + ' || '.join(vals))
out.write_text('\n'.join(lines), encoding='utf-8')
print(out)
