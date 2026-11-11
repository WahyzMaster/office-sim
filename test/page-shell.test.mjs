// page-shell: 로컬 서버(src/server-http.mjs)와 호스팅 데모 빌드(scripts/build-demo.mjs)가 같이 쓰는 문서 껍데기.
// 기대값은 모듈에서 가져오지 않고 여기 적어 둔다 (서버가 실제로 보내는 바이트는 test/server.test.mjs 가 확인한다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageHead, PAGE_TAIL } from '../src/page-shell.mjs';

const OPEN = (lang) => `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">`;
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">';
const CLOSE = '<style>:root{color-scheme:light}body{margin:0}[hidden]{display:none!important}</style></head><body>';

test('pageHead without extra head HTML is the wrapper head, and an empty extra adds no byte', () => {
  assert.equal(pageHead({ lang: 'ko' }), OPEN('ko') + VIEWPORT + CLOSE);
  assert.equal(pageHead({ lang: 'ko', extraHead: '' }), OPEN('ko') + VIEWPORT + CLOSE);
  assert.equal(pageHead({ lang: 'en' }), OPEN('en') + VIEWPORT + CLOSE);
  assert.equal(PAGE_TAIL, '</body></html>');
});

test('extra head HTML is placed inside <head>, right after the viewport meta, unchanged', () => {
  const extra = '<meta name="description" content="a &amp; b"><link rel="canonical" href="https://example.test/">';
  const head = pageHead({ lang: 'en', extraHead: extra });
  assert.equal(head, OPEN('en') + VIEWPORT + extra + CLOSE);
  assert.ok(head.indexOf(extra) < head.indexOf('</head>'));
  assert.ok(head.indexOf('<meta charset="utf-8">') < head.indexOf(extra), 'charset stays first in <head>');
});

test('pageHead accepts language tags only and a string for the extra head', () => {
  assert.equal(pageHead({ lang: 'pt-BR' }), OPEN('pt-BR') + VIEWPORT + CLOSE);
  for (const lang of [undefined, null, '', 'e', 'en"><script>', 'en us', 'en_US', 42]) {
    assert.throws(() => pageHead({ lang }), TypeError, `lang ${JSON.stringify(lang)}`);
  }
  assert.throws(() => pageHead(), TypeError, 'lang is required');
  for (const extraHead of [null, 1, {}, ['<meta>']]) {
    assert.throws(() => pageHead({ lang: 'en', extraHead }), TypeError, `extraHead ${JSON.stringify(extraHead)}`);
  }
});
