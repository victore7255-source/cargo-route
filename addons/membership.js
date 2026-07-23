/* ══════════════ membership.js — 회원(무료 체험·유료) 관리 ══════════════
 * 첫 사용일부터 한 달(31일) 무료 체험 → 이후 유료 전용 기능 잠금.
 * 유료 기능: 운행 기록·운송료 합산(records.js), 유료 지도 정확 도착시간(paidmap.js).
 *
 * ⚠️ 임시 구현 범위: 회원 상태를 이 휴대폰(localStorage)에만 저장한다.
 *    실제 서비스 출시 때는 결제(인앱/PG) + 서버 인증으로 교체해야 하며,
 *    그때 바꿀 곳은 이 파일의 activate()/isPaid() 두 군데뿐이다.
 *
 * 다른 파일에서 쓰는 API:
 *   Membership.hasPaidAccess()  — 유료 기능을 열어도 되는가 (유료회원 or 체험 중)
 *   Membership.isPaid()         — 진짜 유료 회원인가
 *   Membership.trialDaysLeft()  — 체험 남은 일수 (끝났으면 0)
 *   Membership.statusLabel()    — '유료 회원' | '무료 체험 D-12' | '무료 회원'
 *   Membership.showUpsell(name) — "유료 회원이 되면 열립니다" 안내 모달
 *   Membership.onChange(fn)     — 회원 상태 변경 시 화면 갱신 콜백
 */

const Membership = (() => {
  const KEY = 'cargo-member-v1';
  const TRIAL_DAYS = 31;                       // 무료 체험 기간(일) — "한 달"
  const PRICE_LABEL = '월 4,900원 (금액 확정 전)'; // 안내 문구 — 가격 확정 시 수정
  // 결제 연동 전 임시 가입 코드. 코드 1회 입력 = 31일 이용권 (연장 가능).
  const ACTIVATION_CODES = ['화물사랑', 'CARGO2026'];

  let data = { firstUseAt: null, plan: 'free', paidUntil: null };
  const listeners = [];

  function load() {
    try { Object.assign(data, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { /* ignore */ }
    if (!data.firstUseAt) { data.firstUseAt = Date.now(); save(); }   // 체험 시작 = 이 기능 첫 사용일
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
  }
  function emit() { listeners.forEach(fn => { try { fn(); } catch (e) { /* ignore */ } }); }

  // ── 상태 판정 ──
  function isPaid() {
    return data.plan === 'paid' && (!data.paidUntil || data.paidUntil > Date.now());
  }
  function trialDaysLeft() {
    const end = data.firstUseAt + TRIAL_DAYS * 24 * 3600 * 1000;
    return Math.max(0, Math.ceil((end - Date.now()) / (24 * 3600 * 1000)));
  }
  function hasPaidAccess() { return isPaid() || trialDaysLeft() > 0; }
  function statusLabel() {
    if (isPaid()) return '⭐ 유료 회원';
    if (trialDaysLeft() > 0) return `🎁 무료 체험 D-${trialDaysLeft()}`;
    return '무료 회원';
  }

  // ── 안내 모달 ──
  let overlay = null;
  function ensureModal() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'mm-overlay hidden';
    overlay.innerHTML = `
      <div class="mm-modal" role="dialog" aria-modal="true">
        <div class="mm-title" id="mm-title"></div>
        <div class="mm-desc" id="mm-desc"></div>
        <ul class="mm-benefits">
          <li>📒 <b>운행 기록</b> — 한 건 한 건 운송료를 저장하고 하루·일주일·한 달·원하는 기간으로 자동 합산</li>
          <li>⏱️ <b>더 정확한 도착 예정 시간</b> — 실시간 교통이 반영되는 유료 지도로 계산</li>
          <li>📦 <b>운행 건 ↔ 적재함 연결</b> — 어떤 운행에 어떤 짐이 실렸는지 기록</li>
        </ul>
        <div class="mm-price">${PRICE_LABEL}</div>
        <button class="btn primary full" id="mm-join">⭐ 유료 회원 시작하기 (가입 코드)</button>
        <button class="btn ghost full top8" id="mm-close">닫기</button>
        <p class="fine-print top8">결제 기능은 준비 중입니다. 지금은 가입 코드를 받은 분만 유료 이용이 가능합니다.</p>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hide(); });
    overlay.querySelector('#mm-close').addEventListener('click', hide);
    overlay.querySelector('#mm-join').addEventListener('click', activate);
  }
  function hide() { overlay && overlay.classList.add('hidden'); }

  /** "유료 회원이 되면 열립니다" 안내 — 무료 회원이 유료 기능을 눌렀을 때 */
  function showUpsell(featureName) {
    ensureModal();
    overlay.querySelector('#mm-title').textContent = `🔒 ${featureName || '이 기능'}`;
    const expired = trialDaysLeft() <= 0 && !isPaid();
    overlay.querySelector('#mm-desc').innerHTML = expired
      ? `무료 체험 기간(첫 사용 후 한 달)이 끝났습니다.<br><b>유료 회원이 되시면 바로 다시 열립니다.</b> 그동안 쌓인 기록은 지워지지 않고 그대로 보존됩니다.`
      : `이 기능은 <b>유료 회원 전용</b>입니다.<br>지금 유료 회원이 되시면 체험 종료 걱정 없이 계속 이용할 수 있습니다.`;
    overlay.classList.remove('hidden');
  }

  /** 가입 코드 입력 → 31일 이용권 (임시 — 결제 연동 시 이 함수만 교체) */
  function activate() {
    const code = prompt('가입 코드를 입력해 주세요.\n(코드는 관리자에게 문의)');
    if (code == null) return;
    if (!ACTIVATION_CODES.includes(code.trim())) {
      alert('코드가 올바르지 않습니다. 다시 확인해 주세요.');
      return;
    }
    const base = Math.max(Date.now(), data.paidUntil || 0);   // 남은 기간에 이어서 연장
    data.plan = 'paid';
    data.paidUntil = base + 31 * 24 * 3600 * 1000;
    save();
    hide();
    emit();
    if (typeof toast === 'function') {
      toast(`⭐ 유료 회원이 되었습니다! (${new Date(data.paidUntil).toLocaleDateString('ko-KR')}까지)`, 5000);
    }
  }

  function onChange(fn) { listeners.push(fn); }

  load();
  return { hasPaidAccess, isPaid, trialDaysLeft, statusLabel, showUpsell, activate, onChange };
})();
