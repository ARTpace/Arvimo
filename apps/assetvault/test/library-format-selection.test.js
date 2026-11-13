// 格式筛选交互协议：一个逗号字符串 = 全部状态（Serpent MIT 语义移植）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseFormatTokens, compactFormatFilterTokens, formatTokensHas,
  toggleFormatToken, formatGroupSelectionState, toggleFormatGroup,
  formatFilterHasUnknownToken, expandFormatFilterTokens, buildFormatFilter,
  matchesFormatFilter, describeFormatFilter, MAX_FORMAT_FILTER_VALUES,
} from '../src/library/format-filter-selection.js';
import {createFormatFilterState, FORMAT_FILTER_STORAGE_KEY} from '../src/library/format-filter.js';
import {FORMAT_TEXT_TOKEN, FORMAT_UNKNOWN_TOKEN, TEXT_EXTS} from '../src/library/format-registry.js';

const fakeStorage = () => {
  const map = new Map();
  return {
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value)),
    get size() { return map.size; },
  };
};

test('token 解析：逗号 / 中文逗号 / 空格 / 前导点 / 大小写 / 去重', () => {
  assert.deepEqual(parseFormatTokens('png, jpg, mp4'), ['png', 'jpg', 'mp4']);
  assert.deepEqual(parseFormatTokens('.PNG，mp4; cr3'), ['png', 'mp4', 'cr3']);
  assert.deepEqual(compactFormatFilterTokens(['png', '.PNG', 'jpg', '']), ['png', 'jpg']);
  assert.equal(formatTokensHas('PNG, jpg', '.png'), true);
  assert.equal(formatTokensHas('PNG, jpg', 'gif'), false);
  assert.equal(compactFormatFilterTokens(Array.from({length: 300}, (_, i) => `e${i}`)).length, MAX_FORMAT_FILTER_VALUES);
});

test('普通点击只选一个 / 再点清空；Shift 点击累加与移除', () => {
  assert.equal(toggleFormatToken('', 'png'), 'png');
  assert.equal(toggleFormatToken('png', 'png'), '');
  assert.equal(toggleFormatToken('png, jpg', 'gif'), 'gif');
  assert.equal(toggleFormatToken('png', 'jpg', true), 'png, jpg');
  assert.equal(toggleFormatToken('png, jpg', 'jpg', true), 'png');
  assert.equal(toggleFormatToken('png', FORMAT_TEXT_TOKEN, true), `png, ${FORMAT_TEXT_TOKEN}`);
});

test('分组三态与整组开关：全选清本组、半选并齐、其它组不动', () => {
  assert.equal(formatGroupSelectionState('', ['png', 'jpg']), 'none');
  assert.equal(formatGroupSelectionState('png', ['png', 'jpg']), 'partial');
  assert.equal(formatGroupSelectionState('png, jpg', ['png', 'jpg']), 'all');
  assert.deepEqual(parseFormatTokens(toggleFormatGroup('mp4', ['png', 'jpg'])), ['mp4', 'png', 'jpg']);
  assert.deepEqual(parseFormatTokens(toggleFormatGroup('png, jpg, mp4', ['png', 'jpg'])), ['mp4']);
});

test('text 在查询层展开 43 项，unknown 不进正向后缀', () => {
  const expanded = expandFormatFilterTokens([FORMAT_TEXT_TOKEN, FORMAT_UNKNOWN_TOKEN, 'png']);
  assert.equal(expanded.length, TEXT_EXTS.length + 1);
  assert.ok(expanded.includes('plist') && expanded.includes('md'));
  assert.ok(!expanded.includes(FORMAT_UNKNOWN_TOKEN));
  assert.equal(formatFilterHasUnknownToken('png, unknown'), true);
  assert.equal(formatFilterHasUnknownToken(['png']), false);
});

test('matchesFormatFilter：正向 / 排除 / 其他 / 未激活', () => {
  const pick = buildFormatFilter(['png', 'jpg']);
  assert.equal(matchesFormatFilter(['png'], pick), true);
  assert.equal(matchesFormatFilter(['gif'], pick), false);
  assert.equal(matchesFormatFilter(['gif'], buildFormatFilter(['png'], true)), true);
  assert.equal(matchesFormatFilter(['png'], buildFormatFilter(['png'], true)), false);
  assert.equal(matchesFormatFilter(['bin'], buildFormatFilter([FORMAT_UNKNOWN_TOKEN])), true);
  assert.equal(matchesFormatFilter(['png'], buildFormatFilter([FORMAT_UNKNOWN_TOKEN])), false);
  assert.equal(matchesFormatFilter(['bin'], buildFormatFilter([FORMAT_UNKNOWN_TOKEN], true)), false);
  assert.equal(matchesFormatFilter(['md'], buildFormatFilter([FORMAT_TEXT_TOKEN])), true);
  assert.equal(matchesFormatFilter(['bin'], buildFormatFilter([])), true, '未激活的筛选恒放行（兼容老请求）');
  assert.equal(matchesFormatFilter(['bin'], undefined), true);
});

test('describeFormatFilter 把 text/unknown 换中文、排除态加前缀', () => {
  assert.equal(describeFormatFilter([], false), '未选择格式');
  assert.equal(describeFormatFilter(['png', FORMAT_TEXT_TOKEN]), '.png、文本');
  assert.match(describeFormatFilter(['png'], true), /^排除 /);
});

test('状态实例：持久化、清除、matcher 与本地网格共用一个语义', () => {
  const storage = fakeStorage();
  const state = createFormatFilterState({storage});
  assert.equal(state.isEmpty(), true);
  state.setValue('png, jpg');
  state.setExclude(true);
  assert.deepEqual(state.filter(), {formats: ['png', 'jpg'], excludeFormats: true});
  assert.equal(state.matches(['png']), false, '排除模式下 png 不通过');
  assert.equal(state.matches(['gif']), true);
  const restored = createFormatFilterState({storage});
  assert.equal(restored.value, 'png, jpg');
  assert.equal(restored.exclude, true);
  state.clear();
  assert.equal(state.isEmpty(), true);
  assert.equal(state.exclude, false);
  assert.equal(createFormatFilterState({storage}).isEmpty(), true);
  assert.ok(JSON.parse(storage.getItem(FORMAT_FILTER_STORAGE_KEY)).version === 1);
});

test('坏存档 / 只读存储不会让面板状态崩掉', () => {
  const broken = {getItem: () => '{bad json', setItem: () => {throw Error('quota');}};
  const state = createFormatFilterState({storage: broken});
  assert.equal(state.isEmpty(), true);
  state.setValue('png');
  assert.equal(state.value, 'png');
});

test('UI 组件钉住关键交互：点选即累加、分组三态、排除、文本 chip、本地持久化', () => {
  const ui = fs.readFileSync(new URL('../src/library/format-filter.js', import.meta.url), 'utf8');
  for (const pattern of [
    /toggleFormatToken\(filter\.value, button\.dataset\.ext, true\)/,
    /box\.dataset\.state = state/,
    /button\.dataset\.state = state/,
    /toggleFormatGroup\(filter\.value, \[FORMAT_UNKNOWN_TOKEN\]\)/,
    /excludeBox\.disabled = tokens\.length === 0/,
    /FORMAT_TEXT_TOKEN \? '文本'/,
    /storage\?\.setItem\(key, JSON\.stringify/,
    /data-origin="\$\{meta\.origin\}"/,
    /本库扩展 · /,
    /fv-tabs/,
    /fmt-custom-toggle/,
    /showGroup\(/,
  ]) assert.match(ui, pattern, `格式面板缺交互：${pattern}`);
});
