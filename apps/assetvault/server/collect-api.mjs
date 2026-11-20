// /api/collect/* —— 智能收集画板的 HTTP 面。
// 只做参数校验与并发闸门，业务在 collect-rules / collect-runner / collect-scheduler 里。
import {COLLECT_PLATFORMS} from './collect-search.mjs';
import {COLLECT_LIMITS} from './collect-rules.mjs';
import {createHash} from 'node:crypto';

const ROUTES = new Set([
  '/api/collect/status', '/api/collect/rules', '/api/collect/run',
  '/api/collect/runs', '/api/collect/pending', '/api/collect/pending/ack',
]);

function send(res, status, data) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(data));
}

async function readBody(req, limit = 256 * 1024) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > limit) throw Error('请求过大');
  }
  try {
    const data = JSON.parse(raw || '{}');
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { throw Error('无效的 JSON 请求'); }
}

/** 与 /api/library/* 同一条守卫：只允许本机页面调用，跨站与局域网访客一律拒绝。 */
function guard(req) {
  if (req.headers['x-sfx-local'] !== '1') return '缺少本地请求标识';
  const origin = req.headers.origin;
  if (!origin) return null;
  try { return new URL(String(origin)).host === req.headers.host ? null : '跨站请求被拒绝'; }
  catch { return '跨站请求被拒绝'; }
}

const text = value => typeof value === 'string' ? value : '';

export function createCollectApi({rules, runner, pending, scheduler, storage,platformEnabled=()=>true} = {}) {
  if (!rules || !runner || !pending) throw Error('采集接口缺少规则仓库 / 执行器 / 待合并队列');
  const running = new Set();

  async function engine() {
    try {
      if (!storage?.withDb) return 'memory';
      return (await storage.withDb(conn => conn ? 'sqlite' : 'memory')) || 'memory';
    } catch { return 'memory'; }
  }

  async function handle(req, res, u) {
    if (!ROUTES.has(u.pathname)) return false;
    const denied = guard(req);
    if (denied) { send(res, 403, {error: denied}); return true; }
    const method = req.method;

    try {
      if (u.pathname === '/api/collect/status' && method === 'GET') {
        send(res, 200, {
          engine: await engine(),
          scheduler: scheduler?.status?.() || null,
          pending: await pending.status(),
          platforms: COLLECT_PLATFORMS,
          limits: COLLECT_LIMITS,
        });
        return true;
      }

      if (u.pathname === '/api/collect/rules') {
        if (method === 'GET') {
          const data = await rules.snapshot();
          const ruleId = text(u.searchParams.get('ruleId'));
          const limit = Math.max(1, Math.min(200, Number(u.searchParams.get('limit')) || 50));
          send(res, 200, {
            rules: data.rules,
            runs: data.runs.filter(run => !ruleId || run.ruleId === ruleId).slice(0, limit),
            platforms: COLLECT_PLATFORMS,
            limits: COLLECT_LIMITS,
            pending: (await pending.status()).count,
          });
          return true;
        }
        if (method === 'POST') {
          const input=await readBody(req);
          if(input.dedupe==='board'&&(!Array.isArray(input.platforms)||!input.platforms.every(id=>COLLECT_PLATFORMS.some(p=>p.id===id&&p.searchable)&&platformEnabled(id))))throw Error('计划包含不可搜索或已停用的平台');
          const rule = await rules.save(input);
          send(res, 200, {rule, rules: await rules.list()});
          return true;
        }
        if (method === 'DELETE') {
          const id = text(u.searchParams.get('id')).trim();
          if (!id) { send(res, 400, {error: '缺少规则 id'}); return true; }
          send(res, 200, {removed: await rules.remove(id), rules: await rules.list()});
          return true;
        }
        send(res, 405, {error: '不支持的请求方式'});
        return true;
      }

      if (u.pathname === '/api/collect/run') {
        if (method !== 'POST') { send(res, 405, {error: '只支持 POST'}); return true; }
        const input = await readBody(req);
        const id = text(input.id).trim();
        if (!id) { send(res, 400, {error: '缺少规则 id'}); return true; }
        if (running.has(id)) { send(res, 409, {error: '这条规则正在采集，请稍候'}); return true; }
        running.add(id);
        try {
          const requestId=text(input.requestId);
          let execution;
          if(requestId){
            if(!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)||input.dryRun===true)throw Error('运行标识无效');
            const rule=await rules.get(id);if(!rule)throw Error('收集规则不存在');
            const fingerprint=createHash('sha256').update(JSON.stringify({id,boardId:rule.boardId,query:rule.query,queries:rule.queries,scope:rule.scope,maxCalls:rule.maxCalls,platforms:rule.platforms,filters:rule.filters,limit:rule.limit,dedupe:rule.dedupe})).digest('hex');
            const old=(await rules.snapshot()).runs.find(run=>run.requestId===requestId);
            if(old){
              if(old.ruleId!==id||old.fingerprint!==fingerprint){send(res,409,{error:'该运行标识已用于不同条件'});return true;}
              // This process owns no matching lock before this request: a saved running record was interrupted.
              send(res,200,{run:old.status==='running'?{...old,status:'interrupted'}:old});return true;
            }
            if(rule.scope!=='local'&&rule.platforms.some(id=>!platformEnabled(id)))throw Error('计划平台已停用，请修改条件');
            execution={id:`hunt-${requestId}`,requestId,fingerprint,boardId:rule.boardId};
            await rules.beginRun(id,{...execution,boardId:rule.boardId});
          }
          let result;
          try{result=await runner.run(id, {dryRun: input.dryRun === true,execution});}
          catch(error){
            if(execution)await rules.recordRun(id,{...execution,status:'failed',failed:1,warnings:[String(error.message||error)]});
            throw error;
          }
          send(res, 200, {run: result});
        } finally { running.delete(id); }
        return true;
      }

      if (u.pathname === '/api/collect/runs' && method === 'GET') {
        const data = await rules.snapshot();
        const ruleId = text(u.searchParams.get('ruleId'));
        const limit = Math.max(1, Math.min(200, Number(u.searchParams.get('limit')) || 30));
        const requestId=text(u.searchParams.get('requestId'));
        send(res, 200, {runs: data.runs.filter(run => (!ruleId || run.ruleId === ruleId)&&(!requestId||run.requestId===requestId)).slice(0, limit).map(run=>run.status==='running'&&!running.has(run.ruleId)?{...run,status:'interrupted'}:run)});
        return true;
      }

      if (u.pathname === '/api/collect/pending' && method === 'GET') {
        send(res, 200, {models: await pending.list(), ...(await pending.status())});
        return true;
      }

      if (u.pathname === '/api/collect/pending/ack' && method === 'POST') {
        const input = await readBody(req);
        send(res, 200, await pending.ack(input.uids));
        return true;
      }

      send(res, 405, {error: '不支持的请求方式'});
      return true;
    } catch (error) {
      send(res, 400, {error: String(error?.message || '采集请求失败')});
      return true;
    }
  }

  return {handle, routes: ROUTES};
}
