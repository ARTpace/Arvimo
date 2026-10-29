import test from 'node:test';
import assert from 'node:assert/strict';
import {chineseError} from '../src/library/error-message.js';

test('文件系统错误说明原因与操作，保留路径而不暴露英文底层提示',()=>{
 const message=chineseError("发送失败：ENOENT: no such file or directory, mkdir 'C:\\资产\\pack.unpacked'");
 assert.match(message,/发送失败：创建文件夹失败：找不到文件或目录/);
 assert.match(message,/C:\\资产\\pack\.unpacked/);
 assert.doesNotMatch(message,/ENOENT|no such file|mkdir/);
 for(const code of ['EACCES','EPERM','ENOSPC','EBUSY','EEXIST','ENOTDIR','EISDIR','EROFS','EMFILE']){
  assert.doesNotMatch(chineseError(`${code}: system error, open 'asset.zip'`),new RegExp(code+'|system error'));
 }
});

test('网络错误和服务错误显示中文，未知错误有中文兜底',()=>{
 for(const error of ['fetch failed','ECONNREFUSED 127.0.0.1:47752','ETIMEDOUT','getaddrinfo ENOTFOUND example.com','HTTP 403','HTTP 429','HTTP 503','Unexpected token in JSON']){
  assert.match(chineseError(new Error(error)),/[\u3400-\u9fff]/);
 }
 assert.equal(chineseError('unsupported payload',{fallback:true}),'操作失败，请稍后重试；详细原因请查看任务日志。');
});

test('原有中文提示和正常通知保持不变，日志原文不修改',()=>{
 for(const text of ['已发送到已打开的 Blender 场景','文件已保存','后台设置已保存'])assert.equal(chineseError(text),text);
 const error=new Error('fetch failed');chineseError(error);
 assert.equal(error.message,'fetch failed');
 assert.equal(chineseError(''),'');
});
