/**
 * 全部平台（含模型模式）的统一筛选表：分类映射完整性 + 组头一键筛 + 覆盖面 + 排序/范围的形状。
 *
 * 这张表是「一套分类管两个平台」的合同：Sketchfab 侧以 search-options.js 的官方
 * 分类为准（19 个，一个不多一个不少），ArtStation 侧映射值必须是数字 id 字符串。
 * 叶子显式声明 s（S 站 slug），组级 S 值与 A 站映射都由叶子派生，必须与组声明一致。
 * 任何一边加了新分类、这里没跟上，测试会直接点出来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CATEGORIES,searchParams} from '../src/library/search-options.js';
import {UNIFIED_CATEGORIES,UNIFIED_GROUPS,UNIFIED_SORTS,mergedCategory,groupSketchfabCategories,groupSketchfabValue,groupIdOfSketchfabValue,mergedGroupCategory,mergedSelection,toggleGroupValue,groupChipText,artstationCategory,kindAllows,kindType} from '../src/library/merged-filters.js';

test('unified leaves use official Sketchfab slugs when they target Sketchfab',()=>{
 const official=new Set(CATEGORIES.map(([value])=>value).filter(Boolean));
 for(const item of UNIFIED_CATEGORIES)for(const slug of item.s||[])assert.ok(official.has(slug),`${item.value} 的 ${slug} 不是 Sketchfab 官方分类`);
 assert.ok(UNIFIED_CATEGORIES.length>=12,'题材要细过四个大类');
});

test('every ArtStation mapping is a list of numeric facet ids',()=>{
 for(const item of UNIFIED_CATEGORIES){
  assert.ok(Array.isArray(item.as),`${item.value} 的 as 应该是数组`);
  for(const id of item.as)assert.match(String(id),/^\d{1,6}$/,'A 站分类 id 必须是纯数字（对照 /api/artstation/filters 的 value）');
 }
});

test('mergedCategory turns a unified leaf into a comma separated request value',()=>{
 assert.equal(mergedCategory(''),'');
 assert.equal(mergedCategory('creatures'),'66,65,19,36');
 assert.equal(mergedCategory('weapons'),'22,33');
 assert.equal(mergedCategory('wood-metal'),'','没有 ArtStation 映射时返回空串');
 assert.equal(mergedCategory('not-a-category'),'');
});

test('grouping assigns every unified category exactly once',()=>{
 const grouped=UNIFIED_GROUPS.flatMap(group=>group.values).sort();
 const unified=UNIFIED_CATEGORIES.map(item=>item.value).sort();
 assert.deepEqual(grouped,unified,'每个分类都要落进一个组，且只出现一次');
});

test('group sketchfab slugs are derived from member leaves',()=>{
 for(const item of UNIFIED_CATEGORIES)assert.ok(Array.isArray(item.s),`${item.value} 要声明 s`);
 assert.deepEqual(groupSketchfabCategories('nature').sort(),['animals-pets','nature-plants']);
 assert.deepEqual(groupSketchfabCategories('not-a-group'),[]);
});

test('mergedGroupCategory unions the ArtStation ids of a group',()=>{
 assert.equal(mergedGroupCategory('character'),'53,65,66,19,36');
 assert.ok(mergedGroupCategory('scene').includes('13'));
 assert.equal(mergedGroupCategory('not-a-group'),'');
 assert.equal(mergedGroupCategory('not-a-group'),'');
 const union=new Set(UNIFIED_GROUPS.flatMap(group=>mergedGroupCategory(group.id).split(',').filter(Boolean)));
 const leaves=new Set(UNIFIED_CATEGORIES.flatMap(item=>item.as));
 assert.deepEqual([...union].sort(),[...leaves].sort(),'组级映射合起来要覆盖所有叶子的 A 站 id');
});

test('mergedSelection 是统一的读值口子：R1 组优先，R4 空映射标出「本轮跳过 A 站」',()=>{
 // 选叶子：S 站发叶 value，A 站发叶子的映射。
 const leaf=mergedSelection({leaf:'creatures'});
 assert.deepEqual(leaf,{category:'characters-creatures',artCategory:'66,65,19,36',artSkipped:false});
 const nature=mergedSelection({group:'nature'});
 assert.equal(nature.category,'nature-plants,animals-pets');
 assert.equal(nature.artCategory,mergedGroupCategory('nature'));
 assert.equal(nature.artSkipped,false);
 assert.equal(mergedSelection({group:'nature',leaf:'wood-metal'}).category,nature.category);
 assert.equal(mergedSelection({leaf:'wood-metal'}).artSkipped,true);
 // 没选分类（两个容器都空）不算跳过：照样检索，只是不加分类条件。
 assert.deepEqual(mergedSelection({}),{category:'',artCategory:'',artSkipped:false});
 assert.equal(mergedSelection({group:'   '}).artSkipped,false,'空白组值按「没选」处理，别把用户卡成不检索');
 // R1 的正规形态是 slug 串（组容器里存的就是它）：原样喂进来也要派生出同一份结果。
 assert.equal(groupIdOfSketchfabValue(nature.category),'nature');
 assert.deepEqual(mergedSelection({group:nature.category}),nature,'组容器里的 slug 串与组 id 必须等价');
 assert.equal(groupIdOfSketchfabValue('not-a-group'),'','认不出的值不许硬掰成一个组');
});

test('unified sorts are the two orders every platform can share',()=>{
 assert.deepEqual(UNIFIED_SORTS.map(item=>item.value),['relevance','newest','popular','views','name']);
 assert.equal(UNIFIED_SORTS.find(item=>item.value==='views').as,'ranking');
});

test('scope is asset kind, and one kind locks a single-type platform',()=>{
 assert.equal(kindAllows([],'ambientcg'),true);
 assert.equal(kindAllows(['textures'],'ambientcg'),true);
 assert.equal(kindAllows(['models'],'ambientcg'),false);
 assert.equal(kindAllows(['models'],'search'),true);
 assert.equal(kindAllows(['hdris'],'polyhaven','hdris'),true);
 assert.equal(kindAllows(['textures'],'polyhaven','models'),false);
 assert.equal(kindType(['textures'],'polyhaven'),'textures');
 assert.equal(kindType(['models','textures'],'polyhaven'),'');
 assert.equal(kindType(['hdris'],'freestylized'),'skybox');
});

test('组头一键筛：点一次选中整组（容器写 slug 逗号串），再点一次回「全部分类」',()=>{
 // R1：容器里存的是「组内 slug 逗号串」，不是组 id —— S 站的 categories 参数直接用它。
 const life=groupSketchfabValue('nature');
 assert.equal(life,'nature-plants,animals-pets');
 assert.equal(toggleGroupValue('','nature'),life);
 assert.equal(toggleGroupValue(life,'life'),'');
 // 直接点另一个组头是「换组」，不是叠加两组。
 assert.equal(toggleGroupValue(life,'character'),groupSketchfabValue('character'));
 // 容器里可能是带空白的历史值或上一版留下的组 id，别让用户点了没反应。
 assert.equal(toggleGroupValue(`  ${life}  `,'life'),'');
 assert.equal(toggleGroupValue('life','life'),'');
 for(const group of UNIFIED_GROUPS)assert.equal(toggleGroupValue('',group.id),groupSketchfabValue(group.id));
 assert.equal(toggleGroupValue('','not-a-group'),'','未知组没有可写的值');
 // 端到端：容器里的值要能直接过 S 站搜索参数校验（组 id 会被白名单拒掉）。
 assert.equal(searchParams({category:toggleGroupValue('','nature'),sort:'relevance'}).category,life);
});

test('选中题材给出站点名单，树上不靠标记表达覆盖面',async()=>{
 const {feedPlan}=await import('../src/library/merged-catalog.js');
 const weapons=feedPlan({leaf:'weapons'});
 assert.ok(weapons.sites.includes('Sketchfab')&&weapons.sites.includes('FreeStylized'));
 assert.equal(weapons.sites.includes('ambientCG'),false);
 assert.ok(weapons.via.every(row=>row.site&&row.name));
 const wood=feedPlan({leaf:'wood-metal'});
 assert.equal(wood.sites.includes('Sketchfab'),false);
 assert.ok(wood.sites.includes('Poly Haven'));
});

test('组头 chip 文案反映组内分类数，未知组没有文案（组头不可点）',()=>{
 for(const group of UNIFIED_GROUPS)assert.equal(groupChipText(group.id),group.label);
 assert.equal(groupChipText('nature'),'自然');
 assert.equal(groupChipText('not-a-group'),'');
});

test('R4 在纯函数层只有一条口径：A 站 category_ids 一律由统一树的叶子/组头派生',()=>{
 // 选叶子：用叶子映射；选组头：用组映射并集。
 assert.equal(artstationCategory({leaf:'creatures'}),'66,65,19,36');
 assert.equal(artstationCategory({group:'character'}),mergedGroupCategory('character'));
 assert.equal(artstationCategory({group:'character',leaf:'wood-metal'}),mergedGroupCategory('character'));
 assert.equal(artstationCategory({leaf:'wood-metal'}),null);
 // 没选分类不算跳过：'' = 照常检索，只是不加分类条件。
 assert.equal(artstationCategory({}),'');
 assert.equal(artstationCategory(),'');
 // 没有第二道模式门槛：塞个标志位进去也改不了结论。
 assert.equal(artstationCategory({leaf:'music'},true),null,'不允许再有 modelOnly 之类的开关');
});

test('R4 调用点：全部平台（不止模型模式）都走同一条派生分支',()=>{
 const source=readFileSync(new URL('../src/library/app.js',import.meta.url),'utf8');
 assert.match(source,/mode==='art'&&state\.platform===ALL/,'A 站分类派生要在 state.platform===ALL 下生效');
 const at=source.indexOf('artstationCategory(');
 assert.ok(at>0,'app.js 要调用 artstationCategory');
 assert.ok(!/modelOnly/.test(source.slice(Math.max(0,at-260),at+260)),'R4 已扩展到全部 ALL 模式，读值处不该再有模型模式门槛');
});
