import {assembleLibraryStyles} from '../scripts/lib/library-styles.mjs';
// 回归守卫：预览弹窗重构给 <iframe id="viewer"> 加了 hidden 之后，
// 平台自带 viewer 的路径（Sketchfab / ambientCG / SBSAR / ArtStation Marmoset）
// 不走 gltfPreview.prepareStage()，曾全部永久停在「正在加载模型…」。
// 顺带守住瀑布流比例纠正链，以及 self-check --fix 的白名单边界。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const lv = read('src/library/library-view.js');
const as = read('src/library/artstation-ui.js');
const html = read('src/library/index.html');
const css = assembleLibraryStyles();
const sc = read('scripts/self-check.mjs');

test('iframe 默认 hidden 必须有成对的舞台切换', () => {
  assert.match(html, /id="viewer"[^>]*\shidden\b/, '#viewer 保留 hidden 作为默认态');
  const body = lv.match(/function showFrameStage\(\)\{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(body, /canvas\.hidden=true/, '藏掉 three.js 画布');
  assert.match(body, /frame\.hidden=false/, '必须放开 iframe，否则弹窗永远黑底');
  assert.match(body, /state\.textContent=''/, '必须清掉「正在加载模型…」占位');
});

test('平台自带 viewer 的路径都切舞台，提示写进 #state', () => {
  const calls = lv.match(/showFrameStage\(\);/g) || [];
  assert.ok(calls.length >= 4,
    `只有 ${calls.length} 处调用；Sketchfab 通用分支 / ambientCG 两条 / SBSAR 都必须切`);
  assert.match(lv, /function notePreview\(/, '提示统一走 notePreview');
  assert.match(lv, /getElementById\('state'\)/, '新弹窗只有 #state，没有 .viewer-hint');
});

test('ArtStation Marmoset 路径自己放开 iframe', () => {
  const start = as.indexOf('async function openPreview');
  assert.ok(start >= 0, 'openPreview 存在');
  // openPreview 里 model-details 的 innerHTML 模板很长，切片要盖到 catch 分支。
  const body = as.slice(start, start + 3000);
  assert.match(body, /stageCanvas\.hidden=true/, '藏画布');
  assert.match(body, /frame\.hidden=false/, '放开 iframe');
  assert.match(body, /stageState\.textContent=''/, '清加载提示');
  assert.match(body, /catch\(e\)\{if\(stageState\)/, '失败信息也要写进 #state');
});

test('瀑布流比例纠正链不能被缩略图尺寸覆盖', () => {
  assert.match(lv, /const itemRatio=aspectRatioStyle\(node\.dataset\.w,node\.dataset\.h\);/);
  assert.match(lv, /if\(itemRatio\)return;/, '条目自带原图宽高时，不许用 thumb 的自然尺寸覆盖');
  assert.match(lv, /node\.videoWidth/, 'video 走 loadedmetadata');
  assert.match(lv, /node\.decode\?\.\(\)/, 'lazy 图用 decode 兜底');
  assert.match(lv, /placeholder\.style\.aspectRatio=ratio/, '裂图占位继承条目比例');
  assert.match(css, /\.gallery \.thumbnail\{[^}]*aspect-ratio:auto/, '瀑布流不能锁成 1:1');
});

test('self-check 默认检测完自动修复，且白名单不越界', () => {
  assert.match(sc, /const fixMode = !argv\.includes\('--no-fix'\)/, '默认开启修复');
  assert.match(sc, /const apply = fixMode && !argv\.includes\('--dry-run'\)/, '默认直接执行，不等确认');
  assert.match(sc, /id: 'build', auto: true, command: 'npm run build:library'/);
  assert.match(sc, /id: 'probe-retry', auto: true/, '平台假阳性自动重试');
  const autos = [...sc.matchAll(/id: '([a-z-]+)', auto: true/g)].map(m => m[1]);
  assert.deepEqual(autos.sort(), ['build', 'probe-retry'],
    '自动动作只允许这两个；新增前先评审幂等性与回滚路径');
  assert.match(sc, /补录等于伪造来源，禁止自动修/, 'info.json 来源凭证永久排除在白名单外');
  assert.match(sc, /results\.FAIL--; results\.OK\+\+/, '重试恢复后要重算汇总');
  assert.match(sc, /不等待确认/, '不允许残留确认门槛');
});

test('自检扩展组已接入，且不扩大自动修复白名单', () => {
  const extra = read('scripts/self-check-extra.mjs');
  assert.match(sc, /checkServerExtras\(\{report, root, base, cspInfo: csp\}\)/, '组 1 补充判据');
  assert.match(sc, /await checkRuntime\(ctx\)/, '组 6 运行时能力');
  assert.match(sc, /checkRegression\(ctx\)/, '组 7 关键回归');
  assert.match(sc, /artifactIssues\(root\)\.length === 0/, 'build 复验要包含两份产物字节一致');
  assert.match(sc, /function buildStale\(\) \{\n  const parity = artifactIssues\(root\)/,
    '两份产物不一致必须能触发 build 自动修复');
  assert.match(extra, /逐个独立进程/, '回归子集必须隔离，不能多文件共用同一 node --test 进程');
  assert.match(extra, /engine 是固定标识/, 'health.engine 不是降级信号，别误报');
  assert.match(extra, /免登录平台，无 cookie 依赖/, '平台 FAIL 要能拆出登录态归因');
  const autos = [...sc.matchAll(/id: '([a-z-]+)', auto: true/g)].map(m => m[1]);
  assert.deepEqual(autos.sort(), ['build', 'probe-retry'],
    '新增检查组不得偷偷扩大自动动作白名单');
});

// 0.1.15 那次事故的形态：产物里 has3dScene 分支被换成图片画廊，组 2 的静态断言全绿。
// 这条守的是「八条平台预览路径都在产物里」，而且要容忍构建改写标识符（gltfPreview2）。
test('3D 预览矩阵守住八条平台预览路由', () => {
  const extra = read('scripts/self-check-extra.mjs');
  assert.match(extra, /previewMatrix: '\[3\/\d+\] 3D 预览矩阵'/, '组表要有预览矩阵（第 3 组）');
  assert.match(extra, /export async function checkPreviewMatrix/, '矩阵检查函数要导出');
  const routes = [...extra.matchAll(/\['(Sketchfab|ArtStation|ambientCG|PolyHaven|FreeStylized|SimReady|Polyfork|SBSAR)', \/(.+?)\/\],/g)];
  assert.equal(routes.length, 8, '八个平台的预览路径一条都不能少');
  const byName = Object.fromEntries(routes.map(m => [m[1], m[2]]));
  assert.match(byName.ArtStation, /artstationUI\\d\*/, '产物会改写成 artstationUI2，判据要容忍序号');
  assert.match(byName.PolyHaven, /gltfPreview\\d\*\\\.load\\\(/, '不能绑死 gltfPreview 变量名');
  assert.match(byName.SimReady, /loadSimready/, 'SimReady 走本地 USD 渲染');
  assert.match(byName.SBSAR, /loadSubstance/, 'SBSAR 参数预览路径');
  // 在线 / 离线两条分发路径都要跑矩阵（离线只做路由守卫）
  assert.match(sc, /await checkPreviewMatrix\(\{report, group, log, root, base: null\}\)/, '离线也要有路由守卫');
  assert.match(sc, /base: skipPlatforms \? null : base/, '--skip-platforms 只留路由守卫');
  // 路由覆盖 FAIL 视为产物过期，允许 build 自动重建（其它仍人工）
  assert.match(sc, /f\.group === G\.preview \|\| f\.group === G\.previewMatrix/, '矩阵 FAIL 要能进 build 修复范围');
});

// 搜索框粘链接 → routeLink 归类 → 各通道解析。归错通道的表现是「什么都没解析出来」，
// 不报错，最难排查；这里守的是归类用例表本身别被删薄，以及组确实接进了两条分发路径。
test('链接解析守卫：归类用例 + 站点覆盖 + 规则顺序', () => {
  const extra = read('scripts/self-check-extra.mjs');
  assert.match(extra, /linkRoute: '\[5\/\d+\] 链接解析'/, '组表要有链接解析（第 5 组）');
  assert.match(extra, /export async function checkLinkRouting/, '链接解析检查要导出');
  assert.match(extra, /import\(pathToFileURL\(path\.join\(root, 'src\/library\/platforms\.js'\)\)/, '要 import 真实模块，不要用正则镜像源码');
  assert.match(sc, /await checkLinkRouting\(\{report, group, log, root, base, api, skipLive: skipPlatforms\}\)/, '在线路径要跑');
  assert.match(sc, /await checkLinkRouting\(\{report, group, log, root, base: null\}\)/, '离线路径也要跑归类规则');
  // 关键边界一条都不能少：作者页、保留段、非 URL、协议
  assert.match(extra, /'https:\/\/sketchfab\.com\/someuser', 'sketchfab-user'/, '作者页要落到专属通道');
  assert.match(extra, /'https:\/\/sketchfab\.com\/models', 'sketchfab'/, '保留段不能被当成作者名');
  assert.match(extra, /\['abc', 'invalid'/, '非 URL 要判 invalid');
  assert.match(extra, /'ftp:\/\/a\.com\/x', 'invalid'/, '只收 http/https');
  assert.match(extra, /indexOf\('sketchfab-user'\)/, '要守住具体规则先于泛化规则');
  const cases = [...extra.matchAll(/^\s+\['[^']*', '[a-z-]+',/gm)].length;
  assert.ok(cases >= 13, `归类用例至少 13 条（现有 ${cases}）`);
});
