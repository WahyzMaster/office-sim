// office.html 에 적혀 있는 글자 가운데 다른 스크립트가 언어에 맞춰 바꾸지 않던 것 (launch readiness D8).
// office.html 은 영어로 시작한다 (스크립트가 돌기 전에도, 한국어가 아닌 브라우저에서도 읽을 수 있게). 스크립트가 돌면
// hud.js 가 보이는 글자(버튼, 선택 상자, 범례)를 고른 언어로 바꾸고, 이 모듈이 나머지인 aria-label 과 문서의 lang 을 맞춘다.
// 숨겨져 시작하는 기록 관찰 패널(#observe, #toggle-observe)은 여기서 다루지 않는다: observe-panel.js 가 한국어로만 쓴다.

/** [selector, attribute, Korean, English]. The English text is what office.html carries (test/page-defaults.test.mjs). */
export const STATIC_TEXT = Object.freeze([
  ['#stage', 'aria-label', 'AI 코딩 에이전트 세션이 일하는 모습을 보여 주는 3D 사무실', '3D office showing AI coding agent sessions at work'],
  ['#speed', 'aria-label', '재생 속도', 'Playback speed'],
  ['#room-theme', 'aria-label', '공간 테마 프리셋', 'Place theme preset'],
  ['#char-theme', 'aria-label', '캐릭터 외형 프리셋', 'Character look preset'],
  ['#posture-mode', 'aria-label', '캐릭터 보행 자세', 'Character posture'],
  ['#motion-mode', 'aria-label', '캐릭터 모션', 'Character motion'],
  ['#voice-mode', 'aria-label', '캐릭터 음성', 'Character voice'],
  ['#llm-filter', 'aria-label', 'LLM 필터', 'LLM filter'],
  ['#control-preset', 'aria-label', '카메라 조작 프리셋', 'Camera control preset'],
  ['#color-theme', 'aria-label', '조명 모드 전환', 'Switch lighting mode'],
  ['#sound-toggle', 'aria-label', '캐릭터 소리 켜기/끄기', 'Turn character sound on or off'],
  ['#lang-toggle', 'aria-label', '언어 전환 (KO/EN)', 'Switch language (KO/EN)'],
  ['#capture-clip', 'aria-label', '5초 WebM 클립 녹화', 'Record a 5-second WebM clip'],
  ['#toggle-overlay', 'aria-label', '오버레이 모드 전환', 'Toggle overlay mode'],
  ['#floors', 'aria-label', '층 선택', 'Floor selection'],
  ['#log', 'aria-label', '활동 기록', 'Activity log'],
  ['#legend', 'aria-label', '범례 안내', 'Legend'],
  ['#inspector', 'aria-label', '직원 상세', 'Agent details'],
  ['#inspector select[data-act="motion"]', 'aria-label', '모션 선택', 'Choose a motion'],
  ['#exit-overlay', 'aria-label', '오버레이 끄기', 'Turn overlay off'],
].map(Object.freeze));

/**
 * Write every entry in `lang` ('ko' or anything else = English) and set `<html lang>`.
 * A missing element is skipped (the hosted demo and tests may carry fewer).
 */
export function applyStaticText(lang, doc = globalThis.document) {
  if (!doc) return;
  const ko = lang === 'ko';
  if (doc.documentElement) doc.documentElement.lang = ko ? 'ko' : 'en';
  for (const [selector, attr, koText, enText] of STATIC_TEXT) {
    doc.querySelector?.(selector)?.setAttribute?.(attr, ko ? koText : enText);
  }
}

/**
 * Apply the Hud's language now and after every click on the language button. Call after `hud.bind()`: its click
 * handler is registered first, so `hud.lang` is already the new language when this one runs.
 */
export function installStaticText({ hud, doc = globalThis.document } = {}) {
  const apply = () => applyStaticText(hud?.lang, doc);
  apply();
  doc?.getElementById?.('lang-toggle')?.addEventListener?.('click', apply);
  return { apply };
}
