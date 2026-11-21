import { FileBlob, PresentationFile } from "@oai/artifact-tool";
const p = await PresentationFile.importPptx(await FileBlob.load(process.argv[2]));
for (const i of [0,1,2,11,13,16]) {
  const slide = p.slides.items[i];
  console.log(`=== slide ${i+1} ===`);
  console.log(await (await slide.export({format:"layout", detail:"full"})).text());
}
