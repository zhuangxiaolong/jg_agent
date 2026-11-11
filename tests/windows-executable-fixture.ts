export function windowsX64Fixture(): Buffer {
  const content = Buffer.alloc(1024);
  content.writeUInt16LE(0x5a4d, 0);
  content.writeUInt32LE(0x80, 0x3c);
  content.writeUInt32LE(0x00004550, 0x80);
  content.writeUInt16LE(0x8664, 0x84);
  content.writeUInt16LE(1, 0x86);
  content.writeUInt16LE(240, 0x94);
  content.writeUInt16LE(0x20b, 0x98);
  content.writeUInt32LE(512, 0x98 + 60);
  content.writeUInt32LE(512, 0x188 + 16);
  content.writeUInt32LE(512, 0x188 + 20);
  return content;
}
