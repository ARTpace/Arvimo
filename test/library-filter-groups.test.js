import test from 'node:test';
import assert from 'node:assert/strict';
import {
 ARTSTATION_CATEGORY_GROUPS,ARTSTATION_GROUPED_NAMES,FOLD_AFTER,FOLD_MIN_TAIL,MORE_GROUP,categoryMatcher,foldLongList,
} from '../src/library/filter-groups.js';
import {ARTSTATION_CATEGORY_ZH,zhArtCategory} from '../src/library/filter-labels.js';

// 官方全表的「59」与逐条名称由 library-filter-labels.test.js 钉住（那边是对着官方 /filters 抄的）。
// 这里只跟那份中文对照表对账：它有多少个分类，分组表就得不多不少地分完多少个。
const official=Object.keys(ARTSTATION_CATEGORY_ZH);
/** 分组表命中哪些组（命中 0 个 = 会落进渲染器的「其他」组）。 */
const hits=text=>ARTSTATION_CATEGORY_GROUPS.filter(group=>group.match({textContent:text,value:'21'})).map(group=>group.id);

test('ArtStation 分组表把官方分类全表一个不漏地分完，也没有多塞或重分',()=>{
 assert.equal(official.length,59,'官方分类全表的规模变了，分组表要跟着重排');
 assert.equal(ARTSTATION_GROUPED_NAMES.length,official.length);
 assert.equal(new Set(ARTSTATION_GROUPED_NAMES).size,ARTSTATION_GROUPED_NAMES.length,'有分类被分进了两组');
 // 两边排序比对：分组表里少一个、多一个、或某个名字拼错（对不上官方名），都会在这里现形。
 assert.deepEqual([...ARTSTATION_GROUPED_NAMES].sort(),[...official].sort());
});

test('每一组都带 id / 图标 / 名称 / 主题色，id 与名称都不重复',()=>{
 const ids=new Set(),labels=new Set();
 for(const group of ARTSTATION_CATEGORY_GROUPS){
  assert.ok(group.id&&group.icon&&group.label&&/^#[0-9a-f]{6}$/i.test(group.color),`${group.id} 少了 id / 图标 / 名称 / 主题色`);
  assert.ok(group.names.length>=2,`${group.id} 只装了一个分类，不值得为它折一层`);
  assert.ok(!ids.has(group.id)&&!labels.has(group.label),`组 ${group.id} 与前面某组重名`);
  ids.add(group.id);labels.add(group.label);
 }
 assert.ok(ARTSTATION_CATEGORY_GROUPS.length>=4,'组太少等于没折');
 assert.equal(ids.has(MORE_GROUP.id),false,'「更多分类」的组 id 不能和手工分组撞车');
});

test('分组只看显示文案，官方数字 id 一个都不碰',()=>{
 // 值仍是官方 id（21 = Props）：命中与否由文案决定，说明分组没有偷偷依赖数字 id。
 assert.deepEqual(hits('道具'),['props']);
 assert.deepEqual(hits('角色建模'),['character']);
 assert.deepEqual(hits('建筑设计（官方新增）'),[]);
 // 官方以后加的分类、空文案：都不硬塞进某一组，交给渲染器的「其他」组。
 assert.deepEqual(hits('Volumetric Capture'),[]);
 assert.deepEqual(hits(''),[]);
 assert.equal(categoryMatcher(['Props'])({textContent:'道具',value:'21'}),true);
 assert.equal(categoryMatcher(['Props'])({textContent:'Props',value:'21'}),false,'组表用官方英文名声明，认的是翻译后的显示文案');
});

test('官方全表的每一个分类都恰好落进一组',()=>{
 for(const name of official){
  const label=zhArtCategory(name);
  const found=hits(label);
  assert.equal(found.length,1,`${name}（${label}）分到了 ${found.length} 组，应当恰好一组`);
 }
});

test('长列表折叠：够长才折，尾巴太短就整列平铺',()=>{
 const list=count=>Array.from({length:count},(_,index)=>`分类 ${index+1}`);
 const short=list(FOLD_AFTER+FOLD_MIN_TAIL-1);
 assert.deepEqual(foldLongList(short),[short,[]],'折起来也不到最小尾巴，就别折了');
 const long=list(FOLD_AFTER+FOLD_MIN_TAIL);
 const [front,tail]=foldLongList(long);
 assert.equal(front.length,FOLD_AFTER);
 assert.equal(tail.length,FOLD_MIN_TAIL);
 assert.deepEqual([...front,...tail],long,'折叠不丢项、也不改顺序（清单本身按官方热度排序）');
 assert.deepEqual(foldLongList([]),[[],[]]);
 assert.deepEqual(foldLongList(null),[[],[]]);
});

test('「更多分类」组头与阈值都还立着',()=>{
 assert.equal(MORE_GROUP.label,'更多分类');
 assert.ok(MORE_GROUP.icon&&MORE_GROUP.color);
 assert.ok(FOLD_AFTER>=8&&FOLD_AFTER<=20,`常驻项数 ${FOLD_AFTER} 不在「看一眼就够用」的区间里`);
 assert.ok(FOLD_MIN_TAIL>=2);
});
