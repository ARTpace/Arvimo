// 文档渲染纯策略层 + 注册表接线：不加载浏览器库，Node 里可直接跑。
// 重点锁住三件容易退回坑里的事：md 走 markdown 渲染、净化必被调用、外链不跳出弹窗。
import test from 'node:test';
import assert from 'node:assert/strict';
import {FORMATS, formatOf, formatKind, TEXT_EXTS, createFormatRegistry, formatFilterGroups} from '../src/library/format-registry.js';
import {
  DOC_RENDER_MODES, docRenderModeOf, MARKED_OPTIONS, PURIFY_OPTIONS, DOCX_OPTIONS,
  EPUB_OPTIONS, DOC_HINTS, markdownToHtml, hardenLinks, docFailureHint, extLabel,
  DOC_CONVERT_UNAVAILABLE_HINT,
} from '../src/library/doc-render-state.js';
import {DOC_PDF_EXTS, canConvertDoc} from '../server/doc-convert.mjs';

test('注册表：md / markdown 升级为排版渲染，其余文本仍是纯文本', () => {
  assert.equal(formatOf('a.md')?.preview, 'markdown');
  assert.equal(formatOf('a.MARKDOWN')?.preview, 'markdown');
  assert.equal(formatOf('a.txt')?.preview, 'text');
  assert.equal(formatOf('a.json')?.preview, 'text');
  assert.equal(formatOf('a.md')?.kind, 'document', 'md 仍归 document，openFile 才能进文档分支');
  assert.equal(formatOf('a.md')?.origin, 'ref', 'md 是参考清单文本后缀，不该标成本库格式');
  // 文本 token 的 43 项没被拆散：清单完整性与 UI 分组都保持原样。
  assert.equal(TEXT_EXTS.length, 43);
  assert.equal(formatFilterGroups().find(group => group.id === 'text'), undefined,
    'text 组只以 token 形式出现在杂项，不单独成组');
});

test('注册表：新增文档格式都归 document 组且元数据完整', () => {
  const browserRendered = {docx: 'docx', epub: 'epub'};
  for (const [ext, mode] of Object.entries(browserRendered)) {
    const item = formatOf(`a.${ext}`);
    assert.ok(item, `缺格式 ${ext}`);
    assert.equal(item.preview, mode);
    assert.equal(item.group, 'document');
    assert.equal(item.kind, 'document');
    assert.match(item.mime, /^[a-z]+\/[\w.+-]+$/);
    assert.equal(item.origin, 'local');
  }
  for (const ext of DOC_PDF_EXTS) {
    const item = formatOf(`a.${ext}`);
    assert.equal(item?.preview, 'doc-pdf', `${ext} 应走 LibreOffice 转 PDF`);
    assert.equal(item?.group, 'document');
    assert.equal(item?.kind, 'document');
    assert.equal(item?.origin, 'local');
  }
  // 转换白名单必须从注册表派生，不能手写第二份清单。
  assert.deepEqual([...DOC_PDF_EXTS].sort(),
    Object.values(FORMATS).filter(item => item.preview === 'doc-pdf').map(item => item.ext).sort());
  assert.ok(canConvertDoc('报告.PPTX'));
  assert.ok(!canConvertDoc('a.docx'), 'docx 走浏览器渲染，不该喂给 soffice');
  assert.ok(!canConvertDoc('a.pdf'));
  assert.ok(!canConvertDoc('a.bin'));
});

test('docRenderModeOf 是唯一分派表，且与注册表一一对应', () => {
  for (const [mode, id] of Object.entries(DOC_RENDER_MODES)) assert.equal(docRenderModeOf(mode), id);
  assert.equal(docRenderModeOf('text'), null);
  assert.equal(docRenderModeOf('pdf'), null);
  assert.equal(docRenderModeOf('none'), null);
  for (const item of Object.values(FORMATS)) {
    if (['markdown', 'docx', 'epub', 'doc-pdf'].includes(item.preview)) {
      assert.ok(docRenderModeOf(item.preview), `${item.ext} 的 preview 没进分派表`);
    }
  }
});

test('markdown 必过净化：marked 输出原样交给 purify，配置禁脚本/内联样式', () => {
  let seen = null;
  const fakeMarked = {parse: (text, options) => { seen = {text, options}; return `<h1>Hi</h1><script>alert(1)</script>`; }};
  const fakePurify = {sanitize: (html, options) => { seen.purified = html; seen.purifyOptions = options; return `<h1>Hi</h1>`; }};
  const out = markdownToHtml('# Hi', {marked: fakeMarked, purify: fakePurify});
  assert.equal(out, '<h1>Hi</h1>', '返回的是净化后的 HTML，不是 marked 原文');
  assert.equal(seen.text, '# Hi');
  assert.equal(seen.options, MARKED_OPTIONS);
  assert.match(seen.purified, /<script>/, '净化器确实收到了含脚本的原文');
  assert.equal(seen.purifyOptions, PURIFY_OPTIONS);
  assert.equal(MARKED_OPTIONS.gfm, true);
  assert.ok(PURIFY_OPTIONS.FORBID_TAGS.includes('script'));
  assert.ok(PURIFY_OPTIONS.FORBID_TAGS.includes('style'));
  assert.equal(PURIFY_OPTIONS.ALLOW_DATA_ATTR, false);
  // 默认 DOMPurify 会放行 data: SVG，这里必须收紧到只 http/https/mailto/锚点。
  assert.ok(PURIFY_OPTIONS.ALLOWED_URI_REGEXP.test('https://example.com'));
  assert.ok(PURIFY_OPTIONS.ALLOWED_URI_REGEXP.test('mailto:a@b.c'));
  assert.ok(!PURIFY_OPTIONS.ALLOWED_URI_REGEXP.test('javascript:alert(1)'));
  assert.ok(!PURIFY_OPTIONS.ALLOWED_URI_REGEXP.test('data:image/svg+xml,<svg/>'));
});

test('hardenLinks：只给 http(s) 外链补 target/rel，锚点与 mailto 不动', () => {
  // 最小 DOMParser 假实现：只需要 querySelectorAll('a[href]') 与 get/setAttribute。
  // 注入构造器而非 window/document —— 曾经传成 document 导致真浏览器里整条渲染链断掉。
  const captured = [];
  class FakeDOMParser {
    parseFromString(html) {
      const make = href => {
        const attrs = {href};
        return {getAttribute: k => attrs[k] ?? null,
          setAttribute: (k, v) => { attrs[k] = v; captured.push([href, k, v]); }};
      };
      return {querySelectorAll: () => [make('https://a.com'), make('mailto:x@y.z'), make('#top'), make('ftp://f')],
        body: {innerHTML: html}};
    }
  }
  const html = '<a href="https://a.com">A</a>';
  assert.equal(hardenLinks(html, FakeDOMParser), html);
  assert.deepEqual(captured, [
    ['https://a.com', 'target', '_blank'],
    ['https://a.com', 'rel', 'noopener noreferrer'],
  ], '只有 http(s) 外链被加固，mailto / 锚点 / ftp 全不动');
});

test('渲染库配置：docx 白纸分页、epub 不开放脚本', () => {
  assert.equal(DOCX_OPTIONS.experimental, false);
  assert.equal(DOCX_OPTIONS.useBase64URL, true, '图片走 data: 才能过 CSP');
  assert.equal(DOCX_OPTIONS.breakPages, true);
  assert.equal(EPUB_OPTIONS.allowScriptedContent, false, 'epubjs iframe 不能给 allow-scripts');
  assert.equal(EPUB_OPTIONS.allowPopups, false);
});

test('提示文案：四种渲染器都有中文提示，失败文案带扩展名且可操作', () => {
  for (const mode of Object.keys(DOC_RENDER_MODES)) {
    assert.ok(DOC_HINTS[mode], `${mode} 缺提示`);
    assert.match(docFailureHint(mode, 'pptx'), /PPTX/);
  }
  assert.match(DOC_CONVERT_UNAVAILABLE_HINT, /LibreOffice/, '没装 LO 时要能说出装什么');
  assert.equal(extLabel('书.EPUB'), 'epub');
  assert.equal(extLabel('C:\\docs\\报告.DOCX'), 'docx');
  assert.equal(extLabel('noext'), '');
});

test('扩展缝：overrides 仍能改新格式的 preview，且不污染默认注册表', () => {
  const custom = createFormatRegistry({overrides: {docx: {preview: 'text'}}});
  assert.equal(custom.get('a.docx').preview, 'text');
  assert.equal(formatOf('a.docx').preview, 'docx');
});
