// 按艺术家浏览 ArtStation：作品列表与点赞列表。
//
// 这两个端点是 `/users/<username>/projects.json` 与 `/users/<username>/likes.json`，
// 走和搜索同一条出站层（Node 原生 https；被 Cloudflare 403 时自动降级到浏览器指纹）。
//
// 复用搜索那套归一化，所以浏览艺术家得到的结果能直接用现有的卡片、多选、收藏、
// 模型库与共用下载队列——不需要第二套网格。
import {openPublic} from './public-http.mjs';
import {readStreamText} from './artstation-project.mjs';
import {normalizeArtstationProject,decodeEntities} from './artstation-search.mjs';

export const ARTSTATION_ARTIST_TABS=Object.freeze({projects:'作品',likes:'点赞'});
export const ARTSTATION_ARTIST_MAX_PAGE=200;
const USERNAME_RE=/^[A-Za-z0-9_-]{1,64}$/;
// 显式传 per_page（实测接口接受：传 24 就返回 24 条）。不传的话虽然默认是 50，但"每页多少条"
// 就成了隐含约定，翻页判断也没法精确——最后一页通常不满页，拿本页条数当页大小会多翻一页。
export const ARTSTATION_ARTIST_PER_PAGE=48;
export const ARTSTATION_ARTIST_PER_PAGE_MAX=75;
const MAX_BODY=6*1024*1024;
const TAB_PATH=Object.freeze({projects:'projects',likes:'likes'});

export function artistParams(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('浏览参数格式无效');
  const username=String(input.username??'').trim();
  if(!USERNAME_RE.test(username))throw Error('请输入有效的 ArtStation 用户名（字母、数字、下划线或连字符）');
  const tab=input.tab===undefined||input.tab===null?'projects':String(input.tab);
  if(!Object.hasOwn(ARTSTATION_ARTIST_TABS,tab))throw Error('不支持的浏览方式');
  const page=Number(input.page??1);
  if(!Number.isInteger(page)||page<1||page>ARTSTATION_ARTIST_MAX_PAGE)throw Error('无效的页码');
  return {username,tab,page};
}

export function artistTabUrl({username,tab},page){
  const u=new URL(`https://www.artstation.com/users/${encodeURIComponent(username)}/${TAB_PATH[tab]}.json`);
  u.searchParams.set('page',String(Math.max(1,Math.min(ARTSTATION_ARTIST_MAX_PAGE,Number(page)||1))));
  u.searchParams.set('per_page',String(ARTSTATION_ARTIST_PER_PAGE));
  return u.href;
}

/**
 * 分页游标就是上面那个地址本身，回放前必须逐项对得上——
 * 否则等于把任意 ArtStation URL 交给出站层去取（SSRF 面）。
 */
export function validateArtistCursor(cursor){
  let u;
  try{u=new URL(String(cursor||''));}catch{throw Error('无效的浏览分页地址');}
  if(u.protocol!=='https:'||u.hostname!=='www.artstation.com')throw Error('无效的浏览分页地址');
  const m=u.pathname.match(/^\/users\/([A-Za-z0-9_-]{1,64})\/(projects|likes)\.json$/);
  if(!m)throw Error('无效的浏览分页地址');
  const page=Number(u.searchParams.get('page'));
  if(!Number.isInteger(page)||page<1||page>ARTSTATION_ARTIST_MAX_PAGE)throw Error('无效的页码');
  const perPage=Number(u.searchParams.get('per_page'));
  if(!Number.isInteger(perPage)||perPage<1||perPage>ARTSTATION_ARTIST_PER_PAGE_MAX)throw Error('无效的分页大小');
  const tab=Object.keys(TAB_PATH).find(key=>TAB_PATH[key]===m[2]);
  return {url:u.href,username:m[1],tab,page,perPage};
}

export function normalizeArtist(user){
  if(!user||typeof user!=='object')return null;
  const username=String(user.username||'').trim();
  if(!USERNAME_RE.test(username))return null;
  return {
    username,
    name:decodeEntities(String(user.full_name||username)).slice(0,120),
    headline:decodeEntities(String(user.headline||'')).slice(0,160),
    location:decodeEntities(String(user.location||'')).slice(0,120),
    // `large_avatar_url` 指向 cdnb/cdna，和作品封面走同一个图片代理，无需额外白名单。
    avatar:user.large_avatar_url||user.medium_avatar_url||null,
    url:`https://www.artstation.com/${username}`,
    followers:Number(user.followers_count)||0,
    following:Number(user.following_count)||0,
    projects:Number(user.projects_count)||0,
    pro:user.pro_user===true,
  };
}

/**
 * 浏览一个艺术家的作品或点赞。`{cursor}` 继续翻页；第一页附带资料卡。
 *
 * 注意两个端点的字段富度不同：`projects.json` 的条目**没有内嵌 user**（全都属于同一个艺术家），
 * 所以要用正在浏览的用户名补上，否则每一行都会显示成"未知作者"。
 */
export async function artstationArtist(input,{signal,open=openPublic}={}){
  const fromCursor=input?.cursor?validateArtistCursor(input.cursor):null;
  const target=fromCursor||{...artistParams(input),url:null};
  const url=fromCursor?fromCursor.url:artistTabUrl(target,target.page);
  signal?.throwIfAborted();

  const r=await open(url,{artstation:true,signal,timeout:45000});
  if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}throw Error(`ArtStation 艺术家页返回 HTTP ${r.status}`);}
  let payload;
  try{payload=JSON.parse(await readStreamText(r,MAX_BODY));}
  catch{try{r.stream.destroy();}catch{}throw Error('ArtStation 艺术家页返回的不是有效 JSON');}

  const items=Array.isArray(payload?.data)?payload.data:[];
  const models=items.map(item=>normalizeArtstationProject(
    item&&!item.user?{...item,user:{username:target.username}}:item,
  )).filter(Boolean);
  const skipped=items.length-models.length;

  const warnings=[];
  if(skipped)warnings.push(`本页 ${skipped} 个作品标记为成人内容或缺少作品标识，已跳过。`);
  const imageOnly=models.reduce((n,m)=>n+(m.hasMarmoset?0:1),0);
  if(imageOnly)warnings.push(`本页 ${imageOnly} 个作品没有内嵌 Marmoset 场景，下载得到的是作品图片而不是 3D 模型。`);
  // 顶层带 total_count（实测 projects.json 给 198、likes.json 给 14），配合我们显式要求的 per_page
  // 就能精确判断还有没有下一页：已取到 (page-1)×perPage + 本页条数 条。
  // 不能拿"本页条数"当页大小——最后一页几乎总是缺条（198 个作品按 48 分页，第 5 页只剩 6 条），
  // 那样会多翻一页空结果。
  const total=Number(payload?.total_count)||0;
  const perPage=fromCursor?.perPage||ARTSTATION_ARTIST_PER_PAGE;
  const consumed=(target.page-1)*perPage+items.length;
  const next=items.length&&target.page<ARTSTATION_ARTIST_MAX_PAGE&&(!total||consumed<total)
    ? artistTabUrl(target,target.page+1)
    : null;

  return {
    artist:null,
    models,received:items.length,page:target.page,total,
    next,
    pending:[],
    source:`ArtStation · @${target.username} ${ARTSTATION_ARTIST_TABS[target.tab]}`,
    username:target.username,tab:target.tab,warnings,
  };
}

/** 第一页额外取一次艺术家资料，让面板能显示头像与简介。失败不影响作品列表。 */
export async function artstationArtistProfile(username,{signal,open=openPublic}={}){
  const name=String(username||'').trim();
  if(!USERNAME_RE.test(name))throw Error('请输入有效的 ArtStation 用户名');
  const url=`https://www.artstation.com/users/${encodeURIComponent(name)}.json`;
  const r=await open(url,{artstation:true,signal,timeout:30000});
  if(r.status<200||r.status>=300){try{r.stream.destroy();}catch{}return null;}
  try{return normalizeArtist(JSON.parse(await readStreamText(r,2*1024*1024)));}
  catch{return null;}
}
