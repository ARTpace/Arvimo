// 词表的纯函数层：value → 面、别名 → value、value → 子孙。
// 无 IO、无第三方依赖、无副作用 —— 数据库与前端都能测同一份行为。
//
// 关键纪律：**面由词表决定，不由写标签的一方决定**。
// AI 只输出「木材」这个值，面是词表查到 material + subject 两条边；
// 这样换模型、换 prompt 都不会让体系漂移。
import {FACETS, TERMS} from './library-vocab.seed.mjs';

/**
 * 与 SQLite BINARY collation 对齐的比较：UTF-8 的字节序 == 码点序。
 * 检索文本在 SQL 与内存两条路径上都要拼成**同一个字符串**，顺序不一致就可能出现
 * 「同一个查询在一边命中、另一边落空」，所以两边必须用同一套排序规则。
 */
export function compareBinary(a, b) {
  const left = Array.from(String(a ?? ''));
  const right = Array.from(String(b ?? ''));
  const len = Math.min(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const x = left[i].codePointAt(0);
    const y = right[i].codePointAt(0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length - right.length;
}

/**
 * 归一化键：NFKC 消除全角/半角差异，压掉连续空白，转小写。
 * 只用于比较，绝不用于显示 —— 显示永远用词条的 canonical value。
 */
export function normOf(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/** 把种子编译成索引。别名与 canonical 撞名、父级不存在这类脏数据只跳过不抛，由 validateVocab 报出来。 */
export function buildVocab(terms = TERMS, facets = FACETS) {
  const byNorm = new Map();
  const entries = [];
  for (const raw of terms) {
    const value = String(raw?.value ?? '').trim();
    const norm = normOf(value);
    if (!norm || byNorm.has(norm)) continue;
    const entry = {
      value,
      norm,
      facets: [...new Set((raw.facets || []).map(String).filter(key => key in facets))],
      parent: raw.parent ? normOf(raw.parent) : null,
      aliases: [...new Set((raw.aliases || []).map(normOf).filter(Boolean))],
    };
    byNorm.set(norm, entry);
    entries.push(entry);
  }

  // 别名不能盖住某个 canonical 值，否则「库里原本那个词」与「别名」会指向两个 term。
  const aliases = new Map();
  for (const entry of entries) {
    for (const alias of entry.aliases) {
      if (alias === entry.norm || byNorm.has(alias) || aliases.has(alias)) continue;
      aliases.set(alias, entry);
    }
  }

  const children = new Map();
  for (const entry of entries) {
    if (!entry.parent || !byNorm.has(entry.parent)) continue;
    const bucket = children.get(entry.parent) || [];
    bucket.push(entry);
    children.set(entry.parent, bucket);
  }

  // 查询热路径会对同一批输入反复调用：命中缓存后 entryOf 退化成一次 Map.get。
  // 上限只防脏输入灌爆内存，正常词表规模（几百个词）远到不了。
  const entryCache = new Map();
  const entryOf = value => {
    const raw = String(value ?? '');
    const cached = entryCache.get(raw);
    if (cached !== undefined) return cached;
    const norm = normOf(raw);
    const entry = byNorm.get(norm) || aliases.get(norm) || null;
    if (entryCache.size < 5000) entryCache.set(raw, entry);
    return entry;
  };

  /** 检索用：值 + 所有子孙。带 visited，词表写错成环也不会把调用方卡死。 */
  const descendantCache = new Map();
  const descendantValues = value => {
    const key = normOf(value);
    const cached = descendantCache.get(key);
    if (cached) return cached;
    const root = entryOf(key);
    if (!root) return [];
    const out = [];
    const seen = new Set();
    const queue = [root];
    while (queue.length) {
      const current = queue.shift();
      if (seen.has(current.norm)) continue;
      seen.add(current.norm);
      out.push(current.value);
      queue.push(...(children.get(current.norm) || []));
    }
    descendantCache.set(key, out);
    return out;
  };

  /**
   * 检索文本：原始值 ∪ canonical 值 ∪ 该词的全部别名。
   *   - 原始值：用户当时打在资产上的字 —— 搜「stone」必须命中打过 stone 的资产；
   *   - canonical：词表标准名，面板上显示的就是它 —— 搜「石材」必须命中别名资产；
   *   - 别名：同义词在搜索里可互换 —— 「石头 / stone / 石材」是同一个词。
   * 顺序按码点（compareBinary），与 SQL 侧 ORDER BY x COLLATE BINARY 完全一致，
   * 这样两条检索路径拼出的字符串逐字节相同，等价性才守得住。
   */
  const searchValues = values => {
    const out = new Set();
    for (const raw of Array.isArray(values) ? values : []) {
      const value = String(raw ?? '').trim();
      if (!value) continue;
      out.add(value);
      const entry = entryOf(value);
      if (!entry) continue;
      out.add(entry.value);
      for (const alias of entry.aliases) out.add(alias);
    }
    return [...out].sort(compareBinary);
  };

  return {
    terms: entries,
    facets,
    byNorm,
    aliases,
    children,
    entryOf,
    /** 别名/大小写/全角 → canonical value；词表里没有就返回 null（调用方自己决定怎么办）。 */
    canonical: value => entryOf(value)?.value ?? null,
    facetsOf: value => entryOf(value)?.facets ?? [],
    descendantValues,
    searchValues,
    facetValues: facet => entries.filter(entry => entry.facets.includes(facet)),
  };
}

/** 数据体检：返回问题清单，空数组表示词表可用。测试与后台自检共用。 */
export function validateVocab(terms = TERMS, facets = FACETS) {
  const problems = [];
  const seen = new Map();
  const facetKeys = new Set(Object.keys(facets));

  for (const raw of terms) {
    const value = String(raw?.value ?? '').trim();
    if (!value) { problems.push('存在空 value 的词条'); continue; }
    const norm = normOf(value);
    if (seen.has(norm)) problems.push(`重复词条：${value} 与 ${seen.get(norm)}`);
    else seen.set(norm, value);
    for (const facet of raw.facets || []) {
      if (!facetKeys.has(facet)) problems.push(`${value} 的面 ${facet} 不在 FACETS 里`);
    }
    if (!(raw.facets || []).length) problems.push(`${value} 没有归属任何面`);
  }

  const aliasOwner = new Map();
  for (const raw of terms) {
    const value = String(raw?.value ?? '').trim();
    const norm = normOf(value);
    for (const alias of (raw.aliases || []).map(normOf)) {
      if (!alias || alias === norm) continue;
      if (seen.has(alias)) problems.push(`${value} 的别名 ${alias} 与词条「${seen.get(alias)}」撞名`);
      if (aliasOwner.has(alias)) problems.push(`别名 ${alias} 同时属于「${aliasOwner.get(alias)}」和「${value}」`);
      else aliasOwner.set(alias, value);
    }
  }

  // 父级必须存在，且不能成环（A→B→A 会让层级展开死循环）。
  const parentOf = new Map();
  for (const raw of terms) {
    const value = String(raw?.value ?? '').trim();
    const norm = normOf(value);
    if (!raw.parent) continue;
    const parent = normOf(raw.parent);
    if (!seen.has(parent)) { problems.push(`${value} 的父级 ${raw.parent} 不存在`); continue; }
    if (parent === norm) { problems.push(`${value} 的父级是自己`); continue; }
    parentOf.set(norm, parent);
  }
  for (const norm of parentOf.keys()) {
    const path = new Set([norm]);
    let cursor = parentOf.get(norm);
    while (cursor) {
      if (path.has(cursor)) { problems.push(`层级成环：${seen.get(norm)}`); break; }
      path.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }
  return problems;
}

/** 服务端默认实例：种子即运行时词表。 */
export const vocab = buildVocab(TERMS, FACETS);
