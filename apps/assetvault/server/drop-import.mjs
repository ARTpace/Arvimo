// 外部文件 / 文件夹拖入入库。
//
// 浏览器只给 File 对象（没有绝对路径），「链接原文件」那套扫描根用不上，所以先把二进制
// 落到 dataDir/imports/drop-*/ 下，再复用 local-file-import.mjs 的 importFile(linked, skip)：
// 落盘这一份就是资产本体，不再复制第二遍，SHA256 去重 / 同名冲突 / 入库事务全都走现成逻辑。
//
// 流式写入而不是 Buffer.concat：用户拖进来的常是几百 MB 的模型/贴图，全攒内存会炸。
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';

const LIMIT = 512 * 1024 * 1024;
const reject = (message, status = 400) => Object.assign(Error(message), {status});

/** 相对路径清洗：保留文件夹层级，但摘掉 .. / 盘符 / 控制字符 / Windows 保留字符。 */
function safeRel(name) {
  const parts = String(name || '').replace(/\\/g, '/').split('/')
    .map(part => part.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^\.+/, '_').trim())
    .filter(part => part && part !== '.' && part !== '..');
  if (!parts.length) throw reject('文件名无效');
  if (parts.length > 8) throw reject('目录层级太深（最多 8 层）');
  return parts.map(part => part.slice(0, 80)).join('/');
}

export function createDropImporter({dataDir, importRoots, allowLocalRoot = () => {}, localImporter}) {
  const root = path.join(dataDir, 'imports');

  async function save({name, stream, size}) {
    const rel = safeRel(name);
    if (Number(size) > LIMIT) throw reject('单个文件超过 512 MB，请改用「导入文件夹」登记', 413);

    const token = randomBytes(8).toString('hex');
    const dir = path.join(root, `drop-${token}`);
    const target = path.join(dir, ...rel.split('/'));
    await fs.mkdir(path.dirname(target), {recursive: true});
    const part = `${target}.part`;
    const handle = await fs.open(part, 'w');
    let total = 0;
    try {
      for await (const chunk of stream) {
        total += chunk.length;
        if (total > LIMIT) throw reject('单个文件超过 512 MB', 413);
        await handle.write(chunk);
      }
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.rm(dir, {recursive: true, force: true}).catch(() => {});
      throw error;
    }
    await handle.close();
    if (!total) {
      await fs.rm(dir, {recursive: true, force: true}).catch(() => {});
      throw reject('文件是空的');
    }
    // 原子改名：扫描器 / 缩略图接口不会读到写了一半的文件。
    await fs.rename(part, target);

    try {
      // importFile 的 validateSource 要求源目录是已登记的扫描根；imports 本身也是
      // 「托管副本」模式用的目录，两个入口共用同一个根，不额外造一份。
      importRoots.add(root);
      allowLocalRoot(root);
      const result = await localImporter.importFile({
        folder: root, rel: `drop-${token}/${rel}`,
        mode: 'linked', duplicate: 'skip', nameConflict: 'keep-both',
      });
      // 同内容重复被跳过时 asset 指向旧文件，这份新落盘的副本是多余的，清掉免得堆垃圾。
      if (result.status === 'skipped') await fs.rm(dir, {recursive: true, force: true}).catch(() => {});
      return {ok: true, uid: result.asset?.uid, name: rel, status: result.status, bytes: total};
    } catch (error) {
      await fs.rm(dir, {recursive: true, force: true}).catch(() => {});
      throw error;
    }
  }

  return {save};
}
