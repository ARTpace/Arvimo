// Minimal binary-FBX reader: just enough of the container to answer one question with certainty —
// which image file does each material's texture actually resolve to?
//
// Blender writes FBX 7400 (32-bit offsets) by default; 7500 and up use 64-bit offsets.
// Property arrays (f/d/l/i/b) are skipped: the wiring lives in strings and in Connections.

const HEADER = 'Kaydara FBX Binary  ';

function readProperty(buffer, offset) {
  const kind = String.fromCharCode(buffer[offset]);
  offset += 1;
  switch (kind) {
    case 'Y':
      return [buffer.readInt16LE(offset), offset + 2];
    case 'C':
      return [buffer[offset] !== 0, offset + 1];
    case 'I':
      return [buffer.readInt32LE(offset), offset + 4];
    case 'F':
      return [buffer.readFloatLE(offset), offset + 4];
    case 'D':
      return [buffer.readDoubleLE(offset), offset + 8];
    case 'L':
      return [Number(buffer.readBigInt64LE(offset)), offset + 8];
    case 'S': {
      const length = buffer.readUInt32LE(offset);
      offset += 4;
      return [buffer.toString('utf8', offset, offset + length), offset + length];
    }
    case 'R': {
      const length = buffer.readUInt32LE(offset);
      offset += 4;
      return [buffer.subarray(offset, offset + length), offset + length];
    }
    default: {
      if (!'fdlib'.includes(kind)) throw new Error(`unknown FBX property type ${kind} at ${offset - 1}`);
      return [null, offset + 12 + buffer.readUInt32LE(offset + 8)];
    }
  }
}

function readNode(buffer, offset, wide) {
  const head = wide ? 24 : 12;
  const endOffset = wide ? Number(buffer.readBigUInt64LE(offset)) : buffer.readUInt32LE(offset);
  if (endOffset === 0) return [null, offset + head];
  const count = wide ? Number(buffer.readBigUInt64LE(offset + 8)) : buffer.readUInt32LE(offset + 4);
  let cursor = offset + head;
  const nameLength = buffer[cursor];
  cursor += 1;
  const name = buffer.toString('utf8', cursor, cursor + nameLength);
  cursor += nameLength;
  const props = [];
  for (let index = 0; index < count; index += 1) {
    const [value, next] = readProperty(buffer, cursor);
    props.push(value);
    cursor = next;
  }
  const children = [];
  while (cursor < endOffset) {
    const [child, next] = readNode(buffer, cursor, wide);
    if (!child) break;
    children.push(child);
    cursor = next;
  }
  return [{ name, props, children }, endOffset];
}

/** blenders writes 'Name\\x00\\x01Kind'; the kind is the tail, not a separate property. */
function splitName(raw) {
  if (typeof raw !== 'string') return ['', ''];
  const index = raw.lastIndexOf('\x00\x01');
  return index === -1 ? [raw, ''] : [raw.slice(0, index), raw.slice(index + 2)];
}

function childString(node, name) {
  const child = node.children.find(entry => entry.name === name && typeof entry.props[0] === 'string');
  return child ? child.props[0] : '';
}

function childBytes(node, name) {
  const child = node.children.find(entry => entry.name === name && Buffer.isBuffer(entry.props[0]));
  return child ? child.props[0].length : 0;
}

/**
 * @returns {{version:number,materials:Array,textures:Array,videos:Array}} media wiring,
 *   with each texture carrying its material, property (FBX slot) and resolved image name.
 */
export function readFbxMedia(buffer) {
  if (buffer.toString('latin1', 0, 20) !== HEADER) throw new Error('不是二进制 FBX');
  const version = buffer.readUInt32LE(23);
  const wide = version >= 7500;

  const top = [];
  let cursor = 27;
  while (cursor < buffer.length) {
    const [node, next] = readNode(buffer, cursor, wide);
    if (!node) break;
    top.push(node);
    cursor = next;
  }

  const objects = top.find(node => node.name === 'Objects') || { children: [] };
  const connections = top.find(node => node.name === 'Connections') || { children: [] };

  const videos = new Map();
  const textures = new Map();
  const materials = new Map();

  for (const node of objects.children) {
    if (node.props.length < 2) continue;
    const id = node.props[0];
    const [name, kind] = splitName(node.props[1]);
    if (kind === 'Video') {
      videos.set(id, {
        id,
        name,
        relativeFilename: childString(node, 'RelativeFilename'),
        filename: childString(node, 'Filename'),
        contentBytes: childBytes(node, 'Content'),
      });
    } else if (kind === 'Texture') {
      textures.set(id, { id, name, material: null, property: null, video: null });
    } else if (kind === 'Material') {
      materials.set(id, { id, name, textures: [] });
    }
  }

  for (const connection of connections.children) {
    const [kind, childId, parentId, property] = connection.props;
    if (typeof childId !== 'number' || typeof parentId !== 'number') continue;
    if (String(kind).startsWith('OO')) {
      if (videos.has(childId) && textures.has(parentId)) textures.get(parentId).video = childId;
    } else if (textures.has(childId) && materials.has(parentId)) {
      const slot = typeof property === 'string' ? property.split('\x00')[0] : '';
      textures.get(childId).material = parentId;
      textures.get(childId).property = slot;
      materials.get(parentId).textures.push({ property: slot, texture: textures.get(childId) });
    }
  }

  for (const texture of textures.values()) {
    const video = videos.get(texture.video);
    texture.image = video ? video.relativeFilename || video.filename : '';
    texture.contentBytes = video ? video.contentBytes : 0;
  }

  return { version, materials: [...materials.values()], textures: [...textures.values()], videos: [...videos.values()] };
}

/** Every texture a material slot points at, as `{material, property, image, contentBytes}`. */
export function fbxTextureBindings(buffer) {
  const media = readFbxMedia(buffer);
  return media.materials.flatMap(material =>
    material.textures.map(slot => ({
      material: material.name,
      property: slot.property,
      image: slot.texture.image,
      contentBytes: slot.texture.contentBytes,
    }))
  );
}
