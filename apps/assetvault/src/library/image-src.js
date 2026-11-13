// 缩略图地址 → 可以直接塞给 <img src> 的地址。
//
// 两条来源要分开走：
//   - 远端图床（sketchfab / polyhaven / 花瓣…）：浏览器直连会被 CORS 或防盗链挡，必须经
//     /api/image 代理，代理负责白名单、缓存与按需降级；
//   - 同源相对地址（/api/local/thumb?…、/api/local/file?…，本地索引 / 托管副本的图）：本身就是
//     本机直出，再套一层代理会被「只支持图床地址」的白名单挡成一张裂图 —— 画板卡、画布元素、
//     下载任务卡以前各自拼 URL，全都踩了这一个坑。
//
// 统一成这个纯函数，新增调用点就别再手拼 /api/image 了。
const SAME_ORIGIN = /^\/(?!\/)/;
// blob: / data: 是页面自己生成的内存图，代理取不到，必须直出。
const INLINE = /^(blob:|data:)/i;

export function thumbSrc(raw, {rendition = '', full = false} = {}) {
  const url = String(raw || '').trim();
  if (!url) return '';
  if (SAME_ORIGIN.test(url) || INLINE.test(url)) return url;
  const params = [`url=${encodeURIComponent(url)}`];
  if (rendition) params.push(`rendition=${encodeURIComponent(rendition)}`);
  if (full) params.push('full=1');
  return `/api/image?${params.join('&')}`;
}

export const isSameOriginImage = url => SAME_ORIGIN.test(String(url || ''));
