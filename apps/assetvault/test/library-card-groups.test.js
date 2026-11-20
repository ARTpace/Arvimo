import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCardGroups,groupRefKey,collectModelFolders} from '../src/library/card-groups.js';
const item=key=>({kind:'asset',key,level:'item',label:key});
test('整包模型按目录收纳，追加不重复，解散后扫描重新合成，不混入图片',()=>{
 const options={},root='J:/资产',folder='图片/纹理贴图/150 Ornament FBX Files';
 const files=Array.from({length:150},(_,i)=>({root,rel:`${folder}/A_${i}.FBX`,name:`A_${i}.FBX`,kind:'model'}));
 files.push({root,rel:`${folder}/preview.png`,name:'preview.png',kind:'image'});
 assert.equal(collectModelFolders(options,files,[],{id:()=> 'models'}),true);
 assert.equal(options.cardGroups.length,1);assert.equal(options.cardGroups[0].children.length,150);
 assert.equal(options.cardGroups[0].name,'150 Ornament FBX Files');
 assert.equal(collectModelFolders(options,files),false);
 const extra={root,rel:`${folder}/extra.obj`,name:'extra.obj',kind:'model'};
 assert.equal(collectModelFolders(options,[...files,extra]),true);assert.equal(options.cardGroups[0].children.length,151);
 const store=createCardGroups(options);store.ungroupMember('models',options.cardGroups[0].children[0]);
 collectModelFolders(options,[...files,extra]);assert.equal(options.cardGroups[0].children.length,150);
 store.remove('models');assert.equal(options.cardGroups.length,0);collectModelFolders(options,[...files,extra]);assert.equal(options.cardGroups.length,1);assert.equal(options.cardGroups[0].children.length,151);
});
test('已登记模型引用 UID，同目录散文件不重复，单模型不自动成集合',()=>{
 const options={},root='J:/资产',model={uid:'a',platform:'local',localRoot:root,localRel:'包/a.fbx',name:'a.fbx'};
 const files=[{root,rel:'包/a.fbx',name:'a.fbx',kind:'model'},{root,rel:'包/b.obj',name:'b.obj',kind:'model'}];
 collectModelFolders(options,files,[model]);
 assert.deepEqual(options.cardGroups[0].children.map(ref=>ref.kind),['asset','file']);
 assert.equal(collectModelFolders({},[files[0]]),false);
});
function fixture(resolve){let serial=0,saves=0;const options={};const store=createCardGroups(options,{resolve,id:()=>`g${++serial}`,now:()=>100,save:()=>saves++});return {store,options,saves:()=>saves};}

test('拆分单个成员只删该引用，并清 supersedes 让它回到全部资产',()=>{
 const {store,saves}=fixture();
 const a=item('a'),b=item('b');
 const row=store.drop(a,b);
 assert.deepEqual(row.children,[b,a]);
 store.ungroupMember(row.id,a);
 assert.deepEqual(store.find(row.id).children,[b]);
 assert.equal(store.hidden().has(groupRefKey(a)),false);
 assert.equal(store.hidden().has(groupRefKey(b)),true);
 // 图集包被合成时会在 supersedes 里留引用；拆分也要清掉，否则原图集卡继续隐身。
 const target={kind:'package',key:'R|Images',level:'album',label:'Images'};
 const old={kind:'file',key:'R|Images/a.png',root:'R',rel:'Images/a.png',level:'item'};
 const s2=fixture(()=>({children:[old]})).store;
 const album=s2.drop(item('model'),target);
 assert.ok(s2.hidden().has(groupRefKey(target)));
 s2.ungroupMember(album.id,target);
 assert.equal(s2.hidden().has(groupRefKey(target)),false);
 assert.deepEqual(s2.find(album.id).supersedes,[]);
});

test('普通资产组合、追加、刷新恢复及解散均只修改引用',()=>{
 const {store,options,saves}=fixture();
 const a=item('model'),b=item('texture'),c=item('video');
 const album=store.drop(a,b);assert.equal(album.type,'album');assert.deepEqual(album.children,[b,a]);
 store.drop(c,store.reference(album));assert.equal(store.find(album.id).children.length,3);
 assert.ok(store.hidden().has(groupRefKey(a)));assert.equal(saves(),2);
 const restored=createCardGroups(JSON.parse(JSON.stringify(options)));
 assert.equal(restored.find(album.id).children.length,3);
 restored.remove(album.id);assert.equal(restored.hidden().size,0);
});

test('集合集合生成文件夹，第三个集合直接放入，保留各自成员',()=>{
 const {store}=fixture();const a=store.drop(item('a'),item('b')),b=store.drop(item('c'),item('d')),c=store.drop(item('e'),item('f'));
 const folder=store.drop(store.reference(a),store.reference(b));assert.equal(folder.type,'folder');
 store.drop(store.reference(c),store.reference(folder));assert.equal(store.find(folder.id).children.length,3);
 assert.equal(store.find(a.id).children.length,2);
 assert.equal(store.allowed(store.reference(folder),item('a')),false);
});

test('实体图集追加资产时保留原有图片，原文件夹不移动',()=>{
 const target={kind:'package',key:'R|Images',level:'album',label:'Images'};
 const old={kind:'file',key:'R|Images/a.png',root:'R',rel:'Images/a.png',level:'item'};
 const {store}=fixture(()=>({children:[old]}));
 const row=store.drop(item('model'),target);
 assert.deepEqual(row.children,[old,item('model')]);assert.deepEqual(row.supersedes,[target]);
 assert.ok(store.hidden().has(groupRefKey(target)));
 store.remove(row.id);assert.equal(store.hidden().size,0);
});

test('自投递、错误层级不写入，重复加入幂等，归属变更不重复显示',()=>{
 const {store,saves}=fixture();const a=item('a');
 assert.throws(()=>store.drop(a,a));assert.equal(saves(),0);
 const first=store.drop(a,item('b')),second=store.drop(item('c'),item('d'));
 store.drop(a,store.reference(second));
 assert.deepEqual(store.find(first.id).children,[item('b')]);
 store.drop(a,store.reference(second));assert.equal(store.find(second.id).children.length,3);
});


test('missing collection record is recovered despite completed import history',()=>{
 const root='J:/assets',files=[1,2].map(i=>({root,rel:`models/A_${i}.FBX`,name:`A_${i}.FBX`,kind:'model'}));
 const options={};collectModelFolders(options,files,[],{id:()=> 'original'});
 options.cardGroups=[];
 assert.equal(collectModelFolders(options,files),true);
 assert.equal(options.cardGroups[0].id,'original');assert.equal(options.cardGroups[0].children.length,2);
 createCardGroups(options).remove('original');
 options.modelFolderImports['j:/assets/models'].dissolved=true; // Older persisted flags must not suppress rebuilding.
 assert.equal(collectModelFolders(options,files),true);assert.equal(options.cardGroups.length,1);
 assert.equal(options.cardGroups[0].children.length,2);
 assert.equal(collectModelFolders(options,files),false);
});
