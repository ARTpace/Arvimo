// AssetVault CLI —— 人用的脚本入口，同时也是 MCP server 的排错工具。
// 与 MCP 共用 server/ai-client.mjs，因此「是 MCP 错了还是服务错了」可以直接对照复现。
// 输出一律是 JSON，方便管道处理：node scripts/assetvault-cli.mjs jobs | jq '.jobs[] | .state'
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createClient, SEARCH_ENDPOINTS, PLATFORM_KINDS} from '../server/ai-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2] || 'help';
const argv = process.argv.slice(3);

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > 0) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = list[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(argv);
const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const json = value => {
  const text = JSON.stringify(value, null, args.pretty ? 2 : 0);
  process.stdout.write(text + '\n');
};
const jsonArg = (value, label) => {
  if (value === undefined || value === true) throw new Error(`${label} 需要 JSON 值`);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} 不是合法 JSON：${String(value).slice(0, 80)}`);
  }
};
const trimModels = (data, limit) => {
  if (!data || !Array.isArray(data.models)) return data;
  const total = data.models.length;
  return {...data, models: data.models.slice(0, limit), returned: Math.min(limit, total), omitted: Math.max(0, total - limit)};
};
const trimJobs = (data, limit) => {
  if (!data || !Array.isArray(data.jobs)) return data;
  const total = data.jobs.length;
  return {...data, jobs: data.jobs.slice(0, limit), returned: Math.min(limit, total), omitted: Math.max(0, total - limit)};
};

const USAGE = {
  status: 'status                                  服务版本 / 能力位 / 导出目标',
  search: 'search --q <关键词> [--platform <平台>] [--filters <JSON>] [--cursor <值>] [--limit 20]',
  get: 'get --uid <32位ID> | --url <页面地址>',
  jobs: 'jobs [--state <状态>] [--id <任务ID>] [--limit 20]',
  enqueue: 'enqueue --models <JSON数组> --authorized [--kind <类型>] [--options <JSON>] [--folder <目录>]',
  job: 'job --action cancel|retry|hold|resume|remove --id <任务ID>',
  library: 'library [--scan] [--force] [--limit 20]',
  'send-blender': 'send-blender --id <任务ID>',
  targets: 'targets                                 列出导出目标',
  'mcp-config': 'mcp-config                              打印 MCP 客户端配置片段',
};

async function main() {
  const client = createClient();
  switch (command) {
    case 'status':
      return json(await client.getStatus());

    case 'search': {
      const platform = args.platform || 'sketchfab';
      if (!SEARCH_ENDPOINTS[platform]) throw new Error(`不支持的平台 ${platform}；可用：${Object.keys(SEARCH_ENDPOINTS).join(', ')}`);
      const filters = args.filters === undefined ? {} : jsonArg(args.filters, '--filters');
      const result = await client.searchAssets({platform, q: args.q === true ? '' : args.q || '', filters, cursor: args.cursor === true ? null : args.cursor});
      return json(trimModels(result, num(args.limit, 20)));
    }

    case 'get':
      return json(await client.getAsset({uid: args.uid === true ? undefined : args.uid, url: args.url === true ? undefined : args.url}));

    case 'jobs': {
      const snapshot = await client.getJobs();
      if (args.id) {
        const job = snapshot.jobs?.find(item => item.id === args.id);
        if (!job) throw new Error(`找不到任务 ${args.id}`);
        return json(job);
      }
      let jobs = snapshot.jobs || [];
      if (args.state) jobs = jobs.filter(item => item.state === args.state);
      return json(trimJobs({...snapshot, jobs}, num(args.limit, 20)));
    }

    case 'enqueue': {
      const models = jsonArg(args.models, '--models');
      if (!Array.isArray(models)) throw new Error('--models 必须是 JSON 数组');
      if (args.authorized !== true && args.authorized !== 'true') {
        throw new Error('必须显式加上 --authorized，表示你已确认拥有这些模型的下载与使用授权');
      }
      const kind = args.kind || (models[0]?.platform && PLATFORM_KINDS[models[0].platform]) || 'sketchfab';
      return json(await client.enqueueDownload({
        models,
        kind,
        authorized: true,
        options: args.options === undefined ? undefined : jsonArg(args.options, '--options'),
        folder: args.folder === true ? undefined : args.folder,
        force: args.force === true,
        openInBlender: args['open-in-blender'] === true,
      }));
    }

    case 'job':
      return json(await client.manageJob({action: args.action, ids: (Array.isArray(args.id) ? args.id : [args.id]).filter(Boolean)}));

    case 'library': {
      const state = await client.listLibrary();
      if (args.scan) {
        const scanned = await client.scanLibrary({force: args.force === true});
        return json({state, scan: {...scanned, files: (scanned.files || []).slice(0, num(args.limit, 20))}});
      }
      const models = Array.isArray(state?.models) ? state.models.slice(0, num(args.limit, 20)) : state?.models;
      return json({...state, models});
    }

    case 'send-blender':
      return json(await client.sendToBlender({jobId: args.id}));

    case 'targets':
      return json(await client.exportTargets());

    case 'mcp-config':
      return json({
        mcpServers: {
          assetvault: {
            command: 'node',
            args: [path.join(root, 'server', 'ai-mcp.mjs').replace(/\\/g, '/')],
          },
        },
      });

    case 'help':
    case '--help':
    case '-h':
      process.stdout.write('AssetVault CLI\n\n用法：node scripts/assetvault-cli.mjs <命令> [--参数 值] [--pretty]\n\n');
      for (const line of Object.values(USAGE)) process.stdout.write('  ' + line + '\n');
      process.stdout.write('\n公共环境变量：AV_BASE_URL / AV_PORT / SFX_DATA_DIR\n');
      return;

    default:
      throw new Error(`未知命令 ${command}；运行 help 查看可用命令`);
  }
}

main().catch(err => {
  process.stderr.write(JSON.stringify({error: err?.message || String(err), code: err?.code || null}) + '\n');
  process.exitCode = 1;
});
