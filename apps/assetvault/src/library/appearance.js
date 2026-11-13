// 外观：背景（纯色 / 图片）与面板不透明度。
//
// 为什么只动三个 CSS 变量而不做整套主题引擎：界面里几百处颜色是硬编码的深色设计，
// 全量变量化要重写一整份样式表，收益（用户能改主色）与风险（对比度崩、每个面板都要重测）
// 不成比例。用户真正想要的是「换成自己的图 / 让侧栏透一点看见壁纸」——这两个都能靠
// 底色 + 背景图 + 面板 alpha 三个变量做到，且任何一处没覆盖到也只是保持原样。
//
// 存 localStorage 而不是跟资产库数据一起同步：外观属于「这台机器这块屏」，同一份库在
// 台式机（大屏壁纸）和笔记本（纯色）上应该能不一样，也不该为一个背景图去改动库的 blob。
const KEY = 'av-appearance-v1';

/** 预设底色：都是能保证正文对比度的深色，不提供白色（深色组件在浅底上会糊成一片）。 */
export const PRESETS = Object.freeze([
  { id: 'default', label: '墨绿', color: '#0d1117' },
  { id: 'navy', label: '深蓝', color: '#0a1220' },
  { id: 'warm', label: '暖灰', color: '#131110' },
  { id: 'black', label: '纯黑', color: '#000000' },
]);

export const DEFAULT_APPEARANCE = Object.freeze({ color: '#0d1117', image: null, alpha: 1 });

const clampAlpha = value => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(1, Math.max(0.5, number));
};

export function readAppearance(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    const parsed = JSON.parse(raw);
    return {
      color: /^#[0-9a-f]{6}$/i.test(parsed?.color || '') ? parsed.color : DEFAULT_APPEARANCE.color,
      image: typeof parsed?.image === 'string' && parsed.image.startsWith('data:image/') ? parsed.image : null,
      alpha: clampAlpha(parsed?.alpha),
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

/** '#rrggbb' → [r,g,b]（调用方已用正则校验过）。 */
function channels(hex) {
  const value = String(hex).replace('#', '');
  return [0, 2, 4].map(index => parseInt(value.slice(index, index + 2), 16));
}

const shift = (rgb, delta) => rgb.map(channel => Math.max(0, Math.min(255, channel + delta)));
const fade = (rgb, alpha) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Math.round(alpha * 1000) / 1000})`;

/**
 * 把外观写进根元素。幂等，可在首帧前、保存后、别的标签页改动时重复调用。
 *
 * 面板色不是简单「给底色加 alpha」：底色是“页面纸”，面板要略亮一档才看得出层次，
 * 所以派生三档（--av-panel / --av-panel-raised / --av-panel-hover，分别给大容器、
 * 卡片、hover）。弹窗要更实（半透明正文压不住壁纸），吸顶条要几乎不透明
 * （不然下面滚上来的卡片会透出来），因此再拆 solid / modal 两档。
 * 壁纸额外加一层本色 veil：亮色壁纸直接铺满会让浅色字彻底看不清。
 */
export function applyAppearance(view) {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  const state = { ...DEFAULT_APPEARANCE, ...(view || {}) };
  const alpha = clampAlpha(state.alpha);
  const rgb = channels(state.color);
  root.style.setProperty('--av-bg-color', state.color);
  root.style.setProperty('--av-bg-image', state.image ? `url("${state.image}")` : 'none');
  root.style.setProperty('--av-panel-alpha', String(alpha));
  root.style.setProperty('--av-panel', fade(shift(rgb, 4), alpha));
  root.style.setProperty('--av-panel-raised', fade(shift(rgb, 18), alpha));
  root.style.setProperty('--av-panel-hover', fade(shift(rgb, 28), alpha));
  // 输入区比面板再深一档，保住「凹进去」的层次；聚焦时再亮一点。
  root.style.setProperty('--av-field', fade(shift(rgb, -4), alpha));
  root.style.setProperty('--av-field-focus', fade(rgb, alpha));
  root.style.setProperty('--av-panel-solid', fade(rgb, Math.max(alpha, 0.94)));
  root.style.setProperty('--av-modal', fade(rgb, 0.55 + alpha * 0.45));
  root.style.setProperty('--av-veil', state.image ? `linear-gradient(${fade(rgb, 0.7)},${fade(rgb, 0.7)})` : 'none');
}

/** 把图片缩到 1920 宽并转 JPEG：原图直接塞 localStorage 会因为 5MB 配额整块保存失败。 */
async function shrinkImage(file, maxWidth = 1920) {
  if (!file || !/^image\//.test(file.type)) throw Error('请选择图片文件');
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / Math.max(1, bitmap.width));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.82);
}

export function createAppearanceCard({ toast = () => {}, storage = globalThis.localStorage } = {}) {
  let view = readAppearance(storage);
  applyAppearance(view);

  const card = document.createElement('section');
  card.className = 'settings-card';
  card.innerHTML = `
    <div class="settings-section-title"><span>外观</span><small>背景与面板透明度，立即生效</small></div>
    <div class="appearance-row" data-appearance-presets></div>
    <div class="appearance-row">
      <label class="field appearance-color"><span>自定义底色</span><input type="color" data-appearance-color aria-label="自定义背景底色"></label>
      <label class="field appearance-alpha"><span>面板不透明度 <b data-appearance-alpha-value>100%</b></span><input type="range" min="50" max="100" step="5" data-appearance-alpha aria-label="面板不透明度"></label>
    </div>
    <div class="settings-inline-actions">
      <button class="secondary" type="button" data-appearance-image>选择背景图…</button>
      <button class="text-button" type="button" data-appearance-clear-image>清除背景图</button>
      <button class="text-button" type="button" data-appearance-reset>恢复默认外观</button>
    </div>
    <p class="compact-note">只影响这台机器的显示。背景图会缩到 1920 宽后保存在本地浏览器存储里，不上传。</p>`;

  const presetBox = card.querySelector('[data-appearance-presets]');
  const colorInput = card.querySelector('[data-appearance-color]');
  const alphaInput = card.querySelector('[data-appearance-alpha]');
  const alphaValue = card.querySelector('[data-appearance-alpha-value]');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.hidden = true;
  card.append(fileInput);

  for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'appearance-swatch';
    button.dataset.color = preset.color;
    button.title = preset.label;
    button.innerHTML = `<i style="background:${preset.color}"></i><span>${preset.label}</span>`;
    presetBox.append(button);
  }

  function save(next = {}) {
    view = { ...view, ...next };
    applyAppearance(view);
    paint();
    try {
      storage?.setItem(KEY, JSON.stringify(view));
    } catch (error) {
      // 配额满通常就是背景图太大：告诉用户，但颜色与透明度已经生效，不必回滚。
      if (next.image) toast(`背景图保存失败：${String(error?.message || error)}。可换一张小一点的图。`);
    }
  }

  function paint() {
    colorInput.value = view.color;
    alphaInput.value = String(Math.round(view.alpha * 100));
    alphaValue.textContent = `${Math.round(view.alpha * 100)}%`;
    for (const button of presetBox.querySelectorAll('.appearance-swatch')) {
      button.classList.toggle('active', button.dataset.color.toLowerCase() === view.color.toLowerCase());
    }
  }

  presetBox.addEventListener('click', event => {
    const button = event.target.closest('.appearance-swatch');
    if (button) save({ color: button.dataset.color });
  });
  colorInput.addEventListener('change', () => save({ color: colorInput.value }));
  alphaInput.addEventListener('input', () => save({ alpha: clampAlpha(Number(alphaInput.value) / 100) }));
  card.querySelector('[data-appearance-image]').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      save({ image: await shrinkImage(file) });
      toast('背景图已更新');
    } catch (error) {
      toast(`设置背景图失败：${String(error?.message || error)}`);
    }
  });
  card.querySelector('[data-appearance-clear-image]').addEventListener('click', () => save({ image: null }));
  card.querySelector('[data-appearance-reset]').addEventListener('click', () => {
    view = { ...DEFAULT_APPEARANCE };
    applyAppearance(view);
    paint();
    try { storage?.removeItem(KEY); } catch {}
    toast('已恢复默认外观');
  });

  paint();
  return { card };
}
