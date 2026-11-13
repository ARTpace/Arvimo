// Fetches a portable Blender into vendor/blender/ so the FBX export path can run headless.
//
// Only the FBX step needs Blender, so it is never vendored with the tool: this script is an
// explicit, one-time opt-in. Any version/source can be overridden without touching the code.
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createWriteStream} from 'node:fs';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = process.env.BLENDER_VERSION || '4.2.1';
const dir = path.join(root, 'vendor', 'blender');
const target = path.join(dir, process.platform === 'win32' ? 'blender.exe' : 'blender');

if (fs.existsSync(target)) {
  console.log(`已存在：${target}\n如需更新请先删除该文件，或用 BLENDER_VERSION 指定其他版本。`);
  process.exit(0);
}
if (process.platform === 'darwin') {
  throw Error('macOS 版 Blender 是 .dmg 镜像，请手动安装后设置 SFX_BLENDER 指向 Blender.app/Contents/MacOS/Blender。');
}

const platform = process.platform === 'win32' ? 'windows-x64' : process.arch === 'x64' ? 'linux-x64' : 'linux-arm64';
const extension = process.platform === 'win32' ? 'zip' : 'tar.xz';
const series = `Blender${VERSION.split('.').slice(0, 2).join('.')}`;
const file = `blender-${VERSION}-${platform}.${extension}`;
// Ordered fallbacks: an explicit override, then upstream, then mirrors that are usually faster
// from mainland networks. Every candidate is tried before giving up. Note that the mirrors do not
// share a directory layout (TUNA serves `release/`, NJU serves `blender-release/`), so each one
// carries its own path segment instead of sharing a single template.
const sources = [
  process.env.SFX_BLENDER_URL,
  `https://download.blender.org/release/${series}/${file}`,
  `https://mirrors.tuna.tsinghua.edu.cn/blender/release/${series}/${file}`,
  `https://mirror.nju.edu.cn/blender/blender-release/${series}/${file}`,
].filter(Boolean);

await fsp.mkdir(dir, {recursive: true });
// The temporary name must keep the real extension: Expand-Archive on Windows refuses any path
// that does not end in .zip, so a bare `.dl-<pid>` download can never be extracted.
const download = path.join(dir, `.dl-${process.pid}-${Date.now()}.${extension}`);
let lastError = null;
for (const url of sources) {
  console.log(`下载 Blender ${VERSION}（${platform}）…\n${url}`);
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const stream = createWriteStream(download);
    try {
      for await (const chunk of response.body) stream.write(chunk);
      await new Promise((resolve, reject) => { stream.end(); stream.on('finish', resolve); stream.on('error', reject); });
    } catch (error) {
      stream.destroy();
      throw Error(`下载中断：${error.message}`);
    }
    const size = (await fsp.stat(download)).size;
    if (size < 50 * 1024 ** 2) throw Error(`文件过小（${size} 字节），可能不是完整的 Blender 包`);
    await install(download);
    await fsp.unlink(download).catch(() => {});
    console.log(`完成：${target}`);
    console.log('提示：如已有 Blender，可直接设置环境变量 SFX_BLENDER 指向它，无需再下载。');
    process.exit(0);
  } catch (error) {
    lastError = error;
    await fsp.unlink(download).catch(() => {});
    console.log(`  失败：${error.message}`);
  }
}
throw Error(`所有下载源都失败（最后一个错误：${lastError?.message}）。\n请手动安装 Blender，然后设置环境变量 SFX_BLENDER 指向 blender 可执行文件；\n或用 SFX_BLENDER_URL 指定一个可访问的下载地址。`);

async function install(archive) {
  const staging = path.join(os.tmpdir(), `blender-${process.pid}`);
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(staging, { recursive: true });
  try {
    if (process.platform === 'win32') {
      await new Promise((resolve, reject) => execFile('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path "${archive}" -DestinationPath "${staging}" -Force`], { timeout: 600000 }, e => e ? reject(e) : resolve()));
    } else {
      await new Promise((resolve, reject) => execFile('tar', ['-xf', archive, '-C', staging], { timeout: 600000 }, e => e ? reject(e) : resolve()));
    }
    // The archive holds one versioned directory; the executable is what marks its root.
    let executable = null;
    const walk = (current, depth = 0) => {
      if (executable || depth > 6) return;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.name === path.basename(target)) executable = full;
      }
    };
    walk(staging);
    if (!executable) throw Error('压缩包中未找到 Blender 可执行文件');
    // Ship the whole directory: the executable needs its sibling DLLs and datafiles.
    await fsp.cp(path.dirname(executable), dir, { recursive: true, force: true });
    if (process.platform !== 'win32') await fsp.chmod(target, 0o755);
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
