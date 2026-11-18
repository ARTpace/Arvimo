import {readFileSync} from 'node:fs';

export const cardStyleFiles = ['asset-card', 'album-card', 'album-folder-card', 'board-card'];
const sourceRoot = new URL('../../src/library/', import.meta.url);

// 在原来的级联位置展开样式，避免拆文件改变覆盖顺序。
export function assembleLibraryStyles(root = sourceRoot) {
  const sections = new Map();
  for (const name of cardStyleFiles) {
    const css = readFileSync(new URL(`cards/${name}.css`, root), 'utf8');
    const matches = [...css.matchAll(/\/\* @section ([\w-]+) \*\/\r?\n([\s\S]*?)\/\* @endsection \*\//g)];
    for (const match of matches) {
      const key = `${name}/${match[1]}`;
      if (sections.has(key)) throw new Error(`重复卡片样式段: ${key}`);
      sections.set(key, match[2]);
    }
  }
  const css = readFileSync(new URL('app.css', root), 'utf8');
  const used = new Set();
  const result = css.replace(/\/\* @card-style ([\w-]+\/[\w-]+) \*\//g, (_, key) => {
    if (!sections.has(key)) throw new Error(`缺少卡片样式段: ${key}`);
    if (used.has(key)) throw new Error(`重复引用卡片样式段: ${key}`);
    used.add(key);
    return sections.get(key);
  });
  for (const key of sections.keys()) {
    if (!used.has(key)) throw new Error(`未引用卡片样式段: ${key}`);
  }
  return result.replace(/\/\* @shared-style shortcut-settings \*\//g,()=>readFileSync(new URL('shortcut-settings.css',root),'utf8'));
}
