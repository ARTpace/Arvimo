// Shared wording and order for card, board and background menus.
// Keep action callbacks/attributes intact; only presentation is normalized here.
const groups=['常用','整理','来源','新建','显示模式','显示内容','删除'];
const rules=[
 ['常用','预览',['打开预览','打开大图预览']],
 ['常用','打开',['打开素材包','打开文件','打开合集','打开画板']],
 ['常用','播放',['播放视频','播放序列']],
 ['常用','下载',['下载到本地']],
 ['常用','保存原图…',['原图另存到本机…']],
 ['常用','保存视频…',['视频另存到本机…']],
 ['常用','下载原图',['下载原图']],
 ['常用','导出 ZIP',['下载为 ZIP']],
 ['常用','所在文件夹',['打开下载文件夹','打开所在文件夹']],
 ['常用','收藏',['收藏']],['常用','取消收藏',['取消收藏']],
 ['常用','加入资产库',['加入模型库','只入库不下载']],
 ['常用','加入画板…',['加入画板…','图集加入画板…']],
 ['常用','发送到画布',['发送到画布']],
 ['常用','发送到软件…',['发送到其它软件…']],
 ['整理','分类…',['归入自定义子类…']],
 ['整理','标签与评分…',['标签与评分…']],
 ['整理','编辑画板…',['重命名 / 改封面']],
 ['整理','筛选规则…',['编辑筛选规则']],
 ['整理','找相似',['找相似资产','用这张图找相似']],
 ['整理','移出画板',['从画板移出']],
 ['整理','移出合集',['从合集移出']],
 ['整理','重新关联…',['重新定位链接文件…']],
 ['整理','登记资产',['登记 info.json']],
 ['来源','作品页',['在浏览器打开官方页面','在浏览器打开作品页']],
 ['来源','作者作品',['查看该作者的作品']],
 ['来源','复制链接',['复制官方链接']],
 ['来源','复制原图链接',['复制原图地址']],
 ['来源','复制视频链接',['复制视频地址']],
 ['来源','复制路径',['复制路径']],
 ['新建','导入资产',['导入资产']],
 ['新建','新建画板',['新建画板']],
 ['新建','智能画板',['新建智能画板']],
 ['删除','恢复',['放回模型库']],
 ['删除','移入回收站',['移入回收站（保留文件）'],'保留本地文件，仅移入回收站'],
 ['删除','解散合集',['解散整个合集'],'解除集合关系，保留成员资产'],
 ['删除','删除画板',['删除画板（卡片保留）'],'删除画板，保留成员资产'],
 ['删除','删除本地文件…',['删除资产及本地文件…'],'删除资产及关联的本地文件'],
 ['删除','彻底删除',['彻底删除记录']],
];
const byLabel=new Map(rules.flatMap(([group,label,aliases,hint],rank)=>aliases.map(alias=>[alias,{group,label,hint,rank}])));

export function normalizeContextMenu(spec){
 if(!spec?.items)return spec;
 let group='常用';const buckets=new Map();
 for(const item of spec.items){
  if(item.group){group=({'打开与获取':'常用','危险操作':'删除'})[item.group]||item.group;continue;}
  if(item.separator)continue;
  const rule=byLabel.get(item.label);
  const target=rule?.group||(item.danger||item.action==='purge'?'删除':group);
  if(!buckets.has(target))buckets.set(target,[]);
  buckets.get(target).push({...item,label:rule?.label||item.label,hint:rule?.hint||item.hint,rank:rule?.rank??1000});
 }
 const items=[];
 for(const name of [...groups,...[...buckets.keys()].filter(name=>!groups.includes(name))]){
  const rows=buckets.get(name);if(!rows?.length)continue;
  if(items.length)items.push({separator:true});
  items.push({group:name},...rows.sort((a,b)=>a.rank-b.rank));
 }
 return {...spec,items};
}
