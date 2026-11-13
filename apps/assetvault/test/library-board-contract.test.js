// 画板 / 智能收集的契约测试：静态钉住命名、事件、接线与「保存成功后才 ack」的顺序，
// 防止并行开发时有人改了契约却没同步 docs/board-development.md §4。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {assetMenuItems} from '../src/library/card-context-menu.js';
import {COLLECT_ROUTES} from '../src/library/board-api.js';
import {BOARD_EVENTS} from '../src/library/board-store.js';
import {boardCollectHtml, ruleCardHtml} from '../src/library/board-collect-template.js';
import {icon} from '../src/library/icon-set.js';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const esc = value => String(value).replace(/[&<>"]/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[char]));

test('CSS / 事件名遵守冻结契约，不撞图站画板', () => {
  assert.deepEqual(BOARD_EVENTS, {
    changed: 'assetvault:board-changed',
    selected: 'assetvault:board-selected',
    collect: 'assetvault:collect-changed',
  });
  const css = read('src/library/app.css');
  assert.match(css, /\.bd-dialog\{/);
  assert.doesNotMatch(css, /\.bd-dialog[\s\S]{0,4000}\.board-grid/);
  const hub = read('src/library/board-hub.js');
  assert.doesNotMatch(hub, /board-grid|\.board-card/);
});

test('采集路由前后端一致（前端清单 ⊆ 服务端 ROUTES）', () => {
  const server = read('server/collect-api.mjs');
  for (const route of COLLECT_ROUTES) assert.ok(server.includes(`'${route}'`), `服务端缺路由 ${route}`);
  assert.equal(COLLECT_ROUTES.length, 6);
});

test('app.js 装配中枢，右键菜单通过 run 回调注入（不改分发 switch）', () => {
  const app = read('src/library/app.js');
  assert.match(app, /import \{createBoardHub\}/);
  assert.match(app, /boardHub=createBoardHub\(/);
  // 2026-11 起注入带门控：只有库路由、非访客、boardHub 已装配时才给回调，
  // 避免序列菜单 / 画廊里出现访客用不了的「加入画板」。
  assert.match(app, /onBoardPicker:state\.route==='library'&&!visitor&&boardHub\?/);
  assert.ok((app.match(/boardHub\.pickBoards\(uids,options\)/g)||[]).length>=2,'两处菜单都要把回调转给 boardHub');
  const menu = read('src/library/card-context-menu.js');
  assert.match(menu, /ctx\.onBoardPicker/);
  assert.match(menu, /run: \(\) => ctx\.onBoardPicker\(\[uid\], \{mode: 'add'\}\)/);
  assert.match(menu, /run: \(\) => ctx\.onBoardPicker\(\[uid\], \{mode: 'remove'\}\)/);
});

test('资产右键菜单：注入时出现加入/移出，未注入或访客时自动缺席', () => {
  const base = {model: {uid: 'a', name: 'A', url: ''}, uid: 'a', favorite: false, inLibrary: true, isTrash: false, isVisitor: false};
  // assetMenuItems 返回的是 {title, subtitle, items} 规格对象，不是裸数组。
  const withBoards = assetMenuItems({...base, onBoardPicker: () => {}}).items;
  const labels = withBoards.map(item => item.label).filter(Boolean);
  assert.ok(labels.includes('加入画板…'));
  assert.ok(labels.includes('从画板移出…'));
  for (const label of ['加入画板…', '从画板移出…']) {
    const item = withBoards.find(entry => entry.label === label);
    assert.equal(typeof item.run, 'function', '必须是 run 型，避免动 app.js 的 switch');
    assert.equal(item.action, undefined);
  }
  const noBoards = spec => !(spec?.items || []).some(item => /画板/.test(item.label || ''));
  assert.ok(noBoards(assetMenuItems(base)));
  assert.ok(noBoards(assetMenuItems({...base, isVisitor: true, onBoardPicker: () => {}})));
});

test('面板骨架：滑条、分段、图标按钮，无说明段落', () => {
  const html = boardCollectHtml({icon, esc});
  assert.match(html, /type="range" class="bd-limit"/);
  assert.match(html, /data-group="frequency"/);
  assert.match(html, /data-act="(save|run|merge|reload|close)"/);
  assert.doesNotMatch(html, /<p[^>]*>[\u4e00-\u9fa5]{20,}/, '不允许长说明段落');
});

test('规则卡片：操作全是图标按钮，状态用色点表达', () => {
  const html = ruleCardHtml({rule: {id: 'r-1', name: '石材', boardName: '素材', frequency: 'daily', hour: 9,
    platforms: ['sketchfab'], totalAdded: 3, lastStatus: 'ok', enabled: true}, icon, esc});
  for (const action of ['dry', 'run', 'toggle', 'edit', 'delete']) assert.match(html, new RegExp(`data-act="${action}"`));
  assert.match(html, /bd-status-dot/);
  assert.match(html, /data-status="ok"/);
});

test('待合并顺序：mergeModels → persistNow 成功 → ack → renderGrid，且幂等可重放', () => {
  const source = read('src/library/board-collect.js');
  const merge = source.indexOf('state.models = mergeModels');
  const save = source.indexOf('persistNow();', merge);
  const ack = source.indexOf('api.ack(', save);
  const render = source.indexOf('renderGrid();', ack);
  assert.ok(merge > 0 && save > merge && ack > save && render > ack, '顺序错了会在崩溃时丢资产');
  assert.match(source, /if \(merging\) return 0/, '并发闸门');
  assert.match(source, /if \(!models\.length\) return 0/, '空队列短路');
});

test('面板不用 window.prompt / confirm，能力位缺失有明确重启提示', () => {
  const panel = read('src/library/board-collect.js');
  assert.doesNotMatch(panel, /window\.prompt|window\.confirm/);
  assert.match(panel, /请重启服务到 3\.15\.0/);
  assert.match(read('src/library/board-hub.js'), /智能收集需要新后台：请重启服务到 3\.15\.0/);
});

test('服务端能力位与版本同步，前端检测的是同一个键', () => {
  const cap = read('server/capabilities.mjs');
  // 不写死具体版本：这一批能力位是 3.15.0 引入的，之后每次升版都会 bump SERVER_VERSION，
  // 写死等于每次升版都要回来改测试。校验「是 semver 且不低于引入版本」才是这里真正要守的东西。
  const parts = (cap.match(/SERVER_VERSION = '(\d+)\.(\d+)\.(\d+)'/) || []).slice(1).map(Number);
  assert.equal(parts.length, 3, 'SERVER_VERSION 必须是 x.y.z');
  assert.ok(parts[0] > 3 || (parts[0] === 3 && parts[1] >= 15), `版本不能低于 3.15.0，实际 ${parts.join('.')}`);
  for (const key of ['collectRules', 'collectScheduler', 'collectPendingMerge', 'collectPlatformSearch'])
    assert.match(cap, new RegExp(`${key}: true`));
  assert.match(read('src/library/board-hub.js'), /cap\?\.collectRules/);
});
