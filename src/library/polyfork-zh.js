// Polyfork 参数的中文化：两层。
//
//   B 层（这里）—— 纯规则，零依赖、零请求，新资产自动生效。先查整串短语表，再按空格/连字符
//   拆词逐词查，全部词都认识才拼中文。宁可不翻，也不拼出「奶油 stone」这种半中半英。
//   C 层（server/polyfork-zh.mjs）—— 模型翻一遍落盘，前端拿到后就地替换文字，覆盖 B 层没词的长尾。
//
// 界面永远先渲染 B 层结果，所以面板从来不会先闪一屏英文。

/** 整 key 命中：资产方的 key 比 label 稳定，同一个 key 在全站基本同义。 */
const KEYS={
 colorway:'配色方案', stone:'石材', mortar:'砂浆与杂石', timber:'木构架', darkTimber:'深色木件',
 iron:'铁件', interior:'室内（夜间透光）', moss:'苔藓', skin:'皮肤', saddle:'鞍座', mouth:'口腔',
 tallness:'高度', batter:'墙面收分', capPitch:'顶盖坡度', sailSpan:'风帆跨度', sails:'风帆数',
 length:'体长', girth:'体围', swell:'隆起度', rings:'环纹', legs:'腿长', tailLength:'尾长',
 matchday:'赛日程度', sport:'运动类型', bottleHeight:'瓶高', harvested:'已清空',
 crate:'木箱', box:'箱体', bottles:'瓶子', bottle:'瓶子', caps:'瓶盖', cap:'瓶盖',
 handle:'把手', table:'桌板', steel:'钢架', cooler:'冷藏箱', jug:'水壶', towels:'毛巾',
 towel:'毛巾', cups:'杯子', cup:'杯子', bag:'包袋', shelf:'层架', panel:'面板',
 body:'主体', roof:'屋顶', wall:'墙体', door:'门', window:'窗', frame:'木框架',
 trim:'饰边', glass:'玻璃', wheels:'轮子', chimney:'烟囱', base:'底座', head:'头部',
 vane:'风轮叶片', boomtown:'景气程度', weather:'做旧程度', arrangement:'摆放方案',
 blade:'扇叶', mark:'制作者标牌', rust:'锈色', accent:'消防桶', water:'水流', stain:'水渍',
 boards:'木板', legsFrame:'立柱',
};

/** 整串短语命中：拆词翻会出「墙 收分」这种断句，短语表优先。小写、去括号内容后比较。 */
const PHRASES={
 'wall batter':'墙面收分', 'cap pitch':'顶盖坡度', 'sail span':'风帆跨度', 'sail count':'风帆数量',
 'vane blades':'风轮叶片数', 'frame timber':'构架木色', 'fan blades':'扇叶金属', 'tail vane':'尾舵板',
 'maker\'s mark':'制作者标牌', 'makers mark':'制作者标牌', 'fire bucket':'消防水桶', 'dry stain':'干涸水渍',
 'interior lit at night':'室内（夜间透光）', 'interior':'室内（夜间透光）',
 'wall flare':'墙体收分', 'window trim':'窗框饰边', 'roof pitch':'屋顶坡度',
};

/** 拆词用的单词表：名词按「修饰语 + 中心词」顺序拼，正好和中文语序一致。 */
const WORDS={
 stone:'石材', rubble:'毛石', brick:'砖', mortar:'砂浆', plaster:'抹灰', concrete:'混凝土',
 wood:'木', timber:'木构', oak:'橡木', pine:'松木', plank:'木板', boards:'木板', board:'木板',
 iron:'铁件', steel:'钢', metal:'金属', brass:'黄铜', copper:'铜', bronze:'青铜', zinc:'锌',
 galvanised:'镀锌', galvanized:'镀锌', rusted:'锈蚀', rusty:'锈蚀', rust:'锈色',
 roof:'屋顶', wall:'墙体', walls:'墙体', floor:'地面', ceiling:'天花', door:'门', doors:'门',
 window:'窗', windows:'窗', frame:'框架', trim:'饰边', glass:'玻璃', chimney:'烟囱',
 tower:'塔身', base:'底座', body:'主体', head:'头部', top:'顶部', cap:'顶盖', deck:'甲板',
 leg:'腿', legs:'腿', post:'立柱', posts:'立柱', beam:'横梁', brace:'斜撑', girt:'围梁',
 panel:'面板', panels:'面板', sail:'风帆', sails:'风帆', whip:'帆杆', lattice:'格栅',
 blade:'扇叶', blades:'扇叶', hub:'轮毂', wheel:'风轮', vane:'尾舵', tail:'尾部', finial:'塔尖',
 moss:'苔藓', mossy:'苔藓', lichen:'地衣', snow:'积雪', dirt:'污渍', stain:'水渍', wear:'磨损',
 paint:'漆面', paintwork:'漆面', colour:'颜色', color:'颜色', tone:'色调', shade:'明度',
 height:'高度', width:'宽度', length:'长度', depth:'深度', size:'尺寸', scale:'缩放',
 pitch:'坡度', span:'跨度', count:'数量', number:'数量', angle:'角度', radius:'半径',
 batter:'收分', taper:'锥度', splay:'外张', flare:'外张', tallness:'高度', girth:'体围',
 weather:'做旧', weathering:'做旧', aged:'陈旧', sun:'日晒', bleached:'褪色', silvered:'泛银灰',
 fresh:'新做', dark:'深色', light:'浅色', pale:'淡色', warm:'暖色', cool:'冷色',
 interior:'室内', exterior:'室外', lit:'亮灯', night:'夜间', day:'白天',
 skin:'皮肤', hide:'皮', saddle:'鞍座', mane:'鬃毛', mouth:'口腔', eye:'眼睛', eyes:'眼睛',
 water:'水流', bucket:'水桶', mark:'标牌', spare:'备用件', mist:'薄雾',
 // 生物类资产（恐龙、甲虫、蜈蚣）的解剖词。全站一大半资产是这类，缺了它们覆盖率只有四成。
 coat:'表皮', stripe:'条纹', belly:'腹部', fold:'褶皱', crest:'冠饰', band:'环带',
 muzzle:'口鼻', claw:'爪', claws:'爪', iris:'虹膜', tongue:'舌头', stance:'站姿',
 shell:'甲壳', spot:'斑点', spots:'斑点', feet:'足', foot:'足', labrum:'上唇',
 membrane:'翅膜', wing:'翅膀', wings:'翅膀', dome:'穹顶', pattern:'花纹', seam:'接缝',
 fin:'鳍', fins:'鳍', horn:'角', horns:'角', spine:'棘刺', scales:'鳞片',
 feather:'羽毛', feathers:'羽毛', beak:'喙', pupil:'瞳孔',
 antenna:'触角', antennae:'触角', abdomen:'腹部', thorax:'胸部', under:'腹面',
 // 补一轮长尾高频词：部位、材质、装饰件。专有名词（takona 之类）不翻，留在 C 层。
 spread:'展开', breadth:'体宽', trail:'拖尾', trailing:'拖曳', joints:'关节', joint:'接缝',
 clubs:'棒状', mandible:'大颚', mandibles:'大颚', antler:'鹿角', antlers:'鹿角',
 chestnut:'栗色', basalt:'玄武岩', soil:'土壤', earth:'泥土', turf:'草皮', slab:'石板', slabs:'石板',
 packing:'填缝', piece:'构件', pieces:'构件', mirror:'镜面', headdress:'头饰', necklace:'项链',
 figure:'人形', age:'年代', fullness:'饱满度', cornicle:'腹管', cornicles:'腹管',
 cream:'奶油色', sage:'鼠尾草绿', red:'红', green:'绿', blue:'蓝', grey:'灰', gray:'灰',
 black:'黑', white:'白', brown:'棕', tan:'棕褐', ochre:'赭黄', slate:'板岩灰',
 scheme:'方案', variation:'变体', variant:'变体', layout:'布局', arrangement:'摆放',
 boom:'景气', active:'运转', idle:'停摆', season:'季节',
};

/** label 里常见但没信息量的词，拆词时直接丢掉。 */
const NOISE=new Set(['of','the','a','an','and','or','for','on','in','at','to','is','its','with','by','from']);

const clean=text=>String(text??'').toLowerCase().replace(/\([^)]*\)/g,' ').replace(/\s+/g,' ').trim();
const tokens=text=>clean(text).split(/[\s/\-,&]+/).filter(word=>word&&!NOISE.has(word));

/**
 * 单个 label → 中文。三级：整串短语表 → 逐词拼 → key 表兜底。
 *
 * 顺序是踩出来的：key 表看着最准，但同一个 key 在不同资产里含义会变 ——
 * windmill 的 `timber` 是「木构架」，windmill-pump 的 `timber` 却是 label 写作
 * "Boards"（木板）。所以先信资产方自己写的 label，只有 label 翻不出来时才用 key 兜。
 */
export function labelZh(param){
 if(!param)return '';
 const key=String(param.key??'').trim();
 const raw=String(param.label??'').trim();
 if(raw){
  const phrase=PHRASES[clean(raw)];
  if(phrase)return phrase;
  const words=tokens(raw);
  if(words.length){
   const parts=words.map(word=>WORDS[word]);
   if(parts.every(Boolean))return parts.join('');
  }
 }
 if(KEYS[key])return KEYS[key];
 return raw||key;
}

/** 选项 / 配色方案名 → 中文（cream-stone → 奶油色石材）。认不全就保留原文。 */
export function valueZh(value){
 const raw=String(value??'').trim();
 if(!raw)return raw;
 const words=tokens(raw);
 if(!words.length)return raw;
 const parts=words.map(word=>WORDS[word]);
 if(!parts.every(Boolean))return raw;
 // 纯数字或单字母这类选项（"4" / "12"）不该被翻，也不该拼成中文序号。
 return parts.join('');
}

/**
 * 面板上该显示什么：**规则层翻出来了就用规则层，规则层认不出才用模型字典**。
 *
 * 反过来的顺序试过，模型会把 windmill 的 cap pitch 译成「机头坡度」（它按风力发电机理解），
 * 比规则层的「顶盖坡度」差。规则命中说明这几个词我们本来就有把握，没必要让模型重译。
 */
export const labelOf=(param,zh)=>{
 const mine=labelZh(param);
 const raw=String(param?.label??param?.key??'');
 if(mine!==raw)return mine;
 return zh?.labels?.[param?.key]||mine;
};

export const valueOf=(value,zh)=>{
 const mine=valueZh(value);
 if(mine!==String(value??''))return mine;
 return zh?.values?.[String(value)]||mine;
};

export const describeOf=(param,zh)=>zh?.describes?.[param?.key]||param?.describe||'';
