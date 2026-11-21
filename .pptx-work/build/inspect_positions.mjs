import { FileBlob, PresentationFile } from "@oai/artifact-tool";
const p=await PresentationFile.importPptx(await FileBlob.load("D:/jinggong-agent/.pptx-work/build/candidate2.pptx"));
const x=await p.inspect({select:'$.slides[11].elements[*]',include:['id','text','position']});
for(const l of x.ndjson.split('\n')) if(l.trim()) {const e=JSON.parse(l);if(['sh/atc7epon','sh/365472tg','sh/6l0nqxkf','sh/fi5432t4','sh/ylwj2987','sh/ih0jedob'].includes(e.id)) console.log(JSON.stringify(e));}
