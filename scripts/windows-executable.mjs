/** 拒绝被截断或架构不符的 Windows x64 可执行文件，避免只按现有文件生成哈希后误判为完整。 */
export function validateWindowsX64Executable(content) {
  const invalid = detail => { throw new Error(`Windows x64 可执行文件无效：${detail}`); };
  if (content.length < 64 || content.readUInt16LE(0) !== 0x5a4d) invalid('缺少 MZ 头');
  const peOffset = content.readUInt32LE(0x3c);
  if (peOffset > content.length - 24 || content.readUInt32LE(peOffset) !== 0x00004550) invalid('缺少 PE 头');
  if (content.readUInt16LE(peOffset + 4) !== 0x8664) invalid('不是 Windows x64 架构');
  const sectionCount = content.readUInt16LE(peOffset + 6);
  const optionalSize = content.readUInt16LE(peOffset + 20);
  const optionalOffset = peOffset + 24;
  const sectionOffset = optionalOffset + optionalSize;
  if (optionalSize < 112 || sectionOffset > content.length || content.readUInt16LE(optionalOffset) !== 0x20b) invalid('PE32+ 可选头缺失或被截断');
  if (sectionCount === 0 || sectionCount > 96 || sectionOffset + sectionCount * 40 > content.length) invalid('节表缺失或被截断');
  const headerSize = content.readUInt32LE(optionalOffset + 60);
  if (headerSize < sectionOffset + sectionCount * 40 || headerSize > content.length) invalid('文件头大小超出实际文件');
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionOffset + index * 40;
    const rawSize = content.readUInt32LE(offset + 16);
    const rawOffset = content.readUInt32LE(offset + 20);
    if (rawSize && (rawOffset < headerSize || rawOffset + rawSize > content.length)) invalid(`第 ${index + 1} 节超出实际文件，文件可能被截断`);
  }
  return { machine: 'x64', sectionCount, byteLength: content.length };
}
