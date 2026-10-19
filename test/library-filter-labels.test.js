import test from 'node:test';
import assert from 'node:assert/strict';
import {ARTSTATION_CATEGORY_ZH,ARTSTATION_TYPE_ZH,zhArtCategory,zhArtType} from '../src/library/filter-labels.js';

// ArtStation 官方 `/filters` 接口在 2026-09 交出来的 59 个分类名，一字不差地抄在这里：
// 这张表是「我们确实覆盖了官方全表」的凭据。少了哪个，下面的遍历会直接报出来，
// 而不是等到界面上多出一行英文才发现。
const OFFICIAL_CATEGORIES=[
 'Abstract','Anatomy','Animals & Wildlife','Anime & Manga','Architectural Concepts',
 'Architectural Visualization','Automotive','Board & Card Game Art','Book Illustration',
 'Character Animation','Character Design','Character Modeling',"Children's Art",'Comic Art',
 'Concept Art','Cover Art','Creatures','Editorial Illustration',
 'Environmental Concept Art & Design','Fan Art','Fantasy','Fashion & Costume Design','Game Art',
 'Gameplay & Level Design','Games and Real-Time 3D Environment Art','Graphic Design','Hard Surface',
 'Horror','Illustration','Industrial & Product Design','Lighting','Matte Painting','Mecha',
 'Mechanical Design','Motion Graphics','Photogrammetry & 3D Scanning','Pixel and Voxel Art',
 'Portraits','Props','Realism','Science Fiction','Scientific Illustration & Visualization',
 'Scripts & Tools','Sketches','Still Life','Storyboards','Stylized','Technical Art',
 'Textures & Materials','Toys & Collectibles','Tutorials','User Interface (UI) Art',
 'VFX for Film, TV & Animation','VFX for Real-Time & Games','Vehicles',
 'Virtual and Augmented Reality','Visual Development','Weapons','Web and App Design',
];
const OFFICIAL_TYPES=['360 Panos','Marmoset Viewer','Sketchfab','Twinmotion','Video','Video Clip'];

test('artstation labels: the whole official category list is translated',()=>{
 assert.equal(OFFICIAL_CATEGORIES.length,59);
 const missing=OFFICIAL_CATEGORIES.filter(name=>!ARTSTATION_CATEGORY_ZH[name]);
 assert.deepEqual(missing,[],'官方分类漏了中文对照');
 // 「翻译过」和「原样搬回来」必须分得出来：中文与英文原文相同，就等于这行没翻译。
 const untranslated=OFFICIAL_CATEGORIES.filter(name=>ARTSTATION_CATEGORY_ZH[name]===name);
 assert.deepEqual(untranslated,[]);
 // 两个分类共用一个中文名，用户就没法在树上分辨它们。
 const labels=OFFICIAL_CATEGORIES.map(zhArtCategory);
 assert.equal(new Set(labels).size,labels.length,'中文分类名有重复');
});

test('artstation labels: the asset-type facet is translated too',()=>{
 assert.equal(OFFICIAL_TYPES.length,6);
 const labels=OFFICIAL_TYPES.map(zhArtType);
 assert.deepEqual(labels,['360 全景','Marmoset 实时场景','Sketchfab 场景','Twinmotion 场景','视频','视频片段']);
 // 鼠标悬停在选项上要看到完整英文原名，所以不能把英文塞进标题就算完事——这里只保证对得上。
 assert.equal(zhArtType('Marmoset Viewer'),'Marmoset 实时场景');
});

test('artstation labels: unknown names fall back to what ArtStation sent',()=>{
 // 官方以后加了新分类，界面宁可多一行英文，也不能变成 undefined 或空字符串。
 assert.equal(zhArtCategory('Volumetric Capture'),'Volumetric Capture');
 assert.equal(zhArtType('VR Sculpt'),'VR Sculpt');
 // 前后空格不该影响命中（接口偶尔会带）。
 assert.equal(zhArtCategory('  Props  '),'道具');
 assert.equal(zhArtCategory(''),'');
 assert.equal(zhArtCategory(null),'');
 assert.equal(zhArtCategory(undefined),'');
 assert.equal(zhArtType(null),'');
});
