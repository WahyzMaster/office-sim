// 범례 안내 패널(#legend)의 에이전트·품종 카드, 캐릭터 카탈로그, LLM별 캐릭터 배정(llmCharMap), 독립 선택 상태 관리.
export const LEGEND_AGENTS = Object.freeze([
  Object.freeze({
    id: 'claude-app',
    slot: 'claude-code:app',
    swatch: 'background:#f08c5b;border-radius:50%;box-shadow:0 0 0 2px rgba(240,140,91,0.28)',
    label: Object.freeze({ ko: 'Claude/Claude Code·App', en: 'Claude/Claude Code·App' }),
    desc: Object.freeze({
      studio:   Object.freeze({ ko: '코랄 · 데스크톱 헤일로 + 베레모·안테나', en: 'Coral · Desktop halo + beret & gold antenna' }),
      office:   Object.freeze({ ko: '코랄 · 데스크톱 헤일로 + 사원증', en: 'Coral · Desktop halo + ID lanyard' }),
      palace:   Object.freeze({ ko: '코랄 · 금관 정자관 + 주홍 관복', en: 'Coral · Gold-rimmed Jeongjagwan + vermilion robe' }),
      hanok:    Object.freeze({ ko: '코랄 · 비단 유건 + 코랄 배자·서책', en: 'Coral · Silk Yugeon + coral vest & books' }),
      starship: Object.freeze({ ko: '코랄 · 함교 지휘관 바이저 + 아크 코어', en: 'Coral · Bridge commander visor + arc core' }),
    }),
  }),
  Object.freeze({
    id: 'claude-cli',
    slot: 'claude-code:cli',
    swatch: 'background:#d97757;border-radius:50%;box-shadow:0 0 0 2px rgba(217,119,87,0.28)',
    label: Object.freeze({ ko: 'Claude Code·CLI', en: 'Claude Code·CLI' }),
    desc: Object.freeze({
      studio:   Object.freeze({ ko: '테라코타 · 터미널 챙모자 + 골드 안테나', en: 'Terracotta · Terminal visor cap + gold antenna' }),
      office:   Object.freeze({ ko: '테라코타 · 터미널 챙모자 + 사원증', en: 'Terracotta · Terminal visor cap + ID lanyard' }),
      palace:   Object.freeze({ ko: '테라코타 · 정자관 + 홍포 관복', en: 'Terracotta · Jeongjagwan crown + crimson robe' }),
      hanok:    Object.freeze({ ko: '테라코타 · 선비 유건 + 배자·망태기', en: 'Terracotta · Scholar Yugeon + vest & basket' }),
      starship: Object.freeze({ ko: '테라코타 · 엔지니어 헬멧 + 아크 코어', en: 'Terracotta · Engineer helmet + arc core' }),
    }),
  }),
  Object.freeze({
    id: 'codex-app',
    slot: 'codex:app',
    swatch: 'background:#14b8a6;border-radius:50%;box-shadow:0 0 0 2px rgba(20,184,166,0.28)',
    label: Object.freeze({ ko: 'ChatGPT/Codex·App', en: 'ChatGPT/Codex·App' }),
    desc: Object.freeze({
      studio:   Object.freeze({ ko: '민트 틸 · 오비탈 헤일로 + 사이버 바이저', en: 'Mint Teal · Orbital halo + cyber visor' }),
      office:   Object.freeze({ ko: '민트 틸 · 오비탈 헤일로 + 사원증', en: 'Mint Teal · Orbital halo + ID lanyard' }),
      palace:   Object.freeze({ ko: '민트 틸 · 옥장식 흑립 갓 + 비취 관복', en: 'Mint Teal · Jade-crested Gat + jade robe' }),
      hanok:    Object.freeze({ ko: '민트 틸 · 청죽 삿갓 + 비취 배자', en: 'Mint Teal · Celadon Satgat + jade vest' }),
      starship: Object.freeze({ ko: '민트 틸 · 궤도 통신 헤드셋 + 제트팩', en: 'Mint Teal · Orbital comms headset + jetpack' }),
    }),
  }),
  Object.freeze({
    id: 'codex-cli',
    slot: 'codex:cli',
    swatch: 'background:#10b981;border-radius:50%;box-shadow:0 0 0 2px rgba(16,185,129,0.28)',
    label: Object.freeze({ ko: 'Codex·CLI', en: 'Codex·CLI' }),
    desc: Object.freeze({
      studio:   Object.freeze({ ko: '에메랄드 · 터미널 바이저 + 육각 헤드셋', en: 'Emerald · Terminal visor + hex headset' }),
      office:   Object.freeze({ ko: '에메랄드 · 터미널 바이저 + 사원증', en: 'Emerald · Terminal visor + ID lanyard' }),
      palace:   Object.freeze({ ko: '에메랄드 · 흑립 갓 + 어사화·청포 관복', en: 'Emerald · Gat hat + royal Eosahwa plume' }),
      hanok:    Object.freeze({ ko: '에메랄드 · 대나무 삿갓 + 청록 배자', en: 'Emerald · Bamboo Satgat hat + jade vest' }),
      starship: Object.freeze({ ko: '에메랄드 · 전술 HUD 바이저 + 제트팩', en: 'Emerald · Tactical HUD visor + jetpack' }),
    }),
  }),
  Object.freeze({
    id: 'grok',
    slot: 'grok',
    swatch: 'background:#a855f7;border-radius:50%;box-shadow:0 0 0 2px rgba(168,85,247,0.28)',
    label: Object.freeze({ ko: 'Grok Build·CLI', en: 'Grok Build·CLI' }),
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
    slot: 'antigravity:cli',
    swatch: 'background:#06b6d4;border-radius:50%;box-shadow:0 0 0 2px rgba(6,182,212,0.28)',
    label: Object.freeze({ ko: 'Antigravity·CLI', en: 'Antigravity·CLI' }),
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
    slot: 'antigravity:app',
    swatch: 'background:#3b82f6;border-radius:50%;box-shadow:0 0 0 2px rgba(59,130,246,0.28)',
    label: Object.freeze({ ko: 'Antigravity·App', en: 'Antigravity·App' }),
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
    slot: 'sub',
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
  Object.freeze({ id: 'dog-golden', spec: 'dog:golden', swatch: 'background:#f08c5b;border-radius:50%', label: Object.freeze({ ko: '골든 리트리버', en: 'Golden Retriever' }), desc: Object.freeze({ ko: 'Claude·App(코랄 목줄) · 황금빛 장모 · 처진 귀 · 깃털 꼬리', en: 'Claude·App (Coral collar) · Golden coat · floppy ears' }) }),
  Object.freeze({ id: 'dog-shiba', spec: 'dog:shiba', swatch: 'background:#d97757;border-radius:50%', label: Object.freeze({ ko: '시바견', en: 'Shiba Inu' }), desc: Object.freeze({ ko: 'Claude Code·CLI(테라코타 목줄) · 적시바 · 크림색 볼 · 도넛 꼬리', en: 'Claude Code·CLI (Terracotta) · Red sesame · curled donut tail' }) }),
  Object.freeze({ id: 'dog-jindo-black', spec: 'dog:jindo-black', swatch: 'background:#14b8a6;border-radius:50%', label: Object.freeze({ ko: '진돗개 흑구', en: 'Black Jindo' }), desc: Object.freeze({ ko: 'ChatGPT·App(민트 목줄) · 윤기 나는 흑색 털 · 쫑긋한 삼각 귀 · 말린 꼬리', en: 'ChatGPT·App (Mint collar) · Obsidian black coat · prick ears' }) }),
  Object.freeze({ id: 'dog-labrador', spec: 'dog:labrador', swatch: 'background:#10b981;border-radius:50%', label: Object.freeze({ ko: '래브라도', en: 'Labrador' }), desc: Object.freeze({ ko: 'Codex·CLI(에메랄드 목줄) · 크림 옐로 단모 · 처진 귀 · 수달 꼬리', en: 'Codex·CLI (Emerald collar) · Cream Lab coat · otter tail' }) }),
  Object.freeze({ id: 'dog-collie', spec: 'dog:collie', swatch: 'background:#a855f7;border-radius:50%', label: Object.freeze({ ko: '보더 콜리', en: 'Border Collie' }), desc: Object.freeze({ ko: 'Grok Build·CLI(바이올렛 목줄) · 흑백 턱시도 · 흰 이마 줄무늬 · 반접힌 귀', en: 'Grok Build·CLI (Violet collar) · Black & white coat · white blaze' }) }),
  Object.freeze({ id: 'dog-jindo-white', spec: 'dog:jindo-white', swatch: 'background:#06b6d4;border-radius:50%', label: Object.freeze({ ko: '진돗개 백구', en: 'White Jindo' }), desc: Object.freeze({ ko: 'Antigravity·CLI(시안 목줄) · 순백색 털 · 쫑긋한 삼각 귀 · 말린 꼬리', en: 'Antigravity·CLI (Cyan collar) · Snow-white coat · prick ears' }) }),
  Object.freeze({ id: 'dog-jindo-bear', spec: 'dog:jindo-bear', swatch: 'background:#3b82f6;border-radius:50%', label: Object.freeze({ ko: '진돗개 반달곰', en: 'Bear Jindo' }), desc: Object.freeze({ ko: 'Antigravity·App(코발트 목줄) · 네눈박이 황갈색 눈점 + 흰 반달 가슴털', en: 'Antigravity·App (Cobalt) · Tan eyebrow spots + white moon-bear chest crest' }) }),
  Object.freeze({ id: 'dog-corgi', spec: 'dog:corgi', swatch: 'background:conic-gradient(#ffd166,#38bdf8,#a855f7,#ffd166);border-radius:50%', label: Object.freeze({ ko: '웰시 코기', en: 'Welsh Corgi' }), desc: Object.freeze({ ko: '서브에이전트(0.74×) · 황갈색·흰 가슴털 · 식빵 엉덩이 단미', en: 'Subagent (0.74×) · Ginger & white bib · fluffy Corgi bobtail' }) }),
]);

export const LEGEND_CATS = Object.freeze([
  Object.freeze({ id: 'cat-savannah', spec: 'cat:savannah', swatch: 'background:#f08c5b;border-radius:50%', label: Object.freeze({ ko: '사바나·아세라', en: 'Savannah·Ashera' }), desc: Object.freeze({ ko: 'Claude·App(코랄 방울) · 최고가 캣 · 황금빛 치타 점무늬 · 서벌 귀', en: 'Claude·App (Coral bell) · Highest-priced cat · cheetah spots & serval ears' }) }),
  Object.freeze({ id: 'cat-mainecoon', spec: 'cat:mainecoon', swatch: 'background:#d97757;border-radius:50%', label: Object.freeze({ ko: '메인쿤', en: 'Maine Coon' }), desc: Object.freeze({ ko: 'Claude Code·CLI(테라코타 방울) · 거대 장모종 · 스라소니 귀털 · 사자 갈기', en: 'Claude Code·CLI (Terracotta bell) · Giant Maine Coon · lynx ear tufts & lion ruff' }) }),
  Object.freeze({ id: 'cat-persian', spec: 'cat:persian', swatch: 'background:#14b8a6;border-radius:50%', label: Object.freeze({ ko: '친칠라 페르시안', en: 'Chinchilla Persian' }), desc: Object.freeze({ ko: 'ChatGPT·App(민트 방울) · 은빛 실버 화이트 장모 · 에메랄드빛 청록 눈', en: 'ChatGPT·App (Mint bell) · Silver-white Chinchilla Persian · emerald-teal eyes' }) }),
  Object.freeze({ id: 'cat-bengal', spec: 'cat:bengal', swatch: 'background:#10b981;border-radius:50%', label: Object.freeze({ ko: '벵갈', en: 'Bengal' }), desc: Object.freeze({ ko: 'Codex·CLI(에메랄드 방울) · 호박색 표범 로제트 무늬 · 에메랄드 눈', en: 'Codex·CLI (Emerald bell) · Amber leopard rosettes · emerald eyes' }) }),
  Object.freeze({ id: 'cat-british', spec: 'cat:british', swatch: 'background:#a855f7;border-radius:50%', label: Object.freeze({ ko: '브리티시·러시안', en: 'British·Russian' }), desc: Object.freeze({ ko: 'Grok Build·CLI(바이올렛 방울) · 은청색 벨벳 모질 · 통통한 볼 · 호박색 눈', en: 'Grok Build·CLI (Violet bell) · Plush silver-blue coat · chubby cheeks' }) }),
  Object.freeze({ id: 'cat-siamese', spec: 'cat:siamese', swatch: 'background:#06b6d4;border-radius:50%', label: Object.freeze({ ko: '샤미즈(샴)', en: 'Siamese' }), desc: Object.freeze({ ko: 'Antigravity·CLI(시안 방울) · 크림색 몸통 + 초콜릿 얼굴·귀·발 포인트', en: 'Antigravity·CLI (Cyan bell) · Cream body + chocolate seal-point mask & ears' }) }),
  Object.freeze({ id: 'cat-ragdoll', spec: 'cat:ragdoll', swatch: 'background:#3b82f6;border-radius:50%', label: Object.freeze({ ko: '랙돌', en: 'Ragdoll' }), desc: Object.freeze({ ko: 'Antigravity·App(코발트 방울) · 풍성한 흰 목 갈기 털 · 블루 바이컬러', en: 'Antigravity·App (Cobalt bell) · Fluffy white neck ruff · blue-bicolor coat' }) }),
  Object.freeze({ id: 'cat-fold', spec: 'cat:fold', swatch: 'background:conic-gradient(#ffd166,#38bdf8,#a855f7,#ffd166);border-radius:50%', label: Object.freeze({ ko: '스코티시 폴드', en: 'Scottish Fold' }), desc: Object.freeze({ ko: '서브에이전트(0.74×) · 동그랗게 접힌 귀 · 살구빛 치즈 태비', en: 'Subagent (0.74×) · Adorable folded ears · honey-apricot tabby' }) }),
]);

export const LEGEND_BOTS = Object.freeze([
  Object.freeze({ id: 'bot-claude-duet', spec: 'bot:claude-duet', swatch: 'background:#f08c5b;border-radius:50%', label: Object.freeze({ ko: '클로드 듀엣 봇', en: 'Claude Duet' }), desc: Object.freeze({ ko: 'Claude·App · 코랄 포슬린 섀시 · 트윈 하모닉 공명 링 + 듀엣 안테나', en: 'Claude·App · Coral-porcelain chassis · twin harmonic duet rings' }) }),
  Object.freeze({ id: 'bot-claude-code', spec: 'bot:claude-code', swatch: 'background:#d97757;border-radius:50%', label: Object.freeze({ ko: '클로드 코드 봇', en: 'Claude Bot' }), desc: Object.freeze({ ko: 'Claude Code·CLI · 테라코타 메카 · 터미널 챙 바이저 + 스파크 안테나', en: 'Claude Code·CLI · Terracotta mech · terminal visor & spark antenna' }) }),
  Object.freeze({ id: 'bot-chatgpt-dot', spec: 'bot:chatgpt-dot', swatch: 'background:#14b8a6;border-radius:50%', label: Object.freeze({ ko: '챗GPT 도트 봇', en: 'ChatGPT Dot' }), desc: Object.freeze({ ko: 'ChatGPT·App · 민트 구형 도트 오브 · 보이스 파동 링 + 자기부상 호버', en: 'ChatGPT·App · Mint spherical Dot orb · voice-wave ring & hover disc' }) }),
  Object.freeze({ id: 'bot-codex-droid', spec: 'bot:codex-droid', swatch: 'background:#10b981;border-radius:50%', label: Object.freeze({ ko: '코덱스 드로이드', en: 'Codex Droid' }), desc: Object.freeze({ ko: 'Codex·CLI · 에메랄드 헥사 장갑 · 매트릭스 HUD 바이저 + 트윈 셀', en: 'Codex·CLI · Emerald hex-armor · matrix HUD visor & twin cells' }) }),
  Object.freeze({ id: 'bot-grok-bot', spec: 'bot:grok-bot', swatch: 'background:#a855f7;border-radius:50%', label: Object.freeze({ ko: '그록 봇', en: 'Grok Bot' }), desc: Object.freeze({ ko: 'Grok Build·CLI · 옵시디언·바이올렛 · 블랙홀 토성 궤도 링 + X-코어', en: 'Grok Build·CLI · Obsidian-violet · Saturn orbit ring & X-core' }) }),
  Object.freeze({ id: 'bot-agy-probe', spec: 'bot:agy-probe', swatch: 'background:#06b6d4;border-radius:50%', label: Object.freeze({ ko: 'AGY 프로브 봇', en: 'AGY Probe Bot' }), desc: Object.freeze({ ko: 'Antigravity·CLI · 시안 제로G 프로브 · 이중 반중력 링 + 프리즘 코어', en: 'Antigravity·CLI · Cyan zero-G probe · dual gravity rings & prism' }) }),
  Object.freeze({ id: 'bot-agy-mech', spec: 'bot:agy-mech', swatch: 'background:#3b82f6;border-radius:50%', label: Object.freeze({ ko: 'AGY 아스트랄 봇', en: 'AGY Astral Bot' }), desc: Object.freeze({ ko: 'Antigravity·App · 코발트 센티넬 메카 · 사파이어 크라운 + 플라즈마 제트', en: 'Antigravity·App · Cobalt sentinel mech · sapphire crown & thrusters' }) }),
  Object.freeze({ id: 'bot-mini-drone', spec: 'bot:mini-drone', swatch: 'background:conic-gradient(#ffd166,#38bdf8,#a855f7,#ffd166);border-radius:50%', label: Object.freeze({ ko: '미니 드론 봇', en: 'Mini Drone Bot' }), desc: Object.freeze({ ko: '서브에이전트(0.74×) · 동축 로터 드론 봇 · 부모 색상 계승 + 호버 포드', en: 'Subagent (0.74×) · Coaxial rotor drone bot · inherits parent hue' }) }),
]);

export const LEGEND_SIGNALS = Object.freeze([
  Object.freeze({ id: 'speech', swatch: 'background:#fffdf8;border:1.5px solid #2b2a27;border-radius:6px', label: Object.freeze({ ko: '일반 말풍선', en: 'Speech Bubble' }), desc: Object.freeze({ ko: '도구 실행 · 대답 · 작업 완료', en: 'Tool execution · reply · task done' }) }),
  Object.freeze({ id: 'think', swatch: 'background:#fffdf8;border:1.5px dotted #6b6358;border-radius:50%', label: Object.freeze({ ko: '구름 말풍선', en: 'Cloud Bubble' }), desc: Object.freeze({ ko: '에이전트 추론 · 생각 중 (손글씨체)', en: 'Internal reasoning · thinking' }) }),
  Object.freeze({ id: 'ask', swatch: 'background:#fff3c4;border:1.5px solid #e0a32a;border-radius:6px', label: Object.freeze({ ko: '노랑·주황 배지', en: 'Amber Badge' }), desc: Object.freeze({ ko: '질문(선택지 칩) · 권한·계획 승인 대기', en: 'User question or tool/plan approval wait' }) }),
  Object.freeze({ id: 'error', swatch: 'background:linear-gradient(135deg,#e5534b 55%,#4fa3ff 55%);border-radius:4px', label: Object.freeze({ ko: '빨강·파란 땀', en: 'Red + Sweat' }), desc: Object.freeze({ ko: '도구 실패·오류 말풍선 + 파란 식은땀 방울', en: 'Tool error bubble + blue sweat drops' }) }),
  Object.freeze({ id: 'denied', swatch: 'background:#ece7dc;border:1.5px dashed #8a8175;border-radius:6px', label: Object.freeze({ ko: '회색 점선', en: 'Dashed Gray' }), desc: Object.freeze({ ko: '권한 요청 거절 · 작업 방향 변경 지시', en: 'Permission denied or redirected by user' }) }),
  Object.freeze({ id: 'floor', swatch: 'background:transparent;border:2px solid #2fb36a;box-shadow:0 0 0 2px rgba(196,61,52,0.35);border-radius:50%', label: Object.freeze({ ko: '층 테두리 링', en: 'Floor Ring' }), desc: Object.freeze({ ko: '초록 펄스 = 다른 층 새 활동 · 빨강 = 오류 발생', en: 'Green pulse = new activity · Red = error' }) }),
  Object.freeze({ id: 'source', swatch: 'background:linear-gradient(90deg,#2fb36a 34%,#e0a32a 34% 67%,#7c5cd6 67%);border-radius:50%', label: Object.freeze({ ko: '연결 상태 점', en: 'Source Dot' }), desc: Object.freeze({ ko: '초록 라이브 · 노랑 재연결 · 보라 재생 · 기본 데모', en: 'Green Live · Amber Retry · Purple Replay' }) }),
]);

// ---- 독립 캐릭터 카탈로그 및 LLM별 캐릭터 매핑 ----

export const CHAR_THEMES = Object.freeze({
  studio:          Object.freeze({ ko: 'AI 스튜디오 대원',   en: 'AI Studio Chibi' }),
  office:          Object.freeze({ ko: '테크 오피스 사원',   en: 'Tech Office Staff' }),
  palace:          Object.freeze({ ko: '조선 궁궐 관원',     en: 'Joseon Royal Official' }),
  hanok:           Object.freeze({ ko: '전통 한옥 선비',     en: 'Traditional Hanok Scholar' }),
  starship:        Object.freeze({ ko: 'SF 스타십 크루',     en: 'Sci-Fi Starship Crew' }),
  dogs:            Object.freeze({ ko: '강아지 군단 (기본)', en: 'Dog Pack (Default)' }),
  cats:            Object.freeze({ ko: '고양이 살롱 (기본)', en: 'Cat Pack (Default)' }),
  bots:            Object.freeze({ ko: '로봇 군단 (기본)',   en: 'Bot Squad (Default)' }),
  mix:             Object.freeze({ ko: '동물·캐릭터 혼합',   en: 'Mixed Cast' }),
  'dog:golden':      Object.freeze({ ko: '강아지 · 골든 리트리버', en: 'Dog · Golden Retriever' }),
  'dog:labrador':    Object.freeze({ ko: '강아지 · 래브라도',      en: 'Dog · Labrador' }),
  'dog:jindo-white': Object.freeze({ ko: '강아지 · 진돗개 백구',   en: 'Dog · White Jindo' }),
  'dog:jindo-black': Object.freeze({ ko: '강아지 · 진돗개 흑구',   en: 'Dog · Black Jindo' }),
  'dog:jindo-bear':  Object.freeze({ ko: '강아지 · 진돗개 반달곰', en: 'Dog · Bear Jindo' }),
  'dog:collie':      Object.freeze({ ko: '강아지 · 보더 콜리',     en: 'Dog · Border Collie' }),
  'dog:corgi':       Object.freeze({ ko: '강아지 · 웰시 코기',     en: 'Dog · Welsh Corgi' }),
  'dog:shiba':       Object.freeze({ ko: '강아지 · 시바견',        en: 'Dog · Shiba Inu' }),
  'cat:savannah':    Object.freeze({ ko: '고양이 · 사바나·아세라', en: 'Cat · Savannah·Ashera' }),
  'cat:mainecoon':   Object.freeze({ ko: '고양이 · 메인쿤',        en: 'Cat · Maine Coon' }),
  'cat:persian':     Object.freeze({ ko: '고양이 · 친칠라 페르시안', en: 'Cat · Chinchilla Persian' }),
  'cat:bengal':      Object.freeze({ ko: '고양이 · 벵갈',          en: 'Cat · Bengal' }),
  'cat:british':     Object.freeze({ ko: '고양이 · 브리티시·러시안', en: 'Cat · British·Russian' }),
  'cat:siamese':     Object.freeze({ ko: '고양이 · 샤미즈(샴)',    en: 'Cat · Siamese' }),
  'cat:ragdoll':     Object.freeze({ ko: '고양이 · 랙돌',          en: 'Cat · Ragdoll' }),
  'cat:fold':        Object.freeze({ ko: '고양이 · 스코티시 폴드', en: 'Cat · Scottish Fold' }),
  'bot:claude-duet': Object.freeze({ ko: '로봇 · 클로드 듀엣 봇',  en: 'Bot · Claude Duet' }),
  'bot:claude-code': Object.freeze({ ko: '로봇 · 클로드 코드 봇',  en: 'Bot · Claude Bot' }),
  'bot:chatgpt-dot': Object.freeze({ ko: '로봇 · 챗GPT 도트 봇',   en: 'Bot · ChatGPT Dot' }),
  'bot:codex-droid': Object.freeze({ ko: '로봇 · 코덱스 드로이드', en: 'Bot · Codex Droid' }),
  'bot:grok-bot':    Object.freeze({ ko: '로봇 · 그록 봇',         en: 'Bot · Grok Bot' }),
  'bot:agy-probe':   Object.freeze({ ko: '로봇 · AGY 프로브 봇',   en: 'Bot · AGY Probe Bot' }),
  'bot:agy-mech':    Object.freeze({ ko: '로봇 · AGY 아스트랄 봇', en: 'Bot · AGY Astral Bot' }),
  'bot:mini-drone':  Object.freeze({ ko: '로봇 · 미니 드론 봇',    en: 'Bot · Mini Drone Bot' }),
});

export const DEFAULT_CHAR_THEME = 'studio';

export const CHARACTER_CATALOG = Object.freeze({
  auto:              Object.freeze({ ko: '자동 (캐릭터 테마 기본)', en: 'Auto (Pack Default)' }),
  'human:studio':    Object.freeze({ ko: '치비 · AI 스튜디오',      en: 'Chibi · AI Studio' }),
  'human:office':    Object.freeze({ ko: '치비 · 테크 오피스',      en: 'Chibi · Tech Office' }),
  'human:palace':    Object.freeze({ ko: '치비 · 조선 궁궐 관원',   en: 'Chibi · Joseon Official' }),
  'human:hanok':     Object.freeze({ ko: '치비 · 전통 한옥 선비',   en: 'Chibi · Hanok Scholar' }),
  'human:starship':  Object.freeze({ ko: '치비 · SF 스타십 크루',   en: 'Chibi · Starship Crew' }),
  'dog:golden':      Object.freeze({ ko: '강아지 · 골든 리트리버',  en: 'Dog · Golden Retriever' }),
  'dog:labrador':    Object.freeze({ ko: '강아지 · 래브라도',       en: 'Dog · Labrador' }),
  'dog:jindo-white': Object.freeze({ ko: '강아지 · 진돗개 백구',    en: 'Dog · White Jindo' }),
  'dog:jindo-black': Object.freeze({ ko: '강아지 · 진돗개 흑구',    en: 'Dog · Black Jindo' }),
  'dog:jindo-bear':  Object.freeze({ ko: '강아지 · 진돗개 반달곰',  en: 'Dog · Bear Jindo' }),
  'dog:collie':      Object.freeze({ ko: '강아지 · 보더 콜리',      en: 'Dog · Border Collie' }),
  'dog:corgi':       Object.freeze({ ko: '강아지 · 웰시 코기',      en: 'Dog · Welsh Corgi' }),
  'dog:shiba':       Object.freeze({ ko: '강아지 · 시바견',         en: 'Dog · Shiba Inu' }),
  'cat:savannah':    Object.freeze({ ko: '고양이 · 사바나·아세라',  en: 'Cat · Savannah·Ashera' }),
  'cat:mainecoon':   Object.freeze({ ko: '고양이 · 메인쿤',         en: 'Cat · Maine Coon' }),
  'cat:persian':     Object.freeze({ ko: '고양이 · 친칠라 페르시안', en: 'Cat · Chinchilla Persian' }),
  'cat:bengal':      Object.freeze({ ko: '고양이 · 벵갈',           en: 'Cat · Bengal' }),
  'cat:british':     Object.freeze({ ko: '고양이 · 브리티시·러시안', en: 'Cat · British·Russian' }),
  'cat:siamese':     Object.freeze({ ko: '고양이 · 샤미즈(샴)',     en: 'Cat · Siamese' }),
  'cat:ragdoll':     Object.freeze({ ko: '고양이 · 랙돌',           en: 'Cat · Ragdoll' }),
  'cat:fold':        Object.freeze({ ko: '고양이 · 스코티시 폴드',  en: 'Cat · Scottish Fold' }),
  'bot:claude-duet': Object.freeze({ ko: '로봇 · 클로드 듀엣 봇',   en: 'Bot · Claude Duet' }),
  'bot:claude-code': Object.freeze({ ko: '로봇 · 클로드 코드 봇',   en: 'Bot · Claude Bot' }),
  'bot:chatgpt-dot': Object.freeze({ ko: '로봇 · 챗GPT 도트 봇',    en: 'Bot · ChatGPT Dot' }),
  'bot:codex-droid': Object.freeze({ ko: '로봇 · 코덱스 드로이드',  en: 'Bot · Codex Droid' }),
  'bot:grok-bot':    Object.freeze({ ko: '로봇 · 그록 봇',          en: 'Bot · Grok Bot' }),
  'bot:agy-probe':   Object.freeze({ ko: '로봇 · AGY 프로브 봇',    en: 'Bot · AGY Probe Bot' }),
  'bot:agy-mech':    Object.freeze({ ko: '로봇 · AGY 아스트랄 봇',  en: 'Bot · AGY Astral Bot' }),
  'bot:mini-drone':  Object.freeze({ ko: '로봇 · 미니 드론 봇',     en: 'Bot · Mini Drone Bot' }),
});

export const LLM_SLOTS = Object.freeze([
  'claude-code:app', 'claude-code:cli', 'codex:app', 'codex:cli',
  'grok', 'antigravity:cli', 'antigravity:app', 'sub',
]);

const uniformPack = (spec) => Object.freeze({
  'claude-code': spec, 'claude-code:app': spec, 'claude-code:cli': spec,
  codex: spec, 'codex:app': spec, 'codex:cli': spec,
  grok: spec, 'antigravity:cli': spec, 'antigravity:app': spec, sub: spec,
});

export const DEFAULT_LLM_CHAR_MAP = Object.freeze({
  dogs: Object.freeze({
    'claude-code': 'dog:golden',
    'claude-code:app': 'dog:golden',
    'claude-code:cli': 'dog:shiba',
    codex: 'dog:labrador',
    'codex:app': 'dog:jindo-black',
    'codex:cli': 'dog:labrador',
    grok: 'dog:collie',
    'antigravity:cli': 'dog:jindo-white',
    'antigravity:app': 'dog:jindo-bear',
    sub: 'dog:corgi',
  }),
  cats: Object.freeze({
    'claude-code': 'cat:savannah',
    'claude-code:app': 'cat:savannah',
    'claude-code:cli': 'cat:mainecoon',
    codex: 'cat:bengal',
    'codex:app': 'cat:persian',
    'codex:cli': 'cat:bengal',
    grok: 'cat:british',
    'antigravity:cli': 'cat:siamese',
    'antigravity:app': 'cat:ragdoll',
    sub: 'cat:fold',
  }),
  bots: Object.freeze({
    'claude-code': 'bot:claude-code',
    'claude-code:app': 'bot:claude-duet',
    'claude-code:cli': 'bot:claude-code',
    codex: 'bot:codex-droid',
    'codex:app': 'bot:chatgpt-dot',
    'codex:cli': 'bot:codex-droid',
    grok: 'bot:grok-bot',
    'antigravity:cli': 'bot:agy-probe',
    'antigravity:app': 'bot:agy-mech',
    sub: 'bot:mini-drone',
  }),
  mix: Object.freeze({
    'claude-code': 'dog:golden',
    'claude-code:app': 'bot:claude-duet',
    'claude-code:cli': 'cat:mainecoon',
    codex: 'cat:bengal',
    'codex:app': 'bot:chatgpt-dot',
    'codex:cli': 'cat:bengal',
    grok: 'bot:grok-bot',
    'antigravity:cli': 'dog:jindo-white',
    'antigravity:app': 'cat:ragdoll',
    sub: 'bot:mini-drone',
  }),
  studio: Object.freeze({
    'claude-code': 'human:studio',
    'claude-code:app': 'bot:claude-duet',
    'claude-code:cli': 'human:studio',
    codex: 'human:studio',
    'codex:app': 'bot:chatgpt-dot',
    'codex:cli': 'human:studio',
    grok: 'bot:grok-bot',
    'antigravity:cli': 'human:studio',
    'antigravity:app': 'human:studio',
    sub: 'human:studio',
  }),
  office:   uniformPack('human:office'),
  palace:   uniformPack('human:palace'),
  hanok:    uniformPack('human:hanok'),
  starship: uniformPack('human:starship'),
});

export const VOICE_MODES = Object.freeze(['auto', 'dogs', 'cats', 'bots', 'chime', 'chirp', 'blip', 'mute']);
export const DEFAULT_VOICE_MODE = 'auto';

export const COLOR_THEMES = Object.freeze(['system', 'light', 'dark']);
export const DEFAULT_COLOR_THEME = 'system';

export const LLM_FILTERS = Object.freeze(['all', 'claude-code', 'codex', 'grok', 'antigravity']);
export const DEFAULT_LLM_FILTER = 'all';

export const LEGEND_HUMANS = Object.freeze([
  Object.freeze({ id: 'human-studio', spec: 'human:studio', theme: 'studio', swatch: 'background:#d97757;border-radius:50%', label: Object.freeze({ ko: 'AI 스튜디오 대원', en: 'AI Studio Chibi' }), desc: Object.freeze({ ko: '치비 기본 · 베레모·사이버 바이저·반중력 링', en: 'Studio Chibi · Beret, cyber visor & anti-gravity ring' }) }),
  Object.freeze({ id: 'human-office', spec: 'human:office', theme: 'office', swatch: 'background:#10b981;border-radius:50%', label: Object.freeze({ ko: '테크 오피스 사원', en: 'Tech Office Staff' }), desc: Object.freeze({ ko: '오피스 캐주얼 · 사원증 랜야드 + 백팩', en: 'Tech Office · ID lanyard & backpack' }) }),
  Object.freeze({ id: 'human-palace', spec: 'human:palace', theme: 'palace', swatch: 'background:#a855f7;border-radius:50%', label: Object.freeze({ ko: '조선 궁궐 관원', en: 'Joseon Royal Official' }), desc: Object.freeze({ ko: '정자관·흑립 갓·사모 · 금박 흉배 관복', en: 'Joseon Crown & Gat · Gold-crest royal robe' }) }),
  Object.freeze({ id: 'human-hanok', spec: 'human:hanok', theme: 'hanok', swatch: 'background:#06b6d4;border-radius:50%', label: Object.freeze({ ko: '전통 한옥 선비', en: 'Traditional Hanok Scholar' }), desc: Object.freeze({ ko: '유건·대나무 삿갓·망건 · 배자·서책 망태기', en: 'Scholar Yugeon & Satgat · Hanok vest & basket' }) }),
  Object.freeze({ id: 'human-starship', spec: 'human:starship', theme: 'starship', swatch: 'background:#3b82f6;border-radius:50%', label: Object.freeze({ ko: 'SF 스타십 크루', en: 'Sci-Fi Starship Crew' }), desc: Object.freeze({ ko: '아크 리액터 코어 · 트윈 제트팩 우주복', en: 'Arc reactor core · Twin-jetpack pressure suit' }) }),
]);

export const LEGEND_CATALOG = Object.freeze([
  ...LEGEND_DOGS.map((d) => Object.freeze({ ...d, category: 'dogs', theme: d.spec })),
  ...LEGEND_CATS.map((c) => Object.freeze({ ...c, category: 'cats', theme: c.spec })),
  ...LEGEND_BOTS.map((b) => Object.freeze({ ...b, category: 'bots', theme: b.spec })),
  ...LEGEND_HUMANS.map((h) => Object.freeze({ ...h, category: 'human' })),
]);

export function legendCatalogFor(lang = 'ko', category = 'all') {
  const l = lang === 'en' ? 'en' : 'ko';
  return LEGEND_CATALOG
    .filter((it) => category === 'all' || it.category === category)
    .map((it) => ({
      id: it.id,
      spec: it.spec,
      theme: it.theme,
      category: it.category,
      swatch: it.swatch,
      label: it.label[l],
      desc: it.desc[l],
    }));
}

export const CATALOG_TABS = Object.freeze({
  ko: Object.freeze({ all: '전체 29', dogs: '강아지 8', cats: '고양이 8', bots: '로봇 8', human: '휴먼 5' }),
  en: Object.freeze({ all: 'All 29', dogs: 'Dogs 8', cats: 'Cats 8', bots: 'Bots 8', human: 'Humans 5' }),
});

export function renderCatalogSection(legendEl, lang, activeCharTheme, onPickTheme) {
  const catUl = legendEl?.querySelector?.('[data-lg="catalog"]');
  if (!catUl) return;
  const l = lang === 'en' ? 'en' : 'ko';
  const cat = legendEl.dataset.catFilter || 'all';
  const tabBar = legendEl.querySelector('[data-cat-tabs]');
  if (tabBar) {
    tabBar.replaceChildren(...Object.entries(CATALOG_TABS[l]).map(([k, text]) => {
      const b = legendEl.ownerDocument.createElement('button');
      b.type = 'button';
      b.dataset.cat = k;
      b.setAttribute('aria-pressed', String(k === cat));
      b.textContent = text;
      b.addEventListener('click', () => {
        legendEl.dataset.catFilter = k;
        renderCatalogSection(legendEl, l, activeCharTheme, onPickTheme);
        if (typeof window !== 'undefined' && typeof WebGLRenderingContext !== 'undefined') {
          import('./legend-models.js').then((m) => m.mountLegendModels(legendEl)).catch(() => {});
        }
      });
      return b;
    }));
  }
  catUl.replaceChildren();
  for (const it of legendCatalogFor(l, cat)) {
    const li = legendEl.ownerDocument.createElement('li');
    li.dataset.agentId = it.id;
    li.dataset.charSpec = it.spec;
    li.dataset.charTheme = it.theme;
    li.dataset.active = String(activeCharTheme === it.theme || activeCharTheme === it.spec);
    li.tabIndex = 0;
    li.innerHTML = '<canvas class="ag-model" width="128" height="144" aria-hidden="true"></canvas><div class="ag-tag"><i></i><b></b></div><small class="ag-sub"></small><span role="tooltip"></span>';
    li.querySelector('i').setAttribute('style', it.swatch);
    li.querySelector('b').textContent = it.label;
    li.querySelector('.ag-sub').textContent = it.desc;
    li.querySelector('span').textContent = `${it.label} · ${it.desc}`;
    li.addEventListener('click', () => onPickTheme?.(it.theme));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPickTheme?.(it.theme); }
    });
    catUl.append(li);
  }
}

export function llmSlotOf(agent = {}) {
  if (agent.isSub) return 'sub';
  const id = agent.brandOverride || agent.agent || 'claude-code';
  const surface = agent.surface || '';
  if (id === 'claude-code') return surface === 'app' ? 'claude-code:app' : 'claude-code:cli';
  if (id === 'codex') return surface === 'app' ? 'codex:app' : 'codex:cli';
  if (id === 'antigravity') return surface === 'cli' ? 'antigravity:cli' : 'antigravity:app';
  if (LLM_SLOTS.includes(id)) return id;
  return 'claude-code:cli';
}

export function charSpecOf(spec) {
  return Object.hasOwn(CHARACTER_CATALOG, spec) ? spec : 'auto';
}

export function defaultLlmCharMap() {
  return Object.fromEntries(LLM_SLOTS.map((k) => [k, 'auto']));
}

export function llmCharMapOf(raw) {
  const out = defaultLlmCharMap();
  if (!raw || typeof raw !== 'object') return out;
  for (const base of ['claude-code', 'codex']) {
    if (Object.hasOwn(raw, base) && Object.hasOwn(CHARACTER_CATALOG, raw[base])) {
      out[`${base}:app`] = raw[base];
      out[`${base}:cli`] = raw[base];
    }
  }
  for (const k of LLM_SLOTS) {
    if (Object.hasOwn(raw, k) && Object.hasOwn(CHARACTER_CATALOG, raw[k])) out[k] = raw[k];
  }
  return out;
}
