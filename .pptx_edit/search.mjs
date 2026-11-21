import { FileBlob, PresentationFile } from '@oai/artifact-tool';
const input='C:/Users/Administrator/Desktop/第二战区2027经营与交付升级_优化版 (1).pptx';
const p=await PresentationFile.importPptx(await FileBlob.load(input));
for (const q of ['568','万','到账']) {
 const r=await p.inspect({kind:'slide,textbox,shape',search:q,maxChars:20000});
 console.log('\nQUERY',q,'\n',r.ndjson??String(r));
}
