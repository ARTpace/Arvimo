import {esc} from './html-esc.js';

/**
 * 通用加载动效（2026-11-20 用户要求）：内容区正中的细环 + 一行灰字。
 *
 * 以前每个平台各写一套「正在解析图站链接…」的虚线空态、发现页又另写 4 个骨架块，
 * 位置和字号都不统一，看起来像卡片没加载出来。现在只有这一种表达：
 * 加载中的一律居中显示动效，占满整行（`grid-column:1/-1`），不参与网格排布。
 *
 * text 传当前状态文案（「正在搜索 Fab…」/「正在解析图站链接…」），留空时退回「正在加载…」。
 */
export function loadingHtml(text = '') {
  const label = String(text || '').trim() || '正在加载…';
  return `<div class="loading-block" role="status" aria-live="polite"><span class="loading-ring" aria-hidden="true"></span><span class="loading-text">${esc(label)}</span></div>`;
}
