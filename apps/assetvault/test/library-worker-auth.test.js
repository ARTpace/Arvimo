import test from 'node:test';
import assert from 'node:assert/strict';
import {isExportWorkerRequest} from '../server/export-worker.mjs';

test('active worker credentials only allow local read-only conversion resources',()=>{
 const tokens=new Map([['active',{}]]);
 const req={method:'GET',headers:{'x-sfx-transfer':'active'},socket:{remoteAddress:'127.0.0.1'}};
 const allowed=path=>isExportWorkerRequest(req,new URL(path,'http://localhost'),tokens);
 for(const path of ['/worker.html','/engine.js','/api/proxy?url=https://sketchfab.com'])assert.equal(allowed(path),true,path);
 for(const path of ['/api/library/assets','/api/downloads','/api/browser/cookies','/engine.js/extra'])assert.equal(allowed(path),false,path);
 req.method='POST';assert.equal(allowed('/api/proxy'),false);req.method='GET';
 req.socket.remoteAddress='192.168.1.2';assert.equal(allowed('/engine.js'),false);
 req.socket.remoteAddress='::ffff:127.0.0.1';assert.equal(allowed('/engine.js'),true);
 tokens.delete('active');assert.equal(allowed('/engine.js'),false);
 delete req.headers['x-sfx-transfer'];assert.equal(allowed('/engine.js'),false);
});
