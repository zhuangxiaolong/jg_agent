import { FileBlob, PresentationFile } from "@oai/artifact-tool";
const p=await PresentationFile.importPptx(await FileBlob.load("D:/jinggong-agent/.pptx-work/build/candidate3.pptx"));
const x=await p.inspect({select:'$.slides[*]',include:['index','elements.id','elements.text']});
for(const l of x.ndjson.split('\n')) if(l.trim()) {const s=JSON.parse(l); for(const e of s.elements??[]) if(/[→；;]/.test(e.text??'')) console.log(`${s.index+1}\t${e.id}\t${e.text.replace(/\n/g,' / ')}`);}
