// Secret mask (launch readiness W10, decisions D33 to D39; CONTRACT 5). Pure, no imports.
//
// A net, not a detector: a fixed list of shapes is replaced by SECRET_MARKER, and every other text comes back as it
// was written. A secret of any other shape is not seen.
//
// Not a general-purpose function. Its one caller is scrub() in summarize.mjs, which runs it first, on a text that
// clean() has cut to 1,024 characters and tidied: what the page never gets (colour codes, control and zero-width
// characters, lone surrogates) is out and white space is one space. A text that has to be masked goes through
// cleanText, never straight to this function. It never throws; a value that is not a string comes back as it is.
//
// MARK: where clean() took characters out it leaves one MARK. The mask reads the text without the marks, because
// that is what the page gets (a token with a colour code in it is one token there), takes a mark for a token start,
// and puts back the marks outside what it replaced (the path rule of scrub() needs them).
//
// Cost: a text with no candidate pays for one search for MARK and one test of HINT_RE. Every scanner walks forward,
// rejects a candidate that is not at a token start in constant time, goes on behind what it masked and walks a run
// of characters once (runOf). The regular expressions find fixed words or one bounded run; lengths are counted in
// loops. The passes repeat until the text no longer changes (a text with a shape in it takes two), so masking a
// masked text again changes nothing.

export const SECRET_MARKER = '(secret)';
const [MARK, ELLIPSIS, NO_MARKS] = ['\u0000', '\u2026', new Set()];

// One cheap test for "is there anything to look at": the prefixes of D35, the fixed words of D36, the name words of D37.
const HINT_RE = /sk[-_]|rk_|gh[opusr]_|github_pat_|xox[abeoprs]-|akia|asia|aiza|glpat-|npm_|hf_|eyj|bearer|authorization|x-api-key|-----begin|passw|pwd|secret|token|api[_-]?key|access[_-]key|private[_-]key/i;
const NAME_HINT_RE = /passw|pwd|secret|token|api[_-]?key|access[_-]key|private[_-]key/i;

// --------------------------------------------------------------------------------------------- character classes
const [isDigit, isUpper, isLower] = [(c) => c >= 48 && c <= 57, (c) => c >= 65 && c <= 90, (c) => c >= 97 && c <= 122];
const isAlnum = (c) => isDigit(c) || isUpper(c) || isLower(c);
/** A-Za-z0-9_- : the base64url alphabet, and the characters that may not stand in front of a token (D35). */
const isWord = (c) => isAlnum(c) || c === 95 || c === 45;
const [isAlnumUnderscore, isAlnumHyphen, isUpperDigit] = [(c) => isAlnum(c) || c === 95, (c) => isAlnum(c) || c === 45, (c) => isUpper(c) || isDigit(c)];
/** RFC 6750 token characters: A-Za-z0-9 and - . _ ~ + / = */
const isBearerChar = (c) => isAlnum(c) || c === 45 || c === 46 || c === 95 || c === 126 || c === 43 || c === 47 || c === 61;
const [isBlank, isQuote] = [(c) => c === 32 || c === 9, (c) => c === 34 || c === 39];
const isQuoteMark = (c) => c === 34 || c === 39 || c === 96; // " ' `
const isSpaceOrControl = (c) => c <= 32 || c === 127;
/** What may stand behind a quote that closes something: ) ] } > < , ; : . ! ? & | */
const isCloser = (c) => c === 41 || c === 93 || c === 125 || c === 62 || c === 60 || c === 44 || c === 59 || c === 58 || c === 46 || c === 33 || c === 63 || c === 38 || c === 124;

// The run of `cls` characters from `from`: where it ends, and where its last digit stands (-1: none). `memo` keeps the
// run walked last under `key`: asked again from inside it (marks can make every prefix in one long run a token start),
// it is not walked again, so a pass stays linear.
function runOf(s, from, cls, memo, key = cls) {
  const last = memo.get(key);
  if (last !== undefined && from >= last.from && from <= last.end) return last;
  const run = { from, end: from, digit: -1 };
  for (; run.end < s.length && cls(s.charCodeAt(run.end)); run.end++) if (isDigit(s.charCodeAt(run.end))) run.digit = run.end;
  memo.set(key, run);
  return run;
}

/** Steps over blanks, and over the backslash of a wrapped line (a backslash with a blank behind it). */
function skipBlanks(s, from) {
  let i = from;
  while (i < s.length && i - from < 8 && (isBlank(s.charCodeAt(i)) || (s.charCodeAt(i) === 92 && isBlank(s.charCodeAt(i + 1))))) i++;
  return i;
}

/** Behind a line break or tab written out as two characters (`\n`, `\r`, `\t`: a JSON-escaped dump)? */
const afterEscape = (s, at) => at >= 2 && s.charCodeAt(at - 2) === 92 && [110, 114, 116].includes(s.charCodeAt(at - 1));
// A token start (D35): the beginning of the text, a character before it that is not A-Za-z0-9, "_" or "-", a place
// where the caller took a control character out (`marks`), or a written-out line break or tab in front.
const atTokenStart = (s, at, marks) => at === 0 || !isWord(s.charCodeAt(at - 1)) || marks.has(at) || afterEscape(s, at);

/** The caller's marks taken out of `s`: the text without them, and the places in that text where one stood. */
function unmark(s) {
  const marks = new Set();
  let text = '';
  let from = 0;
  for (let i = s.indexOf(MARK); i >= 0; i = s.indexOf(MARK, from)) {
    text += s.slice(from, i);
    marks.add(text.length);
    from = i + 1;
  }
  return { text: text + s.slice(from), marks };
}

// --------------------------------------------------------------------------------------------- D35: known prefixes
const shape = (cls, min, more = {}) => ({ cls, min, exact: false, digit: false, ...more });
const GITHUB = shape(isAlnum, 30);
const SLACK = shape(isAlnumHyphen, 10, { digit: true });
const AWS = shape(isUpperDigit, 16, { exact: true });
const STRIPE = shape(isAlnum, 16);
const SHAPES = new Map([
  ['ghp_', GITHUB], ['gho_', GITHUB], ['ghu_', GITHUB], ['ghs_', GITHUB], ['ghr_', GITHUB],
  ['github_pat_', shape(isAlnumUnderscore, 30)],
  ['xoxa-', SLACK], ['xoxb-', SLACK], ['xoxe-', SLACK], ['xoxo-', SLACK], ['xoxp-', SLACK], ['xoxr-', SLACK], ['xoxs-', SLACK],
  ['AKIA', AWS], ['ASIA', AWS],
  ['AIza', shape(isWord, 35, { exact: true })],
  ['glpat-', shape(isWord, 20)],
  ['npm_', shape(isAlnum, 36, { exact: true })],
  ['hf_', shape(isAlnum, 30)],
  ['sk_live_', STRIPE], ['sk_test_', STRIPE], ['rk_live_', STRIPE], ['rk_test_', STRIPE],
]);
const PREFIX_RE = /sk-|sk_live_|sk_test_|rk_live_|rk_test_|gh[opusr]_|github_pat_|xox[abeoprs]-|AKIA|ASIA|AIza|glpat-|npm_|hf_/g;
const [SK_LONG, SK_MIN] = [['ant-', 'proj-'], 20];

/** The end of the run behind a prefix when it has the shape's length (and digit), else -1. */
function shapeEnd(s, from, sh, memo) {
  const { end, digit } = runOf(s, from, sh.cls, memo);
  const n = end - from;
  if (sh.exact ? n !== sh.min : n < sh.min) return -1;
  return sh.digit && digit < from ? -1 : end;
}

/** `sk-`: 20 or more behind `sk-ant-` or `sk-proj-` (nothing else counts for those two); any other one needs 20 or more with a digit. */
function skEnd(s, from, memo) {
  const { end, digit } = runOf(s, from, isWord, memo);
  for (const sub of SK_LONG) if (s.startsWith(sub, from)) return end - (from + sub.length) >= SK_MIN ? end : -1;
  return end - from >= SK_MIN && digit >= from ? end : -1;
}

function prefixRanges(s, out, marks, memo) {
  PREFIX_RE.lastIndex = 0;
  let m;
  while ((m = PREFIX_RE.exec(s)) !== null) {
    if (!atTokenStart(s, m.index, marks)) continue;
    const from = m.index + m[0].length;
    const end = m[0] === 'sk-' ? skEnd(s, from, memo) : shapeEnd(s, from, SHAPES.get(m[0]), memo);
    if (end < 0) continue;
    out.push(m.index, end);
    PREFIX_RE.lastIndex = end;
  }
}

// --------------------------------------------------------------------------------------------- D36: no prefix
const [JWT_HEAD, JWT_PART_MIN, DOT] = ['eyJ', 10, 46]; // JWT_HEAD: base64url of '{"'

/** A JSON Web Token: three base64url parts joined by dots, the first two starting with JWT_HEAD, each 10 or more. */
function jwtRanges(s, out, marks, memo) {
  let at = s.indexOf(JWT_HEAD);
  while (at >= 0) {
    let next = at + JWT_HEAD.length;
    if (atTokenStart(s, at, marks)) {
      const a = runOf(s, at, isWord, memo, 'jwt1').end;
      const b = runOf(s, a + 1, isWord, memo, 'jwt2').end;
      const c = runOf(s, b + 1, isWord, memo, 'jwt3').end;
      const dots = s.charCodeAt(a) === DOT && s.charCodeAt(b) === DOT && s.startsWith(JWT_HEAD, a + 1);
      const whole = dots && a - at >= JWT_PART_MIN && b - a > JWT_PART_MIN && c - b > JWT_PART_MIN;
      if (whole) out.push(at, c);
      next = whole ? c : a;
    }
    at = s.indexOf(JWT_HEAD, next);
  }
}

const [BEARER_RE, BEARER_MIN] = [/bearer/gi, 16];

/** The word Bearer, blanks, then 16 or more token characters with a digit among them. The word stays. */
function bearerRanges(s, out, marks, memo) {
  BEARER_RE.lastIndex = 0;
  let m;
  while ((m = BEARER_RE.exec(s)) !== null) {
    if (!atTokenStart(s, m.index, marks)) continue;
    const from = skipBlanks(s, BEARER_RE.lastIndex);
    if (from === BEARER_RE.lastIndex) continue;
    const { end, digit } = runOf(s, from, isBearerChar, memo);
    if (end - from >= BEARER_MIN && digit >= from) out.push(from, end);
  }
}

/** The index behind the quote mark at `at` and behind every quote mark and backslash glued to it. */
function quoteRunEnd(s, at) {
  let i = at + 1;
  while (i < s.length && (isQuoteMark(s.charCodeAt(i)) || s.charCodeAt(i) === 92)) i++;
  return i;
}

/** Does a run of quote marks that ends at `after` close something (the end of the text, white space or a closer follows)? */
function closesBefore(s, after) {
  return after >= s.length || isSpaceOrControl(s.charCodeAt(after)) || isCloser(s.charCodeAt(after));
}

const closesAt = (s, at) => closesBefore(s, quoteRunEnd(s, at)); // the same question for the quote mark at `at`

/**
 * The end of a bare value. It runs to white space or a control character, or to a quote mark that closes something
 * (`'... value' next`, `"value",`); quote marks in front of a letter, a digit or any other character are part of the
 * value, so nothing behind them is left in view. A backslash that escapes the closing quote stays outside.
 */
function valueEnd(s, from) {
  let i = from;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (isSpaceOrControl(c)) break;
    const after = isQuoteMark(c) ? quoteRunEnd(s, i) : i + 1;
    if (isQuoteMark(c) && closesBefore(s, after)) break;
    i = after;
  }
  return i > from && i < s.length && s.charCodeAt(i - 1) === 92 && isQuoteMark(s.charCodeAt(i)) ? i - 1 : i;
}

// Marks that may stand around a header name or in front of its value without being part of either: quote marks,
// markdown emphasis and a backslash; in front of a value also an opening bracket.
const isMarkup = (c) => isQuoteMark(c) || c === 42 || c === 95 || c === 92; // " ' ` * _ \
const isOpener = (c) => isMarkup(c) || c === 91 || c === 123 || c === 40 || c === 60; // and [ { ( <
function skipSome(s, from, cls) {
  let i = from;
  while (i < s.length && i - from < 4 && cls(s.charCodeAt(i))) i++;
  return i;
}

const [HEADER_RE, WORD_STOP_RE, API_KEY_HEADER_LENGTH] = [/authorization|x-api-key/gi, /(?<![A-Za-z0-9])(?:authorization|x-api-key)|\\[nrt]/i, 9]; // 9: 'x-api-key'

/** The end of a header word: as valueEnd, but it stops in front of a written-out line break or tab and of the name of a next header. */
function wordEnd(s, from) {
  const end = valueEnd(s, from);
  const k = s.slice(from, end).search(WORD_STOP_RE);
  return k < 0 ? end : from + k;
}
// The scheme words that stay in front of a credential. A first word that is not one of them is masked itself.
const SCHEME_LIST = ['basic', 'bearer', 'digest', 'token', 'apikey', 'negotiate', 'ntlm', 'oauth', 'dpop', 'hoba',
  'mutual', 'vapid', 'aws4-hmac-sha256', 'scram-sha-1', 'scram-sha-256'], SCHEMES = new Set(SCHEME_LIST);
// A lower-cased word that could be a scheme nobody listed: a letter, then at most 19 letters, digits or hyphens.
const SCHEME_SHAPE_RE = /^[a-z][a-z0-9-]{0,19}$/;
// A word that reads as prose, not as a credential: at most 15 letters and hyphens with no capital behind the first,
// and sentence punctuation behind it (`Authorization: required for all endpoints` keeps its words).
const PLAIN_WORD_RE = /^\p{L}[\p{Ll}\p{Lo}-]{0,14}[.,;:!?)]{0,3}$/u;
const isPlainWord = (w) => PLAIN_WORD_RE.test(w);

/**
 * The value of an `Authorization` header behind its scheme, and of an `x-api-key` header. The name is not the end of
 * a longer word (no letter or digit in front; `Proxy-Authorization` and `HTTP_AUTHORIZATION` are fine) and may be a
 * JSON key (a quote on each side of the colon). A known scheme stays and the word behind it is masked (with nothing
 * behind it there is no value). Any other first word is masked unless it is a plain word, and the next one too when
 * the first looks like a scheme, unless both are plain words (prose behind the name and a colon stays).
 */
function headerRanges(s, out, marks, capped) {
  HEADER_RE.lastIndex = 0;
  let m;
  while ((m = HEADER_RE.exec(s)) !== null) {
    if (m.index > 0 && isAlnum(s.charCodeAt(m.index - 1)) && !marks.has(m.index) && !afterEscape(s, m.index)) continue;
    let at = skipBlanks(s, skipSome(s, HEADER_RE.lastIndex, isMarkup));
    if (s.charCodeAt(at) !== 58) continue; // ':'
    at = skipBlanks(s, skipSome(s, skipBlanks(s, skipSome(s, at + 1, isMarkup)), isOpener));
    const first = wordEnd(s, at);
    if (first === at) continue;
    let done = first;
    if (m[0].length === API_KEY_HEADER_LENGTH) {
      if (!isPlainWord(s.slice(at, first))) out.push(at, first);
    } else {
      const next = skipBlanks(s, first);
      const end2 = next > first ? wordEnd(s, next) : next;
      const second = end2 > next && s.charCodeAt(end2 - 1) === 58 && marks.has(next) ? next : end2; // `Name:` at the start of a line is a name
      const word = s.slice(at, first).replace(/[*_]+$/, '').toLowerCase(); // `**Basic**` is the scheme Basic
      if (SCHEMES.has(word)) {
        if (second > next) out.push(next, second);
        done = second;
      } else if (capped && first === s.length && SCHEME_LIST.some((scheme) => scheme.startsWith(word))) {
        done = first; // the length cap cut a scheme word: there is no value
      } else {
        const plain = isPlainWord(s.slice(at, first));
        if (!plain) out.push(at, first);
        if (second > next && SCHEME_SHAPE_RE.test(word) && !(plain && isPlainWord(s.slice(next, second)))) {
          out.push(next, second);
          done = second;
        }
      }
    }
    HEADER_RE.lastIndex = Math.max(HEADER_RE.lastIndex, done);
  }
}

const [PEM_BEGIN, PEM_END, PEM_KIND, PEM_LABEL_MAX] = ['-----BEGIN ', '-----END ', 'PRIVATE KEY-----', 40];
const isLabelChar = (c) => isUpper(c) || isDigit(c) || c === 32;

/** Behind `-----BEGIN ` or `-----END `: the index after `... PRIVATE KEY-----` when that is what the line says, else -1. */
function pemLineEnd(s, from) {
  const head = s.slice(from, from + PEM_LABEL_MAX + PEM_KIND.length);
  const k = head.indexOf(PEM_KIND);
  if (k < 0) return -1;
  for (let i = 0; i < k; i++) if (!isLabelChar(head.charCodeAt(i))) return -1;
  return from + k + PEM_KIND.length;
}

/** A PEM private key: from its BEGIN line through its END line, or (no END line follows) to the end of the text. */
function pemRanges(s, out) {
  let at = s.indexOf(PEM_BEGIN);
  let endLine = -2; // the END line found last: -2 not looked for yet, -1 there is none further on
  while (at >= 0) {
    let next = at + PEM_BEGIN.length;
    const body = pemLineEnd(s, next);
    if (body >= 0) {
      if (endLine === -2 || (endLine >= 0 && endLine < body)) endLine = s.indexOf(PEM_END, body);
      const end = endLine >= 0 ? pemLineEnd(s, endLine + PEM_END.length) : -1;
      const stop = end >= 0 ? end : s.length; // a key the text cuts: header lines, quoting and joins between its lines go too
      out.push(at, stop);
      next = stop;
    }
    at = s.indexOf(PEM_BEGIN, next);
  }
}

// --------------------------------------------------------------------------------------------- D37: name and value
const NAME_WORDS = ['password', 'passwd', 'pwd', 'secret', 'token', 'apikey', 'api_key', 'api-key', 'access_key', 'access-key', 'private_key', 'private-key'];

/** Does the name that ends at `end` end with one of NAME_WORDS (letter case ignored)? Only its last characters matter. */
function endsWithNameWord(s, end) {
  if (end <= 0) return false;
  const tail = s.slice(Math.max(0, end - 11), end).toLowerCase(); // 11: the longest of NAME_WORDS
  return NAME_WORDS.some((w) => tail.endsWith(w));
}

/**
 * The end of the inside of a quoted value whose opening quote is at `open`: the same quote, or the end of the line
 * when the closing quote is not in the text. `escaped`: the opening quote was written `\"`, so the closing one is too.
 */
function quotedEnd(s, open, escaped) {
  const quote = s.charCodeAt(open);
  let i = open + 1;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === quote || c === 10 || c === 13) break;
    if (c === 92 && s.charCodeAt(i + 1) === quote) {
      if (escaped) break;
      i++; // an escaped quote inside the value
    }
  }
  return i;
}

const [isNameChar, NAME_SCAN_MAX] = [(c) => isWord(c) || c === 46, 64];
/** . , ; : ! ? ) ] } : what the URL rule of summarize.mjs gives back to the sentence when it ends a URL. */
const isSentenceEnd = (c) => c === 46 || c === 44 || c === 59 || c === 58 || c === 33 || c === 63 || c === 41 || c === 93 || c === 125;

/** Is the name that ends at `end` a query parameter of a URL (`?name=` or `&name=`)? */
function inQuery(s, end) {
  let i = end;
  while (i > 0 && end - i < NAME_SCAN_MAX && isNameChar(s.charCodeAt(i - 1))) i--;
  const before = s.charCodeAt(i - 1);
  return before === 63 || before === 38;
}

/**
 * The end of a query value: the punctuation that closes the sentence around the URL is not part of it (the URL rule
 * keeps it for the sentence). A marker that already stands there is left whole, so a second pass changes nothing.
 */
function queryValueEnd(s, from, end) {
  let e = end;
  while (e > from && isSentenceEnd(s.charCodeAt(e - 1)) && !s.startsWith(SECRET_MARKER, e - SECRET_MARKER.length)) e--;
  return e;
}

/** Pushes the range of the value that starts at `from` (bare, or inside its quotes) and returns where to go on. */
function pushValue(s, from, out, query = false) {
  const escaped = s.charCodeAt(from) === 92 && isQuote(s.charCodeAt(from + 1));
  const open = escaped ? from + 1 : from;
  if (isQuote(s.charCodeAt(open))) {
    const end = quotedEnd(s, open, escaped);
    // a closing quote with more of the value glued to it (`'abc'def`) closes nothing: all of it is one bare value
    const close = escaped && s.charCodeAt(end) === 92 ? end + 1 : end;
    if (close < s.length && isQuote(s.charCodeAt(close)) && !closesAt(s, close)) {
      const glued = valueEnd(s, close + 1);
      out.push(from, glued);
      return glued;
    }
    if (end > open + 1) out.push(open + 1, end);
    return end;
  }
  const run = valueEnd(s, from);
  const end = query ? queryValueEnd(s, from, run) : run;
  if (end > from) out.push(from, end);
  return end;
}

/**
 * Is the `name=` whose sign is at `at` only named, inside quotes (`the "password=" parameter`, `grep 'token=' src`)?
 * Then the quote behind the sign closes something, and in front of the name (behind `?` or `&`) stands the same quote,
 * escaped or not as the one behind the sign, or a quote mark that comes again right behind the sign (`'password="'`).
 */
function isMention(s, at) {
  const close = s.charCodeAt(at + 1) === 92 ? at + 2 : at + 1;
  const quote = s.charCodeAt(close);
  const runEnd = isQuote(quote) ? quoteRunEnd(s, close) : close;
  if (!isQuote(quote) || !closesBefore(s, runEnd)) return false;
  let i = at;
  while (i > 0 && at - i < NAME_SCAN_MAX && isNameChar(s.charCodeAt(i - 1))) i--;
  if (i > 0 && (s.charCodeAt(i - 1) === 63 || s.charCodeAt(i - 1) === 38)) i--;
  const front = i > 0 ? s.charCodeAt(i - 1) : 0;
  const sameEscape = (close === at + 2) === (i > 1 && s.charCodeAt(i - 2) === 92); // `\"name=\"` or `"name="`, not a mix
  return front === quote ? sameEscape : isQuoteMark(front) && s.slice(close, runEnd).includes(String.fromCharCode(front));
}

/** `name=value` with nothing but the sign between them, when the name ends with a NAME_WORD. `==` and `=>` are code. */
function assignRanges(s, out) {
  let at = s.indexOf('=');
  while (at >= 0) {
    let next = at + 1;
    const after = s.charCodeAt(next);
    if (after !== 61 && after !== 62 && endsWithNameWord(s, at) && !isMention(s, at)) {
      const from = after === 92 && isBlank(s.charCodeAt(next + 1)) ? skipBlanks(s, next) : next; // a wrapped line
      next = Math.max(next, pushValue(s, from, out, inQuery(s, at)));
    }
    at = s.indexOf('=', next);
  }
}

/** The JSON form `"name": "value"` (also with escaped quotes), when the name ends with a NAME_WORD. */
function jsonRanges(s, out) {
  let at = s.indexOf(':');
  while (at >= 0) {
    let next = at + 1;
    let q = at - 1;
    while (q >= 0 && at - q <= 8 && isBlank(s.charCodeAt(q))) q--;
    if (q >= 1 && s.charCodeAt(q) === 34) {
      const nameEnd = s.charCodeAt(q - 1) === 92 ? q - 1 : q;
      if (endsWithNameWord(s, nameEnd)) {
        const v = skipBlanks(s, at + 1);
        const escaped = s.charCodeAt(v) === 92 && s.charCodeAt(v + 1) === 34;
        if (escaped || s.charCodeAt(v) === 34) next = Math.max(next, pushValue(s, v, out));
      }
    }
    at = s.indexOf(':', next);
  }
}

// --------------------------------------------------------------------------------------------- the mask
/** `ranges` (a flat list of [from, to) pairs) in order, with overlapping pairs made one. */
function merged(ranges) {
  const pairs = [];
  for (let i = 0; i < ranges.length; i += 2) if (ranges[i + 1] > ranges[i]) pairs.push([ranges[i], ranges[i + 1]]);
  pairs.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out = [];
  for (const pair of pairs) {
    const last = out[out.length - 1];
    if (last && pair[0] < last[1]) last[1] = Math.max(last[1], pair[1]);
    else out.push(pair);
  }
  return out;
}

/**
 * One pass of every rule over `text`. A mark inside what is replaced goes with it; every other mark stays. An
 * ellipsis as the last character is the one the length cap writes: it is no part of a value (a capped text keeps it).
 */
function maskOnce(text) {
  const { text: full, marks } = text.includes(MARK) ? unmark(text) : { text, marks: NO_MARKS };
  const capped = full.endsWith(ELLIPSIS);
  const s = capped ? full.slice(0, -1) : full;
  const ranges = [];
  const memo = new Map();
  prefixRanges(s, ranges, marks, memo);
  jwtRanges(s, ranges, marks, memo);
  bearerRanges(s, ranges, marks, memo);
  headerRanges(s, ranges, marks, capped);
  pemRanges(s, ranges);
  if (NAME_HINT_RE.test(s)) {
    assignRanges(s, ranges);
    jsonRanges(s, ranges);
  }
  const pairs = merged(ranges);
  if (pairs.length === 0) return text;
  const places = [...marks]; // in rising order
  let k = 0;
  let out = '';
  let pos = 0;
  const keep = (to) => { // s[pos, to) with its marks, the ones at both ends included
    for (; k < places.length && places[k] <= to; k++) {
      out += s.slice(pos, places[k]) + MARK;
      pos = places[k];
    }
    out += s.slice(pos, to);
  };
  for (const [from, to] of pairs) {
    keep(from);
    out += SECRET_MARKER;
    while (k < places.length && places[k] < to) k++;
    pos = to;
  }
  keep(s.length);
  return out + full.slice(s.length) + (k < places.length ? MARK : '');
}

// A replacement can leave the marker glued to the text behind it (two shapes that ran into each other), and a value
// rule then takes that text into the value on a second look: the passes are repeated until nothing changes.
const MAX_PASSES = 8;

/**
 * Replaces the shapes of D35 to D37 by SECRET_MARKER. Masking a masked text again changes nothing.
 * @param {unknown} text a string that its caller has already cut and tidied (see the header of this file)
 * @returns {unknown} the masked string; a value that is not a string as it came
 */
export function maskSecrets(text) {
  if (typeof text !== 'string') return text;
  try {
    if (!HINT_RE.test(text.includes(MARK) ? unmark(text).text : text)) return text;
    let s = text;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const next = maskOnce(s);
      if (next === s) return s;
      s = next;
    }
    return maskOnce(s) === s ? s : SECRET_MARKER; // never seen: a text that still changes shows nothing of itself
  } catch {
    return SECRET_MARKER; // cannot happen with string input; if it ever does, show nothing of the text
  }
}
