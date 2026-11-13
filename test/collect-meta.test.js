// 采集元信息归一化：字段名表、来源判定、提示词拼装。
// 这些是纯函数，不碰数据库与网络 —— 一有平台新增字段，先在这里补断言再改表。
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {pickMeta, lookOf, metaPromptLines, platformFromUrl} from '../server/collect-meta.mjs';

test('采集归一化的两个出口都把 meta 带上（漏一个平台就等于没做）', () => {
  const source = readFileSync(new URL('../server/collect-search.mjs', import.meta.url), 'utf8');
  // 模型条目与图片条目各一处：任何一处漏了，那条链路（3D 平台或图站）就会退回只有 name。
  assert.equal((source.match(/(?:const )?meta = pickMeta\(/g) || []).length, 2);
  assert.equal((source.match(/\.\.\.\(meta \? \{meta\} : \{\}\)/g) || []).length, 2);
});

test('打标提示词确实读了 meta 与 probe，且按已有标签去重', () => {
  const source = readFileSync(new URL('../server/ai-search.mjs', import.meta.url), 'utf8');
  assert.match(source, /metaPromptLines\(input\?\.meta,\{probe:input\?\.probe,exclude:existing\}\)/);
});

test('pickMeta 命中各平台自己的字段名', () => {
  // Kenney 用 category + categoryLabel，ambientCG 只有 category，花瓣用 boardTitle + raw_text。
  assert.equal(pickMeta({category: '3d-models', categoryLabel: '3D 模型'}).category, '3d-models');
  assert.equal(pickMeta({boardTitle: '캐릭터 디자인'}).board, '캐릭터 디자인');
  assert.equal(pickMeta({collection: 'Nice Assets'}).board, 'Nice Assets');
  assert.equal(pickMeta({description: 'A rusty watering can'}).description, 'A rusty watering can');
});

test('pickMeta 接得住模型平台的 categories 数组（9 个平台都是这个形态）', () => {
  // Kenney：[categoryLabel, seriesLabel]；ambientCG：[type]；Sketchfab：[{name,slug}] 归一化后的名字数组。
  assert.equal(pickMeta({categories: ['3D 模型', 'Fantasy']}).category, '3D 模型 / Fantasy');
  assert.equal(pickMeta({categories: ['material']}).category, 'material');
  assert.equal(pickMeta({categories: ['Models', 'Weapons']}).category, 'Models / Weapons');
  // 空数组不能当命中，要继续往后找
  assert.equal(pickMeta({categories: [], category: 'hdri'}).category, 'hdri');
  assert.equal(pickMeta({categories: []}), null);
});

test('pickMeta 全空返回 null（payload 逐字节比较，不能塞空对象）', () => {
  assert.equal(pickMeta({}), null);
  assert.equal(pickMeta({board: '   ', category: ''}), null);
});

test('pickMeta 话题支持数组、空格串与描述里的 #标签', () => {
  assert.deepEqual(pickMeta({hashtags: ['概念设计', '机械']}).hashtags, ['概念设计', '机械']);
  assert.deepEqual(pickMeta({keywords: 'low poly, hand painted'}).hashtags, ['low', 'poly', 'hand', 'painted']);
  assert.deepEqual(pickMeta({raw_text: '做完了 #角色设计 #二次元'}).hashtags, ['角色设计', '二次元']);
  // 去重且限量
  assert.deepEqual(pickMeta({hashtags: ['a', 'a', 'b']}).hashtags, ['a', 'b']);
});

test('pickMeta 出处域名：显式字段优先，其次从地址推导，并去 www', () => {
  assert.equal(pickMeta({sourceHost: 'instagram.com'}).sourceHost, 'instagram.com');
  assert.equal(pickMeta({link: 'https://www.artstation.com/artwork/x'}).sourceHost, 'artstation.com');
  assert.equal(pickMeta({url: 'not-a-url'}), null);
});

test('pickMeta 截断超长描述，不把整段正文塞进 payload', () => {
  const meta = pickMeta({description: 'x'.repeat(500)});
  assert.equal(meta.description.length, 220);
});

test('lookOf 用 probe 给颜色与构图词，缺数据时不出词', () => {
  assert.deepEqual(lookOf({h: 282, s: 0.14, l: 0.76, width: 480, height: 270}), ['浅色调', '紫色', '横图']);
  assert.deepEqual(lookOf({h: 0, s: 0, l: 0.96, width: 480, height: 1450}), ['近白底', '超长竖图']);
  assert.deepEqual(lookOf(null), []);
  assert.deepEqual(lookOf({h: 100, s: 0.4, l: 0.5}), ['绿色']);
});

test('metaPromptLines 空入参返回空串（提示词与旧版逐字一致）', () => {
  assert.equal(metaPromptLines(null), '');
  assert.equal(metaPromptLines({}, {probe: null}), '');
  assert.equal(metaPromptLines(undefined, {probe: {}}), '');
});

test('metaPromptLines 拼出可读提示词并限长', () => {
  const body = metaPromptLines(
    {board: '角色设计', category: 'concept-art', sourceHost: 'artstation.com', hashtags: ['机械']},
    {probe: {h: 300, s: 0.2, l: 0.8, width: 100, height: 100}},
  );
  assert.match(body, /BOARD: 角色设计/);
  assert.match(body, /CATEGORY: concept-art/);
  assert.match(body, /ORIGIN: artstation\.com/);
  assert.match(body, /HASHTAGS: 机械/);
  assert.match(body, /VISUAL: 浅色调, 粉色|VISUAL: 浅色调, 紫色/);
  assert.ok(metaPromptLines({description: 'y'.repeat(1000)}, {limit: 50}).length <= 51);
});

test('metaPromptLines 不再重复已有标签里的词', () => {
  // 花瓣的画板名、500px 的站点分类本来就被归一进平台标签，会出现在 EXISTING TAGS 里。
  const body = metaPromptLines(
    {board: '角色设计', category: 'Concept Art / 机械', hashtags: ['角色设计', '赛博朋克']},
    {exclude: ['角色设计', 'concept art']},
  );
  assert.doesNotMatch(body, /BOARD/);
  assert.match(body, /CATEGORY: 机械/);
  assert.match(body, /HASHTAGS: 赛博朋克/);
});

test('platformFromUrl 覆盖主站与 CDN 域名，判不出返回空串', () => {
  assert.equal(platformFromUrl('https://media.sketchfab.com/models/x/thumbnails/1.jpg'), 'sketchfab');
  assert.equal(platformFromUrl('https://gd-hbimg.huaban.com/abc'), 'huaban');
  assert.equal(platformFromUrl('https://www.artstation.com/artwork/x'), 'artstation');
  assert.equal(platformFromUrl('https://i.pximg.net/img/x.png'), 'pixiv');
  assert.equal(platformFromUrl('https://example.com/a.png'), '');
  assert.equal(platformFromUrl(''), '');
});
