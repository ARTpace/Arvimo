// 采集执行器：一条规则跑一次 = 逐平台搜索 → 本地过滤 → 去重 → 入待合并队列 → 立即入板。
//
// 关键取舍：资产不直接写主状态，先进 pending 队列由前端合并（见 collect-pending.mjs 的注释）。
// 入板是服务端可以直接做的（collection_assets 接受尚未入库的 uid），所以「画板里先看到」
// 是立即生效的；「资产卡片出现」要等前端下一次合并，通常就是几秒后。
import {normalizeFilters, matchesFilters} from './library-query.mjs';
import {setCollectionItems,collectionUids} from './library-collections.mjs';
import {formatsOfModel} from '../src/library/format-registry.js';
import {COLLECT_PLATFORMS, createCollectSearch,collectQueryFallbacks} from './collect-search.mjs';
import {searchCollectedLibrary} from './collect-local.mjs';
import {randomUUID} from 'node:crypto';

const text = value => typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
const KIND = new Map(COLLECT_PLATFORMS.map(platform => [platform.id, platform.kind]));

/** 把采集条目伪装成查询层的行：只有格式 / 标签 / 类型能参与过滤，其余维度没有数据就不假装有。 */
export function collectRow(item) {
  // formatsOfModel 只认 filePath / rel / name 等文件字段，采集条目只有 url；补一个 filePath
  // 才能让「格式」维度的本地过滤真的生效（否则所有采集结果的 formats 恒为空数组）。
  const formats = formatsOfModel({filePath: item.url, name: item.name, thumbnail: item.thumbnail, assetType: item.assetType});
  return {
    uid: item.uid, name: item.name, platform: item.platform, kind: item.assetType || '',
    rating: 0, favorite: false, state: 'active', position: 0, added_at: 0,
    tags: Array.isArray(item.tags) ? item.tags : [], categories: [], formats,
    model: {
      uid: item.uid, name: item.name, url: item.url, thumbnail: item.thumbnail,
      platform: item.platform, assetType: item.assetType, tags: item.tags,
    },
    probe: null,
  };
}

/** 入队模型：前端 mergeModels 只认 uid，其余字段按卡片需要补齐。 */
export function collectModel(item) {
  return {
    uid: item.uid,
    name: item.name,
    author: item.author,
    thumbnail: item.thumbnail,
    url: item.url,
    platform: item.platform,
    assetType: item.assetType,
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 24) : [],
    license: item.license,
    downloadable: item.downloadable !== false,
    source: 'collect',
    collectedAt: Date.now(),
  };
}

export function filterItems(items, filters) {
  const normalized = normalizeFilters(filters || {});
  return (Array.isArray(items) ? items : []).filter(item => matchesFilters(collectRow(item), normalized, null));
}

export function createCollectRunner({
  rules, pending, guard, storage,
  search = createCollectSearch().search,
  localSearch = input=>searchCollectedLibrary(storage,input),
  platformEnabled = ()=>true,
  // 入板写入可替换：默认走 library-collections，测试注入假实现，避免为了一个断言搭 SQLite。
  addToBoard = (conn, boardId, uids) => setCollectionItems(conn, boardId, uids, 'add'),
  boardUids = (conn, boardId) => collectionUids(conn,boardId),
  now = Date.now,
  onWarn = () => {},
} = {}) {
  if (!rules || !pending || !guard) throw Error('采集执行器缺少依赖');
  const running=new Set();

  async function run(ruleId, {dryRun = false, signal,execution} = {}) {
    if(running.has(ruleId))throw Object.assign(Error('这条规则正在采集，请稍候'),{code:'COLLECT_BUSY'});
    running.add(ruleId);
    try{return await execute(ruleId,{dryRun,signal,execution});}finally{running.delete(ruleId);}
  }
  async function execute(ruleId,{dryRun,signal,execution}){
    const rule = await rules.get(ruleId);
    if (!rule) throw Error('收集规则不存在');
    if(!execution&&!dryRun&&rule.dedupe==='board')execution={id:`run-${randomUUID()}`,requestId:`scheduled-${randomUUID()}`,boardId:rule.boardId};
    if (rule.scope!=='local'&&!rule.platforms.length) throw Error('规则没有配置平台');
    const targets = rule.scope==='local'?[]:rule.platforms.slice(0, 12);
    const queries=[...new Set([rule.query,...(rule.queries||[])])].slice(0,3);
    const maxCalls=rule.maxCalls||12;
    // 每个平台多取几条：本地过滤会刷掉一部分，只按平均份额取容易一条不剩。
    const per = Math.max(3, Math.ceil(rule.limit / Math.max(1,Math.min(maxCalls,targets.length*queries.length))) + 2);
    const collected = [];
    const platforms = {};
    const warnings = [];
    if(rule.scope==='local'||rule.scope==='both'){
      try{const items=await localSearch({queries,filters:rule.filters,limit:rule.limit});collected.push(...items);platforms.library={found:items.length,error:''};}
      catch(error){platforms.library={found:0,error:String(error.message||error)};warnings.push(`资产库：${error.message}`);}
    }

    let calls=0;
    // Round-robin by query: every selected platform gets its primary query before extra keywords.
    searchLoop: for(const query of queries){for (const platform of targets) {
      if(calls>=maxCalls){warnings.push(`已达到本轮 ${maxCalls} 次平台调用上限`);break searchLoop;}
      if (signal?.aborted) { warnings.push('采集被取消'); break searchLoop; }
      if(!platformEnabled(platform)){warnings.push(`${platform} 已停用`);platforms[platform]={found:platforms[platform]?.found||0,error:'平台已停用'};continue;}
      const kind = KIND.get(platform) || 'model';
      const gate = await guard.acquire(platform, kind);
      if (!gate.ok) {
        platforms[platform] = {found: platforms[platform]?.found||0, error: gate.reason === 'budget' ? '超出本小时配额' : '冷却中', retryInMs: gate.retryInMs};
        warnings.push(`${platform} 跳过：${gate.reason === 'budget' ? '本小时配额已用完' : '触发冷却'}`);
        continue;
      }
      try {
        calls++;
        const result = await search(platform, {query, limit: per, signal,assetType:rule.filters?.kinds?.length===1?rule.filters.kinds[0]:''});
        const kept = filterItems(result.items, rule.filters);
        platforms[platform] = {found: (platforms[platform]?.found||0)+kept.length, error: platforms[platform]?.error||''};
        collected.push(...kept);
        for (const message of result.warnings || []) warnings.push(`${result.label || platform}：${message}`);
        guard.noteSuccess(platform);
      } catch (error) {
        const retryAfterMs = Number(error?.retryAfterMs) || 0;
        const state = guard.noteFailure(platform, {retryAfterMs});
        const message = String(error?.message || '搜索失败').slice(0, 160);
        platforms[platform] = {found: platforms[platform]?.found||0, error: message, cooldownMs: state.cooldownMs};
        warnings.push(`${platform}：${message}`);
        onWarn(`[collect] ${platform}: ${message}`);
      }
    }
      // Only broaden an empty search, within the same three-query / maxCalls budget.
      if(targets.length&&!collected.length&&query===queries.at(-1)&&queries.length<3&&calls<maxCalls){
        const fallback=collectQueryFallbacks(rule.query).find(q=>!queries.includes(q));
        if(fallback){queries.push(fallback);warnings.push(`未找到匹配，尝试核心关键词：${fallback}（仍需复核风格）`);}
      }
    }

    const unique = new Map();
    for (const item of collected) if (!unique.has(item.uid)) unique.set(item.uid, item);
    const keys = [...unique.values()].map(item => item.key);
    const seen = rule.dedupe==='board'
      ? await storage?.withDb(conn=>{if(!conn)throw Error('画板存储不可用');return boardUids(conn,rule.boardId);})
      : await rules.seenHas(keys);
    if(!seen)throw Error('无法读取画板成员');
    const fresh = [...unique.values()].filter(item => !seen.has(rule.dedupe==='board'?item.uid:item.key)).slice(0, rule.limit);
    const failed = Object.values(platforms).filter(row => row.error).length;
    const base = {
      id: execution?.id||`run-${now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      ruleId: rule.id,
      boardId: rule.boardId,
      at: now(),
      dryRun: !!dryRun,
      found: unique.size,
      added: fresh.length,
      skipped: unique.size - fresh.length,
      failed,
      platforms,
      warnings: warnings.slice(0, 20),
      ...(execution?{...execution,status:failed?(failed===Object.keys(platforms).length&&!collected.length?'failed':'partial'):'completed',board:{ok:true,count:0},candidates:fresh.map(item=>({uid:item.uid,name:item.name,platform:item.platform,thumbnail:item.thumbnail,url:item.pageUrl||item.url,assetType:item.assetType})),addedUids:[]}:{}),
    };

    if (dryRun) return {...base, preview: fresh.slice(0, 24).map(item => ({
      uid: item.uid, name: item.name, author: item.author, thumbnail: item.thumbnail,
      platform: item.platform, url: item.pageUrl || item.url, assetType: item.assetType,
    }))};

    if (!fresh.length) {
      await rules.recordRun(rule.id, base, keys);
      return base;
    }

    const models = fresh.filter(item=>!item._libraryExisting).map(collectModel);
    const queued = await pending.add(models);
    const uids = fresh.map(item => item.uid);
    let board = {ok: false, count: 0, reason: ''};
    if (storage?.withDb) {
      try {
        const result = await storage.withDb(conn => {
          if (!conn) return {ok: false, reason: 'no-db'};
          const before=execution?boardUids(conn,rule.boardId):new Set();
          const result=addToBoard(conn, rule.boardId, uids);
          return {ok: true,count:result?.count||uids.length,...(execution?{addedUids:uids.filter(uid=>!before.has(uid))}:{})};
        });
        board = result || {ok: false, reason: 'no-db'};
      } catch (error) {
        board = {ok: false, count: 0, reason: String(error?.message || '入板失败').slice(0, 120)};
        warnings.push(`画板写入失败：${board.reason}`);
      }
    } else board = {ok: false, reason: 'no-storage'};
    if (!board.ok) warnings.push('画板未能写入，资产已进入待合并队列，可在面板里重试入板');

    const run = await rules.recordRun(rule.id, {...base, warnings: warnings.slice(0, 20),...(execution?{board,addedUids:board.addedUids||[],status:!board.ok||failed?'partial':'completed'}:{})}, keys);
    return {...run, queued: queued.added, board};
  }

  return {run};
}
