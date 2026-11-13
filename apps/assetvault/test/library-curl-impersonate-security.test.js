import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import fs from 'node:fs';
import {curlImpersonateFetch} from '../server/curl-impersonate.mjs';

// Fake child process only. Never executes curl or contacts any site.
async function fakeCurl(t,{code=0,signal=null,status=302}={}){
  const saved=process.env.SFX_CURL_IMPERSONATE;
  process.env.SFX_CURL_IMPERSONATE=process.execPath;
  let args;
  t.mock.method(childProcess,'spawn',(_binary,argv)=>{
    args=argv;
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    queueMicrotask(()=>{
      fs.writeFileSync(argv[argv.indexOf('-D')+1],`HTTP/1.1 ${status} Test\r\nLocation: http://127.0.0.1/private\r\n\r\n`);
      child.stdout.write('fictional-body');child.stderr.write('fictional-secret-must-not-leak');
      child.emit('close',code,signal);
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(()=>{
    t.mock.restoreAll();syncBuiltinESMExports();
    if(saved===undefined)delete process.env.SFX_CURL_IMPERSONATE;else process.env.SFX_CURL_IMPERSONATE=saved;
  });
  return ()=>args;
}

test('curl single hop: no curlrc, no auto-redirect/insecure, direct stays direct',async t=>{
  const args=await fakeCurl(t);
  const response=await curlImpersonateFetch('https://a.test/',{caFile:null});
  assert.equal(response.status,302,'redirect must be exposed to guarded caller');
  assert.equal(response.headers.location,'http://127.0.0.1/private');
  assert.equal(args()[0],'-q');
  assert.equal(args()[args().indexOf('--proxy')+1],'');
  assert.equal(args()[args().indexOf('--proto')+1],'=http,https');
  for(const forbidden of ['-L','--location','-k','--insecure','--proxy-insecure'])assert.ok(!args().includes(forbidden));
  assert.ok(!args().includes('-H'),'no implicit user cookies or caller headers');
});

test('curl explicit CA is supplied to HTTPS target and HTTPS proxy',async t=>{
  const args=await fakeCurl(t,{status:200});
  await curlImpersonateFetch('https://a.test/',{proxy:new URL('https://fictional:fake@proxy.test'),caFile:'fictional-ca.pem'});
  assert.equal(args()[args().indexOf('--cacert')+1],'fictional-ca.pem');
  assert.equal(args()[args().indexOf('--proxy-cacert')+1],'fictional-ca.pem');
  assert.equal(args()[args().indexOf('--proxy')+1],'https://proxy.test');
});

test('curl rejects certificate failure even when partial redirect headers exist; stderr never leaks',async t=>{
  await fakeCurl(t,{code:60});
  await assert.rejects(curlImpersonateFetch('https://a.test/',{caFile:null}),error=>{
    assert.match(error.message,/退出码 60/);assert.doesNotMatch(error.message,/fictional-secret/);return true;
  });
});

test('curl process signal is failure, never a partial HTTP success',async t=>{
  await fakeCurl(t,{code:null,signal:'SIGTERM'});
  await assert.rejects(curlImpersonateFetch('https://a.test/',{caFile:null}),/进程中断/);
});
