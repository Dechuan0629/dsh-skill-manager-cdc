/**
 * Archive import support.
 *
 * A skill archive is unpacked with the host `bsdtar` (libarchive reads zip,
 * 7z, rar, tar and their compressed variants) into a private temporary
 * directory. Before unpacking, every entry name from the listing is checked
 * for traversal; after unpacking the tree is walked again with `lstat`, so a
 * symlink, device node or FIFO can never reach the skill store. The structure
 * itself is strict: one `<name>-skill/` wrapper directory (or the archive root)
 * holding exactly `SKILL.md` and an optional `scripts/` directory.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fail } from './errors.js';
import { assertInside } from './paths.js';

export const ARCHIVE_LIMITS = Object.freeze({
  archiveBytes: 32 * 1024 * 1024,
  extractedBytes: 64 * 1024 * 1024,
  files: 500,
  fileBytes: 10 * 1024 * 1024,
});

const BSDTAR_CANDIDATES = ['/usr/bin/bsdtar', '/usr/local/bin/bsdtar', '/opt/homebrew/bin/bsdtar', '/bin/bsdtar'];
const SKILL_FILE_RE = /^skill\.md$/i;
const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

function resolveBsdtar() {
  for (const candidate of BSDTAR_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return 'bsdtar';
}

function isJunkName(name) {
  const lower = name.toLowerCase();
  if (JUNK_NAMES.has(lower)) return true;
  if (lower.startsWith('._')) return true;
  return false;
}

function isJunkPath(relative) {
  const segments = relative.split('/');
  return segments.some((segment) => segment === '__MACOSX' || isJunkName(segment));
}

/** Run bsdtar with an argv array (never a shell) and a hard timeout. */
async function runBsdtar(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(resolveBsdtar(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(fail('unsupported_archive', `无法启动解压工具：${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(fail('bad_archive', '解压超时'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(fail('unsupported_archive', `解压工具不可用：${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
      });
    });
  });
}

/** Normalize one archive entry name and refuse anything that could escape. */
function checkEntryName(raw) {
  let name = String(raw ?? '').replace(/\r$/, '');
  if (!name) return '';
  name = name.replace(/\\/g, '/');
  while (name.startsWith('./')) name = name.slice(2);
  if (name === '' || name === '.') return '';
  if (name.includes('\0')) fail('bad_archive', '压缩包条目包含非法字符');
  if (name.startsWith('/') || /^[A-Za-z]:\//.test(name)) fail('bad_archive', '压缩包内不允许绝对路径');
  const segments = name.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) fail('bad_archive', '压缩包内不允许使用 .. 路径');
  if (segments.length === 0) return '';
  return segments.join('/');
}

/**
 * List, validate and normalize every entry name of an archive.
 * @returns {Promise<string[]>} normalized relative entry names.
 */
export async function listArchive(archiveFile) {
  const result = await runBsdtar(['-t', '-f', archiveFile]);
  if (result.code !== 0) {
    const detail = result.stderr.split('\n').filter(Boolean).slice(-1)[0] ?? '无法识别的压缩包';
    fail('unsupported_archive', `不支持的压缩包或文件已损坏：${detail}`);
  }
  const names = [];
  for (const line of result.stdout.split('\n')) {
    const name = checkEntryName(line);
    if (name) names.push(name);
  }
  if (names.length === 0) fail('bad_archive', '压缩包为空');
  return names;
}

/** Unpack an archive into `destDir` (which must already exist). */
export async function extractArchive(archiveFile, destDir) {
  const result = await runBsdtar(['-x', '-f', archiveFile, '-C', destDir]);
  if (result.code !== 0) {
    const detail = result.stderr.split('\n').filter(Boolean).slice(-1)[0] ?? '解压失败';
    fail('bad_archive', `解压失败：${detail}`);
  }
  return destDir;
}

/** Walk an unpacked tree, refusing links and special files, counting bytes. */
async function walkTree(rootPath) {
  const files = [];
  let totalBytes = 0;

  async function visit(dir, relativePrefix) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relative = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (isJunkPath(relative)) continue;
      const absolute = path.join(dir, entry.name);
      assertInside(rootPath, absolute);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) fail('invalid_skill', `压缩包内包含符号链接：${relative}`);
      if (info.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!info.isFile()) fail('invalid_skill', `压缩包内包含特殊文件：${relative}`);
      if (info.size > ARCHIVE_LIMITS.fileBytes) fail('too_large', `文件过大：${relative}`);
      totalBytes += info.size;
      if (totalBytes > ARCHIVE_LIMITS.extractedBytes) fail('too_large', '解压后内容超过大小限制');
      files.push({ path: relative, size: info.size, absolute });
      if (files.length > ARCHIVE_LIMITS.files) fail('too_large', `文件数量超过 ${ARCHIVE_LIMITS.files} 个`);
    }
  }

  await visit(rootPath, '');
  return { files, totalBytes };
}

function skillFilesOf(entries) {
  return entries.filter((entry) => entry.isFile() && SKILL_FILE_RE.test(entry.name));
}

/**
 * Validate the strict skill layout inside an unpacked archive.
 *
 * @returns {Promise<{
 *   skillRoot: string,
 *   rootPath: string,
 *   skillFile: string,
 *   scriptsDir: string|null,
 *   files: {path:string,size:number,absolute:string}[],
 *   totalBytes: number,
 *   warnings: string[],
 * }>}
 */
export async function inspectExtracted(extractDir) {
  const rootPath = path.resolve(extractDir);
  const { files, totalBytes } = await walkTree(rootPath);
  const warnings = [];

  const rootEntries = (await readdir(rootPath, { withFileTypes: true })).filter((entry) => !isJunkName(entry.name));
  const rootSkillFiles = skillFilesOf(rootEntries);
  let skillRoot = '';

  if (rootSkillFiles.length === 0) {
    const directories = rootEntries.filter((entry) => entry.isDirectory());
    const candidates = [];
    for (const directory of directories) {
      const children = await readdir(path.join(rootPath, directory.name), { withFileTypes: true });
      if (skillFilesOf(children).length > 0) candidates.push(directory.name);
    }
    if (candidates.length === 0) fail('invalid_skill', '压缩包内未找到 skill.md / SKILL.md（可放在 <名称>-skill/ 目录内或压缩包根目录）');
    if (candidates.length > 1) fail('invalid_skill', `压缩包内存在多个 skill 目录：${candidates.join('、')}`);
    const extras = rootEntries.filter((entry) => entry.name !== candidates[0]).map((entry) => entry.name);
    if (extras.length > 0) warnings.push(`已忽略压缩包根目录的其它条目：${extras.join('、')}`);
    skillRoot = candidates[0];
  } else if (rootSkillFiles.length > 1) {
    fail('invalid_skill', '压缩包内存在多个 skill.md / SKILL.md');
  }

  const skillDir = skillRoot ? path.join(rootPath, skillRoot) : rootPath;
  const topEntries = (await readdir(skillDir, { withFileTypes: true })).filter((entry) => !isJunkName(entry.name));
  const skillFileEntries = skillFilesOf(topEntries);
  if (skillFileEntries.length === 0) fail('invalid_skill', '未找到 skill.md / SKILL.md');
  if (skillFileEntries.length > 1) fail('invalid_skill', '目录内存在多个 skill.md / SKILL.md');

  const scriptsEntry = topEntries.find((entry) => entry.name === 'scripts');
  if (scriptsEntry !== undefined && !scriptsEntry.isDirectory()) fail('invalid_skill', 'scripts 必须是目录');

  const extras = topEntries.filter((entry) => entry.name !== skillFileEntries[0].name && entry.name !== 'scripts');
  if (extras.length > 0) {
    warnings.push(`已忽略 skill 目录内的其它条目（只导入 SKILL.md 与 scripts/）：${extras.map((entry) => entry.name).join('、')}`);
  }

  const skillFile = path.join(skillDir, skillFileEntries[0].name);
  assertInside(rootPath, skillFile);
  const scriptsDir = scriptsEntry === undefined ? null : path.join(skillDir, 'scripts');
  if (scriptsDir === null) warnings.push('压缩包内没有 scripts/ 目录，已自动创建空目录');

  const prefix = skillRoot ? `${skillRoot}/` : '';
  const skillFiles = files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ ...file, path: file.path.slice(prefix.length) }));

  return { skillRoot, rootPath, skillDir, skillFile, scriptsDir, files: skillFiles, totalBytes, warnings };
}
