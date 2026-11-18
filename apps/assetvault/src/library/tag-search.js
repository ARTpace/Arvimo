/** 侧栏「标签」面板的搜索：库里的标签是用户自己打的，中文、英文、带空格混着来，
 *  一个标签动不动几十条，翻起来只能靠滚。这里只做「包含匹配」这一件事，不引模糊库：
 *  输入 木 → 木纹 / 木地板 都出来，输入大小写不同也认。
 *  纯函数单独放一层，是为了让「搜出来对不对」能被单测直接钉住 —— 塞在渲染函数里就只能靠肉眼。 */

/** 归一化关键词：去首尾空白、转小写。全角空格也当空白，从别处粘过来的词常带。 */
export function normalizeTagQuery(query){
 return String(query??'').replace(/[\s\u3000]+/g,' ').trim().toLowerCase();
}

/** 过滤 [值, 计数] 一类的条目：关键词为空＝原样返回，顺序仍由调用方给。 */
export function filterTagEntries(entries,query){
 const keyword=normalizeTagQuery(query);
 if(!keyword)return [...entries];
 return entries.filter(entry=>String(entry?.[0]??'').toLowerCase().includes(keyword));
}

/** 输入框右边那行小字：搜的时候报命中的数字，没搜就不显示（占位会让标题行跳动）。 */
export function tagHitLabel(matched,total,query){
 if(!normalizeTagQuery(query))return '';
 return matched===0?'无匹配':`${matched}/${total}`;
}
