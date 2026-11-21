import { FileBlob, PresentationFile } from "@oai/artifact-tool";
const p = await PresentationFile.importPptx(await FileBlob.load("D:/jinggong-agent/.pptx-work/build/candidate2.pptx"));
const x = await p.inspect({select:'$.slides[*]',include:['index','elements.id','elements.text']});
for (const line of x.ndjson.split('\n')) { if (!line.trim()) continue; const s=JSON.parse(line); if ([0,1,2,4,11,13,15].includes(s.index)) { console.log(`SLIDE ${s.index+1}`); for (const e of s.elements??[]) if (e.text?.trim()) console.log(`${e.id}\t${e.text.replace(/\n/g,' / ')}`); }}
