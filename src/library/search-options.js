// Public Sketchfab category slugs verified against /v3/categories. Labels are local UI translations.
export const CATEGORIES=[['','全部分类'],['animals-pets','动物与宠物'],['architecture','建筑'],['art-abstract','艺术与抽象'],['cars-vehicles','汽车与交通'],['characters-creatures','角色与生物'],['cultural-heritage-history','文化与历史'],['electronics-gadgets','电子产品'],['fashion-style','时尚'],['food-drink','食物与饮品'],['furniture-home','家具与家居'],['music','音乐'],['nature-plants','自然与植物'],['news-politics','新闻与政治'],['people','人物'],['places-travel','场景与旅行'],['science-technology','科学与科技'],['sports-fitness','运动'],['weapons-military','武器与军事']];
const CATEGORY_VALUES=new Set(CATEGORIES.map(([value])=>value).filter(Boolean));
// 分类支持逗号多值：统一树的组头一键筛选会把整组 slug 拼成一串（如 "animals-pets,people"）。
// 逐项过白名单，含非法项时报单值时代同样的错误；空串仍表示「全部分类」，返回时保留逗号串。
export function normalizeCategory(input=''){
 const raw=String(input??'').trim();
 if(!raw)return '';
 const tokens=raw.split(',').map(token=>token.trim());
 for(const token of tokens)if(!CATEGORY_VALUES.has(token))throw new Error('不支持的模型分类');
 return tokens.join(',');
}
export const SORTS={relevance:null,popular:'-likeCount',newest:'-publishedAt',views:'-viewCount'};
/** 每日主题池：给「只想逛逛」的人一个每天都不同的入口。
 *  全是英文词 —— 各平台对英文关键词的命中率明显更好（中文由下面的 aliases 兜底）；
 *  选词也刻意挑 3D 资源里存量大的题材，免得点进去空空如也。 */
export const TOPICS=Object.freeze(['robot','architecture','character','helmet','furniture','chair','house','tree','animal','weapon','spaceship','city','dragon','cat','dog','car','sword','skull','tank','boat','plane','mushroom','treasure','island']);
export const TOPIC_COUNT=6;
/** 今天的主题推荐。同一天永远返回同一组（刷新、切换标签页都不会跳），跨天才整体推进一格：
 *  第一个元素就是「今日主题」（界面上高亮），其余是往后几天的预告，等于整行每天都换新。 */
export function dailyTopics(date=new Date()){
 const day=Math.floor(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate())/86400000);
 const size=Math.min(TOPIC_COUNT,TOPICS.length),out=[];
 for(let i=0;i<size;i++)out.push({en:TOPICS[((day+i)%TOPICS.length+TOPICS.length)%TOPICS.length],today:i===0});
 return out;
}
const aliases={'机器人':'robot','汽车':'car','建筑':'architecture','人物':'character','角色':'character','科幻头盔':'sci fi helmet','头盔':'helmet','家具':'furniture','椅子':'chair','房子':'house','树木':'tree','动物':'animal','武器':'weapon','飞船':'spaceship','城市':'city','龙':'dragon','猫':'cat','狗':'dog'};
export const suggestKeyword=q=>aliases[String(q).trim()]||null;
export function searchParams(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('搜索参数格式无效');
 const q=input.q??'';if(typeof q!=='string'||q.length>200)throw new Error('关键词请控制在 200 字以内');
 const category=normalizeCategory(input.category),sort=input.sort??'relevance';
 if(!Object.hasOwn(SORTS,sort))throw new Error('不支持的排序方式');
 for(const k of ['downloadable','animated','staffpicked'])if(input[k]!==undefined&&typeof input[k]!=='boolean')throw new Error('筛选参数必须是布尔值');
 return {q:q.trim(),category,sort,downloadable:input.downloadable===true,animated:input.animated===true,staffpicked:input.staffpicked===true};
}
