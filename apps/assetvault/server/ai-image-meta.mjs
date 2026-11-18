/**
 * 读取 PNG 里的 AI 生成元数据（tEXt / zTXt / iTXt 文本块），识别提示词。
 *
 * 为什么不用 sharp().metadata()：libvips 不把 PNG 文本块暴露到 metadata.text，
 * 实测为空。这里用文件句柄逐块跳转，只加载文本块数据、跳过 IDAT 像素，
 * 因此一张几 MB 的图也只读几百字节，扫描全场不会拖慢。
 *
 * 覆盖两种主流写入方：
 *   - SD WebUI / Automatic1111 / ComfyUI「保存生成信息」：key = parameters
 *     内容形如「正面提示词\nNegative prompt: xxx\nSteps: 20, Sampler: ..., CFG scale: 7, Seed: 123」
 *   - ComfyUI：key = prompt / workflow，值是完整节点图 JSON
 *
 * 任何读失败、非 PNG、无文本块都返回 null，绝不影响扫描主流程。
 */
import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const MAX_CHUNKS = 512;          // 极端图片的块数上限，防御性
const MAX_TEXT_BYTES = 512 * 1024; // 单块文本上限：workflow JSON 可能较大，但不必无上限
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 逐块读取 PNG 文本块，返回 {keyword: text}；非 PNG 或读失败返回空对象。 */
async function readPngTextChunks(file) {
  let handle;
  const out = {};
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 33) return out;

    const sig = Buffer.alloc(8);
    if ((await handle.read(sig, 0, 8, 0)).bytesRead < 8 || !sig.equals(PNG_SIG)) return out;

    let off = 8;
    for (let i = 0; i < MAX_CHUNKS && off + 12 <= stat.size; i++) {
      const hdr = Buffer.alloc(8);
      if ((await handle.read(hdr, 0, 8, off)).bytesRead < 8) break;
      const len = hdr.readUInt32BE(0);
      const type = hdr.toString('ascii', 4, 8);
      // 块长异常（超过文件剩余或超过上限）直接停，避免畸形文件把循环拖死
      if (len > MAX_TEXT_BYTES || off + 12 + len > stat.size) break;
      const dataStart = off + 8;

      if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
        const data = Buffer.alloc(len);
        await handle.read(data, 0, len, dataStart);
        const sep = data.indexOf(0);
        if (sep > 0) {
          const key = data.toString('latin1', 0, sep);
          try {
            if (type === 'tEXt') {
              out[key] = data.toString('utf8', sep + 1);
            } else if (type === 'zTXt') {
              if (data[sep + 1] === 0) out[key] = zlib.inflateSync(data.subarray(sep + 2)).toString('utf8');
            } else {
              // iTXt: key\0压缩标志(1)压缩方法(1)语言\0翻译键\0文本
              let p = sep + 1;
              const compressed = data[p++]; p++; // p 跳过压缩方法
              const langEnd = data.indexOf(0, p);
              const transEnd = langEnd < 0 ? -1 : data.indexOf(0, langEnd + 1);
              if (langEnd >= 0 && transEnd >= 0) {
                const raw = data.subarray(transEnd + 1);
                out[key] = compressed ? zlib.inflateSync(raw).toString('utf8') : raw.toString('utf8');
              }
            }
          } catch { /* 单个块坏掉不影响其它块 */ }
        }
      }
      off = dataStart + len + 4; // +4 跳过 CRC
      if (type === 'IEND') break;
    }
  } catch {
    // 读失败（文件被占用、权限、竞态删除）→ 当作没有元数据
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  return out;
}

/** 从 parameters 文本里抽正面提示词（去掉 Negative prompt 及后面的参数行）。 */
function positivePromptOf(parameters = '') {
  return String(parameters)
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line && !/^Negative prompt:/i.test(line) && !/^(Steps|Sampler|CFG scale|Seed|Size|Model|Denoising strength|Schedule type|Remember):/i.test(line))
    || '';
}

/** 从 ComfyUI 节点图 JSON 里抽第一个 CLIPTextEncode 的正面提示词。 */
function promptFromWorkflow(raw = '') {
  try {
    const graph = JSON.parse(raw);
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : Object.values(graph || {});
    for (const node of nodes) {
      const cls = String(node?.class_type || node?.type || '');
      if (/CLIPTextEncode/i.test(cls)) {
        const text = node?.inputs?.text ?? node?.widgets_values?.[0];
        if (typeof text === 'string' && text.trim()) return text.trim();
      }
    }
  } catch { /* 不是 JSON 就忽略 */ }
  return '';
}

/**
 * 判断一个 PNG 是否 AI 生成并提取提示词。
 * @returns {null|{tool:string, prompt:string}} 非 AI / 无元数据返回 null
 */
export async function readAiImageMeta(file = '') {
  if (!/\.png$/i.test(file)) return null;
  const text = await readPngTextChunks(file);
  if (!Object.keys(text).length) return null;

  const parameters = text.parameters || '';
  const workflowRaw = text.workflow || text.prompt || '';
  const hasSdParams = /\b(Steps|Sampler|CFG scale)\s*:/i.test(parameters);
  const hasComfyGraph = /"class_type"|"nodes"\s*:/.test(workflowRaw);
  if (!hasSdParams && !hasComfyGraph) return null;

  const prompt = positivePromptOf(parameters) || promptFromWorkflow(workflowRaw);
  const tool = hasSdParams ? (/ComfyUI|workflow/i.test(parameters) ? 'ComfyUI' : 'Stable Diffusion') : 'ComfyUI';
  return {tool, prompt};
}
