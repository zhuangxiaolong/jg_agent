from zipfile import ZipFile
from lxml import etree
from pathlib import Path
import sys
p=Path(sys.argv[1])
with ZipFile(p) as z:
    root=etree.fromstring(z.read('word/document.xml'))
ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
for i,para in enumerate(root.xpath('.//w:body/w:p',namespaces=ns)):
    texts=para.xpath('.//w:t/text()',namespaces=ns)
    s=''.join(texts)
    if any(k in s for k in ['合同总价款','本项目合同金额','项目蓝图款','系统上线款','人民币','实施费用','SMT 21条']):
        print('---PARA',i)
        print(etree.tostring(para,encoding='unicode'))
