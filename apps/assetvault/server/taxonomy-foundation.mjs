// 基础分类 v3：不覆盖用户词条；新增词条显式固定 seed ID，后续改名必须保留该 ID。
const groups=[
 ['software',null,['Photoshop','Illustrator','Substance 3D Painter','Substance 3D Designer','ZBrush','Houdini','Marvelous Designer','3DCoat','Procreate','Krita','After Effects','DaVinci Resolve','Figma']],
 ['platform',null,['Fab','ArtStation','Behance','Pinterest','Unsplash','Pexels','Figma Community','Billfish']],
 ['license',null,['MIT','Apache-2.0','GPL-3.0-only','仅个人使用','仅非商业使用','商业授权','授权未知']],
 ['license','CC BY',['CC BY 4.0']],['license','CC BY-SA',['CC BY-SA 4.0']],['license','CC BY-NC',['CC BY-NC 4.0']],
 ['subject','建筑',['住宅建筑','商业建筑','工业建筑','宗教建筑','古建筑','桥梁','城墙','塔楼','室内空间']],
 ['subject','室内空间',['客厅','卧室','厨房','卫生间','办公室','教室','商店','餐厅']],
 ['subject','家具',['座椅','桌子','床具','柜架','灯具','沙发']],
 ['subject','植被',['灌木','草本植物','藤蔓','苔藓','多肉植物','水生植物']],
 ['subject','树木',['针叶树','阔叶树','棕榈树','枯树']],
 ['subject','花卉',['花束','花瓣','花蕾']],
 ['subject','动物',['哺乳动物','鸟类','鱼类','昆虫','爬行动物','两栖动物']],
 ['subject','人物',['男性角色','女性角色','儿童角色','头部','手部','全身角色']],
 ['subject','服饰',['上装','下装','鞋靴','帽饰','首饰','背包','护甲']],
 ['subject','道具',['书籍','工具','乐器','运动器材','电子设备','文具']],
 ['subject','食物',['水果','蔬菜','饮料','甜点','面包','餐食']],
 ['subject','地形',['沙漠','雪地','草地','森林地表','海岸','洞穴']],
 ['subject','载具',['地面载具','水面载具','轨道载具']],
 ['subject','机械',['齿轮','管线','发动机','机床']],
 ['style',null,['美式卡通','日式卡通','像素立体','黏土定格','纸艺','美术装饰','新艺术','包豪斯','北欧风','洛可可','中世纪风','维多利亚风']],
 ['material',null,['竹材','软木','砂浆','沥青','硅胶','绒布','丝绸','亚麻','棉布','尼龙','纤维','釉面','琉璃','瓷器','搪瓷']],
 ['usage',null,['角色设计','道具设计','材质制作','界面设计','图标设计','分镜','贴花','粒子效果','骨骼动画','动作捕捉','动作参考','色彩参考','构图参考']],
 ['tech',null,['骨骼蒙皮','面部绑定','形态键','顶点色','UDIM','三平面映射','细分曲面','曲线建模','几何节点','实例化','平铺纹理','顶点动画','流体模拟','布料模拟','毛发系统','光照烘焙']],
];

// v5 补充（2026-11-15 用户反馈「标签都是分散的，要给标签分组」）：
// 这些词早就在库里挂着资产，却因为没有归属任何面而全落进「未归类」——
// 词表是数据不是代码，补词只改这个文件 + 递增 VOCAB_REV，不动任何逻辑。
// 刻意不收：蓝天、白色 —— 颜色已经是 assets.color_h 这一列，颜色再当标签就是两套体系打架
//（与 seed 里「刻意不收录类型/格式/尺寸/颜色/评分」同一条纪律）。
const additions=[
 ['subject','建筑',['台阶','拱门','石柱','穹顶','哥特式建筑','塔','尖顶','屋顶','阳台','灯塔','日式建筑']],
 ['subject','宗教建筑',['教堂','钟楼']],
 ['subject','屋顶',['瓦片屋顶']],
 ['style',null,['古典风格','欧式风格','3D渲染']],
 ['mood',null,['宏伟']],
];

const build=(prefix,rows)=>rows.flatMap(([facet,parent,values])=>values.map(value=>({id:prefix+value,value,facets:[facet],aliases:[],...(parent?{parent}:{})})));
export const FOUNDATION_TERMS=[...build('core-v3:',groups),...build('core-v5:',additions)];
