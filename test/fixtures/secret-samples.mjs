// Samples for the secret mask tests (launch readiness W10). Every sample is put together when the test runs, from a
// short prefix and a generated tail, so that no file of the repository holds a token-shaped string (D39).
export const LOWER = 'abcdefghijklmnopqrstuvwxyz';
export const UPPER = LOWER.toUpperCase();
export const DIGITS = '0123456789';
export const LETTERS = LOWER + UPPER;
export const ALNUM = LETTERS + DIGITS;
export const UPPER_DIGITS = UPPER + DIGITS;
export const B64URL = `${ALNUM}_-`;

/** `n` characters of `alphabet`, the same ones on every run (a small linear congruential generator). */
export function chars(n, alphabet = ALNUM, seed = 7) {
  let x = seed >>> 0;
  let out = '';
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += alphabet[(x >>> 16) % alphabet.length];
  }
  return out;
}

/** `n` characters of `alphabet` with a digit in the middle (the rules that ask for "at least one digit"). */
export function withDigit(n, alphabet = LETTERS, seed = 7) {
  const s = chars(n, alphabet, seed);
  const at = Math.floor(n / 2);
  return `${s.slice(0, at)}7${s.slice(at + 1)}`;
}

const join = (...parts) => parts.join('');

/** One sample per family, each with the part that must never be shown (`hidden`) and the text it sits in (`text`). */
export function sampleSet(seed = 11) {
  const tails = {
    anthropic: chars(40, B64URL, seed),
    github: chars(36, ALNUM, seed + 1),
    aws: chars(16, UPPER_DIGITS, seed + 2),
    jwtA: chars(20, B64URL, seed + 3),
    jwtB: chars(30, B64URL, seed + 4),
    jwtC: chars(40, B64URL, seed + 5),
    value: withDigit(24, LETTERS, seed + 6),
    bearer: withDigit(32, ALNUM, seed + 7),
  };
  const jwt = [join('ey', 'J', tails.jwtA), join('ey', 'J', tails.jwtB), tails.jwtC].join('.');
  return {
    anthropic: { text: join('sk-', 'ant-', tails.anthropic), hidden: tails.anthropic },
    github: { text: join('gh', 'p_', tails.github), hidden: tails.github },
    aws: { text: join('AK', 'IA', tails.aws), hidden: tails.aws },
    jwt: { text: jwt, hidden: tails.jwtC },
    named: { text: ['DEPLOY_API_KEY', tails.value].join('='), hidden: tails.value },
    bearer: { text: ['Bearer', tails.bearer].join(' '), hidden: tails.bearer },
  };
}

/** The hidden parts of a sample set, for a "none of them is in this text" check. */
export const hiddenOf = (set) => Object.values(set).map((s) => s.hidden);

// D35: prefix, the characters after it, the least number of them, and what else the rule asks for.
//   digit: at least one digit among them; exact: the run is exactly that long (one more is not that shape either)
export const PREFIXED = [
  { name: 'sk-ant-', prefix: join('sk-', 'ant-'), alphabet: B64URL, min: 20 },
  { name: 'sk-proj-', prefix: join('sk-', 'proj-'), alphabet: B64URL, min: 20 },
  { name: 'sk- (other)', prefix: 'sk-', alphabet: B64URL, min: 20, digit: true },
  ...['p', 'o', 'u', 's', 'r'].map((c) => ({ name: `gh${c}_`, prefix: join('gh', c, '_'), alphabet: ALNUM, min: 30 })),
  { name: 'github_pat_', prefix: join('github', '_pat_'), alphabet: `${ALNUM}_`, min: 30 },
  ...['a', 'b', 'e', 'o', 'p', 'r', 's'].map((c) => ({
    name: `xox${c}-`, prefix: join('xox', c, '-'), alphabet: `${ALNUM}-`, min: 10, digit: true,
  })),
  { name: 'AKIA', prefix: join('AK', 'IA'), alphabet: UPPER_DIGITS, min: 16, exact: true },
  { name: 'ASIA', prefix: join('AS', 'IA'), alphabet: UPPER_DIGITS, min: 16, exact: true },
  { name: 'AIza', prefix: join('AI', 'za'), alphabet: B64URL, min: 35, exact: true },
  { name: 'glpat-', prefix: join('gl', 'pat-'), alphabet: B64URL, min: 20 },
  { name: 'npm_', prefix: join('np', 'm_'), alphabet: ALNUM, min: 36, exact: true },
  { name: 'hf_', prefix: join('h', 'f_'), alphabet: ALNUM, min: 30 },
  ...['sk_live_', 'sk_test_', 'rk_live_', 'rk_test_'].map((p) => ({ name: p, prefix: join(p.slice(0, 3), p.slice(3)), alphabet: ALNUM, min: 16 })),
];

/** A tail of n characters for a row: letters only (so that no other rule can take it), plus the digit when the row asks. */
export function tailOf(row, n, { digit = row.digit === true, seed = 7 } = {}) {
  const letters = row.alphabet === UPPER_DIGITS ? UPPER : LETTERS;
  return digit ? withDigit(n, letters, seed) : chars(n, letters, seed);
}

export const NAME_ENDS = [
  'password', 'passwd', 'pwd', 'secret', 'token', 'apikey', 'api_key', 'api-key', 'access_key', 'access-key',
  'private_key', 'private-key',
];
export const AUTH_HEADER = join('Author', 'ization');
export const KEY_HEADER = join('x-api', '-key');
export const jwtPart = (n, seed) => join('ey', 'J', chars(n - 3, B64URL, seed));
export const pemBegin = (label) => ['-----BEGIN', ...label, 'PRIVATE', 'KEY-----'].join(' ');
export const pemEnd = (label) => ['-----END', ...label, 'PRIVATE', 'KEY-----'].join(' ');
export const pemBody = (lines = 3) => Array.from({ length: lines }, (_, i) => chars(64, `${ALNUM}+/`, i + 1));

/**
 * Every shape of D35 to D37 once, as it would stand in a log: `text`, and `hidden`, the parts of it that must never
 * reach the page. `name` says which row it is.
 */
export function shapeSamples(seed = 31) {
  const v = chars(18, LOWER, seed);
  const w = chars(18, LOWER, seed + 1);
  const tok = withDigit(28, LETTERS, seed + 2);
  const parts = [jwtPart(18, seed + 3), jwtPart(26, seed + 4), chars(30, B64URL, seed + 5)];
  const body = pemBody(2);
  const std = `${chars(12, LETTERS, seed + 6)}/${withDigit(10, LETTERS, seed + 7)}+${chars(8, LETTERS, seed + 8)}`; // base64 with / and +
  return [
    ...PREFIXED.map((row, i) => {
      const tail = tailOf(row, row.exact ? row.min : row.min + 6, { seed: seed + 10 + i });
      return { name: row.name, text: join(row.prefix, tail), hidden: [tail] };
    }),
    { name: 'jwt', text: parts.join('.'), hidden: [parts[1].slice(3), parts[2]] },
    { name: 'bearer', text: ['Bearer', tok].join(' '), hidden: [tok] },
    { name: 'bearer, base64', text: ['Bearer', std].join(' '), hidden: [std.slice(0, 12), std.slice(-8)] },
    { name: 'header with a scheme', text: `${AUTH_HEADER}: Basic ${v}`, hidden: [v] },
    { name: 'header without a scheme', text: `${AUTH_HEADER}: ${v}`, hidden: [v] },
    { name: 'header as JSON', text: `{"${AUTH_HEADER}": "Bearer ${v}"}`, hidden: [v] },
    { name: 'key header', text: `${KEY_HEADER}: ${v}`, hidden: [v] },
    { name: 'pem', text: [pemBegin(['RSA']), ...body, pemEnd(['RSA'])].join('\n'), hidden: body },
    ...NAME_ENDS.map((end) => ({ name: `${end}=`, text: [`DEPLOY_${end.toUpperCase()}`, v].join('='), hidden: [v] })),
    { name: 'name=, base64 value', text: ['client_secret', std].join('='), hidden: [std.slice(0, 12), std.slice(-8)] },
    { name: 'name="quoted"', text: [NAME_ENDS[0], `"${v} ${w}"`].join('='), hidden: [v, w] },
    { name: 'JSON form', text: [`"${NAME_ENDS[6]}"`, `"${v} ${w}"`].join(': '), hidden: [v, w] },
  ];
}

/** The pieces of a hidden part to look for in a text: the whole of it, and its first and last 8 characters. */
export const piecesOf = (sample) => sample.hidden.flatMap((h) => [h, h.slice(0, 8), h.slice(-8)]);
