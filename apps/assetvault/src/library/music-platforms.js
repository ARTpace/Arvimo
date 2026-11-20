export const MUSIC_SITES={
 netease:{id:'netease',label:'网易云音乐',hosts:['music.163.com','163cn.tv'],example:'https://music.163.com/#/song?id=...'},
 kuwo:{id:'kuwo',label:'酷我音乐',hosts:['kuwo.cn'],example:'https://www.kuwo.cn/play_detail/...'},
 qishui:{id:'qishui',label:'汽水音乐',hosts:['music.douyin.com','qishui.douyin.com','luna.douyin.com'],paths:['/'],example:'https://music.douyin.com/qishui/share/track?track_id=...'},
};
for(const site of Object.values(MUSIC_SITES))Object.assign(site,{kind:'audio',search:site.id!=='qishui',tag:'音乐',group:'音频素材',summary:'歌曲试听、原始音频与来源信息',hint:site.id==='qishui'?'粘贴单曲分享链接或分享文案；仅下载当前账号可访问的完整音频':'输入歌名、歌手搜索，或粘贴单曲链接；仅下载当前账号可访问的完整音频，暂不支持歌单批量下载'});
export const isMusicSite=id=>Object.hasOwn(MUSIC_SITES,id);
Object.assign(MUSIC_SITES.qishui,{keywordNotice:'汽水音乐暂不支持关键词搜索，仅支持单曲分享链接。搜歌可切换到网易云音乐。',searchAlternative:'netease',placeholder:'粘贴汽水音乐单曲分享链接（暂不支持关键词搜索）'});
