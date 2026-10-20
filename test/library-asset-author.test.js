import test from 'node:test';
import assert from 'node:assert/strict';
import {authorButton} from '../src/library/asset-author.js';
test('Sketchfab 和 ArtStation 作者名通过资产 UID 提供作品入口',()=>{
 for(const platform of ['sketchfab','artstation']){
  const html=authorButton({uid:'a'.repeat(32),platform,username:'real_account',author:'Display Name'},'card-byline');
  assert.match(html,/data-author-uid="a{32}"/);assert.match(html,/>Display Name</);assert.match(html,/全部资产/);
 }
});
test('缺少账号时不把作者显示名误当账号，其他平台保持普通文字',()=>{
 assert.doesNotMatch(authorButton({author:'Display Name',platform:'sketchfab'}),/data-author-uid/);
 assert.doesNotMatch(authorButton({author:'Test',username:'test',platform:'polyhaven'}),/data-author-uid/);
 assert.match(authorButton({uid:'a',username:'x',author:'<script>',platform:'artstation'}),/&lt;script&gt;/);
});
