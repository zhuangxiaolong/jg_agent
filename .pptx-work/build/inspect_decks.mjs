import { FileBlob, PresentationFile } from "@oai/artifact-tool";

const paths = process.argv.slice(2);
for (const input of paths) {
  const p = await PresentationFile.importPptx(await FileBlob.load(input));
  console.log(`=== ${input} ===`);
  console.log(`slides=${p.slides.items.length}`);
  const result = await p.inspect({
    select: "$.slides[*]",
    include: ["id", "index", "layout", "elements.id", "elements.kind", "elements.text", "elements.title", "elements.alt", "notes.text"],
  });
  for (const line of result.ndjson.split("\n")) {
    if (!line.trim()) continue;
    const slide = JSON.parse(line);
    console.log(`--- SLIDE ${slide.index + 1} | ${slide.layout?.name ?? ""} ---`);
    for (const element of slide.elements ?? []) {
      if (element.text) console.log(`[${element.kind}] ${element.text.replace(/\s+/g, " ").trim()}`);
    }
    if (slide.notes?.text?.trim()) console.log(`[NOTES] ${slide.notes.text.trim()}`);
  }
}
