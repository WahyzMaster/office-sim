// What a canary sweep and a review found after the first two rounds of the secret mask (launch readiness W10,
// D33 to D39; CONTRACT 5), each as the text looked when it got through. Everything goes through cleanText, the
// function every event text uses. Samples are built when the test runs (D39).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText } from '../src/summarize.mjs';
import { SECRET_MARKER as M } from '../src/secret-mask.mjs';
import {
  chars, withDigit, LOWER, LETTERS, ALNUM, PREFIXED, tailOf, AUTH_HEADER as AUTH, KEY_HEADER as KEY, NAME_ENDS, jwtPart, pemBegin, pemBody,
} from './fixtures/secret-samples.mjs';

const BS = '\\';
const cred = (seed) => withDigit(14, LETTERS, seed); // short, mixed case, one digit: only a header or name rule can take it
const gh = PREFIXED.find((r) => r.name === 'ghp_');
const ghToken = (seed) => [gh.prefix, tailOf(gh, 36, { seed })].join('');
const bearerToken = (seed) => withDigit(28, ALNUM, seed);
const jwt = (seed) => [jwtPart(18, seed), jwtPart(26, seed + 1), chars(30, ALNUM, seed + 2)].join('.');

/** cleanText of `text`; none of `hidden` (nor an 8-character piece of it) may be left, and the marker must be there. */
function gone(text, hidden, why) {
  const out = cleanText(text, 400);
  for (const h of hidden) {
    for (const piece of [h, h.slice(0, 8), h.slice(-8)]) assert.equal(out.includes(piece), false, `${why}: a piece of the value is in ${JSON.stringify(out)}`);
  }
  assert.ok(out.includes(M), `${why}: no marker in ${JSON.stringify(out)}`);
  return out;
}

test('two header lines: the name of the second is not taken for the value of the first', () => {
  const [a, b] = [cred(1), cred(2)];
  gone(`${AUTH}: ${a}\n${KEY}: ${b}`, [a, b], 'no scheme, then the key header');
  gone(`${KEY}: ${a}\n${AUTH}: Basic ${b}`, [a, b], 'the key header first');
  gone(`${AUTH}: Bearer\n${KEY}: ${b}`, [b], 'a scheme with nothing behind it, then the key header');
  gone(`${AUTH}: Basic\n${AUTH}: Basic ${b}`, [b], 'the same header twice');
  gone(`${AUTH}: Basic ${a},${KEY}: ${b}`, [a, b], 'two headers joined by a comma');
  gone(`${AUTH}: ${a}\nContent-Type: text/plain\n${KEY}: ${b}`, [a, b], 'another header between them');
});

test('a JSON-escaped dump: a written-out line break in front of a shape is a boundary', () => {
  const [a, tok] = [cred(3), bearerToken(4)];
  for (const esc of [`${BS}n`, `${BS}r${BS}n`, `${BS}t`]) {
    gone(`"GET / HTTP/1.1${esc}${AUTH}: Basic ${a}${esc}Accept: x"`, [a], `${esc} in front of the header name`);
    gone(`"${esc}${KEY}: ${a}"`, [a], `${esc} in front of the key header`);
    gone(`"${esc}Bearer ${tok}"`, [tok], `${esc} in front of Bearer`);
    gone(`"body${esc}${jwt(5)}"`, [jwt(5).split('.')[2]], `${esc} in front of a JSON Web Token`);
    gone(`"KEYS${esc}${ghToken(6)}"`, [ghToken(6).slice(gh.prefix.length)], `${esc} in front of a prefixed token`);
  }
});

test('a PEM private key whose END line is not in the text is masked to the end, whatever stands between its lines', () => {
  const body = pemBody(4);
  const legacy = [pemBegin(['RSA']), 'Proc-Type: 4,ENCRYPTED', `DEK-Info: AES-256-CBC,${chars(32, '0123456789ABCDEF', 9)}`, '', ...body].join('\n');
  gone(legacy, body, 'the legacy encrypted layout (two header lines and an empty line)');
  gone([pemBegin([]), ...body.map((l) => `> ${l}`)].join('\n'), body, 'lines quoted with a greater-than sign');
  gone(`key = "${pemBegin(['EC'])}${BS}n" +\n  "${body[0]}${BS}n" +\n  "${body[1]}${BS}n"`, body.slice(0, 2), 'concatenated code strings');
  gone(JSON.stringify([pemBegin([]), ...body]), body, 'a JSON array of lines');
});

test('markdown and brackets around a header do not hide its value', () => {
  const a = cred(11);
  gone(`**${AUTH}**: Basic ${a}`, [a], 'a bold header name');
  gone(`\`${AUTH}\`: Basic ${a}`, [a], 'a header name in a code span');
  gone(`__${KEY}__: ${a}`, [a], 'an underlined key header name');
  gone(`${AUTH}: \`Basic ${a}\``, [a], 'a code span around the value');
  gone(`${AUTH}: [Basic ${a}]`, [a], 'square brackets around the value');
  gone(`map[${AUTH}:[Basic ${a}] Accept:[x]]`, [a], 'the way Go prints a header map');
  gone(`headers = { ${AUTH}: \`Basic ${a}\` }`, [a], 'a template literal');
  gone(`${AUTH}: (Basic ${a})`, [a], 'parentheses');
  gone(`${AUTH}: <Basic ${a}>`, [a], 'angle brackets');
});

test('a backslash and a line break where a shape has its space (a wrapped command line)', () => {
  const [tok, v] = [bearerToken(12), cred(13)];
  gone(`curl -H "${AUTH}: Bearer ${BS}\n  ${tok}" host`, [tok], 'behind the scheme of a header');
  gone(`Bearer ${BS}\n${tok}`, [tok], 'behind the word Bearer');
  gone(['export API_TOKEN', `${BS}\n${v}`].join('='), [v], 'behind the sign of a name'); // joined here: no sample in this file (D39)
});

test('pieces that a later rule puts together are masked too', () => {
  const tok = bearerToken(14);
  const tail = tailOf(gh, 36, { seed: 15 });
  gone(`Bearer file:///srv/keys/${tok}`, [tok], 'Bearer and a file URL whose last name is the token');
  gone(`${gh.prefix}/srv/keys/${tail}`, [tail], 'a prefix glued to a path whose last name is the tail');
});

test('a value in quotes inside quotes of another kind is a value, not a mention', () => {
  const name = NAME_ENDS[0].toUpperCase();
  for (const first of ['!', ')', ']', '}', '>', '<', ',', ';', ':', '.', '?', '&', '|', ' ']) {
    const v = `${first}${chars(9, LOWER, 21)}`;
    gone(`ssh host 'export ${name}="${v}"; run'`, [v.slice(1)], `a double-quoted value that starts with ${JSON.stringify(first)} inside single quotes`);
    gone(`ssh host '${name}="${v}" run'`, [v.slice(1)], `the same with the single quote directly in front of the name`);
    gone(`sh -c "${name}='${v}' run"`, [v.slice(1)], `a single-quoted value that starts with ${JSON.stringify(first)} inside double quotes`);
    gone(`run \`${name}="${v}"\` now`, [v.slice(1)], `the same behind a backtick`);
  }
  const v = chars(9, LOWER, 22);
  gone(`x '${name}=" ${v}`, [v], 'a quote of another kind in front of the name, an unclosed value behind the sign');
  // a mention still has no value: the quote in front of the name comes again right behind the sign
  for (const text of [`put '${name}="' in front of the value`, `the "${name}=" parameter`, `grep '${name}=' src`, `look for \`${name}=\` here`]) {
    assert.equal(cleanText(text, 400), text);
  }
  gone(`${name}=") ${v}`, [v], 'no quote in front of the name: not a mention');
});

test('a text with no listed shape comes out as it did before the mask existed (paths with deleted characters inside)', () => {
  // The other rules read such a text exactly as before: a deleted character inside a path never splits it. These rows
  // are the outputs of the scrub as it was; they must not show more of a path than its last name.
  const zw = '​';
  assert.equal(cleanText(`open C:${BS}Users${BS}${zw}me${BS}proj${BS}file.txt now`, 200), 'open file.txt now');
  assert.equal(cleanText(`open C:${BS}${zw}Users${BS}${zw}me${BS}${zw}file.txt now`, 200), 'open file.txt now');
  assert.equal(cleanText(`open /Users/me${zw}/proj${zw}/file.txt now`, 200), 'open file.txt now');
  assert.equal(cleanText(`open ~/work⁠/sub/‎file.txt now`, 200), 'open file.txt now');
  assert.equal(cleanText(`open ${BS}${BS}server${BS}share${BS}${zw}dir${BS}file.txt now`, 200), 'open file.txt now');
  assert.equal(cleanText(`dir C:${BS}Users${BS}me${BS}proj${BS}\nnext line`, 200), 'dir proj next line');
});

test('the plain-word rule of the header: its bounds, one by one', () => {
  const kept = (text, why) => assert.equal(cleanText(text, 400), text, why);
  const lower = (n, seed) => chars(n, LOWER, seed);
  for (const head of [AUTH, KEY]) {
    kept(`${head}: ${lower(15, 31)}`, '15 lower-case letters read as a word');
    gone(`${head}: ${lower(16, 32)}`, [lower(16, 32)], '16 letters are no plain word');
    gone(`${head}: ${lower(5, 33)}${lower(4, 34).toUpperCase()}${lower(3, 35)}`, [lower(4, 34).toUpperCase()], 'a capital behind the first letter');
    gone(`${head}: ${lower(10, 36).toUpperCase()}`, [lower(10, 36).toUpperCase()], 'capitals only');
    gone(`${head}: 7${lower(9, 37)}`, [lower(9, 37)], 'a digit as first character');
    gone(`${head}: ${lower(4, 38)}_${lower(4, 39)}`, [lower(4, 39)], 'an underscore');
    kept(`${head}: ${lower(8, 40)}...`, 'three sentence marks behind a word');
    gone(`${head}: ${lower(8, 41)}....`, [lower(8, 41)], 'four are no sentence punctuation');
  }
  gone(`${AUTH}: Custom ${lower(4, 42)}${lower(4, 43).toUpperCase()}`, [lower(4, 43).toUpperCase()], 'behind an unlisted scheme word, a second word with capitals');
  kept(`${AUTH}: custom ${lower(8, 44)} here`, 'two plain words are prose');
});

test('the address rule and the marker: a host without a dot is left alone', () => {
  const local = ghToken(51);
  assert.equal(cleanText(`run ${local}@localhost now`, 200), `run ${M}@localhost now`);
  assert.equal(cleanText(`run ${local}@corp.example now`, 200), 'run (email) now');
});

// ---- found by the check of the fixes above ----

test('the colon inside the emphasis, an opener with a space behind it, and emphasis closed behind the scheme', () => {
  const a = cred(61);
  gone(`**${AUTH}:** Basic ${a}`, [a], 'a bold label with the colon inside');
  gone(`*${AUTH}:* Basic ${a}`, [a], 'an italic label');
  gone(`__${KEY}:__ ${a}`, [a], 'an underlined key label');
  gone(`\`${AUTH}:\` Basic ${a}`, [a], 'a code span that ends behind the colon');
  gone(`${AUTH}: [ Basic ${a} ]`, [a], 'a bracket and a space in front of the scheme');
  gone(`${AUTH}:" Basic ${a}"`, [a], 'a quote directly behind the colon');
  gone(`${AUTH}: **Basic** ${a}`, [a], 'the scheme in bold');
  gone(`${AUTH}: _Bearer_ ${a}`, [a], 'the scheme in italics');
  // up to four marks on each side are stepped over; five are not (CONTRACT 5 names the limit)
  gone(`***${AUTH}***: Basic ${a}`, [a], 'three marks');
  gone(`****${AUTH}****: Basic ${a}`, [a], 'four marks');
  assert.ok(cleanText(`*****${AUTH}*****: Basic ${a}`, 400).includes(a), 'five marks hide the colon: the documented limit');
});

test('a credential with a colon behind it is masked; the name of another header at the start of the next line is kept', () => {
  const a = cred(62);
  gone(`${AUTH}: Bearer ${a}: 401 Unauthorized`, [a], 'a log line that goes on behind a colon');
  gone(`${AUTH}: Custom ${a}:`, [a], 'behind a word that has the shape of a scheme, at the end of the text');
  assert.equal(cleanText(`${AUTH}: Bearer\nContent-Type: text`, 400), `${AUTH}: Bearer Content-Type: text`, 'a scheme with nothing behind it, then another header');
  gone(`${KEY}: my${AUTH.toLowerCase()}key7`, [`my${AUTH.toLowerCase()}key7`], 'the letters of a header name inside a value do not end it');
});

test('the last look reads the result as the page gets it: a break or a deleted character between the pieces', () => {
  const tok = bearerToken(63);
  for (const [name, gap] of [['a line break', '\n'], ['CR LF', '\r\n'], ['a no-break space', '\u00a0'], ['an ideographic space', '\u3000'], ['nine spaces', ' '.repeat(9)]]) {
    gone(`Bearer${gap}file:///srv/keys/${tok}`, [tok], `${name} between Bearer and a file URL`);
    gone(`Bearer${gap}C:${BS}keys${BS}${tok}`, [tok], `${name} between Bearer and a Windows path`);
  }
  for (const [name, gone1] of [['a zero-width space', '\u200b'], ['a control character', '\u0007'], ['a bidi mark', '\u200e'], ['a lone surrogate', '\ud83d']]) {
    const out = cleanText(`Bearer file:///srv/keys/${tok.slice(0, 9)}${gone1}${tok.slice(9)}`, 400);
    assert.equal(out.includes(tok), false, `${name} inside the token: ${JSON.stringify(out)}`);
  }
});

test('a value in escaped quotes inside quotes of the same kind is a value', () => {
  const name = NAME_ENDS[0].toUpperCase();
  for (const first of ['.', '!', ')', ',', ':', ' ']) {
    const v = `${first}${chars(9, LOWER, 64)}`;
    gone(`{"cmd": "${name}=${BS}"${v}${BS}" run"}`, [v.slice(1)], `a JSON command field, the value starts with ${JSON.stringify(first)}`);
  }
  const mention = `a JSON string: "the ${BS}"${name}=${BS}" part"`;
  assert.equal(cleanText(mention, 400), mention, 'escaped on both sides: still a mention');
});

test('in a text with a listed shape, a deleted character behind a backslash does not show a Windows or UNC path', () => {
  const v = cred(65);
  const shape = ['DEPLOY_TOKEN', v].join('=');
  const masked = ['DEPLOY_TOKEN', M].join('='); // joined here: no sample in this file (D39)
  for (const zw of ['\u200b', '\u2060', '\u200e']) {
    assert.equal(cleanText(`${shape} open C:${BS}Users${BS}${zw}me${BS}proj${BS}file.txt now`, 400), `${masked} open file.txt now`);
    assert.equal(cleanText(`${shape} open ${BS}${BS}server${BS}share${BS}${zw}dir${BS}file.txt now`, 400), `${masked} open file.txt now`);
  }
});
