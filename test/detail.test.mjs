// 층이 많을 때 성능(P3): 층마다 그리기 수준을 정하는 순수 규칙 (public/js/detail.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floorDetail, labelRootIndex } from '../public/js/detail.js';

const FULL = { visible: true, labels: true, shadows: true, animate: true };

test('floorDetail: the focused floor is drawn in full', () => {
  assert.deepEqual(floorDetail(3, 3, false), FULL);
});

test('floorDetail: floors below the focus stay visible and animated, without labels or cast shadows', () => {
  assert.deepEqual(floorDetail(0, 3, false), { visible: true, labels: false, shadows: false, animate: true });
});

test('floorDetail: floors above the focus are hidden: no draw, labels, shadows or animation', () => {
  assert.deepEqual(floorDetail(4, 3, false), { visible: false, labels: false, shadows: false, animate: false });
  assert.deepEqual(floorDetail(9, 0, false), { visible: false, labels: false, shadows: false, animate: false });
});

test('floorDetail: the overview draws every floor in full', () => {
  for (const i of [0, 5, 9]) assert.deepEqual(floorDetail(i, 2, true), FULL);
});

test('floorDetail: 10 floors focused on 1F -> one floor drawn, nine skipped', () => {
  const d = Array.from({ length: 10 }, (_, i) => floorDetail(i, 0, false));
  assert.equal(d.filter((x) => x.visible).length, 1);
  assert.equal(d.filter((x) => x.labels || x.shadows || x.animate).length, 1);
});

test('labelRootIndex: the focused floor, or -1 (whole scene) in the overview or with no floors', () => {
  assert.equal(labelRootIndex(2, false, 10), 2);
  assert.equal(labelRootIndex(2, true, 10), -1);
  assert.equal(labelRootIndex(0, false, 0), -1);
  assert.equal(labelRootIndex(12, false, 10), 9);
  assert.equal(labelRootIndex(-1, false, 3), 0);
});
