import fs from 'node:fs';
import path from 'node:path';

export const MAX_LINES = 500;
export const NEAR_CAP_LINES = 450;
export const CRITICAL_CAP_LINES = 490;
export const CODE_DIRS = Object.freeze(['bin', 'src', 'public/js', 'scripts']);
export const THIRD_PARTY_DIRS = Object.freeze(['public/vendor']);
export const MD_FILES = Object.freeze(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'CONTRIBUTING.md']);

const EMOTICON_RE = /\p{Extended_Pictographic}/u;
const UNSAFE_OPEN_RE = /fsp\.open\s*\([^)]*FS\.O_RDONLY\s*\|\s*\(FS\.O_NONBLOCK/;

function checkZeroDependencies(repoRoot, violations) {
  const pkgPath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const depKeys = Object.keys(pkg.dependencies ?? {});
  if (depKeys.length > 0) {
    violations.push(`package.json must have zero runtime dependencies (found: ${depKeys.join(', ')})`);
  }
}

function scanCodeTree(repoRoot, state, thirdPartyDirs = THIRD_PARTY_DIRS) {
  function walk(dirRel) {
    if (thirdPartyDirs.some((d) => dirRel === d || dirRel.startsWith(`${d}/`))) return;
    const absDir = path.join(repoRoot, dirRel);
    if (!fs.existsSync(absDir)) return;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const rel = path.posix.join(dirRel, entry.name);
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!entry.isFile() || !/\.(mjs|js)$/.test(entry.name)) continue;
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      const lines = text.split('\n').length;
      state.totalFiles += 1;
      if (!state.maxLinesFile || lines > state.maxLinesFile.lines) {
        state.maxLinesFile = { file: rel, lines };
      }
      if (lines > MAX_LINES) {
        state.violations.push(`${rel} has ${lines} lines (cap: ${MAX_LINES})`);
      }
      if (lines > NEAR_CAP_LINES) state.nearCapFiles.push({ file: rel, lines });
      if (lines >= CRITICAL_CAP_LINES) state.criticalCapFiles.push({ file: rel, lines });
      if (rel === 'src/desktop-claude.mjs' || rel.startsWith('src/adapters/') || rel.startsWith('src/observe/')) {
        if (UNSAFE_OPEN_RE.test(text)) {
          state.violations.push(`${rel} calls fsp.open without O_NOFOLLOW (CONTRACT.md section 5 violation)`);
        }
      }
    }
  }
  for (const dir of CODE_DIRS) walk(dir);
}

function checkMarkdownEmoticons(repoRoot, violations) {
  for (const mdRel of MD_FILES) {
    const mdPath = path.join(repoRoot, mdRel);
    if (!fs.existsSync(mdPath)) continue;
    const text = fs.readFileSync(mdPath, 'utf8');
    if (EMOTICON_RE.test(text)) {
      violations.push(`${mdRel} contains emoticons (disallowed by CONTRIBUTING.md and GEMINI.md)`);
    }
  }
}

function extractAnchors(markdownText) {
  const fmMatch = markdownText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return [];
  const fmLines = fmMatch[1].split(/\r?\n/);
  const anchors = [];
  let inList = false;
  for (const line of fmLines) {
    const keyMatch = line.match(/^code_anchors\s*:\s*(.*)$/);
    if (keyMatch) {
      const inline = keyMatch[1].trim();
      if (inline.startsWith('[') && inline.endsWith(']')) {
        for (const item of inline.slice(1, -1).split(',')) {
          const clean = item.trim().replace(/^['"]|['"]$/g, '');
          if (clean) anchors.push(clean);
        }
        inList = false;
      } else {
        inList = true;
      }
      continue;
    }
    if (inList) {
      const itemMatch = line.match(/^\s+-\s+(.+)$/);
      if (itemMatch) {
        const clean = itemMatch[1].trim().replace(/^['"]|['"]$/g, '');
        if (clean) anchors.push(clean);
      } else if (/^\S/.test(line)) {
        inList = false;
      }
    }
  }
  return anchors;
}

function symbolExistsInText(text, symbol) {
  if (!symbol) return true;
  if (text.includes(symbol)) return true;
  if (symbol.includes('.')) {
    return symbol.split('.').every((part) => part && text.includes(part));
  }
  return false;
}

function checkLessonAnchors(repoRoot, staleAnchors) {
  const lessonsDir = path.join(repoRoot, 'docs', 'lessons');
  if (!fs.existsSync(lessonsDir)) return;
  for (const entry of fs.readdirSync(lessonsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const lessonRel = path.posix.join('docs/lessons', entry.name);
    const content = fs.readFileSync(path.join(lessonsDir, entry.name), 'utf8');
    for (const anchor of extractAnchors(content)) {
      const hashIdx = anchor.indexOf('#');
      if (hashIdx <= 0) {
        staleAnchors.push({ lesson: lessonRel, anchor, reason: 'invalid_anchor_format' });
        continue;
      }
      const fileRel = anchor.slice(0, hashIdx);
      const symbol = anchor.slice(hashIdx + 1);
      const targetPath = path.join(repoRoot, fileRel);
      if (!fs.existsSync(targetPath)) {
        staleAnchors.push({ lesson: lessonRel, anchor, reason: 'missing_file' });
        continue;
      }
      const targetText = fs.readFileSync(targetPath, 'utf8');
      if (!symbolExistsInText(targetText, symbol)) {
        staleAnchors.push({ lesson: lessonRel, anchor, reason: 'missing_symbol' });
      }
    }
  }
}

export function auditDomHealth(repoRoot, { thirdPartyDirs = THIRD_PARTY_DIRS } = {}) {
  const state = {
    violations: [],
    nearCapFiles: [],
    criticalCapFiles: [],
    staleAnchors: [],
    totalFiles: 0,
    maxLinesFile: null,
  };
  checkZeroDependencies(repoRoot, state.violations);
  scanCodeTree(repoRoot, state, thirdPartyDirs);
  checkMarkdownEmoticons(repoRoot, state.violations);
  checkLessonAnchors(repoRoot, state.staleAnchors);

  state.nearCapFiles.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
  state.criticalCapFiles.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));

  return {
    ok: state.violations.length === 0 && state.staleAnchors.length === 0,
    violations: state.violations,
    violationsCount: state.violations.length,
    nearCapFiles: state.nearCapFiles,
    nearCapFilesCount: state.nearCapFiles.length,
    criticalCapFiles: state.criticalCapFiles,
    criticalCapFilesCount: state.criticalCapFiles.length,
    staleAnchors: state.staleAnchors,
    staleAnchorsCount: state.staleAnchors.length,
    totalFiles: state.totalFiles,
    maxLinesFile: state.maxLinesFile,
  };
}
