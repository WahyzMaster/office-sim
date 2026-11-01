import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_PATH = path.join(ROOT, 'docs', 'SOFTWARE_DEVELOPMENT_REPORT.md');
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

describe('Software Development Report (docs/SOFTWARE_DEVELOPMENT_REPORT.md)', () => {
  it('exists, stays within <= 500 lines, and contains zero emoticons', () => {
    assert.equal(fs.existsSync(REPORT_PATH), true, 'docs/SOFTWARE_DEVELOPMENT_REPORT.md must exist');
    const text = fs.readFileSync(REPORT_PATH, 'utf8');
    const lines = text.split('\n');
    assert.ok(lines.length <= 500, `expected <= 500 lines, got ${lines.length}`);
    assert.equal(EMOJI_RE.test(text), false, 'report must not contain emoticons');
  });

  it('includes all 6 industry-standard sections and requirement traceability IDs', () => {
    const text = fs.readFileSync(REPORT_PATH, 'utf8');
    const expectedHeadings = [
      '## 1. Document Control, Identification & Executive Summary',
      '## 2. System Requirements & Bidirectional Traceability Matrix',
      '## 3. Software Architecture & Detailed Design',
      '## 4. Quality Attributes, Security & Privacy Engineering',
      '## 5. Verification, Validation & Test Report',
      '## 6. Release History, SDLC Governance & Future Roadmap',
    ];
    for (const heading of expectedHeadings) {
      assert.ok(text.includes(heading), `missing section heading: ${heading}`);
    }

    const expectedStandards = [
      'ISO/IEC/IEEE 12207',
      'ISO/IEC/IEEE 29148',
      'ISO/IEC/IEEE 42010',
      'ISO/IEC 25010',
      'ISO/IEC/IEEE 29119',
      'IEEE 1061',
    ];
    for (const std of expectedStandards) {
      assert.ok(text.includes(std), `missing standard reference: ${std}`);
    }

    for (let i = 1; i <= 10; i++) {
      const id = `FR-${String(i).padStart(2, '0')}`;
      assert.ok(text.includes(id), `missing functional requirement ${id}`);
    }
    for (let i = 1; i <= 6; i++) {
      const id = `NFR-${String(i).padStart(2, '0')}`;
      assert.ok(text.includes(id), `missing non-functional requirement ${id}`);
    }
  });

  it('contains Mermaid architecture and sequence diagrams', () => {
    const text = fs.readFileSync(REPORT_PATH, 'utf8');
    const mermaidBlocks = [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)];
    assert.ok(mermaidBlocks.length >= 2, `expected >= 2 mermaid diagrams, got ${mermaidBlocks.length}`);
    assert.ok(
      mermaidBlocks.some((m) => m[1].includes('flowchart')),
      'expected at least one flowchart diagram'
    );
    assert.ok(
      mermaidBlocks.some((m) => m[1].includes('sequenceDiagram')),
      'expected at least one sequenceDiagram'
    );
  });

  it('references only existing repository files in backticked repo paths', () => {
    const text = fs.readFileSync(REPORT_PATH, 'utf8');
    const repoPathRe = /`((?:bin|src|public|scripts|skills|docs|test|\.github|\.claude|\.apm)\/[A-Za-z0-9_./-]+)`/g;
    const seen = new Set();
    for (const match of text.matchAll(repoPathRe)) {
      const rel = match[1].replace(/\/$/, '');
      if (rel.includes('*') || rel.includes('<') || seen.has(rel)) continue;
      seen.add(rel);
      const abs = path.join(ROOT, rel);
      assert.equal(fs.existsSync(abs), true, `referenced path does not exist: ${rel}`);
    }
    assert.ok(seen.size >= 30, `expected >= 30 verified repository paths, got ${seen.size}`);
  });

  it('is cross-linked from README.md, README.ko.md, and CLAUDE.md', () => {
    for (const docFile of ['README.md', 'README.ko.md', 'CLAUDE.md']) {
      const content = fs.readFileSync(path.join(ROOT, docFile), 'utf8');
      assert.ok(
        content.includes('docs/SOFTWARE_DEVELOPMENT_REPORT.md'),
        `${docFile} must reference docs/SOFTWARE_DEVELOPMENT_REPORT.md`
      );
    }
  });
});
