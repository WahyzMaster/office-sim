import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from './fixtures/load-three-record.mjs';

const { Board } = await import('../public/js/board.js');
const {
  summarizePlanItems,
  formatPlanMarkdown,
  findBoardGroup,
  hitFloorBoard,
  pickRoomAgent,
  boardDetailText,
} = await import('../public/js/board-detail.js');

test('Board.set retains up to 8 per-floor plan history snapshots and notifies onChange listeners', () => {
  const board = new Board();
  assert.ok(Array.isArray(board.history));
  assert.equal(board.history.length, 0);

  let notifyCount = 0;
  const off = board.onChange(() => {
    notifyCount += 1;
  });

  board.set(
    'agent-1',
    '클로드-1',
    [
      { content: '1단계 파악', status: 'completed' },
      { content: '2단계 구현', status: 'in_progress' },
    ],
    '#d97757',
  );
  assert.equal(notifyCount, 1);
  assert.equal(board.history.length, 1);
  assert.equal(board.history[0].owner, 'agent-1');
  assert.equal(board.history[0].items.length, 2);
  assert.ok(board.updatedAt > 0);

  // Updating another agent adds a new history tab at the front
  board.set(
    'agent-2',
    '코덱스-2',
    [{ content: '재시도 백오프 추가', status: 'pending' }],
    '#10a37f',
  );
  assert.equal(notifyCount, 2);
  assert.equal(board.history.length, 2);
  assert.equal(board.history[0].owner, 'agent-2');
  assert.equal(board.history[1].owner, 'agent-1');

  // Updating agent-1 again updates agent-1 in-place and promotes it to index 0 without duplicating
  board.set(
    'agent-1',
    '클로드-1',
    [
      { content: '1단계 파악', status: 'completed' },
      { content: '2단계 구현', status: 'completed' },
    ],
    '#d97757',
  );
  assert.equal(board.history.length, 2);
  assert.equal(board.history[0].owner, 'agent-1');
  assert.equal(board.history[0].items[1].status, 'completed');

  // Cap history at 8 entries
  for (let i = 3; i <= 12; i++) {
    board.set(`agent-${i}`, `에이전트-${i}`, [{ content: `작업 ${i}`, status: 'pending' }], '#336699');
  }
  assert.equal(board.history.length, 8);
  assert.equal(board.history[0].owner, 'agent-12');

  off();
  board.set('agent-12', '에이전트-12', [{ content: '갱신', status: 'completed' }], '#336699');
  assert.equal(notifyCount, 13);
});

test('summarizePlanItems computes accurate completion metrics including 7+ unclipped items', () => {
  const empty = summarizePlanItems([]);
  assert.deepEqual(empty, { total: 0, completed: 0, inProgress: 0, pending: 0, pct: 0 });

  const sevenItems = [
    { content: 'Step 1', status: 'completed' },
    { content: 'Step 2', status: 'completed' },
    { content: 'Step 3', status: 'completed' },
    { content: 'Step 4', status: 'in_progress' },
    { content: 'Step 5', status: 'pending' },
    { content: 'Step 6 (truncated on 3D board)', status: 'pending' },
    { content: 'Step 7 (truncated on 3D board)', status: 'pending' },
  ];
  const stats = summarizePlanItems(sevenItems);
  assert.deepEqual(stats, {
    total: 7,
    completed: 3,
    inProgress: 1,
    pending: 3,
    pct: 43,
  });
});

test('formatPlanMarkdown exports full unclipped checklist in ko and en', () => {
  const items = [
    { content: '토큰 검증 흐름 파악 및 OAuth 미들웨어 호출 그래프 추적', status: 'completed' },
    { content: '세션 가드 구현 및 개발 모드 우회 분기 제거', status: 'in_progress' },
    { content: '회귀 테스트 실행 및 통합 검증', status: 'pending' },
  ];
  const mdKo = formatPlanMarkdown({
    floorLabel: '1F · web-app',
    title: '클로드-7f3a',
    branch: 'fix/auth-guard',
    items,
    lang: 'ko',
  });
  assert.match(mdKo, /## \[1F · web-app\] 클로드-7f3a \(fix\/auth-guard\) — 1\/3 \(33%\)/);
  assert.match(mdKo, /- \[x\] 1\. 토큰 검증 흐름 파악 및 OAuth 미들웨어 호출 그래프 추적/);
  assert.match(mdKo, /- \[ \] 2\. \*\*\[진행 중\]\*\* 세션 가드 구현 및 개발 모드 우회 분기 제거/);
  assert.match(mdKo, /- \[ \] 3\. 회귀 테스트 실행 및 통합 검증/);

  const mdEn = formatPlanMarkdown({
    floorLabel: '1F · web-app',
    title: 'Claude-7f3a',
    branch: '',
    items,
    lang: 'en',
  });
  assert.match(mdEn, /## \[1F · web-app\] Claude-7f3a — 1\/3 \(33%\)/);
  assert.match(mdEn, /\*\*\[In Progress\]\*\*/);
});

test('findBoardGroup and hitFloorBoard locate the 3D whiteboard group and prioritize agent hits', () => {
  const board = new Board();
  const archGroup = new THREE.Group();
  const boardGrp = new THREE.Group();
  const frameMesh = new THREE.Mesh(new THREE.BoxGeometry(4.4, 2.2, 0.08), new THREE.MeshStandardMaterial());
  const planeMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), board.material);
  boardGrp.add(frameMesh, planeMesh);
  archGroup.add(boardGrp);

  const floor = {
    index: 0,
    number: '1F',
    label: 'web-app',
    group: { visible: true },
    archGroup,
    board,
    agents: new Set(),
  };

  const found = findBoardGroup(floor);
  assert.equal(found, boardGrp);

  // Mock office raycaster hitting frameMesh inside boardGrp
  const office = {
    floors: [floor],
    stage: { camera: {} },
    hitAgent: () => null,
    raycaster: {
      setFromCamera() {},
      intersectObjects(objs) {
        return objs.includes(frameMesh) ? [{ object: frameMesh }] : [];
      },
    },
  };

  const hit = hitFloorBoard(office, { x: 0, y: 0 });
  assert.equal(hit, floor);

  // When an agent stands in front of the board, hitAgent takes priority
  office.hitAgent = () => ({ id: 'agent-1' });
  assert.equal(hitFloorBoard(office, { x: 0, y: 0 }), null);
});

test('pickRoomAgent prioritizes asking agents in desk and cycles through room occupants', () => {
  const a1 = { id: 'a1', room: 'desk', asking: false, mode: 'work', isSub: false };
  const a2 = { id: 'a2', room: 'desk', asking: true, mode: 'work', isSub: true };
  const a3 = { id: 'a3', room: 'server', asking: false, mode: 'work', isSub: false };
  const floor = { agents: new Set([a1, a2, a3]) };

  // First click on desk selects asking agent a2 first
  const first = pickRoomAgent(floor, 'desk', null);
  assert.equal(first, a2);

  // Second click while a2 is selected cycles to a1
  const second = pickRoomAgent(floor, 'desk', a2);
  assert.equal(second, a1);

  // Clicking an empty room returns null
  assert.equal(pickRoomAgent(floor, 'archive', null), null);
});

test('boardDetailText provides complete ko/en parity', () => {
  const ko = boardDetailText('ko');
  const en = boardDetailText('en');
  assert.deepEqual(Object.keys(ko).sort(), Object.keys(en).sort());
});
