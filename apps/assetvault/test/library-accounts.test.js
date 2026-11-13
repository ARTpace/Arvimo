// ADR-13：账号住在库外面 —— 多个资源库共用一套账号，切库不用重新注册 / 登录。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolveUserPaths} from '../server/data-dir.mjs';

function withAppData(run){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'av-accounts-'));
 try{return run(root,path.join(root,'AssetVault'));}
 finally{fs.rmSync(root,{recursive:true,force:true});}
}

test('账号目录默认在资源库外面（base/accounts）', () => withAppData((root,base) => {
 fs.mkdirSync(path.join(base,'data'),{recursive:true});
 const paths=resolveUserPaths({APPDATA:root});
 assert.equal(paths.dataDir,path.join(base,'data'));
 assert.equal(paths.accountsDir,path.join(base,'accounts'));
 // 账号目录不能落在 dataDir 里，否则被切库带走。
 assert.ok(!paths.accountsDir.startsWith(paths.dataDir+path.sep));
}));

test('老版本写在 dataDir 的账号会搬一次并留档', () => withAppData((root,base) => {
 const dataDir=path.join(base,'data');
 fs.mkdirSync(dataDir,{recursive:true});
 fs.writeFileSync(path.join(dataDir,'auth-users.json'),'{"users":[{"name":"主人"}]}');
 fs.writeFileSync(path.join(dataDir,'auth-token'),'legacy-token');

 const paths=resolveUserPaths({APPDATA:root});
 assert.equal(fs.readFileSync(path.join(paths.accountsDir,'auth-users.json'),'utf8'),'{"users":[{"name":"主人"}]}');
 assert.equal(fs.readFileSync(path.join(paths.accountsDir,'auth-token'),'utf8'),'legacy-token');
 // 源文件改名留档，不回删；老 dataDir 里不再有同名活文件，避免两处各写一份。
 assert.equal(fs.existsSync(path.join(dataDir,'auth-users.json')),false);
 assert.ok(fs.readdirSync(dataDir).some(name => name.startsWith('auth-users.json.migrated-')));
}));

test('目标已存在时迁移不覆盖（用户后来改的密码优先）', () => withAppData((root,base) => {
 const dataDir=path.join(base,'data'),accounts=path.join(base,'accounts');
 fs.mkdirSync(dataDir,{recursive:true});
 fs.mkdirSync(accounts,{recursive:true});
 fs.writeFileSync(path.join(dataDir,'auth-users.json'),'{"users":["old"]}');
 fs.writeFileSync(path.join(accounts,'auth-users.json'),'{"users":["current"]}');

 const paths=resolveUserPaths({APPDATA:root});
 assert.equal(fs.readFileSync(path.join(paths.accountsDir,'auth-users.json'),'utf8'),'{"users":["current"]}');
}));

test('显式 SFX_DATA_DIR 时账号跟着数据目录走（便携实例保持独立）', () => withAppData((root,base) => {
 const portable=path.join(root,'portable');
 fs.mkdirSync(portable,{recursive:true});
 const paths=resolveUserPaths({APPDATA:root,SFX_DATA_DIR:portable});
 assert.equal(paths.accountsDir,path.join(portable,'accounts'));
}));

test('SFX_ACCOUNTS_DIR 优先级最高（启动器与桌面版靠它钉住共享目录）', () => withAppData((root,base) => {
 const portable=path.join(root,'portable'),shared=path.join(base,'accounts');
 fs.mkdirSync(portable,{recursive:true});
 const paths=resolveUserPaths({APPDATA:root,SFX_DATA_DIR:portable,SFX_ACCOUNTS_DIR:shared});
 assert.equal(paths.accountsDir,shared);
}));
