// 기록 관찰 패널의 상한 표시 (유지보수 PR 3, public/js/observe-format.js 와 observe-panel.js 의 화면 모델): 쓴 크기, 다 모인
// 뒤의 자동 종료까지 남은 시간, 상태의 limits 로 만든 상한 한 줄, 끝난 까닭. 숫자는 늘 limits 에서 온다.
// 서버 상태는 손으로 만든 합성 값이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sizeText, spanText, readLimits, limitsText, readReason, reasonText, autoWhy, remainingMs,
} from '../public/js/observe-format.js';
import { readStatus, observeView, ObserveModel } from '../public/js/observe-panel.js';
import { checklist, status, ALL_DONE, LAST, LIMITS } from './fixtures/observe-status.mjs';

const view = (over, opt) => observeView(readStatus(status(over)), opt);
const STARTED = '2026-10-21T15:30:00.000Z';
const at = (ms) => new Date(Date.parse(STARTED) + ms).toISOString();

test('format: sizes in B / KB / MB, spans in 시간 / 분 / 초, junk as zero', () => {
  assert.deepEqual([0, 512, 1024, 3500, 1_258_291, 52_428_800].map(sizeText), ['0 B', '512 B', '1 KB', '3.4 KB', '1.2 MB', '50 MB']);
  assert.deepEqual([600_000, 14_400_000, 5_400_000, 45_000, 90_500, 200].map(spanText), ['10분', '4시간', '1시간 30분', '45초', '1분 31초', '1초 미만']);
  for (const bad of [-1, NaN, '9', undefined]) assert.equal(sizeText(bad), '0 B');
});

test('limits line: built from status.limits only (other numbers show other text); missing or odd limits hide it', () => {
  assert.equal(limitsText(LIMITS), '다 모인 뒤 10분, 최대 4시간, 50 MB 에서 자동으로 끝나요. 결과 파일은 최근 20개만 남겨요.');
  const other = { readyGraceMs: 300_000, maxMs: 7_200_000, maxBytes: 10 * 1024 * 1024, keep: 5 };
  assert.equal(limitsText(other), '다 모인 뒤 5분, 최대 2시간, 10 MB 에서 자동으로 끝나요. 결과 파일은 최근 5개만 남겨요.');
  assert.equal(view({ limits: other }).limits, limitsText(other));
  assert.equal(view().limits, limitsText(LIMITS), 'shown while idle too');
  assert.equal(view({ running: true }).limits, limitsText(LIMITS));
  for (const bad of [undefined, null, 'x', { ...LIMITS, keep: 0 }, { ...LIMITS, maxMs: '1' }, { readyGraceMs: 1 }]) {
    assert.equal(readLimits(bad), null, JSON.stringify(bad));
    assert.equal(view({ limits: bad }).limits, null);
  }
  assert.equal(view({ available: false }).limits, null, 'nothing to limit when it cannot start');
  assert.deepEqual(readLimits({ ...LIMITS, path: '/tmp/x' }), LIMITS, 'numbers only');
});

test('running: the bytes written show; the countdown shows only once ready, from endsAt - startedAt - elapsed', () => {
  const run = { running: true, startedAt: STARTED, elapsedMs: 60_000, bytes: 1_258_291, endsAt: at(14_400_000) };
  const v = view(run);
  assert.equal(v.size, '1.2 MB 기록됨');
  assert.equal(v.ends, null, 'not ready: no countdown (the 4-hour cap is in the limits line)');
  const ready = { ...run, ready: true, checklist: checklist(ALL_DONE), elapsedMs: 700_000, endsAt: at(1_300_000) };
  assert.equal(view(ready).ends, '10:00 뒤 자동으로 끝나요');
  assert.equal(view(ready, { elapsedMs: 700_001 }).ends, '10:00 뒤 자동으로 끝나요', 'whole seconds rounded up');
  assert.equal(view(ready, { elapsedMs: 1_299_500 }).ends, '00:01 뒤 자동으로 끝나요');
  assert.equal(view(ready, { elapsedMs: 1_400_000 }).ends, '00:00 뒤 자동으로 끝나요', 'never negative');
  assert.equal(view({ ...ready, endsAt: 'soon' }).ends, null, 'not an ISO time');
  const idle = view({ ...ready, running: false, last: LAST });
  assert.deepEqual([idle.size, idle.ends], [null, null]);
  const s = readStatus(status({ running: false, bytes: 99, endsAt: at(1) }));
  assert.deepEqual([s.bytes, s.endsAt], [0, null], 'only a running status carries them');
  assert.equal(remainingMs({ running: true, startedAt: STARTED, endsAt: null }, 0), null);
});

test('ObserveModel: the countdown follows the page clock and freezes with it when the connection drops', () => {
  let t = 0;
  const m = new ObserveModel(() => t);
  m.apply(status({ running: true, ready: true, checklist: checklist(ALL_DONE), startedAt: STARTED, elapsedMs: 0, endsAt: at(600_000) }));
  assert.equal(m.view().ends, '10:00 뒤 자동으로 끝나요');
  t = 65_000;
  assert.equal(m.view().ends, '08:55 뒤 자동으로 끝나요');
  m.setConnected(false);
  t = 300_000;
  assert.equal(m.view().ends, '08:55 뒤 자동으로 끝나요');
});

test('last result: the reason in Korean from the limits; auto-stops say so in the state line', () => {
  const last = (reason, limits = LIMITS) => view({ last: { ...LAST, reason }, limits });
  assert.equal(last('user').last.reason, '직접 끝냄');
  assert.equal(last('ready').last.reason, '자동으로 끝남 (다 모인 뒤 10분)');
  assert.equal(last('duration').last.reason, '자동으로 끝남 (최대 4시간)');
  assert.equal(last('bytes').last.reason, '자동으로 끝남 (최대 50 MB)');
  assert.equal(last('close').last.reason, '서버가 꺼지면서 끝남');
  assert.equal(last(undefined).last.reason, null, 'an older server without reason');
  assert.equal(last('ready', { ...LIMITS, readyGraceMs: 120_000 }).last.reason, '자동으로 끝남 (다 모인 뒤 2분)');
  assert.equal(last('bytes', null).last.reason, '자동으로 끝남 (최대 크기)', 'no limits: no numbers');
  assert.equal(last('user').last.counts, '파일 3개 · 덧붙음 57번 · 체크리스트 4/4 채움', 'the counts line stays counts only');
  assert.equal(last('ready').stateText, '관찰이 자동으로 끝났어요 (다 모인 뒤 10분). 다시 시작하면 새 파일에 모아요.');
  assert.equal(last('duration').autoEnd, '기록 관찰이 자동으로 끝났어요 (최대 4시간).');
  assert.equal(last('user').stateText, '관찰을 끝냈어요. 다시 시작하면 새 파일에 모아요.');
  assert.equal(last('user').autoEnd, null);
  assert.equal(last('close').autoEnd, null);
  assert.equal(autoWhy('user', LIMITS), null);
  assert.equal(reasonText('BAIT', LIMITS), null);
});

test('privacy: only the five reason ids, numeric limits and an ISO endsAt pass readStatus', () => {
  const BAIT = 'BAIT-5c2a';
  const raw = status({
    running: true, startedAt: STARTED, bytes: `${BAIT}`, endsAt: `/tmp/${BAIT}`,
    limits: { ...LIMITS, dir: `/Users/${BAIT}/.observe`, keep: 20 },
    last: { ...LAST, reason: `/Users/${BAIT}`, bytes: BAIT },
  });
  const s = readStatus(raw);
  assert.deepEqual([s.bytes, s.endsAt, s.last.reason, s.last.bytes], [0, null, null, 0]);
  assert.deepEqual(s.limits, LIMITS);
  const out = JSON.stringify([s, observeView(s), observeView({ ...s, running: false })]);
  assert.equal(out.includes(BAIT), false, out);
  for (const r of ['user', 'ready', 'duration', 'bytes', 'close']) assert.equal(readReason(r), r);
  for (const r of ['USER', 'toString', '', null, 3]) assert.equal(readReason(r), null, String(r));
});
