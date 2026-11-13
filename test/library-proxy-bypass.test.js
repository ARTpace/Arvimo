// 代理分流：国内图床直连、境外站点继续走代理。
//
// 这不是安全判定（直连照样过 URL/公网 IP 校验与 DNS pinning），是纯性能偏好：
// 实测花瓣走本机 Clash 代理 489ms/张，直连 224ms/张 —— 上千张的板子差出十几分钟。
// 但它必须可覆盖、可关闭，否则「换个网络就下不动了」。
import test from 'node:test';import assert from 'node:assert/strict';
import {shouldBypassProxy} from '../server/public-http.mjs';

test('国内图床默认直连，境外站点仍然走代理',()=>{
  assert.equal(shouldBypassProxy('gd-hbimg.huaban.com',{}),true);
  assert.equal(shouldBypassProxy('gd-hbimg-edge.huaban.com',{}),true);
  assert.equal(shouldBypassProxy('huaban.com',{}),true);
  assert.equal(shouldBypassProxy('www.zcool.com.cn',{}),true);
  assert.equal(shouldBypassProxy('www.artstation.com',{}),false);
  assert.equal(shouldBypassProxy('media.sketchfab.com',{}),false);
  assert.equal(shouldBypassProxy('i.pximg.net',{}),false);
});

test('环境变量可以追加域名、全部直连，或彻底关掉分流',()=>{
  assert.equal(shouldBypassProxy('cdn.example.cn',{SFX_PROXY_BYPASS:'example.cn'}),true);
  assert.equal(shouldBypassProxy('a.b.example.cn',{SFX_PROXY_BYPASS:'example.cn,foo.com'}),true);
  assert.equal(shouldBypassProxy('cdn.example.cn',{SFX_PROXY_BYPASS:'notexample.cn'}),false,'不能按子串匹配');
  assert.equal(shouldBypassProxy('www.artstation.com',{SFX_PROXY_BYPASS:'all'}),true);
  assert.equal(shouldBypassProxy('gd-hbimg.huaban.com',{SFX_PROXY_BYPASS:'none'}),false,'none = 恢复一律走代理');
});

test('认不出的主机老实走代理，空值不误伤',()=>{
  assert.equal(shouldBypassProxy('',{}),false);
  assert.equal(shouldBypassProxy(undefined,{}),false);
  assert.equal(shouldBypassProxy('huaban.com.evil.example',{}),false,'后缀伪装不能命中');
});
