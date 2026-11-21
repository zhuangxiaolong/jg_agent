import fs from 'node:fs/promises';
import { FileBlob, PresentationFile } from '@oai/artifact-tool';
const p=await PresentationFile.importPptx(await FileBlob.load('D:/jinggong-agent/deliverables/第二战区2027经营与交付升级_优化版_第4页修订.pptx'));
const s=p.slides.items[3];
const png=await p.export({slide:s,format:'png',scale:2});
await fs.writeFile('D:/jinggong-agent/.pptx_edit/finalizer/slide-04-final.png',new Uint8Array(await png.arrayBuffer()));
const r=await p.inspect({kind:'slide,textbox',search:'568万',maxChars:5000});
console.log(r.ndjson??String(r));
