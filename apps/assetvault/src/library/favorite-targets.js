// 统一收藏入口（2026-11-12）。
//
// 收藏的既有链路只有一条：卡片上的 data-action="favorite" -> app.js 的 toggleFavorite(uid)
// -> collect([uid]) 把资产写进 state.models，再记进 state.favorites。这样「收藏」同时意味着
// 「留在资产库里」，取消收藏也仍保留记录。
//
// 问题：模型平台的结果在 state.feeds / state.models 里，findModel() 找得到；但 ArtStation 图片模式、
// 图站单图、本地素材包从来不进 state.models，findModel() 查不到它们 —— 早先这些卡片干脆不画
// 心形键，有的画了也只会记下一个孤儿 uid，收藏页里什么都看不到。
//
// 这里的做法是「绘制卡片时登记一次可收藏目标」：把资产对象按 uid 存进会话级 Map，
// findModel() 兜底读它，于是同一条 toggleFavorite 链路对所有平台都成立，不需要第二套状态。
// 本地素材包本来就在资产库里（只是由磁盘索引画卡），登记为 skipCollect：只记收藏标记，
// 不再往 state.models 塞一份重复的模型卡。
//
// Map 只作本次会话的解析层，真值始终是 state.models / state.favorites；入库后即便 Map 被清掉，
// findModel 也能从 state.models 里读回来。
import {pictureSiteJobUid} from './platforms.js';

const targets=new Map();
const LIMIT=8000;
const UID=/^[a-f0-9]{32}$/i;

/** 稳定 uid：32 位十六进制，和 library-state 的 UID 校验、服务端 uidPattern 同一套。 */
export const favoriteUid=(kind,key)=>pictureSiteJobUid(kind,String(key??''));

export function registerFavoriteTarget(uid,model,{skipCollect=false}={}){
 if(!UID.test(uid||''))return uid;
 if(targets.size>LIMIT)targets.clear();
 targets.set(uid,{model,skipCollect});
 return uid;
}

export const favoriteTarget=uid=>targets.get(uid)?.model||null;
export const favoriteSkipsCollect=uid=>!!targets.get(uid)?.skipCollect;

/** 所有平台共用这一颗心形键：类名 / data-action / aria 全部一致，CSS 与事件各只需一套。 */
export function favoriteButtonHtml({uid,saved,icon,esc=value=>String(value??'')}){
 return `<button class="favorite${saved?' saved':''}" data-action="favorite" data-uid="${esc(uid)}" title="${saved?'取消收藏（仍保留在模型库）':'收藏并加入模型库'}" aria-label="${saved?'取消收藏':'收藏资产'}" aria-pressed="${saved}">${icon('heart')}</button>`;
}
