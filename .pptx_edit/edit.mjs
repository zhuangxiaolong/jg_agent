import fs from 'node:fs/promises';
import path from 'node:path';
import { FileBlob, PresentationFile } from '@oai/artifact-tool';

const input = 'C:/Users/Administrator/Desktop/第二战区2027经营与交付升级_优化版 (1).pptx';
const workspaceDir = 'D:/jinggong-agent';
const buildDir = path.join(workspaceDir, '.pptx_edit/build');
const outputDir = path.join(workspaceDir, 'deliverables');
const finalPath = path.join(outputDir, '第二战区2027经营与交付升级_优化版_第4页修订.pptx');
await fs.mkdir(buildDir, { recursive: true });
await fs.mkdir(outputDir, { recursive: true });

const presentation = await PresentationFile.importPptx(await FileBlob.load(input));
console.log('slideSize', presentation.slideSize ?? presentation.slides?.slideSize ?? 'unknown');
const slide = presentation.slides.items[3];
const amount = presentation.resolve('sh/doj29oba');
const note = presentation.resolve('sh/sna103ap');
amount.text = '4,250万  =  568万（明年到账）  +  3,682万（其他现金来源待拆）';
note.text = '关键口径已确认：568万计入2027年到账，防止跨年重复统计。';

const beforeAfter = await presentation.inspect({ target: { id: 'sh/doj29oba', beforeLines: 1, afterLines: 2 }, kind: 'textbox', maxChars: 4000 });
console.log(beforeAfter.ndjson ?? beforeAfter);
const png = await presentation.export({ slide, format: 'png', scale: 2 });
await fs.writeFile(path.join(buildDir, 'slide-04-after.png'), new Uint8Array(await png.arrayBuffer()));
const candidatePath = path.join(buildDir, 'candidate.pptx');
await (await PresentationFile.exportPptx(presentation)).save(candidatePath);
console.log(JSON.stringify({ candidatePath, finalPath }));
