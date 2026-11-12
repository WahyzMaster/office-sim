// The secret mask reads the text as the page will get it (launch readiness W10, D33 to D39; CONTRACT 3.1 and 5).
// cleanText deletes colour codes, control and zero-width characters and lone surrogates and makes every white space
// one space. It does that before the mask looks, so a shape with one of those characters inside it is still that
// shape, and what cleanText sent once it sends again unchanged. Samples are built when the test runs (D39).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, truncate } from '../src/summarize.mjs';
import { maskSecrets, SECRET_MARKER as M } from '../src/secret-mask.mjs';
import {
  shapeSamples, piecesOf, chars, withDigit, LOWER, LETTERS, ALNUM, B64URL, PREFIXED, tailOf, AUTH_HEADER, KEY_HEADER, NAME_ENDS,
} from './fixtures/secret-samples.mjs';

const ESC = '\u001b';
// what truncate() deletes: ANSI codes, C0 and C1 controls, DEL, zero-width and bidi characters, lone surrogates
const GONE = [
  ['a colour code', `${ESC}[31m`], ['a reset code', `${ESC}[0m`], ['the codes grep --color writes', `${ESC}[01;31m${ESC}[K`],
  ['NUL', '\u0000'], ['BEL', '\u0007'], ['a lone ESC', ESC], ['DEL', '\u007f'], ['a C1 control', '\u0085'],
  ['a zero-width space', '\u200b'], ['a word joiner', '\u2060'], ['an invisible operator', '\u2062'],
  ['a left-to-right mark', '\u200e'], ['a bidi override', '\u202e'], ['a bidi isolate', '\u2066'],
  ['a lone surrogate', '\ud83d'], ['two of them', '\u200b\u0007'],
];
// what truncate() turns into one space
const SPACES = [['a line break', '\n'], ['CR LF', '\r\n'], ['a tab', '\t'], ['a no-break space', '\u00a0'],
  ['a line separator', '\u2028'], ['an ideographic space', '\u3000'], ['two spaces', '  '], ['a break between spaces', ' \n ']];

const cat = (...parts) => parts.join('');
const eq = (name, value) => [name, value].join('=');
const masked = (text, want, why) => assert.equal(maskSecrets(text), want, why);
const kept = (text, why) => assert.equal(maskSecrets(text), text, why);
const samples = shapeSamples();
const sent = (text, max = Infinity) => cleanText(text, max);
function noPiece(sample, text, why) {
  for (const piece of piecesOf(sample)) assert.equal(text.includes(piece), false, `${why}: a hidden part is shown in ${JSON.stringify(text)}`);
}

test('every sample is masked as it stands, and nothing of its hidden parts is sent', () => {
  assert.ok(samples.length >= PREFIXED.length + 20, `samples: ${samples.length}`);
  for (const s of samples) {
    const out = sent(s.text);
    assert.ok(out.includes(M), `${s.name}: the marker`);
    noPiece(s, out, s.name);
    assert.equal(sent(out), out, `${s.name}: sent again unchanged`);
  }
});

test('every code unit: when truncate() deletes it from inside a token, the token is masked', () => {
  const gh = PREFIXED.find((r) => r.name === 'ghp_');
  const sample = `${gh.prefix}${tailOf(gh, 36)}`;
  let deleted = 0;
  for (let c = 0; c <= 0xffff; c++) {
    const text = `${sample.slice(0, 9)}${String.fromCharCode(c)}${sample.slice(9)}`;
    if (truncate(text, Infinity) !== sample) continue; // the character stays on the wire, or is a space there
    deleted++;
    if (sent(text) !== M) assert.fail(`U+${c.toString(16).padStart(4, '0')} is deleted behind the mask: ${JSON.stringify(sent(text))}`);
  }
  // what the walk found: 27 C0 controls that are not white space, DEL and the 32 C1 controls, the 17 zero-width and
  // bidi characters of CONTROL_RE, and the 2,048 surrogates (between two letters each one is a lone surrogate)
  assert.equal(deleted, 27 + 33 + 17 + 2048);
  // and every code unit that truncate() turns into the one space a shape has: the shape is still seen
  const tok = withDigit(28, LETTERS, 44);
  let spaces = 0;
  for (let c = 0; c <= 0xffff; c++) {
    const text = `Bearer${String.fromCharCode(c)}${tok}`;
    if (truncate(text, Infinity) !== `Bearer ${tok}`) continue;
    spaces++;
    if (sent(text) !== `Bearer ${M}`) assert.fail(`U+${c.toString(16).padStart(4, '0')} becomes a space behind the mask: ${JSON.stringify(sent(text))}`);
  }
  assert.equal(spaces, 25, 'the white space of JavaScript: 6 ASCII, U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF');
});

test('a character that cleanText deletes, at any place inside a sample, changes nothing of what is sent', () => {
  let rows = 0;
  for (const s of samples) {
    const base = sent(s.text);
    for (const [what, gone] of GONE) {
      for (let i = 1; i < s.text.length; i++) {
        const out = sent(s.text.slice(0, i) + gone + s.text.slice(i));
        if (out !== base) assert.fail(`${s.name}: ${what} at ${i} of ${s.text.length}: sent ${JSON.stringify(out)}, not ${JSON.stringify(base)}`);
        rows++;
      }
    }
  }
  assert.ok(rows > 20_000, `rows: ${rows}`);
});

test('the same inside a sentence, and with a deleted character on both sides of the sign', () => {
  for (const s of samples) {
    const base = sent(`first ${s.text} last`);
    noPiece(s, base, s.name);
    for (const [what, gone] of GONE) {
      for (let i = 1; i < s.text.length; i += 3) {
        const text = `first ${s.text.slice(0, i)}${gone}${s.text.slice(i)} last`;
        assert.equal(sent(text), base, `${s.name}: ${what} at ${i}`);
      }
      // every character of the sample apart from its neighbours (while the text stays under the 1,024-character cut)
      const spread = Array.from(s.text).join(gone);
      if (spread.length < 1000) assert.equal(sent(`first ${spread} last`), base, `${s.name}: ${what} between all characters`);
    }
  }
});

test('D35: a deleted character in front of a sample is a token start, also when a letter stands before it', () => {
  for (const s of samples) {
    const base = sent(s.text);
    for (const [what, gone] of GONE) {
      const out = sent(`x${gone}${s.text}`);
      assert.equal(out, `x${base}`, `${s.name} behind "x" and ${what}`);
      noPiece(s, out, s.name);
    }
  }
});

test('a line break, a tab or a no-break space in place of a space inside a sample changes nothing of what is sent', () => {
  let rows = 0;
  for (const s of samples.filter((x) => /\s/.test(x.text))) {
    const base = sent(s.text);
    const gaps = [...s.text.matchAll(/\s+/g)];
    for (const [what, space] of SPACES) {
      assert.equal(sent(s.text.replace(/\s+/g, space)), base, `${s.name}: ${what} for every gap`);
      for (const g of gaps) {
        assert.equal(sent(s.text.slice(0, g.index) + space + s.text.slice(g.index + g[0].length)), base, `${s.name}: ${what} at ${g.index}`);
        rows++;
      }
    }
  }
  assert.ok(rows >= 8 * 8, `rows: ${rows}`);
});

test('coloured terminal output: the highlight stands on the prefix, the name word, the sign or the scheme word', () => {
  const hit = (t) => `${ESC}[01;31m${ESC}[K${t}${ESC}[m${ESC}[K`; // how grep --color marks a match
  const file = `${ESC}[35m${ESC}[Ksrc/app.js${ESC}[m${ESC}[K${ESC}[36m${ESC}[K:${ESC}[m${ESC}[K12${ESC}[36m${ESC}[K:${ESC}[m${ESC}[K`;
  const v = chars(20, LOWER, 41);
  const tok = withDigit(28, LETTERS, 42);
  const gh = PREFIXED.find((r) => r.name === 'ghp_');
  const tail = tailOf(gh, 36, { seed: 43 });
  const named = eq('DEPLOY_API_KEY', M); // what is left of a name and its value
  const jsonForm = ['"api_key"', `"${M}"`].join(': ');
  const rows = [
    [`${hit(gh.prefix)}${tail}`, M, tail],
    [`${gh.prefix}${hit(tail.slice(0, 9))}${tail.slice(9)}`, M, tail],
    [['DEPLOY_', hit('API_KEY'), '=', v].join(''), named, v],
    [[hit('DEPLOY_API_KEY'), `${ESC}[36m`, '=', `${ESC}[0m${ESC}[32m`, v, `${ESC}[0m`].join(''), named, v],
    [[hit(eq('DEPLOY_API_KEY', '')), v].join(''), named, v],
    [[`"${hit('api_key')}"`, `"${v}"`].join(': '), jsonForm, v],
    [`${hit('Bearer')} ${tok}`, `Bearer ${M}`, tok],
    [`Bearer ${hit(tok.slice(0, 6))}${tok.slice(6)}`, `Bearer ${M}`, tok],
    [`${hit(AUTH_HEADER)}: Basic ${v}`, `${AUTH_HEADER}: Basic ${M}`, v],
    [`${AUTH_HEADER}: ${hit('Basic')} ${v}`, `${AUTH_HEADER}: Basic ${M}`, v],
    [`${hit(KEY_HEADER)}: ${v}`, `${KEY_HEADER}: ${M}`, v],
    // a line break where the shape wants a space
    [`${AUTH_HEADER}: Bearer\n${v}`, `${AUTH_HEADER}: Bearer ${M}`, v],
    [`Bearer\n${tok}`, `Bearer ${M}`, tok],
    [['"api_key"', `"${v}"`].join(':\n  '), jsonForm, v],
  ];
  for (const [text, want, hidden] of rows) {
    for (const line of [text, `${file}${text}`]) {
      const out = sent(line);
      assert.equal(out, line === text ? want : `src/app.js:12:${want}`, JSON.stringify(line));
      assert.equal(out.includes(hidden.slice(0, 8)) || out.includes(hidden.slice(-8)), false, 'a piece of the value is shown');
      assert.equal(sent(out), out, 'sent again unchanged');
    }
  }
});

test('what cleanText sent once it sends again unchanged, whatever was deleted or joined on the way', () => {
  // the same compositions on every run
  let seed = 9001;
  const rnd = (n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  const pick = (list) => list[rnd(list.length)];
  const glue = [' ', ' ', '\n', '\t', '\u00a0', ', ', ': ', '=', '"', "'", '(', ')', 'x', '7', '-', '_', '/', '.', 'and ', '키'];
  for (let i = 0; i < 6000; i++) {
    const parts = Array.from({ length: 2 + rnd(5) }, () => {
      const s = pick(samples);
      const at = 1 + rnd(s.text.length - 1);
      const cut = rnd(3) === 0 ? pick(GONE)[1] : rnd(3) === 0 ? pick(SPACES)[1] : '';
      return rnd(4) === 0 ? pick(glue) : s.text.slice(0, at) + cut + s.text.slice(at);
    });
    const text = parts.join(pick(glue));
    const once = sent(text);
    assert.equal(sent(once), once, `sent twice: ${JSON.stringify(text)}`);
  }
});

test('the length cap: no piece of a sample on either side of the cut, and a second cleaning changes nothing', () => {
  for (const s of samples) {
    for (const max of [200, 120, 80, 60, 40, 24, 12]) {
      for (let lead = 0; lead < max; lead += 7) {
        const text = `${chars(lead, LOWER)} ${s.text.slice(0, 5)}\u200b${s.text.slice(5)} ${chars(30, LOWER, 3)}`;
        const once = sent(text, max);
        assert.ok(Array.from(once).length <= max);
        noPiece(s, once, `${s.name} capped at ${max}`);
        assert.equal(sent(once, max), once, `${s.name} capped at ${max}, cleaned again`);
      }
    }
  }
});

test('a text with no listed shape goes through the other rules as it did before the mask: a path and a URL with a deleted character', () => {
  // (the rows are what the scrub gave before the mask existed; test/secret-mask-sweep.test.mjs has more of them)
  for (const soft of ['\u200b', '\u2060', '\u200e', '\u202e', '\u0085', '\ud83d']) {
    assert.equal(sent(`open /Users/victim/pri${soft}vate/notes.md now`), 'open notes.md now'); // read through, as ever
  }
  for (const [, gone] of GONE) {
    assert.equal(sent(`see https://docs.invented.example/a${gone}b/c?d=1 now`), 'see docs.invented.example now');
    // in front of a path it separates the path from the word before it
    assert.equal(sent(`ls${gone}/Users/victim/private/notes.md`), 'lsnotes.md');
    assert.equal(sent(`cd${gone}~/private/dir`), 'cddir');
    assert.equal(sent(`링크${gone}https://docs.invented.example/a/b`), '링크docs.invented.example');
  }
  // a token as the last segment of a path that follows a colour code: the mask sees it at a token start
  const gh = PREFIXED.find((r) => r.name === 'ghp_');
  const token = `${gh.prefix}${chars(36, ALNUM, 5)}`;
  assert.equal(sent(`cat${ESC}[0m/Users/victim/keys/${token}`), `cat${M}`);
});

// --------------------------------------------------------------------------------------------- the marker and the other rules

test('the marker survives the rest of cleanText', () => {
  const gh = cat('gh', 'p_', chars(36, ALNUM));
  const v = chars(12, LOWER);
  // NAME=(marker)
  assert.equal(cleanText(eq('DEPLOY_API_KEY', gh), 200), eq('DEPLOY_API_KEY', M));
  assert.equal(cleanText(`export ${eq('DB_PASSWORD', v)} && npm test`, 200), `export ${eq('DB_PASSWORD', M)} && npm test`);
  // a path whose last segment became the marker
  assert.equal(cleanText(`/Users/someone/keys/${gh}`, 200), M);
  assert.equal(cleanText(`open /Users/someone/keys/${gh} now`, 200), `open ${M} now`);
  // a URL whose query held a secret: the host only, and no stray bracket
  assert.equal(cleanText(`https://api.invented.example/v1?${eq('access_token', v)}`, 200), 'api.invented.example');
  assert.equal(cleanText(`https://api.invented.example/hook/${gh}`, 200), 'api.invented.example');
  assert.equal(cleanText(`open https://api.invented.example/v1?${eq('token', v)}, then wait`, 200), 'open api.invented.example, then wait');
  assert.equal(cleanText(`is it api.invented.example/v1?${eq('token', v)}?`, 200), 'is it api.invented.example?');
  assert.equal(cleanText(`see https://api.invented.example/hook/${gh}.`, 200), 'see api.invented.example.', 'the sentence keeps its full stop');
  assert.equal(cleanText(`(see api.invented.example/hook/${gh})`, 200), '(see api.invented.example)', 'and its bracket');
  assert.equal(cleanText(`git@code.invented.example:team/${gh}`, 200), 'code.invented.example');
  // a token wrapped in ANSI colour codes: the colour code leaves a control character, which is a token start
  assert.equal(cleanText(`\u001b[31m${gh}\u001b[0m`, 200), M);
  assert.equal(cleanText(`key \u001b[1;32m${gh}\u001b[0m ok`, 200), `key ${M} ok`);
  // the cap comes after the mask: a long token near the start does not push a piece of itself into the cut
  const long = cat('sk-', 'ant-', chars(300, B64URL));
  assert.equal(cleanText(`use ${long} here`, 20), `use ${M} here`);
  // masked text stays masked when it is cleaned again (a title is scrubbed more than once on its way)
  const once = cleanText(`${gh} and ${eq('token', v)} at /Users/someone/x/${gh}`, 200);
  assert.equal(cleanText(once, 200), once);
  assert.equal(once, `${M} and ${eq('token', M)} at ${M}`);
});

// --------------------------------------------------------------------------------------------- the mask alone

test('MARK: the mask reads through a mark its caller left, takes it for a token start and keeps the ones outside', () => {
  const MARK = '\u0000';
  const gh = PREFIXED.find((r) => r.name === 'ghp_');
  const sample = cat(gh.prefix, tailOf(gh, 36));
  for (let i = 1; i < sample.length; i += 5) masked(cat(sample.slice(0, i), MARK, sample.slice(i)), M, `a mark at ${i}`);
  masked(cat('x', MARK, sample), cat('x', MARK, M), 'a token start behind a letter');
  kept(cat('x', sample), 'no mark, no start');
  masked(cat('a', MARK, '/b ', sample, MARK, '/c'), cat('a', MARK, '/b ', M, MARK, '/c'), 'marks outside what was replaced stay');
  const v = chars(9, LOWER);
  masked(cat('pass', MARK, 'word', MARK, '=', MARK, v.slice(0, 4), MARK, v.slice(4)), cat('pass', MARK, 'word', MARK, '=', MARK, M));
  masked(cat('Bear', MARK, 'er ', withDigit(8, LETTERS), MARK, withDigit(9, LETTERS)), cat('Bear', MARK, 'er ', M));
  kept(cat('plain', MARK, ' text', MARK), 'nothing to mask: the text comes back as it was');
});

test('the ellipsis of the length cap is no part of a value: a capped text keeps it', () => {
  const name = NAME_ENDS[0];
  const v = chars(9, LOWER);
  masked(`${eq(name, v)}\u2026`, `${eq(name, M)}\u2026`);
  for (const text of [`${eq(name, M)}\u2026`, `${eq(name, `"${M}"`)}\u2026`, `${eq(name, M.slice(0, 4))}\u2026`]) {
    assert.equal(maskSecrets(maskSecrets(text)), maskSecrets(text), text);
  }
  kept(`${eq(name, '')}\u2026`, 'nothing but the ellipsis behind the sign');
  const auth = AUTH_HEADER;
  kept(`${auth}: Bas\u2026`, 'a scheme word the cap cut');
  kept(`${auth}: Bearer\u2026`);
  const hv = withDigit(9, LOWER);
  masked(`${auth}: ${hv}\u2026`, `${auth}: ${M}\u2026`, 'a value in front of the ellipsis is still a value');
});

test('the marker is the text of D33, and an address whose local part has a listed shape goes whole, as before the mask', () => {
  assert.equal(M, ['(', 'secret', ')'].join(''));
  const gh = PREFIXED.find((r) => r.name === 'ghp_');
  const local = cat(gh.prefix, tailOf(gh, 36, { seed: 77 }));
  const domain = ['corp', 'example'].join('.');
  assert.equal(cleanText(`mail ${local}@${domain} today`, 200), 'mail (email) today', 'no marker in front of a shown domain');
  assert.equal(cleanText(`mail someone@${domain} today`, 200), 'mail (email) today');
});

test('a backslash directly in front of a line break: the path in front of it keeps its last name', () => {
  // the line break becomes a space, and a backslash with a space behind it is an escaped space of a path: the mark
  // that tidy() leaves between the two keeps them apart, as the line break did
  assert.equal(cleanText('dir C:\\Users\\me\\proj\\\nnext line', 200), 'dir proj next line');
  assert.equal(cleanText('see /a/b/c\\\nfoo/bar baz', 200), 'see c foo/bar baz');
  assert.equal(cleanText('echo one \\\n two \\\n three /x/y/z', 200), 'echo one \\ two \\ three z');
});
