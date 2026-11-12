// 문서 껍데기: public/office.html 은 조각이라 <!doctype>, <head>, <body> 가 없다. 그 앞뒤를 감싸는 머리와 꼬리를 만든다.
// 로컬 서버(src/server-http.mjs 의 GET /)와 호스팅 데모 빌드(scripts/build-demo.mjs 의 index.html)가 같이 쓴다 (contract 6).
// 순수 함수: 파일도 네트워크도 건드리지 않는다.

const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/; // 'ko', 'en', 'pt-BR': 속성 값에 그대로 넣으므로 이 꼴만 받는다

export const PAGE_TAIL = '</body></html>';

/**
 * The opening of the document, up to and including `<body>`.
 * @param {{ lang: string, extraHead?: string }} o
 *   lang: the `<html lang>` value (a plain language tag).
 *   extraHead: HTML placed inside `<head>` right after the viewport meta, as given. The caller escapes it;
 *   '' (the default) adds no byte.
 */
export function pageHead({ lang, extraHead = '' } = {}) {
  if (typeof lang !== 'string' || !LANG_RE.test(lang)) throw new TypeError('pageHead: lang must be a language tag such as "en"');
  if (typeof extraHead !== 'string') throw new TypeError('pageHead: extraHead must be a string');
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">`
    + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
    + extraHead
    + '<style>:root{color-scheme:light}body{margin:0}[hidden]{display:none!important}</style></head><body>';
}
