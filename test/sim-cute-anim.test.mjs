// 방(location)별·캐릭터 패밀리별·보행 자세별 디테일 귀여운 안무, 3D 손 소품, Squash & Stretch 검증.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THREE } from './fixtures/load-three-record.mjs';
const {
  MICRO_PROP_KEYS,
  computeStationChoreography,
  ensureAgentMicroProps,
  applyLocationCuteAnim,
  resetAgentCutePose,
} = await import('../public/js/sim-cute-anim.js');

function makeFakeAgentRig(isTetra = false, charFamily = 'human') {
  const armL = new THREE.Group();
  const armR = new THREE.Group();
  const head = new THREE.Group();
  head.position.set(0, isTetra ? 0.88 : 1.44, 0);
  const torsoMesh = new THREE.Group();
  torsoMesh.scale.set(isTetra ? 0.88 : 1, isTetra ? 1.08 : 1, isTetra ? 0.84 : 1);
  return {
    t: 1.2,
    room: 'archive',
    mode: 'work',
    posture: isTetra ? 'tetrapod' : 'bipod',
    charFamily,
    arms: [armL, armR],
    head,
    torsoMesh,
    panicT: 0,
  };
}

test('computeStationChoreography gives each of the 7 rooms a distinct pose and handheld micro-prop in bipod mode', () => {
  const archive = computeStationChoreography({ room: 'archive', mode: 'work', isTetra: false, t: 1.0 });
  assert.equal(archive.propL, 'book');
  assert.equal(archive.propR, null);
  assert.ok(Math.abs(archive.head.y) > 0.01, 'archive scans shelves horizontally');

  const archiveFlip = computeStationChoreography({ room: 'archive', mode: 'work', isTetra: false, t: 3.5 });
  assert.equal(archiveFlip.activityBeat, 'delight');
  assert.ok(archiveFlip.propFlip > 0.2, 'archive flips page during delight beat');

  const devFocus = computeStationChoreography({ room: 'dev', mode: 'work', isTetra: false, t: 1.2 });
  assert.ok(devFocus.armL.z > 0.2 && devFocus.armR.z < -0.2, 'dev converges hands inward for typing');

  const devSip = computeStationChoreography({ room: 'dev', mode: 'work', isTetra: false, t: 4.0 });
  assert.equal(devSip.propR, 'mug');
  assert.equal(devSip.activityBeat, 'delight');
  assert.ok(devSip.head.x < -0.05, 'dev tilts head back to sip coffee');

  const server = computeStationChoreography({ room: 'server', mode: 'work', isTetra: false, t: 1.0 });
  assert.equal(server.propR, 'wrench');
  assert.ok(server.rig.pitch > 0.05, 'server leans into rack');

  const research = computeStationChoreography({ room: 'research', mode: 'work', isTetra: false, t: 1.0 });
  assert.equal(research.propR, 'magnifier');
  assert.ok(research.armR.x < -1.2 && research.armR.z < -0.2, 'research raises magnifier to eye');

  const researchEureka = computeStationChoreography({ room: 'research', mode: 'work', isTetra: false, t: 3.75 });
  assert.equal(researchEureka.activityBeat, 'delight');
  assert.ok(researchEureka.squash.y > 1.04 && researchEureka.squash.x < 0.98, 'research Eureka pop preserves volume');

  const meeting = computeStationChoreography({ room: 'meeting', mode: 'write', isTetra: false, t: 1.0 });
  assert.equal(meeting.propL, 'clipboard');
  assert.equal(meeting.propR, 'wand');

  const desk = computeStationChoreography({ room: 'desk', mode: 'ask', isTetra: false, t: 0.3 });
  assert.equal(desk.propR, 'sign');
  assert.ok(desk.armR.x < -2.3, 'desk raises approval sign overhead');

  const loungeSip = computeStationChoreography({ room: 'lounge', mode: 'idle', isTetra: false, t: 2.8 });
  assert.equal(loungeSip.propR, 'mug');
  assert.ok(loungeSip.armR.x < -1.0, 'lounge lifts warm mug for a sip');

  const loungeStretch = computeStationChoreography({ room: 'lounge', mode: 'idle', isTetra: false, t: 5.6 });
  assert.equal(loungeStretch.activityBeat, 'delight');
  assert.ok(loungeStretch.armL.x < -1.5 && loungeStretch.armR.x < -1.5, 'lounge performs overhead V-stretch');
  assert.ok(loungeStretch.squash.y > 1.04, 'lounge stretch elongates torso Y');
});

test('computeStationChoreography produces species-specific tetrapod behaviors for dogs and cats across rooms', () => {
  const dogArchive = computeStationChoreography({ room: 'archive', mode: 'work', isTetra: true, charFamily: 'dogs', t: 1.1 });
  assert.ok(dogArchive.head.yOffset < -0.05 && dogArchive.head.x > 0.25, 'dog lowers head to sniff floor in archive');

  const catArchive = computeStationChoreography({ room: 'archive', mode: 'work', isTetra: true, charFamily: 'cats', t: 1.1 });
  assert.equal(catArchive.head.yOffset, 0, 'cat perches upright in archive');

  const catDev = computeStationChoreography({ room: 'dev', mode: 'work', isTetra: true, charFamily: 'cats', t: 0.8 });
  assert.ok(catDev.armL.z > 0.1 && catDev.armR.z < -0.1, 'bongo cat taps desk with inward paws');

  const dogServer = computeStationChoreography({ room: 'server', mode: 'work', isTetra: true, charFamily: 'dogs', t: 1.0 });
  assert.ok(dogServer.rig.pitch > 0.1 && dogServer.squash.y < 0.95, 'dog crouches in play-bow before pouncing in server');

  const scoutResearch = computeStationChoreography({ room: 'research', mode: 'work', isTetra: true, charFamily: 'dogs', t: 1.0 });
  assert.ok(scoutResearch.head.yOffset > 0.05, 'tetrapod sits tall in research lookout');

  const begDesk = computeStationChoreography({ room: 'desk', mode: 'ask', isTetra: true, charFamily: 'dogs', t: 0.5 });
  assert.ok(begDesk.armR.x < -0.9 && begDesk.head.z > 0.1, 'dog raises paw and tilts head at review booth');

  const catGroom = computeStationChoreography({ room: 'lounge', mode: 'idle', isTetra: true, charFamily: 'cats', t: 3.5 });
  assert.ok(catGroom.armR.x < -1.1 && catGroom.head.z < -0.2, 'cat grooms cheek with front paw in lounge');
});

test('applyLocationCuteAnim attaches shared micro-props once, toggles visibility, triggers joy burst on work->idle, and respects reducedMotion', () => {
  const agent = makeFakeAgentRig(false, 'human');
  agent.room = 'research';
  agent.mode = 'work';
  agent.t = 1.0;

  applyLocationCuteAnim(agent, false, false);
  const props1 = ensureAgentMicroProps(agent);
  assert.ok(props1);
  assert.equal(props1.magnifier.visible, true);
  assert.equal(props1.book.visible, false);
  assert.equal(MICRO_PROP_KEYS.filter((k) => props1[k].visible).length, 1);

  // Switching to meeting shows clipboard + wand without reallocating microProps
  agent.room = 'meeting';
  agent.mode = 'write';
  applyLocationCuteAnim(agent, false, false);
  assert.equal(agent.microProps, props1);
  assert.equal(props1.clipboard.visible, true);
  assert.equal(props1.wand.visible, true);
  assert.equal(props1.magnifier.visible, false);

  // Transitioning from write -> idle triggers a 0.42s celebratory joy burst hop
  agent.mode = 'idle';
  agent.t = 1.15;
  const joyStart = applyLocationCuteAnim(agent, false, false);
  assert.equal(joyStart.activityBeat, 'joy');
  agent.t = 1.35;
  const joyPeak = applyLocationCuteAnim(agent, false, false);
  assert.equal(joyPeak.activityBeat, 'joy');
  assert.ok(joyPeak.rig.bob > 0.08 && joyPeak.squash.y > 1.08);

  // Reduced motion neutralizes bobbing and squash/stretch while keeping station prop visible
  agent.room = 'archive';
  agent.mode = 'work';
  agent.t = 5.0;
  const redPose = applyLocationCuteAnim(agent, false, true);
  assert.equal(redPose.rig.bob, 0);
  assert.deepEqual(redPose.squash, { x: 1, y: 1, z: 1 });
  assert.equal(props1.book.visible, true);

  // Resetting pose for walking hides all props and restores neutral scale
  resetAgentCutePose(agent, false);
  assert.equal(MICRO_PROP_KEYS.some((k) => props1[k].visible), false);
  assert.deepEqual([agent.torsoMesh.scale.x, agent.torsoMesh.scale.y, agent.torsoMesh.scale.z], [1, 1, 1]);
});
