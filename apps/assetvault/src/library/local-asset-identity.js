// M2 预检契约 v1：纯计算，不读取磁盘、不改包清单、不应用迁移。
// 32hex 与下载协议保持原样；local- 映射仅是收藏键，不替换资产 UID。
import {pictureSiteJobUid} from './platforms.js';

export const LOCAL_IDENTITY_VERSION = 1;
const ONLINE_UID = /^[a-f0-9]{32}$/i;
const LOCAL_UID = /^local-[a-f0-9]{32}$/;

/** 与现有 local-files/favorite-targets 的路径回退逐字节一致，不归一化路径。 */
export function legacyPackageFavoriteUid(pkg = {}) {
  return pictureSiteJobUid('package', `${pkg.root}|${pkg.rel}`);
}

/** 无效/缺失固定 UID 仍按旧路径回退；不根据名字、大小或摘要猜身份。 */
export function packageFavoriteIdentity(pkg = {}) {
  const uid = typeof pkg.uid === 'string' ? pkg.uid : '';
  const legacyUid = legacyPackageFavoriteUid(pkg);
  if (ONLINE_UID.test(uid)) {
    return {assetUid: uid, favoriteUid: uid, legacyUid: uid, stable: true, kind: 'online'};
  }
  if (LOCAL_UID.test(uid)) {
    return {assetUid: uid, favoriteUid: pictureSiteJobUid('assetvault-local-favorite-v1', uid), legacyUid, stable: true, kind: 'local'};
  }
  return {assetUid: '', favoriteUid: legacyUid, legacyUid, stable: false, kind: 'legacy-path'};
}

/**
 * @param {{packages?: object[], favorites?: string[]|Set<string>}} input
 * @returns {{version:number, identities:object[], aliases:object[], migrations:object[], conflicts:object[], unresolved:object[], proposedFavorites:string[]}}
 *
 * packages 仅代表调用方提供的当前扫描快照，不构造未知旧路径映射。
 * identities 保留每个输入包（含重复包），冲突组不生成 alias 或迁移。
 * aliases 是已知且无歧义的回退关系；migrations 仅列本次收藏确需变更项。
 * proposedFavorites 只是预览，不是提交指令；旧键以 aliases/migrations 留作回退依据。
 * 同一快照重复预检结果确定；对 proposedFavorites 再预检不产生重复迁移。
 * 该小型散列不是内容摘要、认证凭据或唯一性证明，键碰撞也必须显式阻断。
 */
export function preflightLocalFavoriteMigration({packages = [], favorites = []} = {}) {
  const identities = packages.map((pkg, index) => ({index, root: pkg.root, rel: pkg.rel, ...packageFavoriteIdentity(pkg)}));
  const conflicts = [];
  const blocked = new Set();
  const groups = new Map();
  const add = (key, item) => {
    const group = groups.get(key) || [];
    group.push(item); groups.set(key, group);
  };
  for (const item of identities) if (item.stable) add(`asset:${item.assetUid}`, item);
  for (const [key, items] of groups) {
    if (items.length < 2) continue;
    items.forEach(item => blocked.add(item.index));
    conflicts.push({code: 'duplicate-fixed-uid', assetUid: key.slice(6), indexes: items.map(item => item.index)});
  }
  // 目标键碰撞、旧键指向不同资产、旧键碰到另一资产的目标键均不能静默吞收藏。
  const keys = new Map();
  for (const item of identities) {
    for (const key of new Set([item.favoriteUid, item.legacyUid])) {
      const group = keys.get(key) || [];
      group.push(item); keys.set(key, group);
    }
  }
  for (const [key, items] of keys) {
    if (items.length < 2) continue;
    items.forEach(item => blocked.add(item.index));
    conflicts.push({code: 'ambiguous-favorite-key', favoriteUid: key, indexes: items.map(item => item.index)});
  }
  const aliases = identities.filter(item => !blocked.has(item.index) && item.stable && item.favoriteUid !== item.legacyUid)
    .map(item => ({from: item.legacyUid, to: item.favoriteUid, assetUid: item.assetUid, index: item.index}));
  const aliasMap = new Map(aliases.map(alias => [alias.from, alias]));
  const blockedKeys = new Set(identities.filter(item => blocked.has(item.index)).flatMap(item => [item.favoriteUid, item.legacyUid]));
  const knownKeys = new Set(identities.filter(item => !blocked.has(item.index)).flatMap(item => [item.favoriteUid, item.legacyUid]));
  const migrations = [], unresolved = [], proposed = new Set();
  for (const uid of new Set(favorites)) {
    if (blockedKeys.has(uid)) {
      unresolved.push({uid, reason: 'conflict'}); proposed.add(uid); continue;
    }
    const alias = aliasMap.get(uid);
    if (alias) {migrations.push({...alias}); proposed.add(alias.to);}
    else {
      proposed.add(uid);
      if (!knownKeys.has(uid)) unresolved.push({uid, reason: 'unknown-association'});
    }
  }
  return {version: LOCAL_IDENTITY_VERSION, identities, aliases, migrations, conflicts, unresolved, proposedFavorites: [...proposed]};
}
