import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {activeModeId} from '../src/library/content-kind-tabs.js';

const source=fs.readFileSync(new URL('../src/library/app.js',import.meta.url),'utf8');
test('展示偏好跨平台保持，重新读取后保持，切换布局不改变内容类别',()=>{
 const values=new Map(),storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
 const prefs=source.slice(source.indexOf("const DISPLAY_KEY="),source.indexOf('// ADR-09：启动期'));
 const platform=source.slice(source.indexOf('function setPlatform('),source.indexOf('/** A 站的「类型」'));
 const setup=()=>{
  const state={route:'discover',mode:'models',platform:'artstation',selected:new Set(),feeds:{},gallery:false};
  const context=vm.createContext({state,localStorage:storage,platformEnabled:()=>true,platformById:id=>({id}),ALL:'all',activeModes:()=>[],rememberPlatform(){},modePresetById:()=>({modelOnly:true}),renderPlatform(){},renderGrid(){},isPictureSite:()=>false,toast(){}});
  vm.runInContext(prefs+platform,context);
  return {state,run:code=>vm.runInContext(code,context)};
 };
 const first=setup();first.run("rememberDisplay('gallery')");
 for(const id of ['sketchfab','flickr','uiverse','link']){
  first.run(`setPlatform('${id}',{autostart:false})`);
  assert.equal(first.state.gallery,true);assert.equal(first.state.mode,'models');
 }
 const restarted=setup();restarted.run("setPlatform('sketchfab',{autostart:false})");
 assert.equal(restarted.state.gallery,true);
 restarted.run("rememberDisplay('grid');setPlatform('flickr',{autostart:false})");
 assert.equal(restarted.state.gallery,false);assert.equal(restarted.state.mode,'models');
 assert.doesNotMatch(source,/state\.gallery\s*=.*preset\.gallery|setPlatform\(target,\{gallery:/);
});

test('瀑布流不再被推断为图片类别，退出类别后保持全部',()=>{
 for(const gallery of [true,false]){
  assert.equal(activeModeId({route:'discover',mode:'',platform:'artstation',gallery}),'');
  assert.equal(activeModeId({route:'discover',mode:'models',platform:'artstation',gallery}),'models');
  assert.equal(activeModeId({route:'discover',mode:'images',platform:'artstation',gallery}),'images');
 }
});
