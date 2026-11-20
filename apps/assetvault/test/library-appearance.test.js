import test from 'node:test';
import assert from 'node:assert/strict';
import {applyAppearance,PRESETS,readAppearance} from '../src/library/appearance.js';
import {readFileSync} from 'node:fs';
import {assembleLibraryStyles} from '../scripts/lib/library-styles.mjs';

test('final cascade keeps neutral surfaces theme-aware, including late search and preview styles',()=>{
 const css=(assembleLibraryStyles()+readFileSync(new URL('../src/library/search-motion.css',import.meta.url),'utf8')+readFileSync(new URL('../src/library/viewer.css',import.meta.url),'utf8')).replace(/\/\*[\s\S]*?\*\//g,'');
 const selectors=['.aa-stat','.aa-row','#library-filters .local-filter-tabs','#library-filters .local-tag-input','#library-filters .local-tag-chips .ftree-leaf','.mascot-lab','.mascot-lab select','.mascot-lab-effects button','#search-panel .bot-bubble','.viewer-wrap'];
 for(const selector of selectors){
  const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m=>m[1].trim().split(/,\s*/).includes(selector));
  assert.ok(rules.length,selector);
  for(const rule of rules){
   const background=rule[2].match(/(?:^|;)\s*background(?:-color)?\s*:([^;]+)/);
   if(background) assert.match(background[1],/var\(--av-/,selector);
  }
 }
});

test('theme changes update shared and legacy surfaces together without touching semantic accents',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
 const values=new Map([['--accent','#c9f581']]);
 Object.defineProperty(globalThis,'document',{configurable:true,value:{documentElement:{style:{setProperty:(key,value)=>values.set(key,value)}}}});
 try{
  for(const preset of PRESETS){
   applyAppearance({color:preset.color,alpha:1,image:null});
   assert.equal(values.get('--bg'),preset.color);
   assert.equal(values.get('--surface'),values.get('--av-panel'));
   assert.equal(values.get('--card'),values.get('--av-panel-raised'));
   assert.equal(values.get('--border'),values.get('--av-line'));
   assert.ok(values.get('--av-caption').startsWith('rgba('));
   assert.equal(values.get('--accent'),'#c9f581');
  }
 }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;}
});


test('theme selection persists and old appearance settings retain dark mode',()=>{
 assert.equal(readAppearance({getItem:()=>JSON.stringify({color:'#131110'})}).mode,'dark');
 assert.equal(readAppearance({getItem:()=>JSON.stringify({mode:'light',color:'#f3f5f7'})}).mode,'light');
 assert.equal(readAppearance({getItem:()=>JSON.stringify({mode:'invalid'})}).mode,'dark');
});

test('light mode applies native control theme and distinct readable surfaces',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
 const values=new Map(),attrs=new Map(),style={setProperty:(key,value)=>values.set(key,value)};
 Object.defineProperty(globalThis,'document',{configurable:true,value:{documentElement:{style,setAttribute:(key,value)=>attrs.set(key,value)}}});
 try{
  applyAppearance({mode:'light',color:'#f3f5f7',alpha:1});
  assert.equal(attrs.get('data-theme'),'light');assert.equal(style.colorScheme,'light');
  assert.notEqual(values.get('--av-panel'),values.get('--av-panel-raised'));
  applyAppearance({mode:'dark',color:'#0d1117',alpha:1});
  assert.equal(attrs.get('data-theme'),'dark');assert.equal(style.colorScheme,'dark');
 }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;}
});
