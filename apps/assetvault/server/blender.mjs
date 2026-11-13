import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundled = path.join(here, '..', 'vendor', 'blender');
const executable = process.platform === 'win32' ? 'blender.exe' : 'blender';
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** `npm run fetch:blender` unpacks here; a stray versioned subfolder is tolerated too. */
function portable() {
  const direct = path.join(bundled, executable);
  if (isFile(direct)) return direct;
  let found = null;
  const walk = (dir, depth = 0) => {
    if (found || depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === executable) found = full;
    }
  };
  walk(bundled);
  return found;
}

/** A Blender the user already has. Versioned folders are scanned newest-name first. */
function installed() {
  if (process.platform === 'win32') {
    const base = 'C:/Program Files/Blender Foundation';
    let names = [];
    try { names = fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort().reverse(); } catch { return null; }
    for (const name of names) {
      const candidate = path.join(base, name, executable);
      if (isFile(candidate)) return candidate;
    }
    return null;
  }
  if (process.platform === 'darwin') {
    const candidate = '/Applications/Blender.app/Contents/MacOS/Blender';
    return isFile(candidate) ? candidate : null;
  }
  for (const candidate of ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender', '/var/lib/flatpak/exports/bin/org.blender.Blender']) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Blender is only needed to export FBX, so it is resolved lazily and never required to start the
 * tool. An explicit SFX_BLENDER wins, then the portable copy this tool fetched itself (its version
 * is known and reproducible), then whatever is installed system-wide.
 */
export function blenderPath() {
  const explicit = process.env.SFX_BLENDER;
  if (explicit && isFile(explicit)) return explicit;
  return portable() || installed();
}

export function blenderStatus() {
  const resolved = blenderPath();
  return {
    available: !!resolved,
    path: resolved || null,
    hint: resolved ? null : '导出 FBX 需要 Blender：运行 npm run fetch:blender 自动获取，或用环境变量 SFX_BLENDER 指向已安装的 blender 可执行文件。',
  };
}
