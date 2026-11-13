// 资产库卡片 → 可拖出的文件清单。
//
// 卡片只给 uid：路径必须由服务端自己从「下载任务记录」或「磁盘扫描结果」里取 —— 前端给不出、
// 也不该给绝对路径，否则拖放端点就成了任意文件读取。
//
// 为什么不能直接把路径交出去：图片包的落盘是一层目录（`images/01-*.png` + `info.json`），
// CF_HDROP 把目录交给 Photoshop / PureRef 之后它们都不知道该拿它怎么办；摊成里面每一张图，
// 才等于「从资源管理器多选拖过去」。3D 导出包是单个 zip / glb，原样给，不能拆。
import path from 'node:path';
import {expandDragFiles} from './drag-stage.mjs';

/**
 * @param {object} options
 * @param {() => Array} options.jobs                      下载任务快照（含 uid / kind / state / filePath）
 * @param {() => string[]} options.roots                  资产库自己的扫描根（下载目录 + 各任务下载根）
 * @param {(roots: string[]) => Promise<Array>} [options.scanPackages] 扫描出的资产包（带 uid / root / rel）
 * @param {(target: string, options?: object) => Promise<string[]>} [options.expand] 注入，便于测试
 * @param {number} [options.maxItems]
 */
export function createAssetResolver({jobs = () => [], roots = () => [], scanPackages = null, expand = expandDragFiles, maxItems = 64, findAsset = null, resolveImported = null} = {}) {
  return async ({uid} = {}) => {
    const id = String(uid || '');
    if (!id) throw Error('缺少资产 ID');
    // 「已保存且文件还在」的任务才是可拖的；同一 uid 可能有多条（重下过），取最新的一条。
    const saved = jobs().filter(job => job && job.uid === id && job.state === 'saved' && job.filePath);
    const job = saved.findLast(item => item.fileExists !== false) || saved[saved.length - 1] || null;
    if (job) return job.kind === 'images' ? expand(job.filePath, {maxItems}) : [job.filePath];
    // 托管/链接导入不产生下载任务，按权威资产记录解析原件，不能降级成文本拖放。
    const imported = findAsset ? await findAsset(id) : null;
    if (imported?.filePath && resolveImported) {
      const file = await resolveImported(imported);
      const files = await expand(file, {maxItems});
      if (!files.length) throw Error('原文件不存在或已移动，请先重新定位');
      return files;
    }
    // 用户自己拷进来、只靠 info.json 登记的资产没有下载任务：按 uid 回到扫描结果里找它的目录，
    // 否则这类卡片在资产库里看得见、拖出去却提示「还没导出到本地」。
    const list = roots();
    if (list.length && scanPackages) {
      const pkg = (await scanPackages(list)).find(item => item.uid === id);
      if (pkg) return expand(path.join(pkg.root, ...String(pkg.rel || '').split('/').filter(Boolean)), {maxItems});
    }
    throw Error('这个资产还没导出到本地，先点下载再拖出');
  };
}
