// Search uses source APIs or the existing signed-in browser session; no home-feed aggregation.
export const SHORT_VIDEO_SITES={
 douyin:{id:'douyin',label:'抖音',hosts:['douyin.com','iesdouyin.com'],example:'https://v.douyin.com/',summary:'视频、图集与实况图参考素材',tag:'分享链接',group:'视频素材',kind:'video',hint:'粘贴作品链接或整段分享文案，解析视频、原图和实况图；不支持主页批量采集'},
 kuaishou:{id:'kuaishou',label:'快手',hosts:['kuaishou.com','chenzhongtech.com','gifshow.com'],example:'https://v.kuaishou.com/',summary:'短视频与图集参考素材',tag:'分享链接',group:'视频素材',kind:'video',hint:'粘贴作品分享链接或整段文案'},
 bilibili:{id:'bilibili',label:'哔哩哔哩',hosts:['bilibili.com','b23.tv'],example:'https://www.bilibili.com/video/',summary:'视频与分 P 参考素材',tag:'分享链接',group:'视频素材',kind:'video',hint:'粘贴 BV 视频链接或 b23.tv 短链；仅解析当前账号可访问的完整 MP4，不下载试看或分离音视频'},
 weibo:{id:'weibo',label:'微博视频',hosts:['weibo.com','weibo.cn','t.cn'],example:'https://weibo.com/tv/show/',summary:'微博视频参考素材',tag:'分享链接',group:'视频素材',kind:'video',hint:'粘贴视频分享链接（tv/show 或含 fid 的链接）'},
};
for(const site of Object.values(SHORT_VIDEO_SITES))Object.assign(site,{search:true,loginFor:'搜索结果可能需要登录或完成站点验证',hint:`输入关键词搜索 ${site.label}，或粘贴作品链接 / 分享文案；搜索可能需要先登录。${site.id==='bilibili'?'下载仍仅支持完整 MP4，不保存试看或分离音视频。':''}`});
export const isSocialMediaSite=id=>id==='xiaohongshu'||Object.hasOwn(SHORT_VIDEO_SITES,id);
export function extractShareUrl(input){
 const text=String(input||'').trim();
 return (text.match(/https?:\/\/[^\s<>"“”]+/i)?.[0]||text).replace(/[，。；！）》】]+$/u,'');
}
