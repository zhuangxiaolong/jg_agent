import { FileBlob, PresentationFile } from "@oai/artifact-tool";
const input = "C:/Users/Administrator/Desktop/第二战区2027年度经营目标达成行动方案_周六会议版.pptx";
const p = await PresentationFile.importPptx(await FileBlob.load(input));
const result = await p.inspect({select:'$.slides[*]',include:['id','index','layout','elements.id','elements.kind','elements.text','elements.position','elements.fill','elements.line','elements.textStyle','elements.fontSize','elements.color','elements.bold']});
for (const line of result.ndjson.split('\n')) { if(!line.trim()) continue; const s=JSON.parse(line); console.log(JSON.stringify({id:s.id,slide:s.index+1,layout:s.layout,elements:(s.elements||[]).map(e=>({id:e.id,kind:e.kind,text:(e.text||'').replace(/\s+/g,' ').trim(),position:e.position,fill:e.fill,line:e.line,style:e.textStyle,fontSize:e.fontSize,color:e.color,bold:e.bold}))})); }
