// S3-c 前端：变更广播客户端的验收。
//
// 守的是三件事：
//   1. **只失效受影响的卡片**：广播带 uid 就只报这些 uid；粗粒度事件才报「全量」。
//   2. **合并重绘**：一批变更攒成一次回调，别一张卡重绘一次。
//   3. **断线不瘫**：连不上就退到 offline，坏帧直接丢，不影响后续事件。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLibraryEvents, collectChange, flushChange} from '../src/library/library-events.js';

/** 假 EventSource：手工推事件，模拟浏览器。 */
class FakeSource {
  static last = null;
  constructor(url) { this.url = url; this.readyState = 0; FakeSource.last = this; }
  close() { this.readyState = 2; }
  open() { this.readyState = 1; this.onopen?.(); }
  message(data) { this.onmessage?.({data}); }
  fail() { this.readyState = 2; this.onerror?.(); }
}

const createTimers = () => {
  const queue = [];
  return {
    setTimer: (fn, ms) => { queue.push({fn, ms}); return queue.length; },
    clearTimer: id => { queue[id - 1] = null; },
    run() { for (const item of queue) if (item) item.fn(); },
  };
};

test('变更收集：带 uid 的只报这些 uid，粗粒度事件才报全量', () => {
  const pending = {uids: new Set(), all: false};
  collectChange({kind: 'tags', uid: 'a'.repeat(32), rev: 3}, pending);
  collectChange({kind: 'tags', uid: 'b'.repeat(32), rev: 4}, pending);
  collectChange({kind: 'tags', uid: 'a'.repeat(32), rev: 5}, pending);
  assert.equal(pending.uids.size, 2, '同一个 uid 多次变更只算一次');
  assert.equal(pending.all, false);

  const changed = flushChange(pending);
  assert.deepEqual(changed.uids.sort(), ['a'.repeat(32), 'b'.repeat(32)].sort());
  assert.equal(changed.all, false);
  assert.equal(pending.uids.size, 0, '取走之后要清空，否则下次会重复通知');

  const coarse = {uids: new Set(), all: false};
  collectChange({kind: 'assets'}, coarse);
  assert.equal(coarse.all, true);
});

test('订阅：连上后收到事件会合并成一次回调', () => {
  const timers = createTimers();
  const changes = [];
  const events = createLibraryEvents({
    createSource: url => new FakeSource(url),
    onChange: change => changes.push(change),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  events.start();
  const source = FakeSource.last;
  source.open();
  source.message(JSON.stringify({kind: 'tags', uid: 'a'.repeat(32), rev: 2}));
  source.message(JSON.stringify({kind: 'tags', uid: 'b'.repeat(32), rev: 2}));
  assert.equal(changes.length, 0, '还没到合并窗口，不该重绘');
  timers.run();
  assert.equal(changes.length, 1, '一批变更只重绘一次');
  assert.equal(changes[0].uids.length, 2);

  // 坏帧直接丢，后续事件照常
  source.message('这不是 JSON');
  source.message(JSON.stringify({kind: 'asset', uid: 'c'.repeat(32), rev: 9}));
  timers.run();
  assert.equal(changes.length, 2);
  assert.equal(changes[1].uids[0], 'c'.repeat(32));

  events.stop();
  assert.equal(source.readyState, 2, '停止后应断开连接');
});

test('连不上就退到 offline，不无限重连', () => {
  const timers = createTimers();
  const statuses = [];
  const events = createLibraryEvents({
    createSource: url => new FakeSource(url),
    onStatus: status => statuses.push(status),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    maxRetries: 1,
  });
  events.start();
  FakeSource.last.fail();
  assert.deepEqual(statuses, ['connecting', 'retrying']);
  // 第二次失败就超过 maxRetries → offline
  FakeSource.last.fail();
  assert.equal(events.status, 'offline');
});
