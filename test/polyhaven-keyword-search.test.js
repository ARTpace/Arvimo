// Poly Haven 的关键词搜索。
//
// 上游 `/assets` 不认任何关键词参数（query / q / search / name 实测都返回同一批），所以关键词
// 一律在服务端本地匹配。这里的每一条都对应一个曾经的坑：关键词被拼进上游 URL 等于没过滤，
// 搜索框看起来完全不起作用。
import test from 'node:test';
import assert from 'node:assert/strict';
import {polyhavenSearch,polyhavenHaystack,polyhavenMatch} from '../server/polyhaven.mjs';

const CATALOG={
  ArmChair_01:{name:'Arm Chair 01',category:'Furniture/Seating/Chairs',categories:['furniture','seating'],tags:['gothic','vintage','chair','wood'],authors:{'Kirill Sannikov':'All'}},
  Rock_01:{name:'Rock 01',category:'Nature/Rocks',categories:['rock','outdoor'],tags:['stone','cliff'],authors:{'Someone Else':'All'}},
  BrickWall_01:{name:'Brick Wall 01',category:'Man made/Bricks',categories:['brick'],tags:['wall','red'],authors:{'Nobody':'All'}},
};
/** 上游一次给全量 map；把「这次请求的 URL」记下来，好断言关键词没被拼进去。 */
function mockOpen(catalog=CATALOG){
  const seen=[];
  const open=async url=>{seen.push(url);return {status:200,stream:[Buffer.from(JSON.stringify(catalog))]};};
  return {open,seen};
}
const names=result=>result.models.map(m=>m.assetId).sort();

test('关键词按名称 / 标签 / 分类 / 作者名匹配',async()=>{
  const {open}=mockOpen();
  assert.deepEqual(names(await polyhavenSearch({q:'chair'},{open})),['ArmChair_01'],'名称与标签都能命中');
  assert.deepEqual(names(await polyhavenSearch({q:'stone'},{open})),['Rock_01'],'标签命中');
  assert.deepEqual(names(await polyhavenSearch({q:'brick'},{open})),['BrickWall_01'],'分类命中');
  assert.deepEqual(names(await polyhavenSearch({q:'Nobody'},{open})),['BrickWall_01'],'作者名命中');
  // 「Furniture/Seating/Chairs」这种路径串只在 category 里，分类数组拆开就没有 chairs。
  assert.deepEqual(names(await polyhavenSearch({q:'chairs'},{open})),['ArmChair_01'],'分类路径串也能命中');
});

test('关键词不区分大小写，多词按 AND',async()=>{
  const {open}=mockOpen();
  assert.deepEqual(names(await polyhavenSearch({q:'ARM CHAIR'},{open})),['ArmChair_01'],'大小写无关');
  assert.deepEqual(names(await polyhavenSearch({q:'chair wood'},{open})),['ArmChair_01'],'两个词都要出现');
  assert.deepEqual(names(await polyhavenSearch({q:'chair stone'},{open})),[],'只满足一个词不算命中');
});

test('空关键词不过滤，返回该类型的全量',async()=>{
  const {open}=mockOpen();
  const all=await polyhavenSearch({type:'models'},{open});
  assert.equal(all.total,3,'没有关键词就不筛');
  assert.equal(all.warnings.length,0);
});

test('没有匹配时给出可照做的说明，而不是安静地返回热门列表',async()=>{
  const {open}=mockOpen();
  const empty=await polyhavenSearch({q:'zzzqqqxyz'},{open});
  assert.equal(empty.total,0);assert.equal(empty.models.length,0);
  assert.match(empty.warnings[0],/zzzqqqxyz/,'文案要带上这次的关键词');
  assert.match(empty.warnings[0],/英文/,'要提示关键词按英文匹配，否则用户会以为库是空的');
});

test('关键词不得拼进上游 URL —— 上游根本不认，拼了等于没过滤',async()=>{
  const {open,seen}=mockOpen();
  await polyhavenSearch({q:'chair',type:'models'},{open});
  assert.equal(seen.length,1);
  assert.ok(seen[0].includes('type=models'),'上游只按类型取全量');
  assert.equal(/query=|\?q=|search=|name=/i.test(seen[0]),false,'上游 URL 里不能再出现关键词参数');
});

test('分页游标带着关键词，翻页不会退回未过滤的全量',async()=>{
  // 每页 24 条，要触发翻页得让命中数超过一页；再造一批「不命中」的资产做对照。
  const catalog={};
  for(let i=0;i<30;i++)catalog[`Alpha_${i}`]={name:`Alpha Asset ${i}`,categories:['alpha'],tags:['alpha'],authors:{'A':'All'}};
  for(let i=0;i<30;i++)catalog[`Zulu_${i}`]={name:`Zulu Asset ${i}`,categories:['zulu'],tags:['zulu'],authors:{'Z':'All'}};
  const {open}=mockOpen(catalog);
  const first=await polyhavenSearch({q:'alpha',type:'models'},{open});
  assert.equal(first.total,30,'命中 30 条，未命中的 30 条不进结果');
  assert.equal(first.models.length,24);
  const cursor=JSON.parse(first.next);
  assert.equal(cursor.q,'alpha','游标要记住关键词');
  assert.equal(cursor.type,'models');
  const second=await polyhavenSearch({cursor:first.next},{open});
  assert.equal(second.query,'alpha','翻页时关键词仍然生效');
  assert.equal(second.models.length,6,'第二页是本轮过滤结果剩下的 6 条，不是未过滤的全量');
  assert.ok(second.models.every(m=>/^Alpha_/.test(m.assetId)),'翻页结果必须仍在关键词集合内');
});

test('haystack / 匹配器是纯函数，方便复用与单测',()=>{
  assert.equal(polyhavenHaystack(null),'');
  assert.equal(polyhavenMatch('abc',''),true,'空关键词恒真');
  assert.equal(polyhavenMatch('arm chair','arm chair'),true);
  assert.equal(polyhavenMatch('arm chair','chair chair'),true);
  assert.equal(polyhavenMatch('arm chair','chair table'),false);
});
