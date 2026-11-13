import test from 'node:test';
import assert from 'node:assert/strict';
import {pictureSiteJobUid} from '../src/library/platforms.js';
import {LOCAL_IDENTITY_VERSION, legacyPackageFavoriteUid, packageFavoriteIdentity, preflightLocalFavoriteMigration} from '../src/library/local-asset-identity.js';

const uid = 'local-' + 'a'.repeat(32);
const pkg = {uid, root:'H:/Assets', rel:'Models/Chair'};
const frozen = value => {if (value && typeof value === 'object') {Object.values(value).forEach(frozen);Object.freeze(value);}return value;};

test('local 固定身份不依赖根目录/包名称，版本化命名空间不冒充原资产 UID', () => {
  const original = packageFavoriteIdentity(pkg);
  const moved = packageFavoriteIdentity({...pkg,root:'J:/Moved',rel:'Renamed'});
  assert.equal(original.favoriteUid,moved.favoriteUid);
  assert.match(original.favoriteUid,/^[a-f0-9]{32}$/);
  assert.equal(original.assetUid,uid);
  assert.equal(original.stable,true);
  assert.notEqual(original.favoriteUid,'a'.repeat(32));
  assert.equal(original.favoriteUid,pictureSiteJobUid('assetvault-local-favorite-v1',uid));
  assert.notEqual(original.legacyUid,moved.legacyUid);
  assert.equal(LOCAL_IDENTITY_VERSION,1);
});

test('在线 32hex UID 逐字沿用；无效或缺 UID 与现有路径键逐字兼容', () => {
  for(const value of ['b'.repeat(32),'ABCDEF'.repeat(5)+'AB']) {
    const identity = packageFavoriteIdentity({...pkg,uid:value});
    assert.equal(identity.favoriteUid,value);assert.equal(identity.legacyUid,value);
  }
  for(const value of [undefined,'','broken','local-'+ 'A'.repeat(32)]) {
    const input={...pkg,uid:value};
    const identity=packageFavoriteIdentity(input);
    assert.equal(identity.favoriteUid,pictureSiteJobUid('package',`${input.root}|${input.rel}`));
    assert.equal(identity.stable,false);
  }
  assert.notEqual(legacyPackageFavoriteUid({...pkg,root:'H:/Assets'}),legacyPackageFavoriteUid({...pkg,root:'h:/assets'}),'legacy path key is not normalized');
});

test('已知旧键给出预览和回退 alias，重复预检幂等且输入完全不变', () => {
  const old=legacyPackageFavoriteUid(pkg),canonical=packageFavoriteIdentity(pkg).favoriteUid;
  const input=frozen({packages:[{...pkg}],favorites:[old,old]});
  const before=JSON.stringify(input);
  const result=preflightLocalFavoriteMigration(input);
  assert.deepEqual(result.proposedFavorites,[canonical]);
  assert.deepEqual(result.migrations,[{from:old,to:canonical,assetUid:uid,index:0}]);
  assert.deepEqual(result.aliases,result.migrations);
  assert.deepEqual(result.conflicts,[]);assert.deepEqual(result.unresolved,[]);
  assert.deepEqual(result,preflightLocalFavoriteMigration(input));
  assert.equal(JSON.stringify(input),before);
  const repeated=preflightLocalFavoriteMigration({packages:input.packages,favorites:result.proposedFavorites});
  assert.deepEqual(repeated.migrations,[]);
  assert.deepEqual(repeated.aliases,result.aliases,'aliases remain available after preview is applied externally');
  assert.deepEqual(repeated.proposedFavorites,result.proposedFavorites);
  assert.deepEqual(JSON.parse(JSON.stringify(result)),result,'preview is plain serializable data');
});

test('同固定 UID 多包保持全部记录、阻断迁移并显式列出冲突', () => {
  const other={...pkg,root:'K:/Another',rel:'Other'};
  const old=legacyPackageFavoriteUid(pkg),canonical=packageFavoriteIdentity(pkg).favoriteUid;
  const result=preflightLocalFavoriteMigration({packages:frozen([pkg,other]),favorites:[old,canonical]});
  assert.equal(result.identities.length,2);
  assert.ok(result.conflicts.some(item=>item.code==='duplicate-fixed-uid'&&item.indexes.length===2));
  assert.deepEqual(result.aliases,[]);assert.deepEqual(result.migrations,[]);
  assert.deepEqual(result.proposedFavorites,[old,canonical]);
  assert.deepEqual(result.unresolved,[{uid:old,reason:'conflict'},{uid:canonical,reason:'conflict'}]);
});

test('不同固定 UID 竞争同路径别名以及目标键碰撞均不自动合并', () => {
  const different={...pkg,uid:'local-'+ 'b'.repeat(32)};
  const old=legacyPackageFavoriteUid(pkg);
  const result=preflightLocalFavoriteMigration({packages:[pkg,different],favorites:[old]});
  assert.ok(result.conflicts.some(item=>item.code==='ambiguous-favorite-key'&&item.favoriteUid===old));
  assert.deepEqual(result.migrations,[]);assert.deepEqual(result.proposedFavorites,[old]);
  const target=packageFavoriteIdentity(pkg).favoriteUid;
  const collision=preflightLocalFavoriteMigration({packages:[pkg,{uid:target,root:'X:/Online',rel:'Model'}],favorites:[old,target]});
  assert.deepEqual(collision.migrations,[]);
  assert.deepEqual(collision.proposedFavorites,[old,target]);
});

test('未知旧路径、无扫描关联在线收藏和无 UID 包保留，不猜测搬迁关联', () => {
  const unknown=legacyPackageFavoriteUid({...pkg,root:'G:/UnknownOldPath'});
  const online='e'.repeat(32);
  const unregistered={root:'D:/Linked',rel:'NewPackage'};
  const fallback=legacyPackageFavoriteUid(unregistered);
  const input=frozen({packages:[pkg,unregistered],favorites:[unknown,online,fallback]});
  const result=preflightLocalFavoriteMigration(input);
  assert.deepEqual(result.proposedFavorites,input.favorites);
  assert.deepEqual(result.migrations,[]);
  assert.deepEqual(result.unresolved,[{uid:unknown,reason:'unknown-association'},{uid:online,reason:'unknown-association'}]);
  assert.equal(result.identities[1].kind,'legacy-path');
  assert.equal(Object.hasOwn(unregistered,'uid'),false);
  const moved=preflightLocalFavoriteMigration({packages:[{...pkg,root:'Z:/Moved'}],favorites:[unknown]});
  assert.deepEqual(moved.proposedFavorites,[unknown]);assert.deepEqual(moved.migrations,[]);
});

test('同源新旧收藏并存的预览只去重收藏集合，不删除包且保留 alias', () => {
  const canonical=packageFavoriteIdentity(pkg).favoriteUid,old=legacyPackageFavoriteUid(pkg);
  const result=preflightLocalFavoriteMigration({packages:[pkg],favorites:new Set([old,canonical])});
  assert.deepEqual(result.proposedFavorites,[canonical]);assert.equal(result.identities.length,1);
  assert.equal(result.aliases.length,1);assert.equal(result.migrations.length,1);
  assert.deepEqual(preflightLocalFavoriteMigration().proposedFavorites,[]);
});
