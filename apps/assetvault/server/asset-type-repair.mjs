import {hasEnvironmentHint,isPanoramicEnvironment} from '../src/library/asset-classification.js';
// 修一批老记录的「资产形态」。
//
// 早期拖入 / 导入的资产如果是**没有扩展名**的文件（生成器导出、浏览器另存，名字是一串
// hash + 提示词），入库时 `formatKind(name)` 只能判成 other：卡片写「打开文件」、点开被
// 甩给系统看图器，图打不开大图、模型进不了 3D 预览。缩略图后来按魔数补上了，但
// `assetType` 是**入库时写进记录**的，不改记录前端就一直按 other 处理。
//
// 这里按文件头把 ext / assetType 补回去。只处理「ext 为空 + 本机路径」的活跃资产，
// 跑第二遍自然就是空操作；认不出的（文件已离线 / 格式没见过）原样留着，不猜。
import {formatKind} from '../src/library/format-registry.js';
import {sniffAssetExtension,inspectAssetFormat} from './image-sniff.mjs';

export async function repairAssetTypes({storage, limit = 20000} = {}) {
  if (!storage) return {repaired: 0, scanned: 0};
  let rows;
  try { rows = await storage.withDb(conn => conn.all("SELECT uid, payload FROM assets WHERE state = 'active'")); }
  catch { return {repaired: 0, scanned: 0}; }
  if (!rows) return {repaired: 0, scanned: 0};

  const ops = [];
  let scanned = 0;
  for (const row of rows) {
    if (ops.length >= limit) break;
    let model;
    try { model = JSON.parse(row.payload); } catch { continue; }
    if(!model||model.platform!=='local'||!model.filePath)continue;
    if(model.ext&&!model.typeOverride&&['image','images','other'].includes(model.assetType)&&hasEnvironmentHint(model)){
      const formatCheck=inspectAssetFormat(model.filePath);
      if(isPanoramicEnvironment({...model,formatCheck})){
        scanned++;
        ops.push({op:'asset:patch',uid:row.uid,patch:{assetType:'env',formatCheck}});
      }
    }
    if(model.ext)continue;
    scanned += 1;
    const ext = sniffAssetExtension(model.filePath);
    if (!ext) continue;
    const kind = formatKind(`asset.${ext}`);
    if (!kind || kind === 'other') continue;
    // format 是筛选用的稳定字段，跟 ext 一起补；其余字段（路径、缩略图 URL）不用动，
    // 服务端本来就是按内容出图出 MIME 的。
    ops.push({op: 'asset:patch', uid: row.uid, patch: {ext, format: ext, assetType: kind}});
  }
  if (!ops.length) return {repaired: 0, scanned};

  try {
    const report = await storage.withDbWrite(conn => conn.applyAssetOps(ops, {actor: 'asset-type-repair'}));
    return {repaired: Number(report?.applied) || ops.length, scanned};
  } catch {
    return {repaired: 0, scanned};
  }
}
