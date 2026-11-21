import fs from 'node:fs/promises';
import { FileBlob, PresentationFile } from '@oai/artifact-tool';

const input = 'C:/Users/Administrator/Desktop/第二战区2027经营与交付升级_优化版 (1).pptx';
const outDir = 'D:/jinggong-agent/.pptx_edit/inspect';
await fs.mkdir(outDir, { recursive: true });
const presentation = await PresentationFile.importPptx(await FileBlob.load(input));
console.log('slides', presentation.slides.items.length);
const result = await presentation.inspect({ kind: 'slide,textbox,shape,image,table,chart,notes,layout', maxChars: 40000 });
await fs.writeFile(`${outDir}/inspect.ndjson`, result.ndjson ?? String(result));
console.log((result.ndjson ?? String(result)).slice(0, 40000));
const slide = presentation.slides.items[3];
const png = await presentation.export({ slide, format: 'png', scale: 2 });
await fs.writeFile(`${outDir}/slide-04.png`, new Uint8Array(await png.arrayBuffer()));
console.log('slide4 exported');
