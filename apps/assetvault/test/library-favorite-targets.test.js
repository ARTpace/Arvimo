import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {favoriteUid,registerFavoriteTarget,favoriteTarget,favoriteSkipsCollect,favoriteButtonHtml} from '../src/library/favorite-targets.js';

// 2026-11-12 反馈：「很多平台的收藏心形按键都没有了，需要统一所有平台都有收藏按键和功能」。
// 这里钉住两件事：① 图标只是一颗按钮，能不能收藏取决于 findModel 找不找得到资产；
// ② 图站单图 / 本地素材包不进 state.models，靠登记「可收藏目标」补上解析层，
//    否则点下去只会留下一个孤儿 uid，收藏页里什么都看不到。
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('收藏 uid 必须是 32 位十六进制，且同一个资产每次算出来都一样',()=>{
 const a=favoriteUid('picture','pixiv:https://example.com/a.png');
 assert.match(a,/^[a-f0-9]{32}$/,'library-state 的 UID 与服务端 uidPattern 都只认这种格式');
 assert.equal(a,favoriteUid('picture','pixiv:https://example.com/a.png'));
 assert.notEqual(a,favoriteUid('picture','pixiv:https://example.com/b.png'));
 assert.notEqual(a,favoriteUid('package','pixiv:https://example.com/a.png'));
});

test('登记过的目标能被 findModel 兜底读到，素材包标成跳过入库',()=>{
 const uid=favoriteUid('picture','huaban:https://example.com/p.jpg');
 registerFavoriteTarget(uid,{uid,name:'一张图'});
 assert.deepEqual(favoriteTarget(uid),{uid,name:'一张图'});
 assert.equal(favoriteSkipsCollect(uid),false,'模型 / 图站资产收藏时仍要 collect');
 const pkg=favoriteUid('package','root|rel');
 registerFavoriteTarget(pkg,{uid:pkg,name:'素材包'},{skipCollect:true});
 assert.equal(favoriteSkipsCollect(pkg),true,'素材包已在磁盘索引里，重复入库会顶掉原卡');
 assert.equal(favoriteTarget('not-a-uid'),null,'非法 uid 不该污染注册表');
});

test('统一心形键：全平台共用同一套类名 / data-action / uid / 无障碍状态',()=>{
 const icon=()=>'<i>heart</i>';
 const off=favoriteButtonHtml({uid:'a'.repeat(32),saved:false,icon});
 const on=favoriteButtonHtml({uid:'a'.repeat(32),saved:true,icon});
 for(const html of [off,on]){
  assert.match(html,/class="favorite/);
  assert.match(html,/data-action="favorite"/);
  assert.match(html,/data-uid="a{32}"/);
  assert.match(html,/<i>heart<\/i>/);
 }
 assert.match(off,/aria-pressed="false"/);
 assert.match(on,/class="favorite saved"/);
 assert.match(on,/aria-pressed="true"/);
});

test('四类卡片都画心形键：模型平台 / ArtStation 图片模式 / 图站单图 / 本地素材包',()=>{
 const cardView=read('src/library/card-view.js');
 const view=read('src/library/library-view.js');
 const local=read('src/library/local-files.js');
 assert.ok(cardView.includes('favoriteButtonHtml({uid:m.uid,saved,icon,esc})'),'模型卡片要画心形键');
 assert.ok(!cardView.includes("pictureMode?'':favoriteButton"),'ArtStation 图片模式不能再屏蔽收藏键');
 assert.ok(view.includes('const heart=favoriteButtonHtml('),'图站单图 / 视频卡要画心形键');
 assert.ok(local.includes('const heart=favoriteButtonHtml('),'本地素材包卡要画心形键');
 assert.ok(/favorites=\(\)=>new Set\(\)/.test(local),'素材包要知道当前已收藏集合，重绘后仍是实心');
});

test('收藏链路真的通：findModel 兜底、toggleFavorite 尊重 skipCollect',()=>{
 const app=read('src/library/app.js');
 assert.ok(app.includes("import {favoriteTarget,favoriteSkipsCollect} from './favorite-targets.js'"));
 assert.ok(app.includes('||favoriteTarget(uid)'),'findModel 末尾要用注册表兜底');
 assert.ok(app.includes('if(!favoriteSkipsCollect(uid))'),'本地素材包别重复 collect');
 assert.ok(app.includes('favorites:()=>state.favorites'),'createLocalFiles 要拿到实时收藏集合');
});

test('选择方块只是隐藏，DOM / data-select 契约留给框选与 Shift 连选',()=>{
 const css=read('src/library/app.css');
 const cardView=read('src/library/card-view.js');
 assert.match(css,/\.card-media>\.card-select\{display:none!important\}/);
 assert.ok(cardView.includes('class="card-select"')&&cardView.includes('data-select="${m.uid}"'),
  'range-select 的 INTERACTIVE / onCheckboxChange 还认这个节点，不能删 DOM');
 assert.ok(read('src/library/range-select.js').includes('data-select'),'框选契约仍在');
});
