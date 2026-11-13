// Uiverse 元素落盘：把站上的 html + css 写成一个能直接双击打开的小工程。
//
// 与图片下载器不同，这里落的是**文本**：一个 index.html（引用 style.css）
// + 一个 style.css（元素的全部样式）+ 一个 README.md（出处、许可、标签）。
//
// 为什么分两个文件而不是塞成一个 html：主人在项目里通常想要 CSS 单独一份
// （贴进自己的样式表、或者改参数），分开最省事；html 里用相对路径引 style.css，
// 双击就能看，也能整个目录拷走。
//
// Tailwind 元素不用特殊处理：站点给的 css 里已经带编译好的 utility 类
// （头部注释写着 tailwindcss v3.4.16），拷出来就是普通 CSS。
import fs from 'node:fs/promises';
import path from 'node:path';
import {fetchUiverseElement} from './uiverse.mjs';
import {buildStandaloneFiles, UIVERSE_TYPE_LABELS} from './uiverse-state.mjs';

const ORIGIN = 'https://uiverse.io';

/** 文件名里不能出现的字符（Windows 限制最严）。 */
function safeName(raw) {
  const cleaned = String(raw || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim();
  return (cleaned || 'uiverse-element').slice(0, 80);
}

/** README：写清出处与许可，社区素材的署名是基本要求。 */
function readme(meta, { html, css }) {
  const typeLabel = UIVERSE_TYPE_LABELS[meta.elementType] || 'UI 组件';
  const lines = [
    `# ${typeLabel} · ${meta.slug}`,
    '',
    `- **来源**：${meta.pageUrl}`,
    `- **作者**：${meta.authorName || meta.username}${meta.authorUrl ? `（${meta.authorUrl}）` : ''}`,
    `- **类型**：${typeLabel}`,
    `- **主题**：${meta.theme || '未标注'}`,
    `- **许可**：Uiverse 社区作品，可自由复制使用；商用前请到来源页确认作者声明`,
    `- **采集时间**：${new Date().toISOString()}`,
  ];
  if (meta.tags.length) lines.push(`- **标签**：${meta.tags.join('、')}`);
  if (meta.viewCount) lines.push(`- **站内浏览量**：${meta.viewCount}`);
  lines.push(
    '',
    '## 文件',
    '',
    '- `index.html` — 元素结构，双击即可预览',
    '- `style.css` — 全部样式（含动效关键帧）',
    '',
    '## 用法',
    '',
    '把 `index.html` 里的结构与 `style.css` 的内容并入自己的项目即可；',
    '两者是独立的，没有外部依赖。',
    '',
    `<!-- HTML（${html.length} 字节） -->`,
    '```html',
    html,
    '```',
    '',
    `<!-- CSS（${css.length} 字节） -->`,
    '```css',
    css,
    '```',
    ''
  );
  return lines.join('\n');
}

/**
 * 落盘一个 Uiverse 元素。
 *
 * 参数与其它 runner 保持一致（uid / output / progress），这样能直接挂进下载队列。
 * 返回值给出目录名，队列据此在任务卡上显示。
 */
export async function runUiverseJob({ uid, url, output, options, name, author, tags }, { signal, progress = () => {} } = {}) {
  signal?.throwIfAborted();
  if (!url) throw Error('Uiverse 元素链接缺失');

  // 从链接里取用户名与 slug：uiverse.io/{username}/{slug}
  const match = String(url).match(/uiverse\.io\/([A-Za-z0-9_-]+)\/([a-z0-9]+-[a-z0-9]+-\d+)/i);
  if (!match) throw Error(`无法从链接里读出 Uiverse 元素（${url}）。请用 https://uiverse.io/用户名/元素名 这样的地址`);
  const [, username, slug] = match;

  await fs.mkdir(output, { recursive: true });
  progress({ stage: 'starting', message: `正在读取 Uiverse 元素（${slug}）…` });

  const { meta, code } = await fetchUiverseElement(username, slug, { signal });
  if (!code.html && !code.css) throw Error('这个 Uiverse 元素没有可下载的代码');

  const title = name || `${UIVERSE_TYPE_LABELS[meta.elementType] || 'UI 组件'} · ${slug}`;
  const folder = safeName(title);
  const dir = path.join(output, folder);
  await fs.mkdir(dir, { recursive: true });

  progress({ stage: 'transferring', message: '正在写入样式与结构…' });
  const files = buildStandaloneFiles({ html: code.html, css: code.css, title });
  await fs.writeFile(path.join(dir, 'index.html'), files.html, 'utf8');
  await fs.writeFile(path.join(dir, 'style.css'), files.css, 'utf8');
  await fs.writeFile(path.join(dir, 'README.md'), readme(meta, code), 'utf8');

  const metaJson = {
    uid,
    kind: 'uielement',
    platform: 'uiverse',
    assetId: meta.id,
    name: title,
    author: author || meta.authorName || meta.username,
    url: meta.pageUrl || url,
    elementType: meta.elementType,
    theme: meta.theme,
    isTailwind: meta.isTailwind,
    tags: [...new Set([...(Array.isArray(tags) ? tags : []), ...meta.tags])],
    license: 'Uiverse 社区作品 · 可自由复制使用',
    files: [
      { file: 'index.html', bytes: Buffer.byteLength(files.html) },
      { file: 'style.css', bytes: Buffer.byteLength(files.css) },
      { file: 'README.md', bytes: Buffer.byteLength(readme(meta, code)) },
    ],
    exportedAt: new Date().toISOString(),
    tool: 'AssetVault · Uiverse',
  };
  await fs.writeFile(path.join(dir, 'info.json'), JSON.stringify(metaJson, null, 2), 'utf8');

  progress({ stage: 'saving', message: `已保存 ${folder}` });
  return { folderName: folder };
}
