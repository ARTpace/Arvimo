// 无扩展名文件的格式识别：读前 32 字节的魔数。
//
// 为什么需要：从浏览器 / 生成器 / 聊天工具存下来的图，常常叫
// 「1694414344978-2876151210-untoon,highly detailed,...」——文件名里没有 `.png`。
// 只看扩展名会把它们判成 other：缩略图接口回 415、卡片只能显示「缩略图加载失败」，
// 预览也拿不到正确的 Content-Type。这里按内容补一次判断，其余流程完全不变。
import fs from 'node:fs';
import path from 'node:path';
import {extensionOf, formatKind, formatMime} from '../src/library/format-registry.js';

/** 认得的位图魔数。够用即可：认不出的一律返回 ''，让调用方按「真不认识」处理。 */
export function sniffImageExtensionFromBuffer(buffer) {
  const b = buffer;
  if (!b || b.length < 4) return '';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  const ascii = (start, end) => b.subarray(start, end).toString('latin1');
  if (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'gif';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  // TIFF：II*\0 或 MM\0*
  if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) return 'tif';
  if (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a) return 'tif';
  // Photoshop：8BPS
  if (b.length >= 4 && ascii(0, 4) === '8BPS') return 'psd';
  // ISO-BMFF（avif / heic）：第 4-8 字节是 'ftyp'，品牌在 8-12。
  if (b.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12).trim();
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  return '';
}

/** 读文件头判格式；文件不存在 / 没权限就当不认识。 */
export function readHead(file, bytes = 32) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read);
  } catch { return null; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* 关闭失败不影响结果 */ } } }
}

/** 认得的 3D 模型头。只收「一眼能确定」的：glb / 二进制 FBX / ply；
 *  obj、stl、usd* 文件头没有唯一特征，认错比认不出更糟，直接返回 ''。 */
export function sniffModelExtensionFromBuffer(buffer) {
  const b = buffer;
  if (!b || b.length < 4) return '';
  const ascii = (start, end) => b.subarray(start, end).toString('latin1');
  if (ascii(0, 4) === 'glTF') return 'glb';
  if (ascii(0, 3) === 'ply') return 'ply';
  // 二进制 FBX：'Kaydara FBX Binary  \x00'；ASCII FBX 以 '; FBX 7.x project file' 开头。
  const head = ascii(0, Math.min(b.length, 20));
  if (head.startsWith('Kaydara FBX Binary')) return 'fbx';
  if (/^; FBX \d/.test(head)) return 'fbx';
  return '';
}

export function sniffModelExtension(file) {
  const head = readHead(file, 24);
  return head ? sniffModelExtensionFromBuffer(head) : '';
}

/** 图片优先、其次模型。给「导入时判不出格式」和「旧记录补格式」共用。 */
export function sniffAssetExtension(file) {
  return sniffAssetExtensionFromBuffer(readHead(file,64));
}

/** 读文件头判格式；文件不存在 / 没权限就当不认识。 */
export function sniffImageExtension(file) {
  const head = readHead(file, 32);
  return head ? sniffImageExtensionFromBuffer(head) : '';
}

/** 有扩展名就原样返回；没有才 sniff。返回「能喂给 format-registry 的文件名」。 */
export function sniffAssetExtensionFromBuffer(head) {
 const known=sniffImageExtensionFromBuffer(head)||sniffModelExtensionFromBuffer(head);
 if(known||!head)return known||'';
 const text=head.toString('latin1');
 if(text.startsWith('%PDF-'))return 'pdf';
 if(['PK\x03\x04','PK\x05\x06','PK\x07\x08'].some(magic=>text.startsWith(magic)))return 'zip';
 if(text.startsWith('RIFF')&&text.slice(8,12)==='WAVE')return 'wav';
 if(text.startsWith('fLaC'))return 'flac';
 if(text.startsWith('BLENDER'))return 'blend';
 if(text.startsWith('#?RADIANCE')||text.startsWith('#?RGBE'))return 'hdr';
 if(head.length>=4&&head.readUInt32LE(0)===20000630)return 'exr';
 return '';
}
/** Read dimensions from bounded headers, never decode the full panorama. */
export function imageDimensionsFromBuffer(head) {
 const type=sniffImageExtensionFromBuffer(head);
 if(type==='png'&&head.length>=24&&head.toString('ascii',12,16)==='IHDR')return {width:head.readUInt32BE(16),height:head.readUInt32BE(20)};
 if(type==='jpg'){
  let offset=2;
  while(offset+4<=head.length){
   if(head[offset++]!==255)break;
   while(head[offset]===255)offset++;
   const marker=head[offset++];
   if(marker===0xd9||marker===0xda)break;
   if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
   if(offset+2>head.length)break;
   const length=head.readUInt16BE(offset);if(length<2||offset+length>head.length)break;
   if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&length>=7)return {width:head.readUInt16BE(offset+5),height:head.readUInt16BE(offset+3)};
   offset+=length;
  }
 }
 return {};
}
/** A signature mismatch is evidence; absence of a signature is not proof of corruption. */
export function inspectAssetFormat(file) {
 const declared=extensionOf(String(file||''));
 const head=readHead(file,64);
 const detected=sniffAssetExtensionFromBuffer(head);
 const dimensions=imageDimensionsFromBuffer(detected==='jpg'?readHead(file,65536):head);
 const canonical=ext=>({jpeg:'jpg',jpe:'jpg',tiff:'tif'})[ext]||ext;
 // ZIP containers (Office, USDZ, etc.) retain their declared subtype until container parsing is available.
 const container=detected==='zip'&&['docx','xlsx','pptx','odt','ods','odp','usdz','3mf','blend'].includes(declared);
 return {...dimensions,declared,detected:container?'':detected,effective:container?declared:detected||declared,
  conflict:!!detected&&!container&&!!declared&&canonical(declared)!==canonical(detected),
  evidence:container?'container':detected?'header':'extension'};
}
export function effectiveFormatName(file) {
 const name=path.basename(String(file||''));
 const checked=inspectAssetFormat(file);
 return checked.effective?`${name}.${checked.effective}`:name;
}

/** 同上，但直接给 kind（'images' 等）。 */
export function effectiveKind(file) {
  return formatKind(effectiveFormatName(file));
}

/** 同上，但直接给 MIME；认不出仍是 application/octet-stream。 */
export function effectiveMime(file) {
  return formatMime(effectiveFormatName(file));
}
