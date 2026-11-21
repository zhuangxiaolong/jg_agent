import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FileBlob, PresentationFile } from '@oai/artifact-tool';

const SKILL_DIR = 'C:/Users/Administrator/.codex/plugins/cache/openai-primary-runtime/presentations/26.1112.11217/skills/presentations';
const workspaceDir = 'D:/jinggong-agent';
const candidatePath = path.join(workspaceDir, '.pptx_edit/build/candidate.pptx');
const FINAL_PPTX = path.join(workspaceDir, 'deliverables/第二战区2027经营与交付升级_优化版_第4页修订.pptx');
const stagingDir = path.join(workspaceDir, '.pptx_edit/finalizer');
await fs.mkdir(stagingDir, { recursive: true });
const { finalizePresentation } = await import(pathToFileURL(path.join(SKILL_DIR, 'container_tools/artifact_tool_utils.mjs')).href);
const p = await PresentationFile.importPptx(await FileBlob.load(candidatePath));
const result = await finalizePresentation({
  workspaceDir,
  candidatePath,
  finalPath: FINAL_PPTX,
  pythonExecutable: 'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',
  integrityValidatorPath: path.join(SKILL_DIR, 'container_tools/inspect_presentation_package_integrity.py'),
  layoutValidatorPath: path.join(SKILL_DIR, 'container_tools/inspect_presentation_layout_geometry.py'),
  layoutArgs: ['--expected-slide-size-emu', '12192000,6858000', '--validate-bullet-geometry', '--validate-heading-fit'],
  requiredNativeTableOwnerSlides: [],
  verifyArtifactToolImport: true,
  receiptPath: path.join(stagingDir, 'validation.json'),
});
console.log(JSON.stringify(result));
