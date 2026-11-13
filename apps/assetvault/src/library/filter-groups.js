/**
 * 侧栏分类树的分组与折叠表。
 *
 * 一棵树的「分类」怎么折，只有两种来源：
 *   1. **手工分组表**（ArtStation 的 59 个官方分类 → 6 个用途组）。名字一律用官方英文原样写，
 *      中文显示文案由 filter-labels.js 翻出来——两份表共用同一份对照，翻译改了这里跟着走，
 *      绝不会出现「分组表里那行中文没人认得」的漂移。
 *   2. **长列表自动折叠**（Poly Haven / ambientCG / FreeStylized / Kenney）。它们的分类来自各自
 *      接口，词表既长又互不相通（ambientCG 有 95 个材质分类、Poly Haven 还混着 collection: 前缀的
 *      合集），手工分组既不可靠也难维护；而这些清单**本身就按官方热度排序**，所以「前 N 个常驻、
 *      其余折进『更多分类』」才是它们的折叠方式。
 *
 * 值一个都不改：分组只看**显示文案**（组里存的是 category matcher，不是 option.value），
 * 请求参数照原样发出去。官方以后新增分类，命不中任何组也不会消失，会落在渲染器的「其他」组里。
 */
import {zhArtCategory} from './filter-labels.js';

/** ArtStation 的一级分组：id 给样式/单测认，names 是官方英文分类名，一个不多一个不少。 */
const ARTSTATION_GROUPS=[
 {id:'character',icon:'user',label:'角色与生物',color:'#8fe0a8',names:[
  'Anatomy','Animals & Wildlife','Character Animation','Character Design','Character Modeling','Creatures','Portraits',
 ]},
 {id:'scene',icon:'grid',label:'场景与环境',color:'#8fbbf0',names:[
  'Architectural Concepts','Architectural Visualization','Environmental Concept Art & Design','Games and Real-Time 3D Environment Art','Matte Painting',
 ]},
 {id:'props',icon:'settings',label:'道具与工业',color:'#c3a4f0',names:[
  'Automotive','Fashion & Costume Design','Hard Surface','Industrial & Product Design','Mechanical Design','Mecha','Props','Textures & Materials','Toys & Collectibles','Vehicles','Weapons',
 ]},
 {id:'genre',icon:'image',label:'题材与风格',color:'#f0ab8a',names:[
  'Abstract','Anime & Manga','Concept Art','Fan Art','Fantasy','Horror','Pixel and Voxel Art','Realism','Science Fiction','Stylized','Visual Development',
 ]},
 {id:'graphic',icon:'image',label:'插画与平面',color:'#eed892',names:[
  'Board & Card Game Art','Book Illustration',"Children's Art",'Comic Art','Cover Art','Editorial Illustration','Graphic Design','Illustration','Motion Graphics','Scientific Illustration & Visualization','Sketches','Still Life','Storyboards','User Interface (UI) Art','Web and App Design',
 ]},
 {id:'production',icon:'play',label:'游戏影视与技术',color:'#8fd8d0',names:[
  'Game Art','Gameplay & Level Design','Lighting','Photogrammetry & 3D Scanning','Scripts & Tools','Technical Art','Tutorials','VFX for Film, TV & Animation','VFX for Real-Time & Games','Virtual and Augmented Reality',
 ]},
];

/**
 * 组的分组判据：按**显示文案**命中。
 *
 * 不能按 option.value 命中——ArtStation 的分类值是官方数字 id（`21`=道具、`66`=角色建模），
 * 把 59 个 id 手抄进来既没有出处、也随时会和官方改动对不上；而显示文案是我们自己翻的，
 * 表就在隔壁 filter-labels.js 里，用同一个函数翻一遍就是同一条口径。
 */
export const categoryMatcher=names=>{
 const wanted=new Set(names.map(zhArtCategory));
 return option=>wanted.has(String(option&&option.textContent||'').trim());
};

/** 渲染器要的分组表：老式 `values`（按值命中）之外，多一种 `match`（按谓词命中）。 */
export const ARTSTATION_CATEGORY_GROUPS=ARTSTATION_GROUPS.map(group=>({...group,match:categoryMatcher(group.names)}));

/** 分组表里声明过的官方分类名。单测拿它跟官方 59 个全表对账：一个不漏、一个不重。 */
export const ARTSTATION_GROUPED_NAMES=ARTSTATION_GROUPS.flatMap(group=>group.names);

/** 长列表折叠：分类多于「阈值 + 最小尾巴」时，前 N 个常驻、其余折进「更多分类」。 */
export const FOLD_AFTER=12;
/** 折起来的那个组至少要有这么多项，才值得多一次点击；尾巴太短就整列平铺，不做没必要的折叠。 */
export const FOLD_MIN_TAIL=4;
/** 「更多分类」组头：与手工分组表同一套渲染，只是没有主题色（灰调）。 */
export const MORE_GROUP={id:'folded',icon:'list',label:'更多分类',color:'#9fb0bf'};

/**
 * 长列表 → [常驻项, 折起来的项]（后者为空数组即「不折」）。
 * 抽成纯函数是为了让「什么时候折、折在哪一项」能被单测直接钉住，不必去 DOM 里数叶子。
 */
export const foldLongList=(list,{after=FOLD_AFTER,minTail=FOLD_MIN_TAIL}={})=>{
 const rows=[...(list||[])];
 return rows.length>=after+minTail?[rows.slice(0,after),rows.slice(after)]:[rows,[]];
};
