// Builds a tiny two-material GLB on disk. The textures are embedded in the binary chunk exactly
// like a Sketchfab/ArtStation download, which is the shape that used to break FBX material wiring.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** A solid-colour RGB PNG, just big enough that nothing treats it as a degenerate image. */
function solidPng(size, [red, green, blue]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x += 1) {
    row[1 + x * 3] = red;
    row[2 + x * 3] = green;
    row[3 + x * 3] = blue;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function padTo(buffer, alignment, filler) {
  const remainder = buffer.length % alignment;
  return remainder === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(alignment - remainder, filler)]);
}

function buildGlb(json, bin) {
  const jsonChunk = padTo(Buffer.from(JSON.stringify(json), 'utf8'), 4, 0x20);
  const binChunk = padTo(bin, 4, 0x00);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4); // 'BIN\0'
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}

/**
 * A two-material GLB whose materials use two different embedded textures, as bytes.
 * @returns {Buffer}
 */
export function twoMaterialGlb() {
  const images = ['body_diff.png', 'cloth_diff.png'];
  const chunks = [];
  let cursor = 0;
  const append = (buffer, alignment = 4) => {
    const start = cursor;
    chunks.push(buffer);
    cursor += buffer.length;
    const pad = (alignment - (cursor % alignment)) % alignment;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      cursor += pad;
    }
    return { byteOffset: start, byteLength: buffer.length };
  };

  const views = [
    append(solidPng(4, [200, 60, 60])),
    append(solidPng(4, [60, 90, 200])),
    append(Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer)),
    append(Buffer.from(new Float32Array([0, 0, 1, 0, 0, 1]).buffer)),
    append(Buffer.from(new Uint16Array([0, 1, 2]).buffer)),
  ];
  const bin = Buffer.concat(chunks);

  const json = {
    asset: { version: '2.0', generator: 'assetvault-test-fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'prop', mesh: 0 }],
    meshes: [
      {
        name: 'prop',
        primitives: [
          { attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 },
          { attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 1 },
        ],
      },
    ],
    materials: [
      { name: 'body', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } },
      { name: 'cloth', pbrMetallicRoughness: { baseColorTexture: { index: 1 }, metallicFactor: 0, roughnessFactor: 1 } },
    ],
    textures: [
      { sampler: 0, source: 0 },
      { sampler: 0, source: 1 },
    ],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    images: [
      { name: images[0], bufferView: 0, mimeType: 'image/png' },
      { name: images[1], bufferView: 1, mimeType: 'image/png' },
    ],
    accessors: [
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 3, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 4, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: views.map((view, index) => ({
      buffer: 0,
      byteOffset: view.byteOffset,
      byteLength: view.byteLength,
      ...(index < 2 ? {} : { target: index === 4 ? 34963 : 34962 }),
    })),
    buffers: [{ byteLength: bin.length }],
  };

  return buildGlb(json, bin);
}

/**
 * Write that GLB to disk.
 * @returns {Promise<{glb:string,images:[string,string]}>}
 */
export async function writeTwoMaterialGlb(dir, name = 'two-materials') {
  const glb = path.join(dir, `${name}.glb`);
  await fs.writeFile(glb, twoMaterialGlb());
  return { glb, images: ['body_diff.png', 'cloth_diff.png'] };
}