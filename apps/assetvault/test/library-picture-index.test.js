// 图站清单窗口：一块画板只解析一次，之后每一屏都是切片。
//
// 这一层存在的唯一理由是「滑到第 10 屏别再把第 1 页重翻一遍」。所以测试的重点不是
// 字段格式，而是「一共回源几次」「总量什么时候才敢报」：这两条错了，前端看到的
// 就是越滑越慢、或者卡片上写着「共 60 张」实际有 1923 张。
import test from 'node:test';
import assert from 'node:assert/strict';
import {pictureWindow, forgetPictureIndex, pictureIndexStats} from '../server/picture-index.mjs';

const BOARD = 'https://huaban.com/boards/1001';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('小红书推荐按需续页，首批短页不触发后台全量并保留重试提示',async()=>{
 const url='https://www.xiaohongshu.com/explore?test=home-paging';forgetPictureIndex('xiaohongshu',url);
 const calls=[];
 const collect=async(_platform,_args,{maxItems})=>{
  calls.push(maxItems);const count=calls.length===1?15:45;
  return {items:Array.from({length:count},(_,id)=>({url:`home-${id}`})),truncated:calls.length===1,personalPaging:1,warning:calls.length===1?'暂未返回后续推荐，可重试':''};
 };
 const first=await pictureWindow('xiaohongshu',url,24,{collect});
 assert.equal(first.truncated,true);assert.match(first.warning,/重试/);assert.deepEqual(calls,[24]);
 const next=await pictureWindow('xiaohongshu',url,84,{collect});
 assert.equal(next.items.length,45);assert.equal(next.truncated,false);assert.deepEqual(calls,[24,84]);
 forgetPictureIndex('xiaohongshu',url);
});

test('小红书关注清单按用户计数、逐窗口扩展，不触发全关注后台长抓取',async()=>{
 const url='https://www.xiaohongshu.com/user/following?test=windows';forgetPictureIndex('xiaohongshu',url);
 const calls=[];
 const collect=async(_platform,_args,{maxItems})=>{
  calls.push(maxItems);const count=Math.min(maxItems,100);
  return {mode:'boards',items:[],boards:Array.from({length:count},(_,id)=>({id:String(id),url:`user-${id}`})),truncated:count<100,personalPaging:1};
 };
 const first=await pictureWindow('xiaohongshu',url,24,{collect});
 assert.equal(first.boards.length,24);assert.equal(first.truncated,true);assert.equal(first.personalPaging,1);
 const more=await pictureWindow('xiaohongshu',url,84,{collect});
 assert.equal(more.boards.length,84);assert.equal(more.truncated,true);
 const end=await pictureWindow('xiaohongshu',url,144,{collect});
 assert.equal(end.boards.length,100);assert.equal(end.total,100);assert.equal(end.truncated,false);
 assert.deepEqual(calls,[24,84,144]);forgetPictureIndex('xiaohongshu',url);
});

test('小红书赞过不足首屏但明确还有更多时，缓存不谎报结束',async()=>{
 const url='https://www.xiaohongshu.com/user/likes?test=partial';forgetPictureIndex('xiaohongshu',url);
 const calls=[];
 const collect=async(_platform,_args,{maxItems})=>{
  calls.push(maxItems);const count=maxItems===24?15:40;
  return {items:Array.from({length:count},(_,id)=>({key:String(id),url:`image-${id}`})),truncated:count===15,personalPaging:1,order:'liked-desc'};
 };
 const first=await pictureWindow('xiaohongshu',url,24,{collect});
 assert.equal(first.items.length,15);assert.equal(first.truncated,true);assert.equal(first.order,'liked-desc');
 const more=await pictureWindow('xiaohongshu',url,84,{collect});
 assert.equal(more.items.length,40);assert.equal(more.truncated,false);assert.deepEqual(calls,[24,84]);
 forgetPictureIndex('xiaohongshu',url);
});

/** 假解析器：按 maxItems 截断，truncated 的语义与 picture-sites.collectPictureAssets 一致。
 *  「全量那一轮」故意慢 20ms：真实站点翻二十页 API 也要几秒，测试里得给后台留出
 *  「首屏已经返回、清单还在长」的那个窗口，否则永远测不到「中途不报 total」这条。 */
function fakeBoard({total = 200, onCall} = {}) {
  const calls = [];
  const collect = async (platform, args, {maxItems} = {}) => {
    calls.push(maxItems);
    onCall?.(maxItems);
    if ((maxItems ?? 0) > 1000) await sleep(120);
    const count = Math.min(total, maxItems ?? total);
    const items = Array.from({length: count}, (_, index) => ({url: `https://img.example/${platform}/${index}.jpg`, width: 100, height: 100}));
    return {items, truncated: count < total, total: count, title: '美宣 插画', author: '某人', platform, client: 'fetch'};
  };
  return {collect, calls};
}

test('第一屏先给一屏，后台把整块画板翻完；第二屏只是切片，不再从第一页重翻', async () => {
  forgetPictureIndex('huaban', BOARD);
  const {collect, calls} = fakeBoard({total: 200});
  const first = await pictureWindow('huaban', BOARD, 60, {collect});
  assert.equal(first.items.length, 60);
  assert.equal(first.truncated, true);
  // 后台还在翻：这时候报「共 60 张」就是骗人，只能不报。
  assert.equal(first.total, 0);
  // 首屏只解析了一屏的量（72 = 一屏 60 + 余量），没有为了首屏去翻 200 张。
  assert.equal(calls[0], 72);

  await sleep(220); // 让后台那一轮跑完

  const second = await pictureWindow('huaban', BOARD, 120, {collect});
  assert.equal(second.items.length, 120);
  assert.equal(second.truncated, true);
  // 翻完之后才给真实总量。
  assert.equal(second.total, 200);
  // 关键：第二屏没有再回源一次 —— 2 次调用是「首屏」+「后台全量」，不是「每屏一次」。
  assert.deepEqual(calls, [72, 6000]);
});

test('翻到底：limit 超过总数时如实报「没有更多」，总量照旧给出', async () => {
  forgetPictureIndex('huaban', BOARD);
  const {collect} = fakeBoard({total: 200});
  await pictureWindow('huaban', BOARD, 60, {collect});
  await sleep(220);
  const all = await pictureWindow('huaban', BOARD, 500, {collect});
  assert.equal(all.items.length, 200);
  assert.equal(all.truncated, false);
  assert.equal(all.total, 200);
  assert.equal(all.complete, true);
});

test('两批结果按图片地址去重：首屏那 72 张不会在全量里再算一遍', async () => {
  forgetPictureIndex('huaban', 'https://huaban.com/boards/1002');
  const {collect} = fakeBoard({total: 90});
  await pictureWindow('huaban', 'https://huaban.com/boards/1002', 60, {collect});
  await sleep(220);
  const all = await pictureWindow('huaban', 'https://huaban.com/boards/1002', 300, {collect});
  assert.equal(all.items.length, 90);
  assert.equal(new Set(all.items.map(item => item.url)).size, 90);
  assert.equal(all.total, 90);
});

test('一张都没翻到才算失败；已经翻到过内容的后续失败不清空已有画面', async () => {
  const empty = 'https://huaban.com/boards/1003';
  forgetPictureIndex('huaban', empty);
  let fail = true;
  const flaky = async () => {
    if (fail) throw new Error('站点拦了');
    return {items: [{url: 'https://img.example/1.jpg'}], truncated: false};
  };
  await assert.rejects(() => pictureWindow('huaban', empty, 60, {collect: flaky}), /站点拦了/);

  // 成功一轮之后再失败：清单还在，不该把用户已经看到的图清空。
  const board = 'https://huaban.com/boards/1004';
  forgetPictureIndex('huaban', board);
  let round = 0;
  const partly = async () => {
    round += 1;
    if (round === 1) return {items: [{url: 'https://img.example/a.jpg'}], truncated: true};
    throw new Error('限流');
  };
  const first = await pictureWindow('huaban', board, 60, {collect: partly});
  assert.equal(first.items.length, 1, '第一屏拿到的图必须留着');
  assert.equal(first.complete, false, '全量那轮失败了，不能标成「已翻完」');
  assert.equal(first.truncated, true, '还没翻完，仍然要告诉前端「还有更多」');
});

test('画板墙（mode:boards）原样返回，不走图片切片', async () => {
  const author = 'https://huaban.com/user/someone';
  forgetPictureIndex('huaban', author);
  const collect = async () => ({
    mode: 'boards',
    boards: [{id: '1', title: '灵感', count: 12}, {id: '2', title: '配色', count: 4}],
    items: [],
    truncated: false,
    title: '某人',
  });
  const result = await pictureWindow('huaban', author, 60, {collect});
  assert.equal(result.mode, 'boards');
  assert.equal(result.boards.length, 2);
  assert.equal(result.items.length, 0);
  assert.equal(result.truncated, false);
});

test('清掉清单之后会重新解析（换画板 / 手动刷新用）', async () => {
  const url = 'https://huaban.com/boards/1005';
  forgetPictureIndex('huaban', url);
  const {collect, calls} = fakeBoard({total: 5});
  await pictureWindow('huaban', url, 60, {collect});
  await sleep(20);
  const cached = await pictureWindow('huaban', url, 60, {collect});
  assert.equal(cached.items.length, 5);
  const before = calls.length;
  forgetPictureIndex('huaban', url);
  await pictureWindow('huaban', url, 60, {collect});
  assert.ok(calls.length > before, '忘掉清单后必须回源一次');
  assert.ok(pictureIndexStats().entries >= 1);
});
