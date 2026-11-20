// 采集用的统一搜索层：把「9 个模型平台 + 8 个可搜索图站 + UI 元素平台」收成一张注册表。
//
// 搜索实现全部复用既有模块（没有第二套抓取逻辑），这里只做三件事：
//   1) 平台 id → 搜索函数的映射（加平台 = 注册表加一行）；
//   2) 结果归一化（models[] 与 items[] 两套形状 → 采集条目）；
//   3) 稳定身份键（图站没有平台 id，只能用 canonical URL 派生 32 位 uid）。
// 出站安全、代理、cookie、缓存都由被复用的模块负责，本层不直连网络。
import {createHash} from 'node:crypto';
import {openPublic} from './public-http.mjs';
import {searchPage} from './catalog.mjs';
import {artstationSearch} from './artstation-search.mjs';
import {polyhavenSearch} from './polyhaven.mjs';
import {ambientcgSearch} from './ambientcg.mjs';
import {polypizzaSearch} from './polypizza.mjs';
import {kenneySearch} from './kenney.mjs';
import {freestylizedSearch} from './freestylized.mjs';
import {polyforkSearch} from './polyfork.mjs';
import {simreadySearch} from './simready.mjs';
import {collectPictureAssets, PICTURE_SITES as SERVER_PICTURE_SITES} from './picture-sites.mjs';
import {searchUiverse, resolveUiverse} from './uiverse.mjs';
import {civitaiSearch} from './civitai.mjs';
import {pickMeta} from './collect-meta.mjs';
import {mergeAutoTags} from '../src/library/auto-tags.js';
import {platformModules, PICTURE_SITES, UI_SITES} from '../src/library/platforms.js';

const MODEL_SEARCHERS = Object.freeze({
  sketchfab: (input, ctx) => searchPage(input, ctx),
  artstation: artstationSearch,
  polyhaven: polyhavenSearch,
  ambientcg: ambientcgSearch,
  polypizza: polypizzaSearch,
  kenney: kenneySearch,
  freestylized: freestylizedSearch,
  polyfork: polyforkSearch,
  simready: simreadySearch,
  civitai: (input, ctx) => civitaiSearch(input, ctx),
});

const SEARCHABLE_PICTURES = Object.freeze(Object.values(PICTURE_SITES)
  .filter(site => site.search === true && SERVER_PICTURE_SITES[site.id])
  .map(site => site.id));

/** UI 与调度器共用的平台清单；searchable:false 的站只支持「钉页面 URL」，不参与关键词采集。 */
export const COLLECT_PLATFORMS = Object.freeze([
  ...platformModules().filter(platform => MODEL_SEARCHERS[platform.id]).map(platform => Object.freeze({
    id: platform.id, label: platform.label, kind: 'model', searchable: true, hint: platform.hint || '',
  })),
  ...Object.values(PICTURE_SITES).map(site => Object.freeze({
    id: site.id, label: site.label, kind: 'picture',
    searchable: SEARCHABLE_PICTURES.includes(site.id), hint: site.hint || '',
  })),
  // UI 元素平台（Uiverse）：产出的是代码而不是图片，走独立的 kind。
  // 归到 'uielement' 而不是塞进 picture —— 图片下载器会把它当图片存，
  // 后面缩略图、格式识别、对比预览全都会出错。
  ...Object.values(UI_SITES).map(site => Object.freeze({
    id: site.id, label: site.label, kind: 'uielement',
    searchable: site.search === true, hint: site.hint || '',
  })),
]);

export const COLLECT_PLATFORM_IDS = Object.freeze(COLLECT_PLATFORMS.map(platform => platform.id));
/** Catalogue keyword searches often AND every word; relax only generic English descriptors. */
export function collectQueryFallbacks(query){
 const original=String(query||'').trim();
 if(!/^[a-z0-9\s-]+$/i.test(original))return [];
 const words=original.split(/\s+/).filter(word=>!/^(stylized|stylised|realistic|handpainted|seamless|pbr|texture[s]?|material[s]?|asset[s]?|model[s]?|wall|floor|3d|2d)$/i.test(word));
 const core=words.join(' ');
 if(!core||core.toLowerCase()===original.toLowerCase())return [];
 return [...new Set([core,words.length>1?words.at(-1):core])].filter(q=>q!==original).slice(0,2);
}
const BY_ID = new Map(COLLECT_PLATFORMS.map(platform => [platform.id, platform]));
// Only adapters that already expose a native type receive it. Post-filtering remains authoritative.
const NATIVE_TYPES={freestylized:{models:'models',textures:'textures',hdris:'skybox',images:'alphas',packs:'packs'},polyhaven:{models:'models',textures:'textures',hdris:'hdris'},ambientcg:{models:'3d-model,terrain',textures:'material,substance',hdris:'hdri,hdri-element'}};

/** 同一张图在不同页面的 URL 会带 utm / 排序参数，去掉它们才能稳定去重。 */
export function canonicalKey(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'from', 'refer', 'spm'])
      url.searchParams.delete(key);
    url.searchParams.sort();
    return `${url.hostname.toLowerCase()}${url.pathname}${url.search}`;
  } catch {
    return value.slice(0, 200);
  }
}

/** 与服务端 uidPattern 一致：32 位小写十六进制。 */
export function collectUid(platform, key) {
  return createHash('md5').update(`${platform}:${key}`).digest('hex');
}

const text = value => typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
const list = (value, max = 24) => (Array.isArray(value) ? value : []).map(text).map(item => item.trim()).filter(Boolean).slice(0, max);

function modelItem(model, platform) {
  const uid = /^[a-f0-9]{32}$/i.test(text(model?.uid)) ? text(model.uid).toLowerCase() : '';
  const key = text(model?.assetId) || text(model?.uid) || canonicalKey(model?.url || model?.name);
  const meta = pickMeta(model);
  return {
    uid: uid || collectUid(platform, key),
    key: `${platform}:${key}`,
    platform,
    name: text(model?.name).trim().slice(0, 200) || '未命名资产',
    author: text(model?.author).slice(0, 120),
    thumbnail: text(model?.thumbnail),
    url: text(model?.url),
    pageUrl: text(model?.url),
    // 收藏即打标：把采集时已确定无疑的元信息（画板名 / 类目 / 话题 / 来源）直接写进 tags，
    // 零 AI 调用、零人工确认。虚拟派生层会对同一批词去重，两处都调是幂等的。
    tags: list(mergeAutoTags(model?.tags, {...model, meta, platform}), 32),
    assetType: text(model?.assetType || model?.kind || 'model').slice(0, 40),
    license: text(model?.license).slice(0, 80),
    downloadable: model?.downloadable !== false,
    width: 0,
    height: 0,
    ...(meta ? {meta} : {}),
  };
}

/** 图片来源判定：只把「像图片地址」的 URL 当缩略图，避免把作品页 URL 塞进 <img> 变成裂图。 */
const looksLikeImage = raw => /\.(png|jpe?g|webp|gif|avif|bmp)(\?|#|$)/i.test(text(raw));

function pictureItem(item, platform) {
  const page = text(item?.pageUrl) || text(item?.url);
  // key 允许抓取层显式给：一篇小红书笔记多图时 pageUrl 全相同，只有这个键能区分每一张，
  // 否则 collectUid 会把它们算成同一张、去重后只剩一条。
  const key = text(item?.key) || canonicalKey(page) || canonicalKey(item?.url) || text(item?.title);
  // thumb 明确给了就信任它（很多 CDN 图地址不带后缀）；否则只在 url 确实是图片时回退，
  // 绝不拿作品页地址冒充缩略图 —— 那样卡片只会显示一张裂图。
  const thumb = text(item?.thumb) || (looksLikeImage(item?.url) ? text(item?.url) : '');
  // 图站的画板名 / #话题 / 出处站最接近「人工分类」——画板名就是用户自己分的类，采集层已经
  // 拿到了，这里必须原样带进 meta，否则打标时又只剩一个标题可用（「来自相册」这种等于没有）。
  const meta = pickMeta({...item, pageUrl: page});
  return {
    uid: collectUid(platform, key),
    key: `${platform}:${key}`,
    platform,
    name: text(item?.title).slice(0, 200) || '图片素材',
    author: text(item?.author).slice(0, 120),
    thumbnail: thumb,
    url: text(item?.url),
    pageUrl: page,
    tags: list(mergeAutoTags(item?.tags, {...item, meta, platform}), 32),
    assetType: item?.type === 'video' ? 'video' : 'image',
    license: '',
    downloadable: true,
    width: Number(item?.width) || 0,
    height: Number(item?.height) || 0,
    ...(meta ? {meta} : {}),
  };
}

/**
 * UI 元素条目归一化。
 *
 * 与 pictureItem 的关键差别：这里的「图」不是图片，而是一段可渲染的代码。
 * 预览文档（html+css 现场拼出来的独立页面）是卡片上真正显示的东西 ——
 * UI 元素的卖点是动效，静态截图把它最值钱的部分丢掉了。
 * 那个 CDN 封面图（imagedelivery.net）在很多网络下连不上，不能当依赖。
 */
function uiElementItem(item, platform) {
  const page = text(item?.pageUrl) || text(item?.url);
  const key = text(item?.elementId) || canonicalKey(page);
  return {
    uid: collectUid(platform, key),
    key: `${platform}:${key}`,
    platform,
    name: text(item?.title).slice(0, 200) || 'UI 元素',
    author: text(item?.author).slice(0, 120),
    thumbnail: '',
    url: text(item?.url),
    pageUrl: page,
    tags: list(item?.tags),
    assetType: 'uielement',
    license: 'Uiverse 社区作品 · 可自由复制使用',
    downloadable: true,
    width: 0,
    height: 0,
    // 预览要用的三样东西：元素 id（取代码用）、类型、主题。
    elementId: text(item?.elementId),
    elementType: text(item?.elementType),
    elementTheme: text(item?.theme),
    elementUsername: text(item?.elementUsername),
    elementSlug: text(item?.elementSlug),
    elementVersion: Number(item?.elementVersion) || 1,
    isTailwind: item?.isTailwind === true,
    // 预览文档：服务端拼好的独立 HTML，前端直接塞进 iframe。
    previewDocument: text(item?.previewDocument),
    html: text(item?.html),
    css: text(item?.css),
    backgroundColor: text(item?.backgroundColor),
  };
}

/**
 * search(platform, {query, limit}) → {items, next, warnings}
 * 只取第一页足够 limit 的条数：采集规则的上限本来就小（默认 20），翻页留给「手动翻更多」。
 */
export function createCollectSearch({open = openPublic, searchers = MODEL_SEARCHERS, pictureCollector = collectPictureAssets, uiSearcher = searchUiverse, uiResolver = resolveUiverse, civitaiKey = ''} = {}) {
  async function search(platform, {query = '', limit = 20, cursor = null, signal,assetType=''} = {}) {
    const meta = BY_ID.get(text(platform));
    if (!meta) throw Error(`不支持的采集平台：${platform}`);
    if (!meta.searchable) throw Error(`${meta.label} 不支持关键词搜索，只能钉作者页或画板页`);
    const q = text(query).trim().slice(0, 300);
    if (!q) throw Error('采集关键词不能为空');
    const take = Math.max(1, Math.min(60, Number(limit) || 20));
    if (meta.kind === 'uielement') {
      const data = await uiSearcher({query: q}, {signal, limit: take});
      return {
        platform, label: meta.label, kind: 'uielement',
        items: (data.items || []).slice(0, take).map(item => uiElementItem(item, platform)),
        next: data.nextPage ? String(data.nextPage) : null,
        warnings: list(data.warnings, 8),
      };
    }
    if (meta.kind === 'picture') {
      const data = await pictureCollector(platform, {url: q}, {maxItems: take, signal, open});
      return {
        platform, label: meta.label, kind: 'picture',
        items: (data.items || []).slice(0, take).map(item => pictureItem(item, platform)),
        next: null,
        warnings: list(data.warnings, 8),
      };
    }
    const fn = searchers[platform];
    if (typeof fn !== 'function') throw Error(`${meta.label} 的搜索模块未接入`);
    const type=NATIVE_TYPES[platform]?.[assetType];
    const data = await fn({q, cursor: cursor || undefined,...(type?{type}:{})}, {signal, open,...(platform==='civitai'?{apiKey:civitaiKey}:{})});
    return {
      platform, label: meta.label, kind: 'model',
      items: (data.models || []).slice(0, take).map(model => modelItem(model, platform)),
      next: data.next || null,
      warnings: list(data.warnings, 8),
    };
  }
  return {platforms: COLLECT_PLATFORMS, search};
}
