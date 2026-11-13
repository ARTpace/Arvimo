import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {blenderPath} from './blender.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'gltf-to-fbx.py');

/** Blender writes a lot; keep the tail so a failure can still be explained. */
function run(command, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = chunk => { output = (output + chunk.toString()).slice(-12000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const abort = () => { try { child.kill('SIGKILL'); } catch {} };
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (error, value) => {
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    child.on('error', error => finish(error));
    child.on('exit', code => {
      if (code === 0) return finish(null, output);
      const reason = output.split(/\r?\n/).filter(line => /error|Error|Traceback|Exception/.test(line)).slice(-3).join(' ') || output.slice(-400);
      finish(Error(`Blender 转换失败（退出码 ${code}）：${reason.trim()}`));
    });
    if (signal?.aborted) abort();
  });
}

/**
 * Turn a loose GLB into FBX with a headless Blender of the caller's choice.
 * The FBX lands next to the GLB so folder delivery needs no extra step.
 */
export async function convertGlbToFbx({ glb, outDir, workRoot, blender: override }, { signal, progress = () => {} } = {}) {
  const blender = override === undefined ? blenderPath() : override;
  if (!blender) {
    throw Error('未找到 Blender，无法导出 FBX。运行 npm run fetch:blender 自动获取，或用环境变量 SFX_BLENDER 指向已安装的 blender 可执行文件。');
  }
  if (!fs.existsSync(glb)) throw Error(`找不到待转换的 GLB：${glb}`);

  await fsp.mkdir(workRoot, { recursive: true });
  const script = path.join(workRoot, 'gltf-to-fbx.py');
  await fsp.copyFile(SCRIPT, script);
  progress({ stage: 'converting', message: '正在用 Blender 转换 FBX（大模型可能需要几分钟）…' });

  const output = await run(blender, ['--background', '--factory-startup', '--python', script, '--', glb, outDir, workRoot], { signal });
  if (!/SFX_FBX_WRITTEN/.test(output)) throw Error('Blender 结束但未报告写出 FBX：' + output.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300));

  const name = path.basename(glb).replace(/\.glb$/i, '') + '.fbx';
  const file = path.join(outDir, name);
  if (!fs.existsSync(file)) throw Error(`Blender 报告的 FBX 不存在：${file}`);
  const bytes = fs.statSync(file).size;
  if (!bytes) throw Error('Blender 写出的 FBX 是空文件');
  const textures = /SFX_FBX_TEXTURES renamed=(\d+) written=(\d+)/.exec(output);
  return {
    file,
    name,
    bytes,
    // Every texture has to carry its own media path, otherwise FBX collapses them onto one image.
    textures: { renamed: textures ? Number(textures[1]) : 0, written: textures ? Number(textures[2]) : 0 },
  };
}
