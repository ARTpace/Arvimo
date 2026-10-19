/**
 * ArtStation 筛选清单的中文对照。
 *
 * ArtStation 的 `/api/artstation/filters` 直接吐官方分面：59 个分类、6 种资产类型，名字全是英文。
 * 服务端只做转述（那条 relay 语义有测试钉着），所以中文放在这里、只作用于显示层：
 * **值一个都不改**——分类的请求参数是数字 id，资产类型是 `marmoset` 这样的串，照原样发出去。
 *
 * 查不到就回落英文原文。官方新增分类时界面只会多一行英文，不会空一格、更不会变成 undefined。
 * Sketchfab 那套分类本来就是中文（search-options.js 的 CATEGORIES），不需要过这里。
 */

export const ARTSTATION_CATEGORY_ZH={
 'Abstract':'抽象',
 'Anatomy':'解剖',
 'Animals & Wildlife':'动物与野生生态',
 'Anime & Manga':'动漫',
 'Architectural Concepts':'建筑概念',
 'Architectural Visualization':'建筑表现',
 'Automotive':'汽车',
 'Board & Card Game Art':'桌游与卡牌',
 'Book Illustration':'书籍插画',
 'Character Animation':'角色动画',
 'Character Design':'角色设计',
 'Character Modeling':'角色建模',
 "Children's Art":'儿童插画',
 'Comic Art':'漫画',
 'Concept Art':'概念设计',
 'Cover Art':'封面插画',
 'Creatures':'怪物生物',
 'Editorial Illustration':'社论插画',
 'Environmental Concept Art & Design':'环境概念设计',
 'Fan Art':'同人创作',
 'Fantasy':'奇幻',
 'Fashion & Costume Design':'时尚与服装',
 'Game Art':'游戏美术',
 'Gameplay & Level Design':'玩法与关卡设计',
 'Games and Real-Time 3D Environment Art':'游戏与实时 3D 场景',
 'Graphic Design':'平面设计',
 'Hard Surface':'硬表面',
 'Horror':'恐怖',
 'Illustration':'插画',
 'Industrial & Product Design':'工业与产品设计',
 'Lighting':'灯光',
 'Matte Painting':'数字接景',
 'Mecha':'机甲',
 'Mechanical Design':'机械设计',
 'Motion Graphics':'动态图形',
 'Photogrammetry & 3D Scanning':'摄影测量与扫描',
 'Pixel and Voxel Art':'像素与体素',
 'Portraits':'肖像',
 'Props':'道具',
 'Realism':'写实',
 'Science Fiction':'科幻',
 'Scientific Illustration & Visualization':'科学插画与可视化',
 'Scripts & Tools':'脚本与工具',
 'Sketches':'速写',
 'Still Life':'静物',
 'Storyboards':'分镜',
 'Stylized':'风格化',
 'Technical Art':'技术美术',
 'Textures & Materials':'贴图与材质',
 'Toys & Collectibles':'玩具与手办',
 'Tutorials':'教程',
 'User Interface (UI) Art':'UI 美术',
 'VFX for Film, TV & Animation':'影视动画特效',
 'VFX for Real-Time & Games':'实时与游戏特效',
 'Vehicles':'载具',
 'Virtual and Augmented Reality':'VR / AR',
 'Visual Development':'视觉开发',
 'Weapons':'武器',
 'Web and App Design':'网页与应用设计',
};

export const ARTSTATION_TYPE_ZH={
 '360 Panos':'360 全景',
 'Marmoset Viewer':'Marmoset 实时场景',
 'Sketchfab':'Sketchfab 场景',
 'Twinmotion':'Twinmotion 场景',
 'Video':'视频',
 'Video Clip':'视频片段',
};

const translate=(table,text)=>{
 const key=String(text??'').trim();
 return table[key]||key;
};

export const zhArtCategory=text=>translate(ARTSTATION_CATEGORY_ZH,text);
export const zhArtType=text=>translate(ARTSTATION_TYPE_ZH,text);
