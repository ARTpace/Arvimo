import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTSTATION_ARTIST_TABS,ARTSTATION_ARTIST_MAX_PAGE,ARTSTATION_ARTIST_PER_PAGE,ARTSTATION_ARTIST_PER_PAGE_MAX,
  artistParams,artistTabUrl,validateArtistCursor,normalizeArtist,
  artstationArtist,artstationArtistProfile,
} from '../server/artstation-artist.mjs';

const cover='https://cdna.artstation.com/p/assets/covers/images/011/655/236/smaller_square/artvostok-stumb.jpg?1530700342';
// projects.json / likes.json 的行形状：都带 hash_id 与封面，只有 likes 额外内嵌 user。
const row=(hash,extra={})=>({id:1,hash_id:hash,url:`https://www.artstation.com/artwork/${hash}`,smaller_square_cover_url:cover,hide_as_adult:false,is_adult_content:false,title:'Emerald3',icons:{marmoset:true},...extra});
/** n 条不重复的行——翻页判断要按真实页大小算，测试数据不能只给一两条。 */
const rows=n=>Array.from({length:n},(_,i)=>row(`h${String(i).padStart(5,'0')}`));
function jsonOpen(payload,{status=200}={}){
  const calls=[];
  const open=async(url,opts)=>{calls.push({url,opts});return {status,headers:{},stream:(async function*(){yield Buffer.from(typeof payload==='string'?payload:JSON.stringify(payload),'utf8');})()};};
  return {open,calls};
}

test('artstation-artist: parameter validation',()=>{
  assert.deepEqual(artistParams({username:'wlop'}),{username:'wlop',tab:'projects',page:1});
  assert.deepEqual(artistParams({username:'  wlop  ',tab:'likes',page:3}),{username:'wlop',tab:'likes',page:3});
  assert.deepEqual(Object.values(ARTSTATION_ARTIST_TABS),['作品','点赞']);
  assert.throws(()=>artistParams({username:'../etc/passwd'}),/用户名/);
  assert.throws(()=>artistParams({username:'a b'}),/用户名/);
  assert.throws(()=>artistParams({username:''}),/用户名/);
  assert.throws(()=>artistParams({username:'x'.repeat(65)}),/用户名/);
  assert.throws(()=>artistParams({username:'wlop',tab:'favourites'}),/浏览方式/);
  assert.throws(()=>artistParams({username:'wlop',page:0}),/页码/);
  assert.throws(()=>artistParams({username:'wlop',page:ARTSTATION_ARTIST_MAX_PAGE+1}),/页码/);
  assert.throws(()=>artistParams([]),/格式/);
});

test('artstation-artist: tab urls pin the page size so paging maths is exact',()=>{
  assert.equal(artistTabUrl({username:'wlop',tab:'projects'},1),`https://www.artstation.com/users/wlop/projects.json?page=1&per_page=${ARTSTATION_ARTIST_PER_PAGE}`);
  assert.equal(artistTabUrl({username:'wlop',tab:'likes'},2),`https://www.artstation.com/users/wlop/likes.json?page=2&per_page=${ARTSTATION_ARTIST_PER_PAGE}`);
  assert.equal(new URL(artistTabUrl({username:'wlop',tab:'likes'},9999)).searchParams.get('page'),String(ARTSTATION_ARTIST_MAX_PAGE));
  assert.equal(new URL(artistTabUrl({username:'wlop',tab:'likes'},0)).searchParams.get('page'),'1');
});

test('artstation-artist: cursors are restricted to an artist tab of our own shape',()=>{
  const good=artistTabUrl({username:'wlop',tab:'projects'},2);
  assert.deepEqual(validateArtistCursor(good),{url:good,username:'wlop',tab:'projects',page:2,perPage:ARTSTATION_ARTIST_PER_PAGE});
  assert.equal(validateArtistCursor(artistTabUrl({username:'wlop',tab:'likes'},1)).tab,'likes');

  assert.throws(()=>validateArtistCursor('https://evil.example.com/users/wlop/projects.json?page=2&per_page=48'),/分页地址/);
  assert.throws(()=>validateArtistCursor('https://www.artstation.com/users/wlop/followers.json?page=2&per_page=48'),/分页地址/);
  assert.throws(()=>validateArtistCursor('https://www.artstation.com/users/a!b/projects.json?page=1&per_page=48'),/分页地址/);
  // 搜索的分页地址不能当艺术家游标用，反之亦然
  assert.throws(()=>validateArtistCursor('https://www.artstation.com/api/v2/search/projects.json?page=2&per_page=48'),/分页地址/);
  assert.throws(()=>validateArtistCursor(good.replace('page=2','page=0')),/页码/);
  assert.throws(()=>validateArtistCursor(good.replace(`per_page=${ARTSTATION_ARTIST_PER_PAGE}`,`per_page=${ARTSTATION_ARTIST_PER_PAGE_MAX+1}`)),/分页大小/);
  assert.throws(()=>validateArtistCursor('https://www.artstation.com/users/wlop/projects.json?page=1'),/分页大小/);
  assert.throws(()=>validateArtistCursor(null),/分页地址/);
});

test('artstation-artist: profile normalization keeps only usable fields',()=>{
  const artist=normalizeArtist({username:'wlop',full_name:'WLOP',headline:'Software engineer, freelance artist',location:'',large_avatar_url:'https://cdnb.artstation.com/p/users/avatars/x.jpg',followers_count:234062,following_count:0,projects_count:198,pro_user:false});
  assert.deepEqual(artist,{
    username:'wlop',name:'WLOP',headline:'Software engineer, freelance artist',location:'',
    avatar:'https://cdnb.artstation.com/p/users/avatars/x.jpg',url:'https://www.artstation.com/wlop',
    followers:234062,following:0,projects:198,pro:false,
  });
  assert.equal(normalizeArtist({username:'bad name'}),null);
  assert.equal(normalizeArtist({}),null);
  assert.equal(normalizeArtist(null),null);
  assert.equal(normalizeArtist('wlop'),null);
});

test('artstation-artist: projects rows have no embedded user, so the browsed name fills in',async()=>{
  const {open,calls}=jsonOpen({total_count:198,data:[row('lEVE8J'),row('no')]});
  const r=await artstationArtist({username:'wlop',tab:'projects'},{open});
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,`https://www.artstation.com/users/wlop/projects.json?page=1&per_page=${ARTSTATION_ARTIST_PER_PAGE}`);
  assert.equal(calls[0].opts.artstation,true);
  assert.equal(r.models.length,1);
  assert.equal(r.models[0].author,'wlop','projects.json 不内嵌 user，作者要从浏览目标补上');
  assert.equal(r.models[0].hasMarmoset,true);
  assert.equal(r.source,'ArtStation · @wlop 作品');
  assert.equal(r.username,'wlop');
  assert.equal(r.tab,'projects');
  assert.equal(r.received,2);
  assert.equal(r.total,198);
  assert.match(r.warnings.join(' '),/1 个作品/);
  assert.ok(r.next);
  assert.equal(new URL(r.next).searchParams.get('page'),'2');
});

test('artstation-artist: likes keep the original author, and an exhausted total ends paging',async()=>{
  const liked=Array.from({length:14},(_,i)=>row(`l${String(i).padStart(5,'0')}`,{user:{username:'flaptrapsart',full_name:'richard anderson'}}));
  const r=await artstationArtist({username:'wlop',tab:'likes'},{open:jsonOpen({total_count:14,data:liked}).open});
  assert.equal(r.models.length,14);
  assert.equal(r.models[0].author,'richard anderson','点赞列表要保留被点赞作品的作者，不能换成浏览者');
  assert.equal(r.source,'ArtStation · @wlop 点赞');
  assert.equal(r.next,null,'14 条一次取完 → 没有下一页');

  // 198 个作品按 48 分页 = 4 满页 + 第 5 页 6 条。这正是"拿本页条数当页大小会多翻一页"的边界：
  // 第 4 页满页 → 还有下一页；第 5 页只剩 6 条 → 到此为止。
  const page4=await artstationArtist({username:'wlop',tab:'projects',page:4},{open:jsonOpen({total_count:198,data:rows(48)}).open});
  assert.ok(page4.next,'第 4 页刚好取到 192/198，还剩 6 条，必须继续');
  const page5=await artstationArtist({username:'wlop',tab:'projects',page:5},{open:jsonOpen({total_count:198,data:rows(6)}).open});
  assert.equal(page5.next,null,'第 5 页取到 198/198，翻页到此结束');
});

test('artstation-artist: rows without a Marmoset scene are called out',async()=>{
  const image=row('xY9zA',{icons:{image:true}});
  const r=await artstationArtist({username:'wlop',tab:'projects'},{open:jsonOpen({total_count:1,data:[image]}).open});
  assert.equal(r.models[0].hasMarmoset,false);
  assert.match(r.warnings.join(' '),/1 个作品没有内嵌 Marmoset 场景/);
});

test('artstation-artist: a cursor replays the same tab and page',async()=>{
  const next=artistTabUrl({username:'wlop',tab:'likes'},3);
  const {open,calls}=jsonOpen({total_count:300,data:rows(48)});
  const page=await artstationArtist({cursor:next},{open});
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,next);
  assert.equal(page.page,3);
  assert.equal(page.tab,'likes');
  assert.equal(page.username,'wlop');
  assert.equal(page.source,'ArtStation · @wlop 点赞');
  // 第 3 页取到 144/300，后面还有
  assert.ok(page.next);
});

test('artstation-artist: remote failures are reported, never swallowed',async()=>{
  await assert.rejects(artstationArtist({username:'wlop'},{open:async()=>({status:403,headers:{},stream:(async function*(){})()})}),/HTTP 403/);
  await assert.rejects(artstationArtist({username:'wlop'},{open:jsonOpen('<html>not json</html>').open}),/有效 JSON/);
});

test('artstation-artist: the profile card is best-effort',async()=>{
  const {open,calls}=jsonOpen({username:'wlop',full_name:'WLOP',projects_count:198});
  const artist=await artstationArtistProfile('wlop',{open});
  assert.equal(calls[0].url,'https://www.artstation.com/users/wlop.json');
  assert.equal(calls[0].opts.artstation,true);
  assert.equal(artist.name,'WLOP');
  assert.equal(artist.projects,198);
  // 资料取不到时返回 null，调用方照常列作品
  assert.equal(await artstationArtistProfile('wlop',{open:async()=>({status:403,headers:{},stream:(async function*(){})()})}),null);
  await assert.rejects(artstationArtistProfile('../bad',{open}),/用户名/);
});
