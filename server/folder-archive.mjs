import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inspectGlb,inspectImage,declaredImages,declaredTextures,declaredSbsar,assertSbsar,isSbsarMaterial,IMAGE_PREFIX_BYTES} from './archive.mjs';
import {zipEntries,writeZipFiles} from './zip-writer.mjs';

const MAX = 2 * 1024 ** 3;
const GLB_PREFIX = 32 * 1024 ** 2;

/** Every regular file under `dir`, as `/`-joined relative paths, sorted for stable output. */
async function collect(dir, signal, maxBytes=MAX) {
  const files = [];
  let total = 0;
  const walk = async (current, prefix) => {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      signal?.throwIfAborted();
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { await walk(full, relative); continue; }
      // Symlinks and devices have no defined meaning in an export; only real files ship.
      if (!entry.isFile()) throw Error(`导出目录包含非普通文件：${relative}`);
      const size = (await fsp.stat(full)).size;
      total += size;
      if (total > maxBytes) throw Error(`导出内容超过 ${Math.round(maxBytes/1024**2)}MB 打包限制，请在主机上取回文件或选择 ZIP 格式重新导出`);
      files.push({ relative, full, size });
    }
  };
  await walk(dir, '');
  if (!files.length) throw Error('导出目录是空的');
  return { files: files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0)), total };
}

/** The GLB inside a staged export; FBX conversion needs exactly one of these. */
export async function findStagedGlb(dir) {
  let found = null;
  const walk = async current => {
    if (found) return;
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      if (found) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.glb$/i.test(entry.name)) found = full;
    }
  };
  await walk(dir);
  if (!found) throw Error('导出内容里没有 GLB，无法转换 FBX');
  return found;
}

/**
 * Pack a finished staging folder as a ZIP. Only used for the "FBX + ZIP" combination: the FBX
 * step needs loose files on disk first, so the archive is built once the conversion is done.
 */
export async function packFolder(dir, destination, { signal, maxBytes=MAX } = {}) {
  const { files, total } = await collect(dir, signal, maxBytes);
  const entries = [];
  for (const file of files) {
    signal?.throwIfAborted();
    entries.push({ name: file.relative, data: await fsp.readFile(file.full) });
  }
  await fsp.writeFile(destination, zipEntries(entries));
  return { bytes: total, entries: entries.length };
}

export async function packFolderDownload(dir,destination,{signal}={}){
 const {files,total}=await collect(dir,signal);
 await writeZipFiles(destination,files,{signal});
 return {bytes:total,entries:files.length};
}

async function readPrefix(file, length) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Folder delivery skips the ZIP, so there is no central directory to validate. The same
 * guarantees are checked against the tree instead: info.json still has to prove provenance
 * against the job's uid, and at least one .glb still has to be a real glTF 2.0 mesh. The
 * SHA-256 covers relative paths as well as contents, so it changes when a file is added,
 * removed, renamed or edited — the same "did the payload change?" question the ZIP hash answers.
 */
export async function verifyFolder(dir, { uid, signal } = {}) {
  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat || !stat.isDirectory()) throw Error('导出目录不存在');

  const { files, total } = await collect(dir, signal);

  const infoFile = files.find(f => f.relative === 'info.json');
  if (!infoFile) throw Error('缺少 info.json，无法确认模型来源');
  if (infoFile.size > 1024 * 1024) throw Error('模型说明过大');
  const info = JSON.parse(await fsp.readFile(infoFile.full, 'utf8'));
  if (uid && info.uid !== uid) throw Error('模型来源信息不匹配');

  const glbs = [];
  for (const file of files.filter(f => f.relative.toLowerCase().endsWith('.glb'))) {
    const prefix = await readPrefix(file.full, Math.min(file.size, GLB_PREFIX));
    glbs.push(inspectGlb(prefix, file.relative, file.size));
  }
  // Image bundles declare their own payload; the declaration is the provenance, so it has to agree
  // with the tree in both directions (missing = truncated, unlisted = unvouched content). Material
  // bundles follow the same rule for their PBR maps under `textures/`. The same rule the ZIP
  // verifier applies, so folder and archive delivery accept exactly the same bundles.
  let images = null, textures = null;
  if (info.kind === 'images') {
    const declared = declaredImages(info);
    const present = files.filter(f => /^images\/[^/]+$/.test(f.relative));
    for (const item of declared) if (!files.some(f => f.relative === item.file)) throw Error(`导出目录里缺少已登记的作品图片：${item.file}`);
    for (const file of present) if (!declared.some(item => item.file === file.relative)) throw Error(`导出目录里有未登记的作品图片：${file.relative}`);
    images = [];
    for (const file of present) {
      signal?.throwIfAborted();
      const prefix = await readPrefix(file.full, Math.min(file.size, IMAGE_PREFIX_BYTES));
      images.push(inspectImage(prefix, file.relative, file.size));
    }
    if (!images.length) throw Error('导出目录里没有作品图片');
  } else if (isSbsarMaterial(info)) {
    const file = declaredSbsar(info);
    const present = files.find(f => f.relative === file);
    if (!present) throw Error(`导出目录里缺少已登记的 Substance 文件：${file}`);
    const prefix = await readPrefix(present.full, Math.min(present.size, 16));
    assertSbsar(prefix, file);
    textures = [];
  } else if (info.kind === 'material') {
    const declared = declaredTextures(info);
    const present = files.filter(f => /^textures\/[^/]+$/.test(f.relative));
    for (const item of declared) if (!files.some(f => f.relative === item.file)) throw Error(`导出目录里缺少已登记的材质贴图：${item.file}`);
    for (const file of present) if (!declared.some(item => item.file === file.relative)) throw Error(`导出目录里有未登记的材质贴图：${file.relative}`);
    textures = [];
    for (const file of present) {
      signal?.throwIfAborted();
      const prefix = await readPrefix(file.full, Math.min(file.size, IMAGE_PREFIX_BYTES));
      textures.push(inspectImage(prefix, file.relative, file.size));
    }
    if (!textures.length) throw Error('导出目录里没有材质贴图');
  } else if (info.kind === 'hdri' || info.kind === 'pack') {
    const declared = Array.isArray(info.files) ? info.files : [];
    if (!declared.length) throw Error('导出目录里没有登记的文件');
    for (const item of declared) if (!files.some(f => f.relative === item.file)) throw Error(`导出目录里缺少已登记的文件：${item.file}`);
  } else if (info.platform === 'polyhaven') {
    const mesh = files.filter(f => /\.(?:fbx|gltf|glb|blend|usdc|usd)$/i.test(f.relative));
    if (!mesh.length) throw Error('导出目录里没有 Poly Haven 的模型文件');
    for(const item of info.files||[]){const file=files.find(f=>f.relative===item.file);if(!file||file.size!==item.bytes)throw Error(`Poly Haven 文件缺失或不完整：${item.file}`);}
  } else if (!glbs.length) throw Error('缺少有效 GLB');

  const digest = createHash('sha256');
  for (const file of files) {
    signal?.throwIfAborted();
    digest.update(file.relative);
    digest.update('\0');
    for await (const chunk of fs.createReadStream(file.full, { signal })) digest.update(chunk);
  }
  return {
    bytes: total,
    info,
    entries: files.length,
    glbs,
    images,
    textures,
    warning: files.some(f => f.relative === 'MISSING_BLIT.txt'),
    author: String(info.author || ''),
    source: String(info.source_url || ''),
    sha256: digest.digest('hex'),
    verifiedAt: Date.now(),
    folder: true,
  };
}
