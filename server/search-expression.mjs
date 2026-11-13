// 资产库布尔检索语法：移植自 Serpent src/shared/search-expression.ts（MIT）。
// Copyright (c) 2026 Serpent contributors. 完整许可：docs/THIRD_PARTY-Serpent.txt。
//
// 原文件是 91 行纯函数，只依赖一个 `import type`；这里删掉类型、补上 AssetVault 自己的字段
// 别名（platform / category / rating / note），保持同一套语义，避免重新发明一套查询语言。
//
// 语法（与 Serpent 保持一致，用户手册可直接复用）：
//   空格 = AND，  | = OR，  -前缀 = 排除，  "短语" 保留空格与竖线，  \ 转义
//   field:value 限定字段，例如 tag:石头 -author:demo | "stone lantern" rating:4
// 解析结果：{clauses:[...]} 或 {clauses:[], groups:[[...],[...]]}
//   clauses 组内全部满足（AND），groups 之间任一满足（OR）；exclude 的 clause 取反。
// 这是纯函数：无 IO、无第三方依赖，服务端与未来的脚本/MCP 可以共用。
const ALIASES = Object.freeze({
  name: 'name', filename: 'name', title: 'name',
  tag: 'tags', tags: 'tags',
  desc: 'note', description: 'note', note: 'note', comment: 'note',
  link: 'url', url: 'url', source_url: 'url', source: 'url',
  author: 'author', artist: 'author',
  path: 'path', folder: 'path', folder_path: 'path',
  meta: 'metadata', metadata: 'metadata', metadata_text: 'metadata',
  platform: 'platform', site: 'platform',
  category: 'category', kind: 'category', type: 'category',
  // 格式维度：ext:png / format:FBX / filetype:glb。值由 library-query 的 row.formats 提供，
  // 与筛选面板的逗号 token 是同一套后缀语义（大小写不敏感、无前导点）。
  ext: 'format', extension: 'format', format: 'format', filetype: 'format',
  rating: 'rating',
  // 封面探测元数据：color:blue / aspect:1.7 / width:>=2000 / resolution:>=3200 / duration:>10
  color: 'color', colour: 'color', hue: 'color', palette: 'color',
  aspect: 'aspect', ratio: 'aspect', aspect_ratio: 'aspect',
  width: 'width', height: 'height', resolution: 'resolution', longedge: 'longEdge', long_edge: 'longEdge',
  duration: 'duration', length: 'duration',
});

export const SEARCH_FIELDS = Object.freeze([...new Set(Object.values(ALIASES))]);

/**
 * 词法切分：引号内的空格与竖线是内容，转义字符原样保留。
 * 内部保留 quoted 标记 —— 比 Serpent 原版多走一步：引号里的 `tag:foo` / `-foo`
 * 按字面量搜索，不会被当成字段限定或排除符，符合「引号 = 精确短语」的直觉。
 */
function scan(value) {
  const tokens = [];
  let current = '';
  let inQuotes = false;
  let quoted = false;
  let escaped = false;
  const push = () => {
    const trimmed = current.trim();
    if (trimmed) tokens.push({text: trimmed, quoted});
    current = '';
    quoted = false;
  };
  for (const character of String(value ?? '')) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    // Serpent 的引号只控制分词；保留 AssetVault「整词引号为字面量」扩展，
    // 但字段前缀之后的引号不得取消 name:/tag: 等字段或 - 排除语义。
    if (character === '"') { if (!inQuotes && !current) quoted = true; inQuotes = !inQuotes; continue; }
    if (!inQuotes && character === '|') { push(); tokens.push({or: true}); continue; }
    if (!inQuotes && /\s/u.test(character)) { push(); continue; }
    current += character;
  }
  if (escaped) current += '\\';
  push();
  return tokens;
}

/** 对外仍是 Serpent 同款的字符串数组（'|' 表示分组），便于脚本 / MCP 复用。 */
export function tokenizeSearchExpression(value) {
  return scan(value).map(token => token.or ? '|' : token.text);
}

/**
 * 解析成与 Serpent 同形的查询契约。未知别名不当作字段，整串按普通词处理 ——
 * 用户搜 `http:foo` 之类不会突然什么都搜不到。
 */
export function parseSearchExpression(value) {
  const groups = [[]];
  for (const item of scan(value)) {
    if (item.or) {
      if (groups.at(-1).length > 0) groups.push([]);
      continue;
    }
    let token = item.text;
    const exclude = !item.quoted && token.startsWith('-');
    if (exclude) token = token.slice(1);
    const separator = item.quoted ? -1 : token.indexOf(':');
    const alias = separator > 0 ? token.slice(0, separator).toLowerCase() : null;
    const field = alias ? ALIASES[alias] ?? null : null;
    const text = field ? token.slice(separator + 1) : token;
    if (!text) continue;
    groups.at(-1).push({field, values: [text], exclude});
  }
  const nonEmpty = groups.filter(group => group.length > 0);
  if (nonEmpty.length <= 1) return {clauses: nonEmpty[0] ?? [], groups: []};
  return {clauses: [], groups: nonEmpty};
}

/** 帮助文本：界面与 /api/library/query 的错误提示都从这一处取，避免两处说法不一致。 */
export const SEARCH_SYNTAX_HELP = '空格=同时满足，| =任一满足，-词=排除，"短语"=精确，tag:/author:/rating:/ext:/color:/aspect:/width:/duration: 限定字段';
