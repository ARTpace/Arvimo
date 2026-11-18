// 外部文件 / 文件夹拖入入库。
//
// 浏览器只给 File 对象（没有绝对路径），「链接原文件」那套扫描根用不上，所以先把二进制
// 落到 dataDir/imports/分组/子类型/ 下（asset-folders.mjs 统一分类），再复用
// local-file-import.mjs 的 importFile(linked, skip)：落盘这一份就是资产本体，不再复制第二遍，
// SHA256 去重 / 同名冲突 / 入库事务全都走现成逻辑。
//
// 流式写入而不是 Buffer.concat：用户拖进来的常是几百 MB 的模型/贴图，全攒内存会炸。
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes, createHash} from 'node:crypto';
import {assetFolder, uniqueTarget, pruneEmptyDirs} from './asset-folders.mjs';

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

export function createDropImporter({dataDir, archiveRoot, importRoots, allowLocalRoot = () => {}, localImporter}) {
  // 落点 = 资产根（与平台下载同一个目录），旧版落在 dataDir/imports 里的老副本仍由扫描排除规则管。
  const root = path.resolve(archiveRoot || path.join(dataDir, 'imports'));

  // 图集模式：拖进来的整包图（一个文件夹 70 张 alpha）不该变成 70 张卡片。
  // 这批文件落进 `<分组>/<子类型>/<图集名>/`，收尾时写一份 info.json —— 扫描据此认成
  // 「一个包 = 一张卡」，点开在里面翻图集。状态只活在这一批里，flush/abort 就清掉。
  const albums = new Map();
  const albumKey = (batch, album) => `${batch}|${album}`;
  function albumState(batch, album, dir, ext) {
    const key = albumKey(batch, album);
    let state = albums.get(key);
    if (!state) {
      const storedRel = path.relative(root, dir).split(path.sep).join('/');
      // uid 必须稳定：同一图集重复导入时扫描认到的还是同一个资产，不会每次多出一条。
      const uid = createHash('sha1').update(`album:${storedRel}`).digest('hex').slice(0, 32);
      state = {batch, title: album, dir, rel: storedRel, uid, files: 0, bytes: 0, ext, paths: []};
      albums.set(key, state);
    }
    return state;
  }

  async function save({name, stream, size, batch, album = '', canvasBoard = ''}) {
    const rel = safeRel(name);
    // 保留图集相对层级，避免不同父目录下的同名图集合并。
    const albumName = album ? safeRel(album) : '';
    if (Number(size) > LIMIT) throw reject('单个文件超过 512 MB，请改用「导入文件夹」登记', 413);

    // 统一物理层级：imports/分组/子类型/文件名（asset-folders.mjs 是唯一真相源）。
    // 去掉旧的日期层与原文件夹层级；按文件名判定类型，同名靠 uniqueTarget 加 (2)/(3) 不覆盖。
    const token = randomBytes(8).toString('hex');
    const ext = (path.extname(path.posix.basename(rel)).slice(1) || 'png').toLowerCase();
    // 图集模式：整批文件进同一个图集目录。分类锚点固定用 album.png —— 按「每个文件自己的
    // 扩展名」分类会把 EXR/HDR 判成 HDRI、PSD 判成图片，一个图集散进两个分类目录，
    // 清单目录里就少文件。图集就是一个整体，统一落「图片/其他图片/<图集名>」。
    const dir = albumName
      ? path.join(root, assetFolder({filename: 'album.png'}), safeRel(albumName))
      : canvasBoard
        ? path.join(root, '画布导入', createHash('sha256').update(String(canvasBoard)).digest('hex').slice(0, 24))
        : path.join(root, assetFolder({filename: path.posix.basename(rel)}));
    await fs.mkdir(dir, {recursive: true});
    let target = await uniqueTarget(path.join(dir, path.posix.basename(rel)));
    const part = `${target}.${token}.part`;
    // 分类目录是多个批次共用的，不能整目录删 —— 只收自己这一份，再顺手收掉空目录。
    const discard = async () => {
      await fs.rm(part, {force: true}).catch(() => {});
      await fs.rm(target, {force: true}).catch(() => {});
      await pruneEmptyDirs(path.dirname(target), root);
    };
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
      await discard();
      throw error;
    }
    await handle.close();
    if (!total) {
      await discard();
      throw reject('文件是空的');
    }
    // 原子改名：扫描器 / 缩略图接口不会读到写了一半的文件。
    try { await fs.rename(part, target); }
    catch (error) {
      // 4 路并发拖入同名文件时，另一个请求可能刚好先占了这个名字：换个序号再改名。
      const retry = await uniqueTarget(target);
      if (retry === target) throw error;
      await fs.rename(part, retry);
      target = retry;
    }
    const storedRel = path.relative(root, target).split(path.sep).join('/');

    if (albumName) {
      // 图集模式不逐张建资产记录：资产是「整个目录」，收尾时写 info.json 由扫描认成一张卡。
      // 每张图单独入库正是用户抱怨的「一个包炸成 70 张卡」。
      const state = albumState(batch, albumName, dir, ext);
      state.files += 1;
      state.bytes += total;
      state.paths.push(target);
      return {ok: true, uid: state.uid, name: storedRel, status: 'packed', bytes: total, asset: null};
    }

    try {
      // importFile 的 validateSource 要求源目录是已登记的扫描根；imports 本身也是
      // 「托管副本」模式用的目录，两个入口共用同一个根，不额外造一份。
      importRoots.add(root);
      allowLocalRoot(root);
      const result = await localImporter.importFile({
        folder: root, rel: storedRel,
        mode: 'linked', duplicate: 'skip', nameConflict: 'keep-both', batch,
        // 这份副本是本管道刚写的，批次报废时归我们删；用户原文件不归我们管。
        ownedCopy: true,
      });
      // 同内容重复被跳过时 asset 指向旧文件，这份新落盘的副本是多余的，清掉免得堆垃圾。
      // staged（批量待入库）不能删：它本身就是资产本体，要等 flush 提交后才算数。
      if (result.status === 'skipped') await discard();
      const asset=result.asset;
      return {ok: true, uid: asset?.uid, name: storedRel, status: result.status, bytes: total,
        asset:asset?{uid:asset.uid,url:asset.url,thumbnail:asset.thumbnail,name:asset.name,bytes:asset.bytes,ext:asset.ext}:null};
    } catch (error) {
      await discard();
      throw error;
    }
  }

  /** 收尾：先把图集清单写盘（扫描据此认成一张卡），再走原有的批量入库。 */
  async function flush(batch) {
    const mine = [...albums.values()].filter(item => item.batch === batch);
    for (const item of mine) {
      const manifest = path.join(item.dir, 'info.json');
      // 同名图集重复导入时是「追加」而不是覆盖：数量与体积累加，uid 沿用上次那份，
      // 否则同一目录每次导入都在库里换一个身份，标签和画板归属全丢。
      let old = {};
      try { old = JSON.parse(await fs.readFile(manifest, 'utf8')) || {}; } catch {}
      const info = {
        schema: 1,
        uid: typeof old.uid === 'string' && old.uid ? old.uid : item.uid,
        title: String(old.title || path.posix.basename(item.title)),
        sourceFolder: item.title,
        kind: 'images',
        assetType: 'image',
        fileCount: (Number(old.fileCount) || 0) + item.files,
        bytes: (Number(old.bytes) || 0) + item.bytes,
        addedAt: Number(old.addedAt) || Date.now(),
        platform: 'local',
        source: 'drop-import',
      };
      await fs.writeFile(manifest, JSON.stringify(info, null, 2), 'utf8');
      albums.delete(albumKey(batch, item.title));
    }
    // 写完清单立刻"定住"目录树：Windows 对刚创建/刚写入的目录有枚举延迟（实测 readdir
    // 会短暂漏掉新目录），紧跟着的前端重扫就会扑空，卡片不出现 —— 用户看到的就是
    // 「合并成图集了但库里什么都没有」。反复读父目录直到能看见图集、读图集直到能
    // 看见清单和全部文件，超时也不报错（下次手动扫描还能补上）。
    for (const item of mine) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          const [siblings, inside] = await Promise.all([
            fs.readdir(path.dirname(item.dir)),
            fs.readdir(item.dir),
          ]);
          const listed = siblings.includes(path.basename(item.dir))
            && inside.includes('info.json')
            && inside.filter(name => name.toLowerCase() !== 'info.json').length >= item.files;
          if (listed) break;
        } catch { /* 目录暂时读不到就重试 */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const result = await localImporter.flushBatch(batch);
    return mine.length
      ? {...result, albums: mine.map(item => ({uid: item.uid, name: item.title, dir: item.rel, files: item.files}))}
      : result;
  }

  /** 放弃这批：只删本批写进图集目录的文件，不碰同名图集里上次导入的内容。 */
  async function abort(batch) {
    const mine = [...albums.values()].filter(item => item.batch === batch);
    for (const item of mine) {
      for (const file of item.paths || []) await fs.rm(file, {force: true}).catch(() => {});
      await pruneEmptyDirs(item.dir, root).catch(() => {});
      albums.delete(albumKey(batch, item.title));
    }
    return localImporter.abortBatch(batch);
  }

  return {save, flush, abort};
}
