// 범례 안내 패널(#legend)의 에이전트·품종 카드 및 상태·색깔 신호 데이터와 DOM 렌더러.
export const LEGEND_AGENTS = Object.freeze([
  Object.freeze({
    id: 'claude',
    swatch: 'background:#d97757;border-radius:50%;box-shadow:0 0 0 2px rgba(217,119,87,0.28)',
    label: Object.freeze({ ko: 'Claude', en: 'Claude' }),
    desc: Object.freeze({
      studio:   Object.freeze({ ko: '테라코타 · 베레모 + 골드 안테나', en: 'Terracotta · Beret + gold antenna' }),
      office:   Object.freeze({ ko: '테라코타 · 베레모 + 사원증', en: 'Terracotta · Beret + ID lanyard' }),
      palace:   Object.freeze({ ko: '테라코타 · 정자관 + 홍포 관복', en: 'Terracotta · Jeongjagwan crown + crimson robe' }),
      hanok:    Object.freeze({ ko: '테라코타 · 선비 유건 + 배자·망태기', en: 'Terracotta · Scholar Yugeon + vest & basket' }),
      starship: Object.freeze({ ko: '테라코타 · 커맨더 헬멧 + 아크 코어', en: 'Terracotta · Commander helmet + arc core' }),
    }),
  }),
  Object.freeze({
    id: 'codex',
    swatch: 'background:#10b981;border-radius:50%;box-shadow:0 0 0 2px rgba(16,185,129,0.28)',
    label: Object.freeze({ ko: 'Codex', en: 'Codex' }),
    desc: Object.freeze({
      studio:   Object.freeze({ ko: '에메랄드 · 사이버 바이저 + 발광 눈', en: 'Emerald · Cyber visor + glowing LEDs' }),
      office:   Object.freeze({ ko: '에메랄드 · 사이버 바이저 + 사원증', en: 'Emerald · Cyber visor + ID lanyard' }),
      palace:   Object.freeze({ ko: '에메랄드 · 흑립 갓 + 어사화·청포 관복', en: 'Emerald · Gat hat + royal Eosahwa plume' }),
      hanok:    Object.freeze({ ko: '에메랄드 · 대나무 삿갓 + 청록 배자', en: 'Emerald · Bamboo Satgat hat + jade vest' }),
      starship: Object.freeze({ ko: '에메랄드 · 전술 HUD 바이저 + 제트팩', en: 'Emerald · Tactical HUD visor + jetpack' }),
    }),
  }),
  Object.freeze({
    id: 'grok',
    swatch: 'background:#a855f7;border-radius:50%;box-shadow:0 0 0 2px rgba(168,85,247,0.28)',
    label: Object.freeze({ ko: 'Grok', en: 'Grok' }),
    desc: Object.freeze({
      studio:   Object.freeze({ ko: '바이올렛 · 블랙홀 궤도 링 + 별 위성', en: 'Violet · Black-hole orbit ring + star' }),
      office:   Object.freeze({ ko: '바이올렛 · 블랙홀 궤도 링 + 사원증', en: 'Violet · Black-hole orbit ring + lanyard' }),
      palace:   Object.freeze({ ko: '바이올렛 · 관상감 사모 + 황금 혼천의 링', en: 'Violet · Samo cap + golden armillary ring' }),
      hanok:    Object.freeze({ ko: '바이올렛 · 전립 + 금빛 상모·별 장식', en: 'Violet · Jeonrip cap + golden plume' }),
      starship: Object.freeze({ ko: '바이올렛 · 제로G 중력장 실드 + 위성', en: 'Violet · Zero-G gravity shield + orbiter' }),
    }),
  }),
  Object.freeze({
    id: 'agy-cli',
    swatch: 'background:#06b6d4;border-radius:50%;box-shadow:0 0 0 2px rgba(6,182,212,0.28)',
    label: Object.freeze({ ko: 'AGY·CLI', en: 'AGY·CLI' }),
    desc: Object.freeze({
      studio:   Object.freeze({ ko: '시안 · 이중 반중력 링 + 부유 크리스탈', en: 'Cyan · Dual anti-gravity halo + crystal' }),
      office:   Object.freeze({ ko: '시안 · 반중력 헤일로 링 + 사원증', en: 'Cyan · Anti-gravity halo + lanyard' }),
      palace:   Object.freeze({ ko: '시안 · 금관·옥비녀 + 비취 후광 링', en: 'Cyan · Gold crown & jade pin + halo' }),
      hanok:    Object.freeze({ ko: '시안 · 망건·옥관자 + 비취 구슬', en: 'Cyan · Headband & jade button + orb' }),
      starship: Object.freeze({ ko: '시안 · 그래비티 코어 링 + 플라즈마 제트', en: 'Cyan · Gravity core rings + plasma jet' }),
    }),
  }),
  Object.freeze({
    id: 'agy-app',
    swatch: 'background:#3b82f6;border-radius:50%;box-shadow:0 0 0 2px rgba(59,130,246,0.28)',
    label: Object.freeze({ ko: 'AGY·App', en: 'AGY·App' }),
    desc: Object.freeze({
      studio:   Object.freeze({ ko: '코발트 · 앱/IDE 반중력 링 + 크리스탈', en: 'Cobalt · App/IDE anti-gravity ring + crystal' }),
      office:   Object.freeze({ ko: '코발트 · 앱/IDE 반중력 링 + 사원증', en: 'Cobalt · App/IDE anti-gravity ring + lanyard' }),
      palace:   Object.freeze({ ko: '코발트 · 청옥 비녀 금관 + 청색 관복', en: 'Cobalt · Sapphire pin crown + blue robe' }),
      hanok:    Object.freeze({ ko: '코발트 · 청옥 관자 망건 + 쪽빛 배자', en: 'Cobalt · Sapphire headband + indigo vest' }),
      starship: Object.freeze({ ko: '코발트 · 함교 반중력 슈트 + 코발트 코어', en: 'Cobalt · Bridge gravity suit + cobalt core' }),
    }),
  }),
  Object.freeze({
    id: 'sub',
    swatch: 'background:conic-gradient(#ffd166,#38bdf8,#a855f7,#ffd166);border-radius:50%',
    label: Object.freeze({ ko: '서브에이전트', en: 'Subagent' }),
    desc: Object.freeze({
      studio:   Object.freeze({ ko: '소형(0.74×) · 회전 프로펠러 모자 (부모 색상 계승)', en: '0.74× mini · Spinning propeller cap (parent hue)' }),
      office:   Object.freeze({ ko: '소형(0.74×) · 회전 프로펠러 모자 (부모 색상 계승)', en: '0.74× mini · Spinning propeller cap (parent hue)' }),
      palace:   Object.freeze({ ko: '소형(0.74×) · 색동 바람개비 머리장식 (부모 색상 계승)', en: '0.74× mini · Spinning pinwheel ornament' }),
      hanok:    Object.freeze({ ko: '소형(0.74×) · 색동 바람개비 머리장식 (부모 색상 계승)', en: '0.74× mini · Spinning pinwheel ornament' }),
      starship: Object.freeze({ ko: '소형(0.74×) · 호버 드론 로터 (부모 색상 계승)', en: '0.74× mini · Hover drone rotor (parent hue)' }),
    }),
  }),
]);

export const LEGEND_DOGS = Object.freeze([
  Object.freeze({
    id: 'dog-golden',
    swatch: 'background:#d97757;border-radius:50%',
    label: Object.freeze({ ko: '골든 리트리버', en: 'Golden Retriever' }),
    desc: Object.freeze({ ko: 'Claude(테라코타 목줄) · 황금빛 장모 · 처진 귀 · 깃털 꼬리', en: 'Claude (Terracotta collar) · Golden coat · floppy ears' }),
  }),
  Object.freeze({
    id: 'dog-labrador',
    swatch: 'background:#10b981;border-radius:50%',
    label: Object.freeze({ ko: '래브라도', en: 'Labrador' }),
    desc: Object.freeze({ ko: 'Codex(에메랄드 목줄) · 크림 옐로 단모 · 처진 귀 · 수달 꼬리', en: 'Codex (Emerald collar) · Cream Lab coat · otter tail' }),
  }),
  Object.freeze({
    id: 'dog-jindo-white',
    swatch: 'background:#06b6d4;border-radius:50%',
    label: Object.freeze({ ko: '진돗개 백구', en: 'White Jindo' }),
    desc: Object.freeze({ ko: 'AGY·CLI / Claude · 순백색 털 · 쫑긋한 삼각 귀 · 말린 꼬리', en: 'AGY·CLI / Claude · Snow-white coat · prick ears · curled tail' }),
  }),
  Object.freeze({
    id: 'dog-jindo-black',
    swatch: 'background:#10b981;border-radius:50%',
    label: Object.freeze({ ko: '진돗개 흑구', en: 'Black Jindo' }),
    desc: Object.freeze({ ko: 'AGY·CLI / Codex · 윤기 나는 흑색 털 · 쫑긋한 삼각 귀 · 말린 꼬리', en: 'AGY·CLI / Codex · Obsidian black coat · prick ears · curled tail' }),
  }),
  Object.freeze({
    id: 'dog-jindo-bear',
    swatch: 'background:#3b82f6;border-radius:50%',
    label: Object.freeze({ ko: '진돗개 반달곰', en: 'Bear Jindo' }),
    desc: Object.freeze({ ko: 'AGY·App(코발트 목줄) · 네눈박이 황갈색 눈점 + 흰 반달 가슴털', en: 'AGY·App (Cobalt) · Tan eyebrow spots + white moon-bear chest crest' }),
  }),
  Object.freeze({
    id: 'dog-collie',
    swatch: 'background:#a855f7;border-radius:50%',
    label: Object.freeze({ ko: '보더 콜리', en: 'Border Collie' }),
    desc: Object.freeze({ ko: 'Grok(바이올렛 목줄) · 흑백 턱시도 · 흰 이마 줄무늬 · 반접힌 귀', en: 'Grok (Violet collar) · Black & white coat · white blaze · semi-prick ears' }),
  }),
  Object.freeze({
    id: 'dog-corgi',
    swatch: 'background:conic-gradient(#ffd166,#38bdf8,#a855f7,#ffd166);border-radius:50%',
    label: Object.freeze({ ko: '웰시 코기', en: 'Welsh Corgi' }),
    desc: Object.freeze({ ko: '서브에이전트(0.74×) · 황갈색·흰 가슴털 · 식빵 엉덩이 단미', en: 'Subagent (0.74×) · Ginger & white bib · fluffy Corgi bobtail' }),
  }),
  Object.freeze({
    id: 'dog-shiba',
    swatch: 'background:conic-gradient(#ffd166,#38bdf8,#a855f7,#ffd166);border-radius:50%',
    label: Object.freeze({ ko: '시바견', en: 'Shiba Inu' }),
    desc: Object.freeze({ ko: '서브에이전트(0.74×) · 적시바 · 크림색 볼(우라지로) · 도넛 꼬리', en: 'Subagent (0.74×) · Red sesame · cream cheeks · curled donut tail' }),
  }),
]);

export const LEGEND_CATS = Object.freeze([
  Object.freeze({
    id: 'cat-savannah',
    swatch: 'background:#d97757;border-radius:50%',
    label: Object.freeze({ ko: '사바나·아세라', en: 'Savannah·Ashera' }),
    desc: Object.freeze({ ko: 'Claude(테라코타 방울) · 최고가 캣 · 황금빛 치타 점무늬 · 서벌 귀', en: 'Claude (Terracotta bell) · Highest-priced cat · cheetah spots & serval ears' }),
  }),
  Object.freeze({
    id: 'cat-bengal',
    swatch: 'background:#10b981;border-radius:50%',
    label: Object.freeze({ ko: '벵갈', en: 'Bengal' }),
    desc: Object.freeze({ ko: 'Codex(에메랄드 방울) · 호박색 표범 로제트 무늬 · 에메랄드 눈', en: 'Codex (Emerald bell) · Amber leopard rosettes · emerald eyes' }),
  }),
  Object.freeze({
    id: 'cat-british',
    swatch: 'background:#a855f7;border-radius:50%',
    label: Object.freeze({ ko: '브리티시·러시안', en: 'British·Russian' }),
    desc: Object.freeze({ ko: 'Grok(바이올렛 방울) · 은청색 벨벳 모질 · 통통한 볼 · 호박색 눈', en: 'Grok (Violet bell) · Plush silver-blue coat · chubby cheeks' }),
  }),
  Object.freeze({
    id: 'cat-siamese',
    swatch: 'background:#06b6d4;border-radius:50%',
    label: Object.freeze({ ko: '샤미즈(샴)', en: 'Siamese' }),
    desc: Object.freeze({ ko: 'AGY·CLI(시안 방울) · 크림색 몸통 + 초콜릿 얼굴·귀·발 포인트', en: 'AGY·CLI (Cyan bell) · Cream body + chocolate seal-point mask & ears' }),
  }),
  Object.freeze({
    id: 'cat-ragdoll',
    swatch: 'background:#3b82f6;border-radius:50%',
    label: Object.freeze({ ko: '랙돌·페르시안', en: 'Ragdoll·Persian' }),
    desc: Object.freeze({ ko: 'AGY·App(코발트 방울) · 풍성한 흰 목 갈기 털 · 블루 바이컬러', en: 'AGY·App (Cobalt bell) · Fluffy white neck ruff · blue-bicolor coat' }),
  }),
  Object.freeze({
    id: 'cat-fold',
    swatch: 'background:conic-gradient(#ffd166,#38bdf8,#a855f7,#ffd166);border-radius:50%',
    label: Object.freeze({ ko: '스코티시 폴드', en: 'Scottish Fold' }),
    desc: Object.freeze({ ko: '서브에이전트(0.74×) · 동그랗게 접힌 귀 · 살구빛 치즈 태비', en: 'Subagent (0.74×) · Adorable folded ears · honey-apricot tabby' }),
  }),
]);

export const LEGEND_SIGNALS = Object.freeze([
  Object.freeze({
    id: 'speech',
    swatch: 'background:#fffdf8;border:1.5px solid #2b2a27;border-radius:6px',
    label: Object.freeze({ ko: '일반 말풍선', en: 'Speech Bubble' }),
    desc: Object.freeze({ ko: '도구 실행 · 대답 · 작업 완료', en: 'Tool execution · reply · task done' }),
  }),
  Object.freeze({
    id: 'think',
    swatch: 'background:#fffdf8;border:1.5px dotted #6b6358;border-radius:50%',
    label: Object.freeze({ ko: '구름 말풍선', en: 'Cloud Bubble' }),
    desc: Object.freeze({ ko: '에이전트 추론 · 생각 중 (손글씨체)', en: 'Internal reasoning · thinking' }),
  }),
  Object.freeze({
    id: 'ask',
    swatch: 'background:#fff3c4;border:1.5px solid #e0a32a;border-radius:6px',
    label: Object.freeze({ ko: '노랑·주황 배지', en: 'Amber Badge' }),
    desc: Object.freeze({ ko: '질문(선택지 칩) · 권한·계획 승인 대기', en: 'User question or tool/plan approval wait' }),
  }),
  Object.freeze({
    id: 'error',
    swatch: 'background:linear-gradient(135deg,#e5534b 55%,#4fa3ff 55%);border-radius:4px',
    label: Object.freeze({ ko: '빨강·파란 땀', en: 'Red + Sweat' }),
    desc: Object.freeze({ ko: '도구 실패·오류 말풍선 + 파란 식은땀 방울', en: 'Tool error bubble + blue sweat drops' }),
  }),
  Object.freeze({
    id: 'denied',
    swatch: 'background:#ece7dc;border:1.5px dashed #8a8175;border-radius:6px',
    label: Object.freeze({ ko: '회색 점선', en: 'Dashed Gray' }),
    desc: Object.freeze({ ko: '권한 요청 거절 · 작업 방향 변경 지시', en: 'Permission denied or redirected by user' }),
  }),
  Object.freeze({
    id: 'floor',
    swatch: 'background:transparent;border:2px solid #2fb36a;box-shadow:0 0 0 2px rgba(196,61,52,0.35);border-radius:50%',
    label: Object.freeze({ ko: '층 테두리 링', en: 'Floor Ring' }),
    desc: Object.freeze({ ko: '초록 펄스 = 다른 층 새 활동 · 빨강 = 오류 발생', en: 'Green pulse = new activity · Red = error' }),
  }),
  Object.freeze({
    id: 'source',
    swatch: 'background:linear-gradient(90deg,#2fb36a 34%,#e0a32a 34% 67%,#7c5cd6 67%);border-radius:50%',
    label: Object.freeze({ ko: '연결 상태 점', en: 'Source Dot' }),
    desc: Object.freeze({ ko: '초록 라이브 · 노랑 재연결 · 보라 재생 · 기본 데모', en: 'Green Live · Amber Retry · Purple Replay' }),
  }),
]);
