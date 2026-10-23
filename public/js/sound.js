// 캐릭터 음성 추상화(CharacterVoice.makeSound) 및 품종·테마별 구체 구현(DogVoice.bark, CatVoice.meow/purr, SynthVoice).
// 외부 오디오 파일 없이 Web Audio API 로 합성하며, 공간 테마와 완전히 독립적으로 캐릭터/보이스 설정을 따른다.
import { activeCharThemeOf, activeVoiceModeOf, langOf, resolveAgentAppearance } from './rooms.js';

const DOG_ORDER = ['golden', 'labrador', 'jindo-white', 'jindo-black', 'jindo-bear', 'collie', 'corgi', 'shiba'];
const CAT_ORDER = ['savannah', 'mainecoon', 'persian', 'bengal', 'british', 'siamese', 'ragdoll', 'fold'];

function hashId(s = '') {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function pickPetBreed(agent = {}, theme = activeCharThemeOf()) {
  if (agent.petBreed) return agent.petBreed;
  const resolved = resolveAgentAppearance(agent, { charTheme: theme });
  if (resolved.breed) return resolved.breed;
  const h = hashId(agent.id || '');
  const isCat = theme === 'cats' || String(theme).startsWith('cat:');
  if (!isCat) {
    if (agent.isSub) return h % 2 === 0 ? 'corgi' : 'shiba';
    if (agent.agent === 'claude-code') return agent.surface === 'app' ? 'golden' : 'shiba';
    if (agent.agent === 'codex') return agent.surface === 'app' ? 'jindo-black' : 'labrador';
    if (agent.agent === 'grok') return 'collie';
    if (agent.agent === 'antigravity') return agent.surface === 'cli' ? 'jindo-white' : 'jindo-bear';
    return DOG_ORDER[h % DOG_ORDER.length];
  }
  if (agent.isSub) return 'fold';
  if (agent.agent === 'claude-code') return agent.surface === 'app' ? 'savannah' : 'mainecoon';
  if (agent.agent === 'codex') return agent.surface === 'app' ? 'persian' : 'bengal';
  if (agent.agent === 'grok') return 'british';
  if (agent.agent === 'antigravity') return agent.surface === 'cli' ? 'siamese' : 'ragdoll';
  return CAT_ORDER[h % CAT_ORDER.length];
}

let audioCtx = null;
let soundOn = true;

export const isSoundEnabled = () => soundOn;
export function setSoundEnabled(v) {
  soundOn = !!v;
  if (soundOn) ensureAudio();
  return soundOn;
}

function ensureAudio() {
  if (!soundOn || typeof window === 'undefined') return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) {
    try { audioCtx = new Ctx(); } catch { return null; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume?.().catch(() => {});
  return audioCtx;
}

function tone(ctx, type, fStart, fEnd, start, dur, gainVal = 0.12) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(fStart, start);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, fEnd), start + dur);
  gain.gain.setValueAtTime(0.001, start);
  gain.gain.linearRampToValueAtTime(gainVal, start + dur * 0.18);
  gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + dur + 0.01);
}

// 추상 기반 클래스: 모든 캐릭터 보이스는 makeSound(trigger, opts) 인터페이스를 따른다.
export class CharacterVoice {
  makeSound(trigger = 'click', opts = {}) {
    const spec = this.resolve(trigger, opts);
    const ctx = ensureAudio();
    if (ctx && !opts.silent) {
      try { this.play(ctx, spec, opts); } catch { /* 브라우저 오디오 정책 차단 시 무시 */ }
    }
    return spec;
  }

  resolve() {
    throw new Error('CharacterVoice.resolve must be implemented by subclass');
  }

  play() {
    throw new Error('CharacterVoice.play must be implemented by subclass');
  }
}

// 강아지 보이스 구현체: bark(멍멍/왈왈), happyBark(신난 멍멍), whimper(낑)
export class DogVoice extends CharacterVoice {
  constructor(breed = 'golden', isSub = false) {
    super();
    this.breed = breed;
    this.small = isSub || breed === 'corgi' || breed === 'shiba';
  }

  resolve(trigger) {
    if (trigger === 'error') {
      return { soundId: 'whimper', ko: '낑…', en: 'Whine…', duration: 0.7 };
    }
    if (trigger === 'pet' || trigger === 'done') {
      return {
        soundId: 'happyBark',
        ko: this.small ? '총총! 멍! ♥' : '멍멍! ♪',
        en: this.small ? 'Yap! Yap! ♥' : 'Woof! Woof! ♪',
        duration: 0.85,
      };
    }
    return {
      soundId: 'bark',
      ko: this.small ? '멍! 멍!' : this.breed.startsWith('jindo') ? '왈! 왈!' : '멍멍!',
      en: this.small ? 'Yap! Yap!' : 'Woof! Woof!',
      duration: 0.65,
    };
  }

  play(ctx, spec) {
    if (spec.soundId === 'whimper') return this.whimper(ctx);
    if (spec.soundId === 'happyBark') return this.happyBark(ctx);
    return this.bark(ctx);
  }

  bark(ctx, pitchMult = 1) {
    const now = ctx.currentTime;
    const base = (this.small ? 330 : 210) * pitchMult;
    for (const [offset, mult] of [[0, 1], [0.15, 1.08]]) {
      tone(ctx, 'sawtooth', base * 1.45 * mult, base * 0.68 * mult, now + offset, 0.11, 0.11);
      tone(ctx, 'triangle', base * 2.1 * mult, base * 0.95 * mult, now + offset, 0.11, 0.08);
    }
  }

  happyBark(ctx) {
    this.bark(ctx, 1.12);
    const now = ctx.currentTime;
    const base = this.small ? 420 : 280;
    tone(ctx, 'triangle', base, base * 1.35, now + 0.31, 0.14, 0.1);
  }

  whimper(ctx) {
    const now = ctx.currentTime;
    tone(ctx, 'sine', 520, 290, now, 0.22, 0.08);
    tone(ctx, 'sine', 460, 240, now + 0.25, 0.24, 0.07);
  }
}

// 고양이 보이스 구현체: meow(야옹/냐옹), purr(골골송), hiss(하악/먀앗)
export class CatVoice extends CharacterVoice {
  constructor(breed = 'savannah', isSub = false) {
    super();
    this.breed = breed;
    this.small = isSub || breed === 'fold';
  }

  resolve(trigger) {
    if (trigger === 'error') {
      return { soundId: 'hiss', ko: '하악! 먀앗!', en: 'Hiss! Mew!', duration: 0.75 };
    }
    if (trigger === 'work' || trigger === 'think' || trigger === 'pet') {
      return {
        soundId: trigger === 'pet' ? 'meow' : 'purr',
        ko: trigger === 'pet' ? '야옹~ 골골 ♥' : '골골골… ♪',
        en: trigger === 'pet' ? 'Meow~ Purr ♥' : 'Purr… ♪',
        duration: 0.85,
      };
    }
    return {
      soundId: 'meow',
      ko: this.small ? '냐앙~ ♪' : '야옹~ ♪',
      en: this.small ? 'Mew~ ♪' : 'Meow~ ♪',
      duration: 0.7,
    };
  }

  play(ctx, spec) {
    if (spec.soundId === 'hiss') return this.hiss(ctx);
    if (spec.soundId === 'purr') return this.purr(ctx);
    return this.meow(ctx);
  }

  meow(ctx) {
    const now = ctx.currentTime;
    const f0 = this.small ? 580 : 480;
    tone(ctx, 'triangle', f0, f0 * 1.48, now, 0.18, 0.11);
    tone(ctx, 'sine', f0 * 1.48, f0 * 0.86, now + 0.16, 0.24, 0.1);
  }

  purr(ctx) {
    const now = ctx.currentTime;
    for (let i = 0; i < 4; i++) {
      tone(ctx, 'sawtooth', 58, 42, now + i * 0.09, 0.08, 0.045);
    }
  }

  hiss(ctx) {
    const now = ctx.currentTime;
    tone(ctx, 'sawtooth', 880, 420, now, 0.22, 0.09);
  }
}

// 인간형 테마 보이스 구현체: 궁궐·한옥(옥소리 차임), 스타십(R2 비프), 스튜디오·오피스(마림바 블립)
export class SynthVoice extends CharacterVoice {
  constructor(theme = 'studio', isSub = false) {
    super();
    this.theme = theme;
    this.small = isSub;
  }

  resolve(trigger) {
    const id = this.theme === 'palace' || this.theme === 'hanok' ? 'chime'
      : this.theme === 'starship' ? 'chirp' : 'blip';
    if (trigger === 'error') return { soundId: id, ko: '앗! ♪', en: 'Oops! ♪', duration: 0.55 };
    if (trigger === 'pet') return { soundId: id, ko: '반가워요! ♪', en: 'Hello! ♪', duration: 0.65 };
    return { soundId: id, ko: '톡! ♪', en: 'Blip! ♪', duration: 0.5 };
  }

  play(ctx, spec) {
    const now = ctx.currentTime;
    const base = this.small ? 660 : 520;
    if (spec.soundId === 'chime') {
      tone(ctx, 'sine', base, base * 1.5, now, 0.28, 0.09);
    } else if (spec.soundId === 'chirp') {
      tone(ctx, 'square', base * 1.1, base * 1.65, now, 0.09, 0.06);
      tone(ctx, 'square', base * 1.65, base * 1.25, now + 0.1, 0.09, 0.06);
    } else {
      tone(ctx, 'triangle', base, base * 1.25, now, 0.12, 0.08);
    }
  }
}

export function voiceFor(agent, theme = activeCharThemeOf(), voiceMode = activeVoiceModeOf()) {
  const resolved = resolveAgentAppearance(agent || {}, { charTheme: theme, voiceMode });
  if (resolved.voiceKind === 'dogs' || theme === 'dogs') {
    return new DogVoice(resolved.breed || pickPetBreed(agent, 'dogs'), !!agent?.isSub);
  }
  if (resolved.voiceKind === 'cats' || theme === 'cats') {
    return new CatVoice(resolved.breed || pickPetBreed(agent, 'cats'), !!agent?.isSub);
  }
  return new SynthVoice(resolved.voiceStyle || theme, !!agent?.isSub);
}

export function makeSound(agent, trigger = 'click', opts = {}) {
  const charTheme = opts.charTheme ?? opts.theme ?? activeCharThemeOf();
  const vMode = opts.voiceMode ?? activeVoiceModeOf();
  if (vMode === 'mute' && !opts.force) return null;
  const lang = langOf(opts.lang);
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (!opts.force && agent?.lastSoundAt && now - agent.lastSoundAt < 1400) return null;
  if (agent) agent.lastSoundAt = now;
  const voice = voiceFor(agent || {}, charTheme, vMode === 'mute' ? 'auto' : vMode);
  const spec = voice.makeSound(trigger, { ...opts, silent: opts.silent || vMode === 'mute' });
  const text = spec[lang] || spec.ko;
  if (agent) {
    agent.soundT = spec.duration;
    agent.vocalText = text;
  }
  return { ...spec, text };
}
