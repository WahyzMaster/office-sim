// 서가 책·모니터 화면처럼 절차적으로 짓는 소품이 매번 같은 모양이 되도록 쓰는 시드 난수.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32, seedOf } from '../public/js/rng.js';

test('mulberry32: the same seed gives the same stream, every value in [0, 1)', () => {
  const a = mulberry32(seedOf('shelves'));
  const b = mulberry32(seedOf('shelves'));
  for (let i = 0; i < 10; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1, `${v}`);
  }
});

test('seedOf: different strings give different seeds', () => {
  assert.notEqual(seedOf('a'), seedOf('b'));
  assert.ok(Number.isInteger(seedOf('archive')) && seedOf('archive') >= 0);
});
