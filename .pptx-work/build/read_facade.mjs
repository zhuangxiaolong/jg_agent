import { FileBlob, PresentationFile } from "@oai/artifact-tool";
const p=await PresentationFile.importPptx(await FileBlob.load("C:/Users/Administrator/Desktop/第二战区2027年度经营目标达成行动方案_周六会议版.pptx"));
const ids=["sh/547294r6","sh/k3yl0zql","sh/7qp4be9c","sh/9072xkry","sh/a10jqpsj","sh/x4r21kru"];
for(const id of ids){const x=p.resolve(id); console.log(id, {geometry:x.geometry,position:x.position,fill:x.fill,line:x.line,frame:x.frame,text:x.text?{value:x.text.value,style:x.text.style,fontSize:x.text.fontSize,color:x.text.color}:null});}
