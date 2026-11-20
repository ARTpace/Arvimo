// 智能收集画板的规则存储：规则 / 运行记录 / 去重索引三合一的独立 JSON 文件。
//
// 为什么不放 SQLite：规则是低频写、体量小（≤50 条），而内核不可用时合集路由整套 503。
// 独立文件让「规则能看、能改、能停」不被内核可用性绑架，采集失败也不会污染主状态。
// 去重索引 seen 放在同一文件，是为了「一条规则跑完 = 一次原子写盘」，不出现规则已更新、
// 去重没更新的半截状态。
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const COLLECT_LIMITS = Object.freeze({
  rules: 50,
  runs: 200,
  seen: 20000,
  name: 60,
  query: 300,
  platforms: 12,
  perRun: 60,
  fileBytes: 8 * 1024 * 1024,
});

export const COLLECT_FREQUENCIES = Object.freeze(['manual', 'daily']);
export const COLLECT_MODES = Object.freeze(['auto', 'review']);
export const COLLECT_FILTER_KEYS = Object.freeze(['formats', 'tags', 'excludeTags', 'kinds']);

const text = value => typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
const strings = (value, max) => (Array.isArray(value) ? value : []).map(item => text(item).trim()).filter(Boolean).slice(0, max);
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;
const newId = () => `r-${randomUUID().replace(/-/g, '').slice(0, 16)}`;

/** 只留真正参与本地过滤的四个键：采集结果还没有评分 / 颜色 / 尺寸，假装支持只会给出空结果。 */
export function normalizeRuleFilters(input) {
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    formats: strings(data.formats, 64),
    tags: strings(data.tags, 32),
    excludeTags: strings(data.excludeTags, 32),
    kinds: strings(data.kinds, 24),
  };
}

/** 每天固定小时的下一次触发；传 9 表示「每天本地时间 9:00」。 */
export function nextDailyAt(hour, from = Date.now()) {
  const target = new Date(Number(from) || Date.now());
  const h = Math.max(0, Math.min(23, number(hour, 9)));
  target.setHours(h, 0, 0, 0);
  if (target.getTime() <= Number(from)) target.setDate(target.getDate() + 1);
  return target.getTime();
}

/** 到期判定是纯函数，调度器只负责喂 now；测试不需要等真实时间。 */
export function ruleDue(rule, now = Date.now()) {
  if (!rule || rule.enabled === false) return false;
  if (rule.frequency !== 'daily') return false;
  const at = number(rule.nextRunAt);
  return at > 0 && at <= Number(now);
}

/** 宽容量：坏记录 / 老版本字段一律补默认值，不让一条脏数据把整个规则文件拖死。 */
export function normalizeRule(input, now = Date.now()) {
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const stamp = number(now) || Date.now();
  const frequency = COLLECT_FREQUENCIES.includes(data.frequency) ? data.frequency : 'manual';
  const hour = Math.max(0, Math.min(23, number(data.hour, 9)));
  const createdAt = number(data.createdAt, stamp) || stamp;
  return {
    id: text(data.id).trim() || newId(),
    boardId: text(data.boardId).trim(),
    boardName: text(data.boardName).trim().slice(0, COLLECT_LIMITS.name),
    name: text(data.name).trim().slice(0, COLLECT_LIMITS.name) || '未命名收集规则',
    platforms: [...new Set(strings(data.platforms, COLLECT_LIMITS.platforms))],
    query: text(data.query).trim().slice(0, COLLECT_LIMITS.query),
    scope: ['local','both'].includes(data.scope)?data.scope:'platform',
    queries: [...new Set(strings(data.queries,3).map(q=>q.slice(0,COLLECT_LIMITS.query)))].filter(q=>q!==text(data.query).trim().slice(0,COLLECT_LIMITS.query)).slice(0,2),
    maxCalls: Math.max(1,Math.min(12,number(data.maxCalls,12))),
    expand: data.expand === true,
    dedupe: data.dedupe === 'board' ? 'board' : 'global',
    filters: normalizeRuleFilters(data.filters),
    limit: Math.max(1, Math.min(COLLECT_LIMITS.perRun, number(data.limit, 20))),
    frequency,
    hour,
    mode: COLLECT_MODES.includes(data.mode) ? data.mode : 'auto',
    enabled: data.enabled !== false,
    createdAt,
    updatedAt: number(data.updatedAt, stamp) || stamp,
    lastRunAt: number(data.lastRunAt),
    nextRunAt: number(data.nextRunAt) || (frequency === 'daily' ? nextDailyAt(hour, stamp) : 0),
    lastStatus: ['ok', 'partial', 'failed'].includes(data.lastStatus) ? data.lastStatus : '',
    failStreak: Math.max(0, number(data.failStreak)),
    totalAdded: Math.max(0, number(data.totalAdded)),
  };
}

export function normalizeRun(input) {
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const platforms = data.platforms && typeof data.platforms === 'object' && !Array.isArray(data.platforms) ? data.platforms : {};
  return {
    id: text(data.id).trim() || `run-${newId().slice(2)}`,
    ruleId: text(data.ruleId),
    boardId: text(data.boardId),
    at: number(data.at) || Date.now(),
    dryRun: data.dryRun === true,
    found: Math.max(0, number(data.found)),
    added: Math.max(0, number(data.added)),
    skipped: Math.max(0, number(data.skipped)),
    failed: Math.max(0, number(data.failed)),
    platforms,
    warnings: strings(data.warnings, 20),
    ...(data.requestId ? {
      requestId: text(data.requestId).slice(0,100), fingerprint:text(data.fingerprint).slice(0,64),
      status: ['running','completed','partial','failed','interrupted'].includes(data.status)?data.status:'failed',
      candidates: (Array.isArray(data.candidates)?data.candidates:[]).slice(0,60).map(item=>({
        uid:text(item.uid).slice(0,32),name:text(item.name).slice(0,200),platform:text(item.platform).slice(0,60),
        thumbnail:text(item.thumbnail).slice(0,4000),url:text(item.url).slice(0,4000),assetType:text(item.assetType).slice(0,40),
      })),
      addedUids:strings(data.addedUids,60),
      board:data.board&&typeof data.board==='object'?{ok:data.board.ok===true,reason:text(data.board.reason).slice(0,160),count:number(data.board.count)}:{ok:false,reason:'未执行'},
    }:{}),
  };
}

/** 保留最近的事件；seen 的 value 是写入时间戳，按时间倒序裁剪。 */
export function pruneSeen(input, limit = COLLECT_LIMITS.seen) {
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const rows = Object.entries(data)
    .map(([key, at]) => [text(key).slice(0, 200), number(at)])
    .filter(([key, at]) => key && at > 0);
  rows.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(rows.slice(0, limit));
}

export function normalizeStore(input) {
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    version: 1,
    rules: (Array.isArray(data.rules) ? data.rules : []).map(item => normalizeRule(item)).slice(0, COLLECT_LIMITS.rules),
    runs: (Array.isArray(data.runs) ? data.runs : []).map(normalizeRun).slice(0, COLLECT_LIMITS.runs),
    seen: pruneSeen(data.seen),
  };
}

/**
 * 规则仓库：所有写操作串行排队，读缓存直到写盘成功才替换，避免「写下一条时把上一条覆盖」。
 * io 与 now 都注入，测试可以用假文件系统和固定时钟。
 */
export function createCollectRules({file, now = Date.now, io = fs} = {}) {
  if (!file) throw Error('缺少收集规则文件路径');
  let cache = null;
  let queue = Promise.resolve();

  async function load() {
    if (cache) return cache;
    try {
      const stat = await io.stat(file);
      if (Number(stat.size) > COLLECT_LIMITS.fileBytes) throw Error('规则文件过大');
      cache = normalizeStore(JSON.parse(await io.readFile(file, 'utf8')));
    } catch {
      cache = normalizeStore({});
    }
    return cache;
  }

  function commit(mutator) {
    const write = queue.then(async () => {
      const current = await load();
      const next = mutator(current);
      if (!next) return current;
      await io.mkdir(path.dirname(file), {recursive: true});
      await io.writeFile(`${file}.tmp`, JSON.stringify(next));
      await io.rename(`${file}.tmp`, file);
      cache = next;
      return next;
    });
    queue = write.catch(() => {});
    return write;
  }

  return {
    file,
    async snapshot() {
      const data = await load();
      return {rules: data.rules.map(rule => ({...rule})), runs: data.runs.map(run => ({...run})), seenCount: Object.keys(data.seen).length};
    },
    async list() {
      return (await load()).rules.map(rule => ({...rule}));
    },
    async get(id) {
      const key = text(id).trim();
      return (await load()).rules.find(rule => rule.id === key) || null;
    },
    async save(input) {
      const current = await load();
      const existing = text(input?.id) ? current.rules.find(rule => rule.id === text(input.id)) : null;
      const rule = normalizeRule({...existing, ...input, updatedAt: now()}, now());
      if(rule.scope!=='local'&&new Set((Array.isArray(input?.platforms)?input.platforms:[]).map(value=>text(value).trim()).filter(Boolean)).size>COLLECT_LIMITS.platforms)throw Error('每轮最多选择 12 个平台');
      if (!rule.name.trim()) throw Error('规则名称不能为空');
      if (!rule.boardId) throw Error('请先选择一个画板');
      if (rule.scope!=='local'&&!rule.platforms.length) throw Error('至少选择一个平台');
      if (!rule.query.trim()) throw Error('请填写要收集的关键词');
      // 只有新建、或频率/小时真的变了才重算下次触发，改个名字不该把今天的计划推走。
      if (!existing) rule.nextRunAt = rule.frequency === 'daily' ? nextDailyAt(rule.hour, now()) : 0;
      else if (existing.frequency !== rule.frequency || existing.hour !== rule.hour)
        rule.nextRunAt = rule.frequency === 'daily' ? nextDailyAt(rule.hour, now()) : 0;
      await commit(store => {
        const rules = store.rules.filter(item => item.id !== rule.id);
        if (!existing && rules.length >= COLLECT_LIMITS.rules) throw Error(`最多只能保存 ${COLLECT_LIMITS.rules} 条收集规则`);
        rules.unshift(rule);
        return {...store, rules};
      });
      return {...rule};
    },
    async remove(id) {
      const key = text(id).trim();
      let removed = false;
      await commit(store => {
        const rules = store.rules.filter(rule => rule.id !== key);
        removed = rules.length !== store.rules.length;
        return removed ? {...store, rules, runs: store.runs.filter(run => run.ruleId !== key)} : null;
      });
      return removed;
    },
    async beginRun(ruleId,result){
      const run=normalizeRun({...result,ruleId,status:'running'});
      await commit(store=>{
        if(store.runs.some(item=>item.requestId===run.requestId))throw Error('运行标识已存在，请核对原任务');
        return {...store,runs:[run,...store.runs.filter(item=>item.id!==run.id)].slice(0,COLLECT_LIMITS.runs)};
      });
      return run;
    },
    /** 采集结束回写：运行记录 + 规则状态 + 去重索引一次原子落盘。 */
    async recordRun(ruleId, result, seenKeys = []) {
      const key = text(ruleId).trim();
      const run = normalizeRun({...result, ruleId: key});
      const stamp = now();
      await commit(store => {
        const index = store.rules.findIndex(rule => rule.id === key);
        if (index < 0) return null;
        const prev = store.rules[index];
        const failed = run.failed > 0 && run.added === 0;
        const next = {
          ...prev,
          lastRunAt: stamp,
          lastStatus: failed ? 'failed' : run.failed > 0 ? 'partial' : 'ok',
          failStreak: failed ? prev.failStreak + 1 : 0,
          totalAdded: prev.totalAdded + run.added,
          nextRunAt: prev.frequency === 'daily' ? nextDailyAt(prev.hour, stamp) : 0,
        };
        const rules = [...store.rules];
        rules[index] = next;
        const seen = {...store.seen};
        for (const item of seenKeys) if (item) seen[text(item).slice(0, 200)] = stamp;
        return {...store, rules, runs: [run, ...store.runs.filter(item=>item.id!==run.id)].slice(0, COLLECT_LIMITS.runs), seen: pruneSeen(seen)};
      });
      return run;
    },
    async seenHas(keys = []) {
      const data = (await load()).seen;
      return new Set((Array.isArray(keys) ? keys : []).map(text).filter(key => data[key]));
    },
    /** 调度器启动时用：停机超过一周的规则不该在开机瞬间全部开跑。 */
    async resetOverdue(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
      const stamp = now();
      let changed = 0;
      await commit(store => {
        const rules = store.rules.map(rule => {
          if (rule.frequency !== 'daily' || !rule.nextRunAt || stamp - rule.nextRunAt < maxAgeMs) return rule;
          changed += 1;
          return {...rule, nextRunAt: nextDailyAt(rule.hour, stamp), failStreak: 0};
        });
        return changed ? {...store, rules} : null;
      });
      return changed;
    },
  };
}
