// 落盘命名规则：只有这一份实现。
//
// 为什么必须共用：图片包目录名是「标题 + uid 前 8 位」。下载器、以及「只入库」写出的远程卡，
// 必须算出同一个目录名 —— 否则之后在远程卡上点「下载原图」，队列会认不出那张卡的目录，
// 在旁边另建一个 `标题 (1)`，同一个资产变成两张卡、两份内容。
//
// 规则本身很简单，但它是跨模块契约（下载器 / 远程卡 / 恢复扫描都依赖它），
// 所以单独放一个文件，而不是从一个模块里 export 给另一个模块顺手用。

/** 去掉文件系统不接受的字符，压到 100 字符，并把 uid 前 8 位缀在末尾保证可区分。
 *  keepUid=false 给已有可读身份（「标题 - 作者」）的交付用，避免尾巴上的乱码 hash。 */
export function cleanStem(name, uid, keepUid=true) {
  const raw = String(name || 'model');
  let stem = raw
    .replace(/\.zip$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/,'')
    .slice(0, 100) || 'model';
  if (keepUid && !stem.includes(uid.slice(0, 8))) stem += '-' + uid.slice(0, 8);
  return stem;
}

export function cleanFilename(name, uid, keepUid=true) {
  return cleanStem(name, uid, keepUid) + '.zip';
}

export function cleanFolderName(name, uid, keepUid=true) {
  return cleanStem(name, uid, keepUid);
}

/** 3D 模型平台的可读交付 stem：「标题 - 作者」。
 *  ArtStation 之外各平台由下载器统一用 j.name(标题) + j.author(作者) 生成，不带 uid/hash 尾巴。
 *  作者是平台名（Poly Haven / NVIDIA 等）也照带，跟 ArtStation 规则保持一致；标题已含作者时不重复。 */
export function assetStem(name, author) {
  const clean = s => String(s || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim();
  const title = clean(name).slice(0, 80) || '模型';
  const who = clean(author).slice(0, 60);
  return who && !title.toLowerCase().includes(who.toLowerCase()) ? `${title} - ${who}` : title;
}
