// 合同集成测试：真实原语 + 内存严格 CAS，不是生产引擎或真实 WebDAV 服务器验收。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebdav} from '../server/webdav-client.mjs';
import {encodeSyncSnapshot, decodeSyncSnapshot} from '../server/sync-snapshot-object.mjs';
import {planSyncHeadCommit} from '../server/sync-head-plan.mjs';
import {mergeSyncRecord} from '../server/sync-three-way.mjs';

const HEAD = 'assetvault-v2/head.json';
const objectPath = hash => `assetvault-v2/objects/${hash}.json`;
const commitId = n => n.toString(16).padStart(64, '0');

function fixture() {
  const files = new Map(), requests = [];
  let version = 0, afterHeadGet = null;
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname.slice(1);
    const headers = new Headers(options.headers);
    assert.equal(options.redirect, 'error');
    assert.ok(path.startsWith('assetvault-v2/'), '不得接触 v1 命名空间');
    const old = files.get(path);
    const request = {path, method: options.method, match: headers.get('if-match'), none: headers.get('if-none-match')};
    requests.push(request);
    assert.notEqual(options.method, 'HEAD', '合同读取不得使用 HEAD 拼接令牌');
    if (options.method === 'GET') {
      request.status = old ? 200 : 404;
      const response = new Response(old ? Buffer.from(old.buffer) : null,
        {status: request.status, headers: old ? {etag: old.etag} : {}});
      if (path === HEAD && afterHeadGet) {
        const hook = afterHeadGet;
        afterHeadGet = null;
        await hook(); // 已捕获旧响应，返回前让另一客户端发布新 head。
      }
      return response;
    }
    assert.equal(options.method, 'PUT');
    assert.notEqual(request.match !== null, request.none !== null, '所有写入必须恰带一个条件');
    if ((request.none === '*' && old) || (request.match !== null && request.match !== old?.etag)) {
      request.status = 412;
      return new Response(null, {status: 412});
    }
    assert.ok(request.none === '*' || request.match === old?.etag);
    if (path === HEAD) {
      const head = JSON.parse(Buffer.from(options.body).toString());
      assert.ok(files.has(objectPath(head.snapshotHash)), 'head 只能引用已完成上传的对象');
    }
    const etag = `"cas-${++version}"`;
    files.set(path, {etag, buffer: Buffer.from(options.body)});
    request.status = old ? 204 : 201;
    return new Response(null, {status: request.status, headers: {etag}});
  };
  const client = () => createWebdav({url: 'https://dav.invalid', fetchImpl});
  return {files, requests, client, afterNextHeadGet(hook) { afterHeadGet = hook; }};
}

async function readBaseline(dav) {
  const meta = await dav.getWithMetadata(HEAD);
  if (!meta) return {head: null, rawEtag: null, snapshot: null};
  const head = JSON.parse(meta.buffer.toString());
  const object = await dav.getWithMetadata(objectPath(head.snapshotHash));
  if (!object) throw new Error('同步快照对象缺失');
  const {buffer} = object;
  // head 原语尚不含 bytes；本测试以下载实际长度传入 codec，hash 仍绑定内容。
  const snapshot = decodeSyncSnapshot(buffer, {hash: head.snapshotHash, bytes: buffer.length});
  return {head, rawEtag: meta.rawEtag, snapshot};
}

async function stage(dav, baseline, snapshot, id) {
  const encoded = encodeSyncSnapshot(snapshot);
  const plan = planSyncHeadCommit({previous: baseline.head, rawEtag: baseline.rawEtag,
    snapshotHash: encoded.hash, commitId: commitId(id)});
  await dav.putConditional(objectPath(encoded.hash), encoded.buffer, {ifNoneMatch: '*'});
  return {plan, encoded};
}
const publish = (dav, staged) => dav.putConditional(HEAD, Buffer.from(JSON.stringify(staged.plan.head)), staged.plan.condition);

async function initialize(f, snapshot) {
  const dav = f.client();
  const empty = await readBaseline(dav);
  const staged = await stage(dav, empty, snapshot, 1);
  assert.deepEqual(staged.plan.condition, {ifNoneMatch: '*'});
  await publish(dav, staged);
  return dav;
}

test('首次 create-only；双客户端先对象后 head，同基线仅一成功，412 后重读三方合并清空再 CAS', async () => {
  const f = fixture();
  const base = {note: '旧备注', favorite: true, rating: 3, tags: ['保留', '移除']};
  const a = await initialize(f, base), b = f.client();
  const baseA = await readBaseline(a), baseB = await readBaseline(b);
  assert.equal(baseA.rawEtag, baseB.rawEtag);
  const localA = {...base, note: '', favorite: false, tags: []};
  const localB = {...base, rating: 0};
  const [stagedA, stagedB] = await Promise.all([stage(a, baseA, localA, 2), stage(b, baseB, localB, 3)]);
  const results = await Promise.allSettled([publish(a, stagedA), publish(b, stagedB)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'WEBDAV_CONFLICT');
  assert.equal(rejected.reason.status, 412);
  const updates = f.requests.filter(item => item.path === HEAD && item.method === 'PUT').slice(1);
  assert.equal(updates.length, 2, '412 没有无条件重试');
  assert.deepEqual(updates.map(item => item.status).sort(), [204, 412]);
  assert.ok(updates.every(item => item.match === baseA.rawEtag && item.none === null));
  // 两个不可变对象均在 head CAS 前上传；失败者对象存在但未可见。
  assert.ok(f.files.has(objectPath(stagedA.encoded.hash)));
  assert.ok(f.files.has(objectPath(stagedB.encoded.hash)));
  const winner = results[0].status === 'fulfilled' ? localA : localB;
  const loser = results[0].status === 'fulfilled' ? localB : localA;
  const latest = await readBaseline(b);
  assert.deepEqual(latest.snapshot, winner);
  const merged = mergeSyncRecord({base, local: loser, remote: latest.snapshot});
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.record, {note: '', favorite: false, rating: 0, tags: []});
  const retry = await stage(b, latest, merged.record, 4);
  assert.equal(retry.plan.head.parentCommit, latest.head.commitId);
  assert.equal(retry.plan.head.generation, 3);
  assert.equal(retry.plan.condition.ifMatch, latest.rawEtag);
  await publish(b, retry);
  assert.deepEqual((await readBaseline(a)).snapshot, merged.record);
});

test('同字段冲突保留 base/双方快照，测试编排阻止提交 head；损坏对象拒绝读取', async () => {
  const f = fixture();
  const base = {note: '基线', favorite: true};
  const a = await initialize(f, base), b = f.client();
  const baseline = await readBaseline(b);
  const remote = {...base, note: '远端修改'};
  const staged = await stage(a, baseline, remote, 2);
  await publish(a, staged);
  const latest = await readBaseline(b);
  const before = f.requests.filter(item => item.method === 'PUT' && item.path === HEAD).length;
  const merged = mergeSyncRecord({base: baseline.snapshot, local: {...base, note: ''}, remote: latest.snapshot});
  assert.equal(merged.conflicts.length, 1);
  assert.deepEqual(merged.record, base);
  assert.deepEqual(merged.conflicts[0], {scope: 'field', field: 'note', base: {present: true, value: '基线'},
    local: {present: true, value: ''}, remote: {present: true, value: '远端修改'}});
  // 这里只演示测试调用方必须检查 conflicts，planner 本身不执行 I/O。
  if (!merged.conflicts.length) await publish(b, await stage(b, latest, merged.record, 3));
  assert.equal(f.requests.filter(item => item.method === 'PUT' && item.path === HEAD).length, before);
  assert.deepEqual((await readBaseline(a)).snapshot, remote);
  const object = f.files.get(objectPath(latest.head.snapshotHash));
  object.buffer[object.buffer.length - 3] ^= 1;
  await assert.rejects(() => readBaseline(b), /SHA-256/);
  assert.equal(f.requests.filter(item => item.method === 'PUT' && item.path === HEAD).length, before);
});

test('单次 GET 捕获旧 head 与令牌后远端发布新版：旧计划 412，重读配对后正确 CAS', async () => {
  const f = fixture();
  const base = {note: '基线', rating: 1};
  const a = await initialize(f, base), b = f.client();
  const baseline = await readBaseline(a);
  const remote = {...base, note: '新版'};
  const remoteStage = await stage(a, baseline, remote, 2);
  const oldEtag = baseline.rawEtag;
  const readsBefore = f.requests.filter(item => item.method === 'GET' && item.path === HEAD).length;
  f.afterNextHeadGet(() => publish(a, remoteStage));
  const captured = await readBaseline(b);
  assert.equal(f.requests.filter(item => item.method === 'GET' && item.path === HEAD).length, readsBefore + 1);
  assert.deepEqual(captured.head, baseline.head);
  assert.equal(captured.rawEtag, oldEtag);
  assert.deepEqual(captured.snapshot, base);
  assert.notEqual(f.files.get(HEAD).etag, captured.rawEtag);
  const winningHead = Buffer.from(f.files.get(HEAD).buffer);
  const stale = await stage(b, captured, {...base, rating: 0}, 3);
  const putsBefore = f.requests.filter(item => item.method === 'PUT' && item.path === HEAD).length;
  await assert.rejects(() => publish(b, stale), error => error.code === 'WEBDAV_CONFLICT' && error.status === 412);
  assert.equal(f.requests.filter(item => item.method === 'PUT' && item.path === HEAD).length, putsBefore + 1);
  assert.deepEqual(f.files.get(HEAD).buffer, winningHead, '旧计划不能覆盖已发布的新版本');
  const latest = await readBaseline(b);
  assert.deepEqual(latest.head, remoteStage.plan.head);
  assert.equal(latest.rawEtag, f.files.get(HEAD).etag);
  assert.deepEqual(latest.snapshot, remote);
  const merged = mergeSyncRecord({base: captured.snapshot, local: {...base, rating: 0}, remote: latest.snapshot});
  assert.deepEqual(merged.conflicts, []);
  const retry = await stage(b, latest, merged.record, 4);
  assert.equal(retry.plan.condition.ifMatch, latest.rawEtag);
  assert.equal(retry.plan.head.parentCommit, remoteStage.plan.head.commitId);
  assert.equal(retry.plan.head.generation, latest.head.generation + 1);
  await publish(b, retry);
  assert.deepEqual((await readBaseline(a)).snapshot, {note: '新版', rating: 0});
  assert.ok(f.requests.every(item => item.method !== 'HEAD'));
});

test('缺失或超过 8 MiB 的快照对象显式拒绝，读取失败无 PUT 且不覆盖 head', async () => {
  const f = fixture();
  const dav = await initialize(f, {note: '正常基线'});
  const baseline = await readBaseline(dav);
  const path = objectPath(baseline.head.snapshotHash);
  const headBefore = {etag: f.files.get(HEAD).etag, buffer: Buffer.from(f.files.get(HEAD).buffer)};
  const putsBefore = f.requests.filter(item => item.method === 'PUT').length;
  f.files.delete(path); // 模拟远端 head 引用丢失对象，不能误当空库。
  await assert.rejects(() => readBaseline(dav), /同步快照对象缺失/);
  assert.equal(f.requests.filter(item => item.method === 'PUT').length, putsBefore);
  assert.deepEqual(f.files.get(HEAD), headBefore);
  // 无 Content-Length：必须在真实 client 流式累计时拒绝，不能仅依赖响应头。
  f.files.set(path, {etag: '"malicious-object"', buffer: Buffer.alloc(8 * 1024 * 1024 + 1, 32)});
  const readsBefore = f.requests.length;
  await assert.rejects(() => readBaseline(dav), error => error.code === 'WEBDAV_TOO_LARGE' && error.status === 200);
  assert.deepEqual(f.requests.slice(readsBefore).map(item => [item.method, item.path]), [['GET', HEAD], ['GET', path]]);
  assert.equal(f.requests.filter(item => item.method === 'PUT').length, putsBefore);
  assert.deepEqual(f.files.get(HEAD), headBefore);
});
