// 小红书新通道的两份形状（页面 JSON / 渲染后 DOM）→ 统一笔记卡片。
// 夹具就是 2026-11-09 从真实响应里截下来的片段，别改成「看起来更合理」的样子：
// 这两条通道的字段名（snake_case、note_card 包一层）就是这么别扭，改顺了测试就失去意义了。
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseXhsApiItems,parseXhsDomCards,parseXhsUrl,parseXhsUser,pickXhsImage} from '../server/xhs-state.mjs';
import {pictureUrlCandidates} from '../server/picture-sites.mjs';

const API_PAYLOAD={
 code:0,
 success:true,
 data:{
  items:[
   {
    id:'69d6fc08000000001f007646',
    model_type:'note',
    xsec_token:'ABn7vPjgMOGwpLSy6d3SywyDNyUUuU4tMrrMoI589YMag=',
    note_card:{
     display_title:'新手露营👏有哪些好用建议？',
     type:'normal',
     cover:{width:1773,height:2364,url_default:'http://sns-webpic-qc.xhscdn.com/202611092232/1adc/notes_pre_post/1040g3k831u!nc_n_webp_mw_1',url_pre:'http://sns-webpic-qc.xhscdn.com/202611092232/62d6/notes_pre_post/1040g3k831u!nc_n_webp_prv_1'},
     user:{nick_name:'郑小喜',user_id:'5b6e6a6a6b58b71c13d5db07',xsec_token:'ABb5jithP6J7pN3pcnnbelvqzQ8IhNSrHD_pc64aElfL8='},
     interact_info:{liked_count:'7622'},
    },
   },
   // 同 id 的第二份（接口会分页重复给同一批）：必须去重
   {id:'69d6fc08000000001f007646',note_card:{display_title:'新手露营👏有哪些好用建议？',cover:{url_default:'http://sns-webpic-qc.xhscdn.com/x/notes_pre_post/1040g3k831u!nc_n_webp_mw_1'}}},
   // 没有封面的卡片（视频笔记偶尔如此）：丢掉，不能占一条空卡
   {id:'aaaaaaaaaaaaaaaaaaaaaaaa',note_card:{display_title:'没封面',cover:{}}},
  ],
 },
};

test('搜索接口的 note_card（snake_case）能归一成笔记卡片',()=>{
 const notes=parseXhsApiItems(API_PAYLOAD);
 assert.equal(notes.length,1,'同 id 去重、没封面的丢弃');
 const note=notes[0];
 assert.equal(note.noteId,'69d6fc08000000001f007646');
 assert.equal(note.title,'新手露营👏有哪些好用建议？');
 assert.equal(note.author,'郑小喜');
 assert.equal(note.authorId,'5b6e6a6a6b58b71c13d5db07');
 assert.equal(note.likedCount,'7622');
 assert.equal(note.xsecToken,'ABn7vPjgMOGwpLSy6d3SywyDNyUUuU4tMrrMoI589YMag=','详情页要用顶层 token，不是 user 上那个');
 assert.match(note.cover,/sns-img-qc\.xhscdn\.com/,'封面要从压缩档升到原图档');
 assert.equal(note.cover.includes('!nc_n_webp'),false,'转码后缀要截掉');
 assert.equal(note.cover.includes('/202611092232/'),false,'时效签名换域名后会 403，必须剥掉');
 assert.match(note.cover,/\/notes_pre_post\/1040g3k831u$/);
});

test('pickXhsImage 认得出接口那份的 url_default / url_pre',()=>{
 assert.match(pickXhsImage({url_default:'http://sns-webpic-qc.xhscdn.com/a/b/file!nc_n_x'}),/sns-img-qc\.xhscdn\.com/);
 assert.match(pickXhsImage({url_pre:'http://sns-webpic-qc.xhscdn.com/a/b/file!nc_n_x'}),/sns-img-qc\.xhscdn\.com/);
 assert.equal(pickXhsImage({}),'');
});

test('DOM 抽出的卡片也能归一（没有 token，详情链接只能给裸地址）',()=>{
 const notes=parseXhsDomCards([
  {id:'6a5f794900000000110068f8',src:'https://sns-webpic-qc.xhscdn.com/202611092237/e69/spectrum/1040g0k0322!nc_n_webp_m',title:'炎热夏季独自一人在加州海滩上露营',author:'山野星光07-21'},
  {id:'6a5f794900000000110068f8',src:'https://sns-webpic-qc.xhscdn.com/dupe.jpg',title:'重复',author:'x'},
  {id:'',src:'https://sns-webpic-qc.xhscdn.com/noid.jpg'},
  {id:'6ad960a8000000003300b150',src:'',title:'没图'},
 ]);
 assert.equal(notes.length,1,'缺 id / 缺封面 / 重复的都要丢掉');
 assert.equal(notes[0].noteId,'6a5f794900000000110068f8');
 assert.equal(notes[0].author,'山野星光07-21');
 assert.equal(notes[0].xsecToken,'','DOM 里拿不到 token');
 assert.match(notes[0].cover,/sns-img-qc\.xhscdn\.com/);
 assert.equal(notes[0].cover.includes('/202611092237/'),false);
});
test('parseXhsUrl 认出首页推荐，且不抢 /explore/<笔记id>',()=>{
 assert.equal(parseXhsUrl('https://www.xiaohongshu.com/explore').type,'home');
 assert.equal(parseXhsUrl('https://www.xiaohongshu.com/explore?channel_id=homefeed_recommend').type,'home');
 assert.equal(parseXhsUrl('https://www.xiaohongshu.com/explore/').type,'home');
 const note=parseXhsUrl('https://www.xiaohongshu.com/explore/6a06c9360000000036001d5a?xsec_token=abc&xsec_source=pc_search');
 assert.equal(note.type,'note');
 assert.equal(note.noteId,'6a06c9360000000036001d5a');
 assert.match(note.query,/xsec_token=abc/,'笔记的 xsec_token 必须原样留着');
 assert.equal(parseXhsUrl('https://www.xiaohongshu.com/有一些别的东西').type,'unknown');
});

test('主页的 user.notes 是按 tab 分的二维数组：拍平一层，但别把元组卡片拆散',()=>{
 const CARD=(id,title)=>({
  noteId:id,
  displayTitle:title,
  xsecToken:`TOKEN-${id.slice(0,4)}`,
  user:{nickname:'郑小喜',userId:'5b6e6a6a6b58b71c13d5db07'},
  cover:{urlDefault:`http://sns-webpic-qc.xhscdn.com/x/notes_pre_post/${id}!nc_n_webp_mw_1`},
 });
 // 真实形状：5 个 tab，只有「笔记」那个有内容
 const tabbed={user:{basicInfo:{nickname:'郑小喜',userId:'5b6e6a6a6b58b71c13d5db07'},notes:[[CARD('a'.repeat(24),'第一篇'),CARD('b'.repeat(24),'第二篇')],[],[],[],[]]}};
 const profile=parseXhsUser(tabbed);
 assert.equal(profile.nickname,'郑小喜');
 assert.equal(profile.notes.length,2,'笔记 tab 里的两条都要出来（2026-11-09 的 bug 是只认出 1 条）');
 assert.equal(profile.notes[0].title,'第一篇');
 assert.equal(profile.notes[0].authorId,'5b6e6a6a6b58b71c13d5db07','列表卡片要带作者 id，点作者名才能进主页');
 assert.equal(profile.notes[0].xsecToken,'TOKEN-'+'aaaa','主页卡片带 token：详情页链接靠它才打得开');
 // 元组形态的卡片 `[id, card]` 不能被拍平，否则一张卡被拆成两半、双双丢弃
 const tuples={user:{basicInfo:{nickname:'x'},notes:[[['c'.repeat(24),{displayTitle:'元组形态',cover:{urlDefault:'http://sns-webpic-qc.xhscdn.com/x/y!nc_n_webp_m'}}]]]}};
 assert.equal(parseXhsUser(tuples).notes.length,1);
 assert.equal(parseXhsUser(tuples).notes[0].title,'元组形态');
});

test('带时效签名的封面，代理会先要去掉签名的那条',()=>{
 const signed='https://sns-img-qc.xhscdn.com/202611092308/7f79b89efcdd5fd7a60c26979d8134b7/spectrum/1040g0k032516lju0k00g5ov9oqe9tek9fo0sl5o';
 const list=pictureUrlCandidates(signed);
 assert.equal(list[0],'https://sns-img-qc.xhscdn.com/spectrum/1040g0k032516lju0k00g5ov9oqe9tek9fo0sl5o');
 assert.equal(list[1],signed);
});
