// 标签词表的**客户端镜像**：面（分组）由词表决定，前端只查表，不自己猜。
//
// 为什么要有这一层：
//   · 同一个意思在库里常常写着三种（architecture / building / 建筑）。散着显示就是一团，
//     按词表归一到标准名再合并计数，面板才读得出「这是一类东西」。
//   · 一个词可以同时属于多个面（木材 = 材质 ∩ 题材）。面是**边**不是列 ——
//     一个词出现在两组里是正常的，两组的数字也一样（按词去重），不会加不起来。
//   · 词表在服务端（词表种子 → SQLite），前端不直接 import 服务端模块，
//     所以这里拿服务端给的词表快照自己建索引。
//
// 纪律：**归一只影响显示与筛选，不改数据**。库里写的是什么就是什么，
// 词表升级也不会顺手删掉用户的自造标签（docs §5.2「不同维度可出现同名，不用名称作持久关联键」）。

/**
 * 归一键。必须与服务端 `normOf`（server/library-vocab.mjs）完全一致：
 * NFKC 消全角/半角差 → 压连续空白 → 小写。
 * 两边不一致就会出现「在一边能搜到、在另一边搜不到」的老毛病。
 */
export function normalizeTagKey(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

let model = null;
let pending = null;

/** 词表模型（同步读）。未加载完成时返回 null —— 调用方要能扛住这个状态。 */
export function facetModel() { return model; }

/**
 * 拉一次词表快照并建索引。幂等：并发调用共用同一个请求，失败不缓存（下次再试）。
 * @param {string} [url] 接口地址（测试可注入）
 */
export function ensureFacetVocab(url = '/api/library/tags/facets?limit=0') {
  if (model) return Promise.resolve(model);
  if (pending) return pending;
  pending = fetch(url, {cache: 'no-store', headers: {'X-SFX-Local': '1'}})
    .then(response => response.ok ? response.json() : null)
    .then(view => {
      model = view?.vocab ? buildModel(view.vocab) : null;
      pending = null;
      return model;
    })
    .catch(() => { pending = null; return null; });
  return pending;
}

/** 词表变了要重建索引（标签管理里改过词条之后调用）。 */
export function invalidateFacetVocab() { model = null; pending = null; }

/**
 * 建索引：
 *   byNorm    归一键 → 词条（标准名 / 面 / 别名 / 父级）
 *   aliasOf   别名归一键 → 词条（同一个词换个写法，指向同一条）
 *   matchOf   词条 → 「算同一个词」的全部写法（自身 + 别名 + 全部子孙的写法）
 */
function buildModel(vocab) {
  const byNorm = new Map();
  const aliasOf = new Map();
  const order = Array.isArray(vocab.order) && vocab.order.length ? vocab.order : Object.keys(vocab.facets || {});
  const labels = {...(vocab.facets || {})};
  for (const term of vocab.terms || []) {
    const name = String(term?.v ?? '').trim();
    if (!name) continue;
    const norm = normalizeTagKey(name);
    if (!norm || byNorm.has(norm)) continue;
    const entry = {
      name,
      facets: (term.f || []).filter(key => key in labels),
      aliases: (term.a || []).map(normalizeTagKey).filter(Boolean),
      parent: term.p ? normalizeTagKey(term.p) : null,
      children: [],
    };
    byNorm.set(norm, entry);
    // 别名也要能查得到 —— 库里同一个意思常写着三种（architecture / building / 建筑）。
    for (const alias of entry.aliases) if (!byNorm.has(alias) && !aliasOf.has(alias)) aliasOf.set(alias, entry);
  }
  const entryOf = value => {
    const norm = normalizeTagKey(value);
    return byNorm.get(norm) || aliasOf.get(norm) || null;
  };
  // 父子关系要在全部词条进表之后才连 —— 子级可能排在父级前面。
  for (const entry of byNorm.values()) {
    if (entry.parent && byNorm.has(entry.parent)) byNorm.get(entry.parent).children.push(entry.name);
  }
  // 一个词「算同一个词」的写法集合：自身 + 别名 + 子孙（子孙的别名也算）。
  const matchCache = new Map();
  const matchOf = name => {
    const key = normalizeTagKey(name);
    if (matchCache.has(key)) return matchCache.get(key);
    const entry = entryOf(key);
    const out = new Set();
    if (entry) {
      const queue = [entry];
      const seen = new Set();
      while (queue.length) {
        const current = queue.shift();
        if (!current || seen.has(current.name)) continue;
        seen.add(current.name);
        out.add(normalizeTagKey(current.name));
        for (const alias of current.aliases) out.add(alias);
        for (const child of current.children) {
          const kid = byNorm.get(normalizeTagKey(child));
          if (kid) queue.push(kid);
        }
      }
    }
    matchCache.set(key, out);
    return out;
  };
  return {byNorm, aliasOf, entryOf, order, labels, matchOf};
}

/**
 * 归一一个标签：返回标准名与它所属的面。
 * 词表里没有的词原样返回（用户自造标签不能被悄悄改掉）。
 */
export function resolveTag(value) {
  const name = String(value ?? '').trim();
  const entry = facetModel()?.entryOf(name);
  if (!entry) return {name, canonical: name, facets: [], known: false};
  return {name, canonical: entry.name, facets: entry.facets, known: true};
}

/**
 * 判断某个资产的一堆标签里，是否命中指定分类。
 * 命中口径 = 分类的标准名 + 它的别名 + 全部子孙（选父类时子孙一起筛出来）。
 */
export function categoryMatches(categories, category) {
  const wanted = String(category ?? '').trim();
  if (!wanted) return false;
  const list = Array.isArray(categories) ? categories : [];
  const model = facetModel();
  if (!model) return list.includes(wanted);
  const target = model.matchOf(wanted);
  // 分类本身不在词表里（自造标签）：退回精确匹配，别乱展开。
  if (!target.size) return list.includes(wanted);
  return list.some(item => target.has(normalizeTagKey(item)));
}

/**
 * 把「标签 + 计数」列表按面分组。
 *
 * 规则：
 *   · 先按词表归一：architecture / building / 建筑 合成一个「建筑」，计数相加；
 *   · 一个词属于多个面就出现在多个组里（面是边不是列），各组数字相同；
 *   · 词表里没有、或词表里有但没归属任何面的词 → 「未归类」组，排最后；
 *   · 组序 = 词表定义序（风格→题材→材质→用途→氛围→技术→软件→授权→平台）。
 *
 * @param {Array<[string, number]>} entries 标签与计数
 * @param {object} [options] {unfiledLabel='未归类', limit=0} limit>0 时每组最多留几个
 */
export function groupTagEntries(entries, options = {}) {
  const {unfiledLabel = '未归类', limit = 0} = options;
  const model = facetModel();
  const buckets = new Map();
  const unfiled = [];
  // 同一个标准名在多个面下必须显示同一个数字，所以先按标准名合并，再分面。
  const merged = new Map();
  for (const [raw, count] of entries || []) {
    const info = resolveTag(raw);
    const key = normalizeTagKey(info.canonical);
    const current = merged.get(key);
    // 计数取**最大值**而不是相加：同一批资产的同义标签（architecture / building / 建筑）
    // 是「一次标注写了几种写法」，加起来会虚高好几倍（建筑 241 会算成 964）。
    // 取最大值正好等于「多少个资产带这个词」——与服务端 tag_counts 按 uid 去重的口径一致。
    if (current) current.count = Math.max(current.count, count);
    else merged.set(key, {name: info.canonical, count, facets: info.facets, known: info.known});
  }
  for (const item of merged.values()) {
    const keys = item.facets.filter(key => model?.labels && key in model.labels);
    if (!keys.length) { unfiled.push(item); continue; }
    for (const key of keys) {
      const bucket = buckets.get(key) || [];
      bucket.push(item);
      buckets.set(key, bucket);
    }
  }
  const order = model?.order || [];
  const groups = order.filter(key => buckets.has(key)).map(key => ({
    key,
    label: model.labels[key],
    items: sortItems(buckets.get(key), limit),
  }));
  if (unfiled.length) groups.push({key: 'unfiled', label: unfiledLabel, items: sortItems(unfiled, limit)});
  return groups;
}

function sortItems(items, limit) {
  const sorted = [...items].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  return limit > 0 ? sorted.slice(0, limit) : sorted;
}
