import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import * as esbuild from 'esbuild';

const root = new URL('../', import.meta.url);
const output = new URL('design/card-ui/', root);
const names = ['asset-card', 'album-card', 'album-folder-card', 'board-card'];
const labels = ['普通资产卡', '图集', '图集文件夹', '画板'];
const styles = {};
for (const name of names) {
  const css = await fs.readFile(new URL(`src/library/cards/${name}.css`, root), 'utf8');
  // HTML 是可独立编辑的副本；恢复源文件各段的响应式作用域，不需要生产构建占位符。
  let scope = '';
  let expanded = '';
  // 单独读取每段之前的作用域注释，避免将 @section 当作普通说明。
  const sections = [...css.matchAll(/\/\* @section [\w-]+ \*\/\r?\n([\s\S]*?)\/\* @endsection \*\//g)];
  let cursor = 0;
  for (const section of sections) {
    const comments = [...css.slice(cursor, section.index).matchAll(/\/\* ([^\n]*?) \*\//g)];
    scope = comments.at(-1)?.[1] || '';
    expanded += /^@(media|supports|container)\b/.test(scope) ? `${scope}{\n${section[1]}\n}\n` : `${section[1]}\n`;
    cursor = section.index + section[0].length;
  }
  styles[name] = (await esbuild.transform(expanded, {loader:'css', minify:false})).code;
}

const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${{
  edit:'<path d="m15 5 4 4M4 20l4-1L20 7l-4-4L4 15z"/>',
  trash:'<path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 10v7m4-7v7"/>',
  layers:'<path d="m3 8 9-5 9 5-9 5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  heart:'<path d="M20 5c-3-3-6-1-8 1-2-2-5-4-8-1-4 4 1 9 8 15 7-6 12-11 8-15z"/>',
}[name]}</svg>`;
const image = i => {
  const colors = ['#b8d1a1','#d4b67e','#a9c6db','#c4b1d9','#97c9b9','#d8aaa2','#a2b3d5','#cecd95','#d1b5c3'];
  const shape = i % 3 === 0
    ? '<path d="M128 40 182 78 169 151 128 202 77 160 69 87Z"/><path d="m128 40 3 76 51-38m-51 38 38 35m-38-35-54 44m54-44-62-29m62 29-3 86" fill="none" stroke="#25343a" stroke-width="6"/>'
    : i % 3 === 1
      ? '<path d="M128 33 192 155 128 220 64 155Z"/><path d="M128 62v119m-38-41 38 41 38-41" fill="none" stroke="#26333c" stroke-width="9"/>'
      : '<g transform="translate(128 128)"><ellipse cy="-45" rx="30" ry="56"/><ellipse cy="-45" rx="30" ry="56" transform="rotate(72)"/><ellipse cy="-45" rx="30" ry="56" transform="rotate(144)"/><ellipse cy="-45" rx="30" ry="56" transform="rotate(216)"/><ellipse cy="-45" rx="30" ry="56" transform="rotate(288)"/><circle r="24" fill="#25313b"/></g>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><radialGradient id="bg"><stop stop-color="#293842"/><stop offset="1" stop-color="#121b24"/></radialGradient></defs><path fill="url(#bg)" d="M0 0h256v256H0z"/><g fill="${colors[i % colors.length]}" stroke="${colors[i % colors.length]}" stroke-linejoin="round" stroke-width="2">${shape}</g></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
};
const img = (i, cls='') => `<img class="${cls}" src="${image(i)}" alt="" draggable="false">`;
const tiles = () => `<div class="pkg-collage">${Array.from({length:9},(_,i)=>`<div class="pkg-tile">${img(i,'pkg-tile-img')}</div>`).join('')}</div>`;
const resize = '<button class="pkg-resize" aria-label="拖动调整卡片布局" title="拖动调整卡片布局"></button>';
const markup = {
  'asset-card':`<article class="model-card" tabindex="0"><div class="card-media">${img(0,'thumbnail')}<button class="favorite" aria-label="收藏">${icon('heart')}</button></div><div class="card-meta"><button class="card-title">风格化岩石 · 山地</button><div class="card-author">3D 资产 · 本地素材</div><div class="card-bottom"><span class="license-tag">FBX</span><span class="card-source">2K</span></div></div></article>`,
  'album-card':`<article class="model-card pkg-collection pkg-foot pkg-c4" tabindex="0"><div class="card-media">${tiles()}<div class="card-foot"><div class="card-foot-title">风格化符文</div><div class="card-foot-sub">9 张图片</div></div></div>${resize}</article>`,
  'album-folder-card':`<article class="model-card album-folder-card pkg-collection pkg-c4" tabindex="0"><div class="album-folder-stack"><div class="album-folder-covers">${tiles()}</div><div class="album-folder-caption"><strong>图案与纹饰</strong><span class="album-folder-count">14 个图集</span></div></div>${resize}</article>`,
  'board-card':`<article class="bd-card" tabindex="0"><div class="bd-card-cover">${img(2)}<div class="bd-card-foot"><strong>场景灵感</strong><span class="bd-card-meta">7 个资产</span></div></div><div class="bd-card-strip">${[1,3,4].map(i=>`<span class="bd-card-thumb">${img(i)}</span>`).join('')}</div><button class="bd-card-tool bd-card-canvas" aria-label="打开画布">${icon('layers')}</button><span class="bd-card-tools"><button class="bd-card-tool" aria-label="编辑画板">${icon('edit')}</button><button class="bd-card-tool" aria-label="删除画板">${icon('trash')}</button></span></article>`,
};
const shellCss = `
:root{color-scheme:dark;--accent:#c9f581;--text:#e7eaf0;--muted:#8893a3;--border:#27303d;--av-panel-raised:#151c25;--av-panel-hover:#1b222c;--lib-media-ratio:1;--lib-col-min:200px;--lib-gap-x:12px;--lib-gap-y:14px;font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;color:var(--text);background:#0d1218}
*{box-sizing:border-box}body{margin:0;padding:36px clamp(20px,5vw,72px)}button,a{font:inherit;color:inherit}button{display:inline-flex;align-items:center;justify-content:center;cursor:pointer;border:0;background:none}button:focus-visible,article:focus-visible{outline:2px solid var(--accent);outline-offset:4px}svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}img{display:block;max-width:100%}i{display:inline-flex;width:18px;height:18px}h1{font-size:24px;font-weight:600;margin:0}header>p{color:var(--muted);margin:6px 0 20px}nav{display:flex;gap:18px;flex-wrap:wrap}nav a{color:#a8b5c0;text-decoration:none;font-size:12px}nav a:hover{color:var(--accent)}.preview-grid{display:flex;flex-wrap:wrap;align-items:flex-start;gap:40px;margin-top:42px}.preview-section{width:260px;flex:0 0 260px}.preview-section h2{font-size:13px;font-weight:500;color:#9caaba;margin:0 0 24px}.preview-stage{width:232px;padding-top:8px}.preview-stage>.model-card{width:100%}.preview-layouts{display:flex;align-items:center;gap:8px;margin:22px 0 0}.preview-layouts button{padding:3px 0;color:#7e8c99;font-size:12px}.preview-layouts button:hover,.preview-layouts button[aria-pressed=true]{color:var(--accent)}.pkg-c4 .pkg-tile:nth-child(n+5),.pkg-c6 .pkg-tile:nth-child(n+7){display:none}.preview-stage>.pkg-c6 .pkg-collage{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr))}.preview-stage>.pkg-c6.pkg-wide .pkg-collage{grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr))}.preview-stage .pkg-resize{cursor:nwse-resize}.preview-section:has(.pkg-wide),.preview-section:has(.pkg-c9){width:360px;flex-basis:360px}.preview-stage:has(.pkg-wide),.preview-stage:has(.pkg-c9){width:336px}@media(max-width:460px){.preview-section,.preview-section:has(.pkg-wide),.preview-section:has(.pkg-c9){width:100%;flex-basis:100%}.preview-stage,.preview-stage:has(.pkg-wide),.preview-stage:has(.pkg-c9){max-width:100%}}`;
const behavior = `
function setLayout(section,mode){const card=section.querySelector('.pkg-collection');card.classList.remove('pkg-c4','pkg-c6','pkg-c9','pkg-wide');card.classList.add('pkg-c'+mode[0]);if(mode==='6h')card.classList.add('pkg-wide');section.querySelectorAll('[data-layout]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.layout===mode)));}
document.querySelectorAll('[data-layout]').forEach(b=>b.onclick=()=>setLayout(b.closest('.preview-section'),b.dataset.layout));
document.querySelectorAll('.favorite').forEach(b=>b.onclick=()=>{b.classList.toggle('saved');b.setAttribute('aria-pressed',String(b.classList.contains('saved')));});
document.querySelectorAll('.pkg-resize').forEach(handle=>handle.onpointerdown=e=>{e.preventDefault();const section=handle.closest('.preview-section'),x=e.clientX,y=e.clientY;handle.setPointerCapture(e.pointerId);handle.onpointermove=move=>{const dx=move.clientX-x,dy=move.clientY-y;if(Math.abs(dx)<22&&Math.abs(dy)<22)return;setLayout(section,dx>90&&dy>90?'9':dx>35&&dx>dy?'6h':dy>35?'6v':'4');};handle.onpointerup=handle.onpointercancel=()=>{handle.onpointermove=null;};});`;

function section(name) {
  const layouts = name.includes('album') ? `<div class="preview-layouts">${[['4','四宫'],['6v','竖六宫'],['6h','横六宫'],['9','九宫']].map(([value,label])=>`<button data-layout="${value}" aria-pressed="${value==='4'}">${label}</button>`).join('')}</div>` : '';
  return `<section class="preview-section"><h2>${labels[names.indexOf(name)]}</h2><div class="preview-stage">${markup[name]}</div>${layouts}</section>`;
}
function html(selected) {
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Arvimo · 卡片 UI 预览</title>\n<style id="preview-shell">${shellCss}</style>\n${names.map((n,i)=>`<!-- ${labels[i]}：直接编辑下面这段 CSS。普通资产样式也包含共用基础。 -->\n<style id="${n}-styles">\n${styles[n]}</style>`).join('\n')}\n</head><body><header><h1>卡片 UI 预览</h1><p>悬停查看交互，切换宫格对比布局。</p><nav><a href="index.html">全部卡片</a>${names.map((n,i)=>`<a href="${n}.html">${labels[i]}</a>`).join('')}</nav></header><div class="preview-grid">${selected.map(section).join('\n')}</div><script>${behavior}</script></body></html>`;
}
await fs.mkdir(output, {recursive:true});
await fs.writeFile(new URL('index.html', output), html(names));
for (const name of names) await fs.writeFile(new URL(`${name}.html`, output), html([name]));
await fs.writeFile(new URL('README.md', output), '# HTML 卡片设计副本\n\n直接打开 index.html 查看四类卡片，也可以分别打开四个 HTML。所有 CSS、图形和演示脚本均内嵌，可离线打开和独立修改。\n\n每份 HTML 内有 asset-card-styles、album-card-styles、album-folder-card-styles、board-card-styles 四个 style 区域。preview-shell 只控制演示页布局。\n\n封面为内嵌 SVG 示例图，不使用或修改资产库数据。悬停、收藏高亮、宫格切换和角标拖动为设计演示；打开画板、编辑、删除等业务动作未接入。\n\n这是 UI 设计副本，修改 HTML 不会自动改变应用。调整后可交回 HTML，再迁移到生产 CSS。重新运行 node scripts/export-card-preview.mjs 会覆盖这些设计副本，请先保留自己的修改。\n');
console.log(`HTML previews exported: ${fileURLToPath(output)}`);
