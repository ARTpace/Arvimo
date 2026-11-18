import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {CONTENT_KINDS, MODE_TABS, contentMatchesKind, modeAllowsLocalKind} from '../src/library/content-kind-tabs.js';
import {MODE_PRESETS,modePresetById} from '../src/library/mode-presets.js';
import {TYPE_GROUPS, activeLocalTypeId, localTypeFacets} from '../src/library/local-type-tree.js';
import {paths} from '../src/library/icon-set.js';

const read = name => readFileSync(new URL(`../src/library/${name}`, import.meta.url), 'utf8');
const treeIds = TYPE_GROUPS.flatMap(group => group.kinds);

test('侧栏类型树覆盖模式轨：顶部图标能选中的类型，侧栏都有同一枚节点', () => {
  // 2026-11-14 用户反馈「两侧没对齐」：侧栏读的是 #local-kind 的静态 options，
  // UI / 文本 / 视频在侧栏根本没有入口。类型清单只能有一份（CONTENT_KINDS）。
  for (const tab of MODE_TABS) {
    const localKind = modePresetById(tab.id)?.localKind || tab.id;
    assert.ok(CONTENT_KINDS.some(kind => kind.id === localKind), `${tab.id} 在 CONTENT_KINDS 里没有对应类型`);
    assert.ok(treeIds.includes(localKind), `${tab.label} 在侧栏类型树里没有节点`);
  }
});

test('类型树分组：六个母分类与顶部顺序一致，子类型完整且不重复', () => {
  assert.deepEqual(TYPE_GROUPS.map(group => group.id), MODE_PRESETS.map(preset=>preset.groupId));
  assert.deepEqual(TYPE_GROUPS.map(group => group.label), MODE_PRESETS.map(preset=>preset.label));
  for (const group of TYPE_GROUPS) {
    for (const id of group.kinds) {
      const kind = CONTENT_KINDS.find(entry => entry.id === id);
      assert.ok(kind, `${id} 没有在 CONTENT_KINDS 登记`);
      assert.ok(paths[kind.icon], `${id} 的图标 ${kind.icon} 不在 icon-set`);
    }
  }
  // 一个都不能漏：CONTENT_KINDS 有几类，类型树就得挂几类，否则又变成「顶上有、侧栏没有」。
  assert.deepEqual([...treeIds].sort(), CONTENT_KINDS.filter(kind=>kind.id!=='unknown').map(kind => kind.id).sort());
});

test('类型树计数：登记资产、磁盘资产包、零散文件各按自己的词表落位，子分类带计数', () => {
  const groups = localTypeFacets({
    models: [{uid: 'm1', assetType: 'models', categories: ['角色', '角色', '场景']}],
    packages: [{category: 'material', categories: ['木纹']}],
    files: [{kind: 'video'}],
  });
  const byId = new Map(groups.flatMap(group => group.kinds).map(kind => [kind.id, kind]));
  assert.equal(byId.get('models').count, 1);
  // 计数相同就按中文排序（localeCompare('zh')），同一份数据每次都排成同一个顺序，列表不跳。
  assert.deepEqual(byId.get('models').children, [{value: '场景', count: 1, icon: 'tag'}, {value: '角色', count: 1, icon: 'tag'}]);
  assert.equal(byId.get('textures').count, 1);
  assert.deepEqual(byId.get('textures').children, [{value: '木纹', count: 1, icon: 'tag'}]);
  // category='material' 是资产包的内部词表，不能当成子分类标签铺给用户看。
  assert.ok(!byId.get('textures').children.some(child => child.value === 'material'));
  assert.equal(byId.get('videos').count, 1);
  assert.equal(byId.get('images').count, 0);
  // 分组计数是子类型之和，点分组这一层的数字不能和展开后的明细打架。
  assert.equal(groups.find(group=>group.id==='three-d').count, 2);
  // 视频 / 音频是两个独立母类了，旧的「影音」分组不再存在。
  assert.equal(groups.find(group=>group.id==='video-assets').count, 1);
  assert.equal(groups.find(group=>group.id==='media'), undefined);
});

test('高亮判定：显式模式优先，其次 state.contentKind，最后才是旧下拉值', () => {
  // UI 模式的 id 与类型 id 不同名（ui → uielement），漏了这层映射就点「UI」侧栏不亮。
  assert.equal(activeLocalTypeId({mode: 'ui'}, () => ''), 'uielement');
  assert.equal(activeLocalTypeId({contentKind: 'videos'}, () => ''), 'videos');
  assert.equal(activeLocalTypeId({}, () => 'textures'), 'textures');
  assert.equal(activeLocalTypeId({}, () => 'not-a-kind'), '');
});

test('侧栏渲染走类型树，点击统一落到 applyLocalType，外部监听不重复处理面板内点击', () => {
  const view = read('library-view.js');
  assert.match(view, /localTypeFacets\(\{models:tagged,packages,files\}\)/);
  assert.match(view, /data-type-group=/);
  assert.match(view, /data-local-kind=/);
  assert.match(view, /data-local-category=/);
  assert.match(view, /ctx\.applyLocalType\(/);
  const app = read('app.js');
  // 面板内的点击由 renderLocalFilters 自己处理（折叠、再点取消），全局监听必须让路，
  // 否则刚取消的选中会被它原样写回来。
  assert.match(app, /if\(button\.closest\('#library-filters'\)\)return;/);
  assert.match(app, /notifyCategory:label=>assistant\.notify\(\{type:'category',label\}\)/);
});

test('侧栏每个类型都说清归属：顶部有图标，或明确登记为只在侧栏筛', () => {
  const tabKinds = MODE_TABS.map(tab => modePresetById(tab.id)?.localKind || tab.id);
  // 顶部那排只放五个常驻入口，这几类本来就没有图标，点的时候必须显式清掉模式残留，
  // 否则上一轮的模式会把这批结果再夹一遍，看着像「点了没反应」。
  const sideOnly = ['textures', 'hdris', 'packs'];
  for (const id of treeIds) {
    const hasTab = tabKinds.includes(id);
    const declared = sideOnly.includes(id);
    assert.ok(hasTab !== declared, `${id} 的归属没说清：要么接顶部图标，要么登记为只在侧栏筛`);
  }
  for (const id of tabKinds) assert.ok(treeIds.includes(id), `${id} 在顶部有图标，侧栏却没有节点`);
});

test('id 不同名的类型点侧栏也要点亮顶部：ui → uielement 走模式映射', () => {
  const app = read('app.js');
  // 只认同名 id 的话，「UI 元素」点了顶部不亮，两边又各走各的。
  assert.match(app, /const owner=MODE_PRESETS\.find\(preset=>preset\.localKinds\.includes\(id\)\)/);
  assert.match(app, /state\.mode=owner\?\.id\|\|''/);
  // 映射表本身得成立，否则上面两行只是写法正确、实际不生效。
  assert.equal(MODE_PRESETS.find(preset => preset.localKind === 'uielement')?.id, 'ui');
});


test('母分类筛选覆盖所有子类型，且顶部与侧栏保持六组一一对应', () => {
 assert.equal(TYPE_GROUPS.length,6);
 assert.deepEqual(TYPE_GROUPS.map(group=>group.modeId),MODE_TABS.map(tab=>tab.id));
 for(const kind of ['models','textures','hdris','packs']) {
  assert.ok(contentMatchesKind({assetType:kind},'three-d'),kind);
 }
 assert.equal(contentMatchesKind({assetType:'images'},'three-d'),false);
 assert.ok(modeAllowsLocalKind('three-d','packages',{category:'material'}));
 assert.ok(modeAllowsLocalKind('three-d','packages',{category:'skybox'}));
 assert.ok(modeAllowsLocalKind('three-d','packages',{category:'pack'}));
 assert.ok(modeAllowsLocalKind('three-d','files',{kind:'model'}));
 assert.equal(modeAllowsLocalKind('three-d','files',{kind:'image',name:'portrait.png'}),false);
 assert.ok(contentMatchesKind({assetType:'audio'},'audio-assets'));
 assert.ok(contentMatchesKind({assetType:'videos'},'video-assets'));
 assert.equal(contentMatchesKind({assetType:'audio'},'video-assets'),false,'音频不该再被视频母类收进去');
 assert.ok(modeAllowsLocalKind('audio-assets','files',{kind:'audio'}));
 assert.ok(modeAllowsLocalKind('video-assets','files',{kind:'video'}));
 assert.equal(modeAllowsLocalKind('image-assets','files',{kind:'model'}),false);
 assert.equal(activeLocalTypeId({mode:'models',contentKind:'three-d'}),'');
 assert.equal(activeLocalTypeId({mode:'models',contentKind:'textures'}),'textures');
});

test('材质子分类不从标签或资产编号生成，真实分类保留且按资产计数',()=>{
 const models=[
  {assetType:'textures',assetId:'Metal064',categories:['Metal','Material','064','Metal064'],tags:['064','64','metal064','rust','rusted','damaged'],userTags:['自定义标签']},
  {assetType:'textures',categories:['Metal'],tags:['086','86','fabric086','fabric']},
 ];
 const groups=localTypeFacets({models,packages:[{category:'material',assetId:'Fabric086',categories:['Fabric','086','Fabric086'],tags:['086','86','fabric086','damaged']}],files:[{kind:'image',tags:['图片描述']}]});
 const types=groups.flatMap(group=>group.kinds);
 assert.deepEqual(types.find(row=>row.id==='textures').children,[{value:'Metal',count:2,icon:'tag'},{value:'Fabric',count:1,icon:'tag'}]);
 assert.deepEqual(types.find(row=>row.id==='images').children,[{value:'其他图片',count:1,icon:'image'}],'无来源信息的图片归入其他图片；原标签「图片描述」仍不进分类树');
 assert.deepEqual(models[0].tags,['064','64','metal064','rust','rusted','damaged'],'分类展示不删改原标签');
});
