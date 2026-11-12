// The secret mask alone (src/secret-mask.mjs, launch readiness W10, decisions D33 to D39). One row per shape of D35 to
// D37, the token-start rule, the minimum lengths, what D37 and D38 say is never masked, and the cost bound of D39.
// Every sample is built when the test runs (test/fixtures/secret-samples.mjs): this file holds no token-shaped string.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { maskSecrets, SECRET_MARKER } from '../src/secret-mask.mjs';
import {
  chars, withDigit, LOWER, UPPER, DIGITS, LETTERS, ALNUM, B64URL, PREFIXED, tailOf, NAME_ENDS, jwtPart, pemBody,
  pemBegin as PEM_BEGIN, pemEnd as PEM_END,
} from './fixtures/secret-samples.mjs';

const M = SECRET_MARKER;
const cat = (...parts) => parts.join('');
const masked = (text, want, why) => assert.equal(maskSecrets(text), want, why);
const kept = (text, why) => assert.equal(maskSecrets(text), text, why);

test('D35: every prefixed shape is replaced by the marker at its minimum length', () => {
  for (const row of PREFIXED) {
    const sample = cat(row.prefix, tailOf(row, row.min));
    masked(sample, M, `${row.name}: alone`);
    masked(`use ${sample} for the call`, `use ${M} for the call`, `${row.name}: inside a sentence`);
    if (!row.exact) masked(cat(row.prefix, tailOf(row, row.min + 25)), M, `${row.name}: longer`);
  }
  // the whole alphabet of a row counts, not only letters
  for (const row of PREFIXED.filter((r) => !r.exact)) {
    masked(cat(row.prefix, withDigit(row.min + 8, row.alphabet, 3)), M, `${row.name}: its full alphabet`);
  }
});

test('D35: one character short of the minimum is not masked', () => {
  for (const row of PREFIXED) {
    kept(cat(row.prefix, tailOf(row, row.min - 1)), `${row.name}: ${row.min - 1} characters`);
    kept(cat(row.prefix, tailOf(row, row.min - 1, { digit: true })), `${row.name}: ${row.min - 1} characters with a digit`);
  }
  // sk-ant- and sk-proj- have their own length: a shorter tail is not the "other sk-" shape, digit or not
  for (const row of PREFIXED.slice(0, 2)) {
    for (const n of [19, 17, 16, 15, 12]) kept(cat(row.prefix, withDigit(n, B64URL)), `${row.name}: ${n} characters with a digit`);
    masked(cat(row.prefix, withDigit(20, B64URL)), M, `${row.name}: 20 characters`);
  }
});

test('D35: the shapes that ask for a digit are not masked without one, and the exact ones not when longer', () => {
  for (const row of PREFIXED.filter((r) => r.digit)) {
    kept(cat(row.prefix, tailOf(row, row.min + 6, { digit: false })), `${row.name}: no digit`);
  }
  for (const row of PREFIXED.filter((r) => r.exact)) {
    kept(cat(row.prefix, tailOf(row, row.min + 1)), `${row.name}: one character more than its length`);
  }
  // sk-ant- and sk-proj- need no digit
  for (const row of PREFIXED.slice(0, 2)) masked(cat(row.prefix, chars(row.min, LETTERS)), M, `${row.name}: letters only`);
});

test('D35: a shape counts only at a token start', () => {
  for (const row of PREFIXED) {
    const sample = cat(row.prefix, tailOf(row, row.min));
    // not a start: the character before is a letter, a digit, "_" or "-"
    for (const before of ['x', 'Z', '4', '_', '-']) kept(cat(before, sample), `${row.name} after "${before}"`);
    // a start: the beginning of the text, white space, punctuation, a control character
    for (const before of [' ', '\n', '\t', ':', '=', '(', '"', "'", '/', '.', ',', '\u0000', '\u001b']) {
      masked(cat(before, sample), cat(before, M), `${row.name} after ${JSON.stringify(before)}`);
    }
    // a letter of another script is not an ASCII letter: the token is still masked
    masked(cat('키', sample), cat('키', M), `${row.name} after a Korean letter`);
  }
});

test('D35: what follows a masked token stays', () => {
  const gh = cat('gh', 'p_', chars(36, ALNUM));
  masked(`${gh}.`, `${M}.`);
  masked(`"${gh}",`, `"${M}",`);
  masked(`${gh} ${gh}`, `${M} ${M}`);
  masked(`${gh}/x`, `${M}/x`);
});

// --------------------------------------------------------------------------------------------- D36

test('D36: a JSON Web Token (three parts, the first two starting with the JSON marker, each 10 or more)', () => {
  const jwt = [jwtPart(10, 1), jwtPart(10, 2), chars(10, B64URL, 3)].join('.');
  masked(jwt, M);
  masked(`token ${jwt} expired`, `token ${M} expired`);
  masked([jwtPart(36, 1), jwtPart(120, 2), chars(43, B64URL, 3)].join('.'), M, 'a usual size');
  // one character short in each part
  kept([jwtPart(9, 1), jwtPart(10, 2), chars(10, B64URL, 3)].join('.'), 'first part 9');
  kept([jwtPart(10, 1), jwtPart(9, 2), chars(10, B64URL, 3)].join('.'), 'second part 9');
  kept([jwtPart(10, 1), jwtPart(10, 2), chars(9, B64URL, 3)].join('.'), 'third part 9');
  // two parts, or a second part that does not start like JSON
  kept([jwtPart(12, 1), jwtPart(12, 2)].join('.'), 'two parts');
  kept([jwtPart(12, 1), chars(12, LOWER, 2), chars(12, B64URL, 3)].join('.'), 'the second part is not JSON');
  // only at a token start
  kept(cat('x', jwt), 'glued to a letter');
});

test('D36: Bearer and 16 or more token characters with a digit; the word stays', () => {
  const tok = withDigit(16, LETTERS);
  masked(['Bearer', tok].join(' '), ['Bearer', M].join(' '));
  masked(['bearer', tok].join(' '), ['bearer', M].join(' '), 'letter case ignored');
  masked(['curl -H Bearer', `${tok}==`, 'now'].join(' '), ['curl -H Bearer', M, 'now'].join(' '), 'base64 padding is part of it');
  kept(['Bearer', withDigit(15, LETTERS)].join(' '), '15 characters');
  kept(['Bearer', chars(24, LETTERS)].join(' '), 'no digit');
  kept('Bearer tokens are sent in a header', 'prose');
  kept(['forBearer', tok].join(' '), 'the word is glued to another');
});

test('D36: the value of an Authorization header after its scheme, and of an x-api-key header', () => {
  const v = withDigit(12, LOWER); // short, with one digit: only the header rule can take it
  const word = chars(12, LOWER); // letters only: a credential behind a known scheme, prose anywhere else
  const auth = ['Author', 'ization'].join('');
  const key = ['x-api', '-key'].join('');
  masked(`${auth}: Basic ${v}`, `${auth}: Basic ${M}`);
  masked(`${auth}: Bearer ${v}`, `${auth}: Bearer ${M}`);
  masked(`${auth}: ${v}`, `${auth}: ${M}`, 'no scheme');
  masked(`${auth.toLowerCase()}:Token ${v}`, `${auth.toLowerCase()}:Token ${M}`, 'lower case, no space after the colon');
  masked(`Proxy-${auth}: Basic ${v}`, `Proxy-${auth}: Basic ${M}`);
  masked(`-H '${auth}: Bearer ${v}' -X POST`, `-H '${auth}: Bearer ${M}' -X POST`, 'the closing quote stays');
  masked(`{"${auth}": "Bearer ${v}", "Accept": "x"}`, `{"${auth}": "Bearer ${M}", "Accept": "x"}`, 'JSON headers');
  // a known scheme: the word behind it is the credential, whatever it looks like
  masked(`${auth}: Basic ${word}`, `${auth}: Basic ${M}`);
  // a scheme that is not a known one: a plain word stays, what does not read as a word is masked
  masked(`${auth}: Custom ${v} next`, `${auth}: Custom ${M} next`);
  masked(`${auth}: X7scheme ${word} next`, `${auth}: ${M} ${M} next`, 'a first word that is no plain word: both go');
  // prose behind the name and a colon keeps its words (as a name and a colon do in D37)
  kept(`${auth}: required for all endpoints`);
  kept(`${auth}: header missing, retry later`);
  kept(`401 ${auth}: Required.`);
  kept(`${auth}: 필요합니다`);
  kept(`${key}: required`);
  kept(`${auth}: ${word}`, 'letters only, without a scheme: read as a word');
  masked(`${auth}: ${withDigit(30, B64URL)}. then retry`, `${auth}: ${M} then retry`);
  masked(`${key}: ${v}`, `${key}: ${M}`);
  masked(`${key.toUpperCase()}:${v}`, `${key.toUpperCase()}:${M}`);
  masked(`-H "${key}: ${v}"`, `-H "${key}: ${M}"`);
  // a quote mark inside the value is part of it
  masked(`${key}: ab'cd"ef\`gh next`, `${key}: ${M} next`);
  masked(`${auth}: Basic ab'cd"ef next`, `${auth}: Basic ${M} next`);
  masked(`${auth}: ab'cd next`, `${auth}: ${M} next`);
  // the header name alone, or with nothing after it; a known scheme with nothing behind it is no value
  kept(`the ${auth} header`);
  kept(`send \`${auth}:\` with every call`);
  kept(`${key}: `);
  kept(`## ${auth}`);
  kept(`## ${auth} header`);
  kept(`${auth}: Bearer`);
  kept(`-H '${auth}: Basic' and the rest`);
  // the name as the end of a longer word is another word; behind a hyphen or an underscore it is the header
  for (const word of [`re${auth.toLowerCase()}`, `Pre${auth.toLowerCase()}`, `un${auth.toLowerCase()}`, `my${key}`, `2${key}`]) {
    kept(`${word}: later this week`, word);
    kept(`${word}: Basic ${v}`, word);
  }
  masked(`HTTP_${auth.toUpperCase()}: Basic ${v}`, `HTTP_${auth.toUpperCase()}: Basic ${M}`);
  masked(`my-${key}: ${v}`, `my-${key}: ${M}`);
  masked(`x\u0000${auth}: Basic ${v}`, `x\u0000${auth}: Basic ${M}`, 'a mark in front of the name is a start');
});

test('D36: a PEM private key, from its BEGIN line through its END line', () => {
  for (const label of [[], ['RSA'], ['EC'], ['OPENSSH'], ['ENCRYPTED']]) {
    const block = [PEM_BEGIN(label), ...pemBody(), PEM_END(label)];
    masked(block.join('\n'), M, `${label.join(' ') || 'plain'}: lines`);
    masked(block.join(' '), M, `${label.join(' ') || 'plain'}: flattened to one line`);
    masked(block.join('\\n'), M, `${label.join(' ') || 'plain'}: as a JSON string`);
    masked(`key:\n${block.join('\n')}\ndone`, `key:\n${M}\ndone`, 'what is around it stays');
  }
});

test('D36: a PEM private key whose end is not in the text is masked through the key text that follows', () => {
  const begin = PEM_BEGIN(['RSA']);
  masked([begin, ...pemBody(2)].join('\n'), M);
  masked(begin, M, 'the BEGIN line alone');
  masked(`see ${[begin, ...pemBody(2)].join(' ')}`, `see ${M}`);
  // a public key or a certificate is not a private key
  kept(['-----BEGIN', 'PUBLIC', 'KEY-----'].join(' '));
  kept(['-----BEGIN', 'CERTIFICATE-----'].join(' '));
});

// --------------------------------------------------------------------------------------------- D37

const eq = (name, value) => [name, value].join('=');
const json = (name, value) => JSON.stringify({ [name]: value }).replace('":"', '": "').slice(1, -1); // "name": "value"
const inString = (text) => JSON.stringify(text).slice(1, -1); // as it stands inside a JSON string: quotes escaped

test('D37: name and value with only "=" between them, for every listed ending', () => {
  const v = chars(9, LOWER);
  for (const end of NAME_ENDS) {
    masked(eq(end, v), eq(end, M), end);
    masked(eq(end.toUpperCase(), v), eq(end.toUpperCase(), M), `${end}: upper case`);
    masked(eq(`OPENAI_${end.toUpperCase()}`, v), eq(`OPENAI_${end.toUpperCase()}`, M), `${end}: a prefix before it`);
    masked(`run --${eq(end, v)} now`, `run --${eq(end, M)} now`, `${end}: an option`);
    masked(`export ${eq(`MY.${end}`, v)}; next`, `export ${eq(`MY.${end}`, M)} next`, `${end}: the value runs to the white space`);
  }
});

test('D37: a quoted value is masked inside its quotes', () => {
  const v = `${chars(5, LOWER)} ${chars(5, LOWER, 2)}`;
  const name = NAME_ENDS[0];
  masked(eq(name, `"${v}"`), eq(name, `"${M}"`));
  masked(eq(name, `'${v}'`), eq(name, `'${M}'`));
  masked(`${eq(name, `"${v}"`)} --user x`, `${eq(name, `"${M}"`)} --user x`);
  masked(eq(name, `"${v}`), eq(name, `"${M}`), 'the closing quote is not in the text');
  masked(eq(name, `\\"${v}\\"`), eq(name, `\\"${M}\\"`), 'escaped quotes inside a JSON string');
  kept(eq(name, '""'), 'an empty value');
  // a quote mark ends a bare value only where it closes something: in front of a letter or a digit it is part of
  // the value, so no tail of the value stays in view
  for (const q of ["'", '"', '`']) {
    masked(eq(name, `abc${q}def`), eq(name, M), `a ${q} inside a bare value`);
    masked(eq(name, `abc${q}7x${q}z end`), `${eq(name, M)} end`, `two of ${q} inside a bare value`);
    masked(`run ${q}--${eq(name, 'abc')}${q} now`, `run ${q}--${eq(name, M)}${q} now`, `a closing ${q} stays`);
    masked(`(${q}${eq(name, 'abc')}${q}).`, `(${q}${eq(name, M)}${q}).`, `a closing ${q} in front of a bracket`);
  }
  masked(eq(name, "'abc'def ghi"), `${eq(name, M)} ghi`, 'a quoted value with more glued to its closing quote');
  masked(eq(name, '"abc"def"gh" ij'), `${eq(name, M)}" ij`, 'and with more quotes behind it');
  // a query parameter of a URL: the punctuation that ends the sentence around the URL stays outside
  masked(`/v1/login?${eq(name, 'abc')}, then`, `/v1/login?${eq(name, M)}, then`);
  masked(`/v1/login?a=1&${eq(name, 'abc')}?`, `/v1/login?a=1&${eq(name, M)}?`);
  masked(`(/v1/login?${eq(name, 'abc')}).`, `(/v1/login?${eq(name, M)}).`);
  masked(`(/v1/login?${eq(name, M)}).`, `(/v1/login?${eq(name, M)}).`, 'a second pass leaves the marker whole');
  kept(`${name}=`, 'no value');
  kept(`${name}= x`, 'white space after the sign');
});

test('D37: a name and its sign that are only named inside quotes have no value', () => {
  for (const end of NAME_ENDS) {
    for (const q of ['"', "'"]) {
      const mention = cat(q, eq(end, ''), q);
      kept(`the ${mention} parameter is missing from the address, please add it`, `${end} in ${q}`);
      kept(`grep -rn ${mention} src/ --include=*.js`, `${end} in ${q}: a command line`);
      kept(`expect(url).toContain(${mention});`, `${end} in ${q}: a line of code`);
      kept(`look for ${cat(q, '?', eq(end, ''), q)} or ${cat(q, '&', eq(end, ''), q)}, and for ${cat(q, '--', eq(end, ''), q)}.`, `${end} in ${q}: behind ? & --`);
      kept(`it ends with ${mention}`, `${end} in ${q}: at the end of the text`);
    }
    kept(`a JSON string: "the ${cat('\\"', eq(end, ''), '\\"')} part"`, `${end}: escaped quotes`);
  }
  // a value in quotes is still a value: the quote behind the sign opens it
  const v = chars(9, LOWER);
  const name = NAME_ENDS[0];
  masked(`"${eq(name, `"${v}"`)} next`, `"${eq(name, `"${M}"`)} next`, 'the same quote in front of the name, and a value');
  masked(`'${eq(name, `'${v} ${v}'`)}`, `'${eq(name, `'${M}'`)}`);
  masked(`run ${eq(name, `"${v}"`)} now`, `run ${eq(name, `"${M}"`)} now`, 'no quote in front of the name');
  masked(`x '${eq(name, '"')} ${v}`, `x '${eq(name, `"${M}`)}`, 'a quote of another kind in front of the name that does not come again behind the sign: an unclosed value');
  kept(`put '${eq(name, '"')}' in front of the value and close it`, 'a mention with nested quotes keeps the rest of the sentence');
  kept(`x "${eq(name, '"')} ${v}`, 'the same quote on both sides: what follows the space is not its value');
});

test('D37: the JSON form, for every listed ending', () => {
  const v = `${chars(6, LOWER)} ${chars(6, LOWER, 2)}`;
  for (const end of NAME_ENDS) {
    masked(json(end, v), json(end, M), end);
    masked(`{${json(`client_${end}`, v)}, "n": 1}`, `{${json(`client_${end}`, M)}, "n": 1}`, `${end}: inside an object`);
    masked(json(end, v).replace('": "', '":"'), json(end, M).replace('": "', '":"'), `${end}: no space`);
    masked(inString(json(end, v)), inString(json(end, M)), `${end}: escaped quotes`);
  }
  masked(`{${json(NAME_ENDS[4], v).slice(0, -3)}`, `{${json(NAME_ENDS[4], M).slice(0, -1)}`, 'the closing quote is not in the text');
  // a value that is not a string is not that form
  kept('{"token": 1532}');
  kept('{"token": null, "secret": true}');
});

test('D37: not masked: name, colon and value in prose; a name that only contains such a word; spaces around the sign', () => {
  for (const text of [
    'Token: expired, retrying',
    'Password: see the vault entry',
    'total_tokens=1532',
    'max_tokens=4096',
    'tokenizer=x',
    'token_count=5',
    'passwordless=true',
    'secrets=3 found',
    'secretary=Kim',
    'pwd_dir=build',
    'apikeys=2',
    'the token = the value',
    'if (token==null) return',
    'const read = (token)=>token.id',
    'token!=old',
  ]) kept(text, text);
});

// --------------------------------------------------------------------------------------------- D38

test('D38: never masked: hashes, uuids, plain base64 and hex, file names, versions, kebab-case names, Korean text', () => {
  const hex = (n, seed) => chars(n, `${DIGITS}abcdef`, seed);
  for (const text of [
    `commit ${hex(40, 1)}`,
    `at ${hex(7, 2)} (HEAD)`,
    `sha256:${hex(64, 3)}`,
    [hex(8, 4), hex(4, 5), hex(4, 6), hex(4, 7), hex(12, 8)].join('-'),
    `${chars(64, `${ALNUM}+/`, 9)}==`,
    chars(86, B64URL, 10),
    'secret-mask.mjs',
    'token-utils.test.mjs · passwords.txt · api-key-rotation.md',
    'src/session-recap.mjs L10-40',
    'v0.12.0 -> 1.2.3-beta.4 (node 24.13.0)',
    'three@0.160.0',
    // kebab-case names that start like a prefix
    'sk-button-group-primary-large-outline',
    'sk-learn-pipeline-builder-utils',
    'xoxo-gossip-column-weekly',
    'hf-transformers-tokenizer-fast',
    'npm-package-arg',
    'glpat-reader-notes',
    'gh-pages-deploy-action',
    // names with an underscore that start like a prefix but are too short or the wrong alphabet
    'npm_config_registry',
    'ghp_readme',
    'hf_hub_download',
    'sk_test_mode',
    'AKIA is the access key prefix',
    '이 토큰은 만료되었습니다. 비밀번호를 다시 설정하세요.',
    '토큰 갱신 로직 정리',
    'Read the token count from the usage record',
    'The password field needs a label',
    'key=value pairs in the query',
    'a=b&c=d',
    'feat/glo-1250-secret-mask',
    'mcp__github__get_pull_request',
    '',
  ]) kept(text, text);
});

test('D35 before D38: a kebab-case name that has one of the prefixed shapes is masked', () => {
  // 20 or more characters behind `sk-` with a digit among them, whatever the words are
  masked(cat('sk-', 'button-group-v2-primary-large'), M);
  masked(cat('sk-', 'ant-', 'design-tokens-for-the-dark-theme'), M);
  masked(cat('xoxo', '-gossip-column-week-12'), M);
  masked(cat('gl', 'pat-reader-notes-for-the-release'), M);
  // without the digit, or shorter, they are names
  kept(cat('sk-', 'button-group-primary-large'));
  kept(cat('sk-', 'btn-v2'));
  kept(cat('xoxo', '-gossip-column-weekly'));
  kept(cat('gl', 'pat-reader-notes'));
});

/** String literals of a JavaScript source text ('...', "...", `...`), comments skipped. */
function stringLiterals(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out.push(src.slice(i + 1, j));
      i = j;
    }
  }
  return out;
}

test('D38: every string of the built-in demo (public/js/sources.js) comes back unchanged', () => {
  const src = fs.readFileSync(new URL('../public/js/sources.js', import.meta.url), 'utf8');
  const literals = stringLiterals(src);
  assert.ok(literals.length > 300, `string literals found: ${literals.length}`);
  assert.ok(literals.includes('AskUserQuestion') && literals.includes('pending'), 'the scanner reads the file');
  for (const lit of literals) kept(lit, `demo string: ${lit.slice(0, 40)}`);
  // and the file line by line (a string the scanner split wrongly would still be on its line)
  for (const line of src.split('\n')) kept(line, `demo line: ${line.slice(0, 40)}`);
});

// --------------------------------------------------------------------------------------------- the whole mask

function everySample() {
  const v = chars(9, LOWER);
  const tok = withDigit(20, LETTERS);
  const auth = ['Author', 'ization'].join('');
  return [
    ...PREFIXED.map((row) => cat(row.prefix, tailOf(row, row.min))),
    [jwtPart(14, 1), jwtPart(20, 2), chars(22, B64URL, 3)].join('.'),
    ['Bearer', tok].join(' '),
    `${auth}: Basic ${v}`,
    `${auth}: ${withDigit(12, LOWER)}`, // without a scheme a plain word is prose: the value needs more than letters
    `${['x-api', '-key'].join('')}: ${withDigit(12, LOWER)}`,
    [PEM_BEGIN(['RSA']), ...pemBody(), PEM_END(['RSA'])].join('\n'),
    [PEM_BEGIN([]), ...pemBody(2)].join(' '),
    ...NAME_ENDS.flatMap((end) => [eq(end, v), eq(end, `"${v} ${v}"`), json(end, v), inString(json(end, v))]),
  ];
}

test('masking twice gives the same text as masking once', () => {
  const samples = everySample();
  for (const s of samples) {
    const once = maskSecrets(s);
    assert.notEqual(once, s, `masked at all: ${s.slice(0, 12)}`);
    assert.ok(once.includes(M));
    assert.equal(maskSecrets(once), once, `twice: ${once}`);
  }
  const all = samples.join(' and ');
  const once = maskSecrets(all);
  assert.equal(maskSecrets(once), once);
  for (const sep of ['\n', ', ', '; ', ' | ']) {
    const text = maskSecrets(samples.join(sep));
    assert.equal(maskSecrets(text), text, `joined by ${JSON.stringify(sep)}`);
  }
});

test('shapes glued to each other and to other text: one more masking still changes nothing, and no sample is left', () => {
  // the same compositions on every run: samples, name words, quotes and punctuation joined without a rule
  let seed = 4242;
  const rnd = (n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  const pick = (list) => list[rnd(list.length)];
  const samples = everySample();
  const glue = [' ', '', '', '\n', ',', ';', ':', '=', '"', "'", '`', '/', '.', ')', '&', '?', 'x', '7', '-', '_', 'and', '=>', ': "', M, '키'];
  const names = NAME_ENDS.map((end) => `${pick(['', 'MY_', '--', '?', '&', '"'])}${end}`);
  for (let i = 0; i < 4000; i++) {
    const parts = Array.from({ length: 2 + rnd(6) }, () => pick([pick(samples), pick(samples), pick(names), pick(glue), pick(glue)]));
    const text = parts.join(pick(['', '', ' ', ',', '=', ':']));
    const once = maskSecrets(text);
    assert.equal(maskSecrets(once), once, `twice: ${JSON.stringify(once)}`);
  }
  // a quote mark inside a value: neither side of it stays in view, whatever stands around it
  for (let i = 0; i < 3000; i++) {
    const a = chars(6 + rnd(6), ALNUM, 500 + i);
    const b = chars(8 + rnd(6), ALNUM, 900 + i);
    const lead = pick([
      eq(pick(names), ''), `${eq(pick(NAME_ENDS), '')}${pick(["'", '"'])}`, `${['x-api', '-key'].join('')}: `,
      `${['Author', 'ization'].join('')}: ${pick(['', 'Basic ', 'Bearer ', 'Custom '])}`,
    ]);
    const text = `${pick(['', 'run ', '(', '"'])}${lead}${a}${pick(["'", '"', '`', "''", '"\'', '\\"'])}${b}${pick(['', ' ', ' next', ') and', '" x', "' y", ', z', '\n'])}`;
    const out = maskSecrets(text);
    assert.equal(out.includes(a) || out.includes(b), false, `a side of the value is shown: ${JSON.stringify(out)}`);
    assert.equal(maskSecrets(out), out);
  }
  // a prefixed token that stands alone between two other shapes is never left in part
  const gh = cat('gh', 'p_', chars(36, ALNUM));
  for (const s of samples) {
    const out = maskSecrets(`${s} ${gh} ${s}`);
    assert.equal(out.includes(gh.slice(4, 16)), false, `the token between two samples: ${out.slice(0, 60)}`);
  }
});

test('odd inputs: never throws, non-strings come back as they are', () => {
  for (const v of [undefined, null, 0, 42, true, {}, [], Symbol.iterator, () => {}]) assert.equal(maskSecrets(v), v);
  assert.equal(maskSecrets(''), '');
  assert.equal(maskSecrets('\u0000'), '\u0000');
  assert.equal(maskSecrets('\uD83D'), '\uD83D', 'a lone surrogate');
  assert.equal(maskSecrets('='), '=');
  assert.equal(maskSecrets('"": ""'), '"": ""');
  assert.equal(maskSecrets('Bearer'), 'Bearer');
});

test('D39: long and hostile inputs stay fast (a generous bound: only a runaway match would miss it)', () => {
  const N = 4000;
  const starts = [
    ...PREFIXED.map((r) => r.prefix), cat('ey', 'J'), 'Bearer ', 'bearer', ['Author', 'ization'].join(''), `${['Author', 'ization'].join('')}: `,
    ['x-api', '-key'].join(''), '-----BEGIN ', PEM_BEGIN(['RSA']), `${PEM_BEGIN([])}\n`, '=', '==', 'a=', 'token', eq('token', ''), eq('token', 'a '),
    cat('"token"', ': "'), '": "', '":', '\\"', '"', "'", ':', '.', cat('ey', 'J', 'a.'), `${chars(10, B64URL)}.`,
  ];
  const inputs = [
    ...starts.map((p) => p.repeat(N)),
    ...starts.map((p) => `${p} `.repeat(N)),
    ...[LOWER, UPPER, DIGITS, '-', '_', '=', '.', '/', '+', ' ', '\n', '"', '가'].map((c) => c[0].repeat(1024)),
    ...['a', 'A', '0', '-', '_', '='].map((c) => c.repeat(200_000)),
    `${chars(1024, B64URL)} `.repeat(200),
    ...["'", '"', '`', "'\\", '\\"'].flatMap((q) => [`${eq('token', '')}${q.repeat(100_000)}x`, `${eq('token', 'a')}${`${q}b`.repeat(50_000)}`]),
    'An ordinary sentence about the build, the tests and the release notes. '.repeat(3000),
    // the caller's marks: between all characters of a long text, and in front of every prefix, name and quote
    `${'\u0000a'.repeat(100_000)} ${eq('token', 'x')}`,
    ...starts.map((p) => `\u0000${p}`.repeat(N)),
    ...starts.map((p) => Array.from(p).join('\u0000').repeat(N)),
  ];
  const t0 = performance.now();
  for (const input of inputs) {
    const once = maskSecrets(input);
    assert.equal(typeof once, 'string');
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 5000, `masking ${inputs.length} hostile inputs took ${Math.round(ms)} ms`);
});

test('D34: the mask is called from scrub() of summarize.mjs only, first and last, and has no import of its own', () => {
  const root = new URL('../src/', import.meta.url);
  const files = fs.readdirSync(root, { recursive: true }).filter((f) => f.endsWith('.mjs')).map((f) => f.split('\\').join('/'));
  assert.ok(files.length > 60 && files.includes('adapters/grok/desktop-bot.mjs'), 'the whole src tree is read');
  const users = files.filter((f) => f !== 'secret-mask.mjs' && /secret-mask\.mjs|maskSecrets/.test(fs.readFileSync(new URL(f, root), 'utf8')));
  assert.deepEqual(users, ['summarize.mjs']);
  const summarize = fs.readFileSync(new URL('summarize.mjs', root), 'utf8');
  const body = summarize.slice(summarize.indexOf('function scrub(s) {'), summarize.indexOf('const SCRUB_LIMIT'));
  assert.equal(summarize.split('maskSecrets(').length - 1, body.split('maskSecrets(').length - 1, 'every call is inside scrub()');
  assert.match(body, /^function scrub\(s\) \{\n {2}const view = tidy\(s\);\n {2}const masked = maskSecrets\(view\);\n/, 'first: on the text as the page gets it');
  assert.match(body, /const seen = tidy\(out\);[^\n]*\n {2}const again = maskSecrets\(seen\);\n {2}return again === seen \? out : again;\n\}/, 'last: once more, on the result');
  assert.doesNotMatch(fs.readFileSync(new URL('secret-mask.mjs', root), 'utf8'), /^\s*import\s|\bimport\(|require\(/m, 'a pure module');
});
