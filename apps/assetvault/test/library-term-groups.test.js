// 检索词组分区的契约与纯函数（对应 src/library/term-groups.js）。
// 这里只测「数据怎么分组」，DOM 与事件由 library-history-manual-only.test.js 看源码断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import {TERM_GROUPS,TERM_GROUP_IDS,buildTermSections} from '../src/library/term-groups.js';

const history=[
 {group:'recent',label:'house',title:'Sketchfab · house',icon:'search',entry:{kind:'search'}},
 {group:'recent',label:'tree',title:'Sketchfab · tree',icon:'search',entry:{kind:'search'}},
 {group:'links',label:'站酷·哎哟嘿嘿',title:'粘贴链接解析 · zcool.com.cn',icon:'link',entry:{kind:'link'}},
];
const daily=[
 {term:'house',label:'house',today:true,badge:'今日',title:'今天的主题'},
 {term:'tree',label:'tree',today:false,badge:'',title:'试试这个主题'},
];
const related=[{term:'cottage',label:'cottage',title:'搜索相近词：cottage'}];
const byId=sections=>Object.fromEntries(sections.map(section=>[section.id,section]));

test('group contract is stable, data-driven and free of duplicates',()=>{
 assert.deepEqual(TERM_GROUP_IDS,['recent','links','daily','related']);
 assert.equal(new Set(TERM_GROUP_IDS).size,TERM_GROUP_IDS.length);
 assert.ok(TERM_GROUPS.every(group=>group.label&&group.icon&&group.hint&&group.tone),'每组都要有标题 / 图标 / 说明 / 配色');
 assert.deepEqual(TERM_GROUPS.filter(group=>group.filterable).map(group=>group.id),['recent','links'],'只有历史两组参与输入收窄');
 assert.deepEqual(TERM_GROUPS.filter(group=>group.hideWhenEmpty).map(group=>group.id),['links','daily'],'没内容时不留空标题');
 assert.ok(Object.isFrozen(TERM_GROUPS),'契约表只读，运行期不许偷偷加组');
});

test('history rows and topic rows land in their own sections',()=>{
 const sections=byId(buildTermSections({history,daily,related}));
 assert.equal(sections.recent.items.length,2);
 assert.equal(sections.links.items[0].label,'站酷·哎哟嘿嘿');
 assert.equal(sections.daily.items.length,2);
 assert.equal(sections.daily.items[0].badge,'今日','首颗主题带今日徽标');
 assert.equal(sections.daily.items[0].today,true);
 assert.equal(sections.related.items[0].term,'cottage');
 assert.equal(sections.recent.tone,'slate');
 assert.equal(sections.daily.tone,'green');
});

test('typing narrows only history groups, topic groups stay visible',()=>{
 const sections=byId(buildTermSections({history,daily,related,term:'tre'}));
 assert.deepEqual(sections.recent.items.map(item=>item.label),['tree']);
 assert.equal(sections.links,undefined,'链接组没有匹配项就整组隐藏');
 assert.equal(sections.daily.items.length,2,'今日主题是灵感入口，不该被输入框筛掉');
 assert.equal(sections.related.items.length,1,'相近词同理');
});

test('no match still explains itself in the recent group',()=>{
 const sections=byId(buildTermSections({history,daily:[],related:[],term:'zzz'}));
 assert.equal(sections.recent.items.length,0);
 assert.match(sections.recent.empty,/没有匹配“zzz”的检索记录/);
 assert.equal(sections.daily,undefined);
 assert.ok(sections.related.empty.includes('提交搜索'),'相近词组保留说明，不让用户以为坏了');
});

test('related note wins over the default empty text, and limit caps each group',()=>{
 const sections=byId(buildTermSections({history:[],daily:[],related:[],relatedNote:'正在推荐相近词…'}));
 assert.equal(sections.related.empty,'正在推荐相近词…');
 assert.equal(sections.recent.empty,'还没有检索记录 · 搜过的关键词会留在这里');
 const many=Array.from({length:20},(_,i)=>({group:'recent',label:`word-${i}`,title:'',icon:'search'}));
 const capped=byId(buildTermSections({history:many,daily:[],related:[],limit:6}));
 assert.equal(capped.recent.items.length,6);
 assert.equal(capped.recent.items[0].label,'word-0');
});

test('malformed input cannot crash the popover',()=>{
 const groupIds=TERM_GROUP_IDS;
 const sections=buildTermSections({history:null,daily:null,related:null,term:null,limit:0});
 assert.ok(sections.every(section=>groupIds.includes(section.id)));
 assert.equal(sections.find(section=>section.id==='recent').items.length,0);
});
