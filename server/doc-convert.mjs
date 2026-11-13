// 文档转 PDF：pptx / xlsx / rtf / doc / odt 等「浏览器没有靠谱纯 JS 渲染器」的格式，
// 交给本机 LibreOffice headless 转成 PDF，再复用本地文件预览里现成的 pdf iframe。
//
// 与 video-transcode.mjs 是同一套外部二进制范式：
//   - probe 探测（环境变量 → 常见安装路径 → PATH），结果缓存，探测只做一次；
//   - 所有子进程走 externalProcessOptions()（Windows 隐藏控制台），不另起一套；
//   - soffice 退出码不可信（实测可能 0 但没产出），一律以「输出 PDF 存在且非空」为准。
//
// 安全：只有注册表中 preview:'doc-pdf' 的后缀才允许喂给 soffice，避免把任意路径
// （含符号链接 / 可执行文件）交给外部进程。转换结果按 mtime+size 落磁盘缓存。
import {FORMATS, extensionOf} from '../src/library/format-registry.js';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {externalProcessOptions} from './thumb-cache.mjs';

/** 从格式注册表派生：允许转换的后缀。新增 doc-pdf 格式只改注册表一行。 */
export const DOC_PDF_EXTS = Object.freeze(
  Object.values(FORMATS).filter(item => item.preview === 'doc-pdf').map(item => item.ext),
);
const DOC_PDF_SET = new Set(DOC_PDF_EXTS);
export const canConvertDoc = name => DOC_PDF_SET.has(extensionOf(name));

/** 各平台常见的 soffice 安装位置；PATH 兜底放在最后。 */
export function sofficeCandidates(platform = process.platform, env = process.env) {
  const exe = platform === 'win32' ? 'soffice.exe' : 'soffice';
  const common = platform === 'win32'
    ? ['C:\\Program Files\\LibreOffice\\program\\soffice.exe',
       'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe']
    : platform === 'darwin'
      ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice']
      : ['/usr/bin/soffice', '/usr/local/bin/soffice', '/opt/libreoffice/program/soffice'];
  return [env.SFX_SOFFICE, ...common, exe].filter(Boolean);
}

/**
 * 找 LibreOffice：环境变量 → 常见安装路径 → PATH，用 `--version` 验证能启动，结果缓存。
 * 注入参数只为测试；生产调用不传。
 */
export function createSofficeProbe({env = process.env, platform = process.platform,
  exists = fs.existsSync, run = spawnSync, candidates = null} = {}) {
  let cached;
  return () => {
    if (cached !== undefined) return cached;
    cached = null;
    for (const candidate of candidates ?? sofficeCandidates(platform, env)) {
      // PATH 上的裸命令名交给系统解析；绝对路径先确认存在，省掉一次无谓 spawn。
      if (path.isAbsolute(candidate) && !exists(candidate)) continue;
      try {
        const result = run(candidate, ['--version'],
          externalProcessOptions({timeout: 8000, stdio: 'ignore'}));
        if (result.status === 0) { cached = candidate; break; }
      } catch {}
    }
    return cached;
  };
}

export const findSoffice = createSofficeProbe();

/** LibreOffice 探测结果，供 /api/doc/status 给前端一句准确提示。 */
export function docStatus(probe = findSoffice) {
  const bin = probe();
  return {available: !!bin, path: bin || null, exts: DOC_PDF_EXTS};
}

/**
 * 构造 soffice 参数（纯函数，可单测）。
 * 每次转换用独立 UserInstallation profile —— 用户桌面上可能开着 LibreOffice，
 * 共用默认 profile 会让 headless 直接把命令转给前台实例然后静默失败。
 */
export function sofficeArgs({file, outdir, profileDir}) {
  return [
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    '--headless', '--nologo', '--nodefault', '--norestore', '--nolockcheck',
    '--convert-to', 'pdf', '--outdir', outdir, file,
  ];
}

/** soffice 把输入 foo.pptx 输出成 outdir/foo.pdf；同名不同后缀会互相覆盖，故按哈希分目录。 */
export function expectedPdfPath(file, outdir) {
  return path.join(outdir, `${path.basename(file, path.extname(file))}.pdf`);
}

/** 缓存键：路径 + 大小 + 修改时间 + 转换器版本，源一变就自然失效。 */
export function cacheKeyFor(file, stat) {
  return createHash('sha1')
    .update(`${file}|${stat.size}|${Math.floor(stat.mtimeMs)}|docconv-v1`)
    .digest('hex');
}

/**
 * 把一个文档转成 PDF，返回 {buffer, cached}。
 * 缓存命中直接读盘；未命中则建独立临时目录（profile + outdir）跑一次 soffice，
 * 校验输出文件存在且非空（退出码不作数），写入缓存，最后清理临时目录。
 */
export async function convertToPdf(file, {probe = findSoffice, run = spawnSync,
  cacheDir = path.join(os.tmpdir(), 'assetvault-doc-pdf'),
  mkdtemp = fs.mkdtempSync, read = fs.readFileSync, write = fs.writeFileSync,
  remove = fs.rmSync, stat = fs.statSync} = {}) {
  if (!canConvertDoc(file)) throw Error(`不支持转换这个格式：${path.extname(file)}`);
  const bin = probe();
  if (!bin) throw Error('没找到 LibreOffice（soffice）；装一个 LibreOffice，或用 SFX_SOFFICE 指定 soffice 路径');

  const source = stat(file);
  const key = cacheKeyFor(file, source);
  await fs.promises.mkdir(cacheDir, {recursive: true});
  const cachedFile = path.join(cacheDir, `${key}.pdf`);
  try {
    const buffer = await fs.promises.readFile(cachedFile);
    if (buffer.length) return {buffer, cached: true};
  } catch {}

  // 每次转换独占一个临时目录：profile 与输出同名文件都不会并发撞车。
  const work = mkdtemp(path.join(os.tmpdir(), 'assetvault-lo-'));
  try {
    const outdir = path.join(work, 'out');
    const profileDir = path.join(work, 'profile');
    fs.mkdirSync(outdir, {recursive: true});
    fs.mkdirSync(profileDir, {recursive: true});
    const result = run(bin, sofficeArgs({file, outdir, profileDir}),
      externalProcessOptions({timeout: 120000, stdio: 'ignore'}));
    if (result.error) throw result.error;
    const output = expectedPdfPath(file, outdir);
    // 退出码不可信：转换失败时 soffice 可能仍返回 0，必须以产物为准。
    if (!fs.existsSync(output)) {
      throw Error('LibreOffice 没能生成 PDF（文件可能损坏、受密码保护，或本机缺少字体）');
    }
    const buffer = read(output);
    if (!buffer.length) throw Error('LibreOffice 生成了空 PDF');
    write(cachedFile, buffer);
    return {buffer, cached: false};
  } finally {
    try { remove(work, {recursive: true, force: true}); } catch {}
  }
}
