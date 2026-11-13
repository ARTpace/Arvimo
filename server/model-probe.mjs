// 封面探测取值的**单点**：写库时列化（library-blob）与查询时过滤（library-filter-semantics）
// 必须对同一个 model 得到同一组数字，否则「索引里 1920 宽、筛选按 1024 算」这种错会很难查。
//
// 零依赖：blob 的定位是「纯转换层」，它为了读个宽高不该把整条过滤语义链拉进来
// （那样打包装配的最小闭包也会跟着变大）。
const text = value => typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** model.probe 是浏览器封面探测注入的缓存；resolution / width / height 是平台包自带的事实字段。 */
function dimension(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= 100000 ? Math.round(n) : null;
}

export function probeOfModel(model = {}) {
  const raw = object(model.probe);
  const match = /(\d{2,6})\s*[x×]\s*(\d{2,6})/i.exec(text(model.resolution));
  const res = match ? {width: Number(match[1]), height: Number(match[2])} : {};
  const width = dimension(raw.width) ?? dimension(model.width) ?? res.width ?? null;
  const height = dimension(raw.height) ?? dimension(model.height) ?? res.height ?? null;
  const h = number(raw.h), s = number(raw.s), l = number(raw.l);
  const hasColor = /^#[0-9a-f]{6}$/i.test(text(raw.hex)) && h >= 0 && h <= 360 && s >= 0 && s <= 1 && l >= 0 && l <= 1;
  const durationValue = Number(raw.duration ?? model.durationSec ?? model.duration);
  const duration = Number.isFinite(durationValue) && durationValue > 0 ? durationValue : null;
  if (!width && !height && !hasColor && !duration) return null;
  return {width, height, duration, ...(hasColor ? {hex: raw.hex, h, s, l} : {})};
}
