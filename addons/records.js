/* ══════════════ records.js — 운행 기록 · 운송료 합산 (유료 기능) ══════════════
 * ① 배송지를 입력하면 그 배차 건의 '운송료 입력 칸'이 자동으로 생긴다 (유료 회원).
 * ② 각 운행 건에 적재함(적재 탭)의 어떤 화물이 실렸는지 선택해 연결할 수 있다.
 *    — 적재함에 입력 안 한 짐(작은 짐·직행 등)은 연결 없이 그냥 두면 된다.
 * ③ 운행 종료를 누르면 운행 요약 + 건별 운송료가 '기록' 탭에 저장되고,
 *    오늘/이번 주/이번 달/기간 지정으로 자동 합산된다.
 * ④ 무료 회원이 기록을 열면 "유료 회원이 되면 열립니다" 안내가 뜬다 (membership.js).
 *
 * 이 파일은 스스로 '기록' 탭과 운송료 카드를 만들어 붙인다. app.js 수정 불필요.
 * (app.js 전역: $, $$, state, cargoItems, itemLabel, toast, esc, uid, isoDate,
 *  fmtDateK, fmtKm, fmtDur, switchTab, isFutureStop 사용)
 */

const Records = (() => {
  const ACTIVE_KEY = 'cargo-jobs-active-v1';  // 오늘 진행 중인 운행 건(운송료 입력 대기)
  const LOG_KEY = 'cargo-log-v1';             // 보관된 건별 기록
  const TRIPS_KEY = 'cargo-trips-v1';         // 운행(운행 시작~종료) 요약
  const LOG_MAX = 600, TRIPS_MAX = 120;

  let active = [];   // [{id, createdAt, date, label, fare(null=미입력), cargoIds:[]}]
  let log = [];      // [{id, date, label, fare, cargoDesc, tripId}]
  let trips = [];    // [{id, date, startedAt, endedAt, stopCount, doneCount, distance, duration, stops}]
  let period = 'today';            // today | week | month | custom
  let customFrom = '', customTo = '';
  const openCargo = new Set();     // 화물 연결 선택창이 펼쳐진 job id

  // ─────────── 저장/불러오기 ───────────
  function loadAll() {
    try { active = JSON.parse(localStorage.getItem(ACTIVE_KEY) || '[]'); } catch (e) { active = []; }
    try { log = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (e) { log = []; }
    try { trips = JSON.parse(localStorage.getItem(TRIPS_KEY) || '[]'); } catch (e) { trips = []; }
  }
  function saveAll() {
    try {
      localStorage.setItem(ACTIVE_KEY, JSON.stringify(active));
      localStorage.setItem(LOG_KEY, JSON.stringify(log));
      localStorage.setItem(TRIPS_KEY, JSON.stringify(trips));
    } catch (e) { /* ignore */ }
  }

  // ─────────── 날짜·금액 도우미 ───────────
  function todayIso() { return isoDate(new Date()); }
  function weekStartIso() {
    const d = new Date();
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));   // 월요일 시작
    return isoDate(d);
  }
  function monthStartIso() { return todayIso().slice(0, 8) + '01'; }
  function won(n) { return (n || 0).toLocaleString('ko-KR') + '원'; }

  /** "70000" · "70,000" · "7만" · "7.5만" → 숫자(원). 실패 시 null */
  function parseMoney(s) {
    if (s == null) return null;
    const t = String(s).trim().replace(/[,\s원]/g, '');
    if (!t) return null;
    const man = t.match(/^(\d+(?:\.\d+)?)만$/);
    if (man) return Math.round(parseFloat(man[1]) * 10000);
    const n = parseInt(t, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  // ─────────── 운행 건(job) 관리 ───────────
  function shortAddr(l) { return String(l || '').split(/\s+/).slice(0, 2).join(' ').slice(0, 16); }

  /** 방금 입력된 배송지들로 건 이름 제안: "마곡동 → 판교역로" */
  function suggestLabel() {
    const todays = (state.stops || []).filter(s => !isFutureStop(s));
    const loads = todays.filter(s => s.type === '상차');
    const unloads = todays.filter(s => s.type === '하차');
    if (!loads.length && !unloads.length) return '운행 건';
    const a = loads.length ? shortAddr(loads[loads.length - 1].label) : '출발';
    const b = unloads.length ? shortAddr(unloads[unloads.length - 1].label) : '';
    return b ? `${a} → ${b}` : a;
  }

  function addJob(label) {
    const j = { id: uid(), createdAt: Date.now(), date: todayIso(), label: label || suggestLabel(), fare: null, cargoIds: [] };
    active.push(j);
    saveAll();
    return j;
  }

  /** 이 건에 연결된 적재함 화물 설명 (보관 시점에 문자열로 굳힌다) */
  function cargoDescOf(j) {
    const items = (typeof cargoItems !== 'undefined' ? cargoItems : []);
    return (j.cargoIds || [])
      .map(id => items.find(it => it.id === id))
      .filter(Boolean).map(itemLabel).join(' · ');
  }

  function archiveJob(j, tripId) {
    log.unshift({ id: j.id, date: j.date, label: j.label, fare: j.fare, cargoDesc: cargoDescOf(j), tripId: tripId || null });
    if (log.length > LOG_MAX) log.length = LOG_MAX;
  }

  /** 기록으로 넘어간 건들에 연결된 화물은 적재함에서 비운다 (배송 끝난 짐 자동 정리) */
  function removeLinkedCargo(jobs) {
    if (typeof cargoItems === 'undefined') return 0;
    const ids = new Set(jobs.flatMap(j => j.cargoIds || []));
    if (!ids.size) return 0;
    const before = cargoItems.length;
    cargoItems = cargoItems.filter(it => !ids.has(it.id));
    saveItems();
    renderCargoItems();
    return before - cargoItems.length;
  }

  /** 날짜가 지난 진행 건은 자동으로 기록으로 넘긴다 (운행 종료를 안 눌렀어도 금액 보존) */
  function rollover() {
    const today = todayIso();
    const past = active.filter(j => j.date < today);
    if (!past.length) return;
    past.forEach(j => archiveJob(j, null));
    active = active.filter(j => j.date >= today);
    removeLinkedCargo(past);
    saveAll();
  }

  /** 운행 종료 시: 운행 요약 저장 + 오늘 건들을 운행에 붙여 보관 */
  function onTripEnded(snap) {
    const stops = (snap.snapshot && snap.snapshot.stops) || [];
    const t = {
      id: uid(),
      date: isoDate(new Date(snap.startedAt || Date.now())),
      startedAt: snap.startedAt, endedAt: Date.now(),
      stopCount: stops.length,
      doneCount: stops.filter(s => snap.events && snap.events[s.id] && snap.events[s.id].doneAt).length,
      distance: (snap.snapshot && snap.snapshot.distance) || 0,
      duration: (snap.snapshot && snap.snapshot.duration) || 0,
      stops: stops.map(s => ({ label: s.label, type: s.type })),
    };
    trips.unshift(t);
    if (trips.length > TRIPS_MAX) trips.length = TRIPS_MAX;
    const toArchive = active.splice(0);
    toArchive.forEach(j => archiveJob(j, t.id));   // 화물 설명을 먼저 기록에 굳힌 뒤
    const removed = removeLinkedCargo(toArchive);  // 적재함에서 비운다
    saveAll();
    renderJobCards();
    if (Membership.hasPaidAccess()) {
      toast(removed
        ? `📒 운행·운송료를 기록했고, 배송 끝난 화물 ${removed}건을 적재함에서 비웠습니다`
        : '📒 운행과 운송료를 기록 탭에 저장했습니다', 4500);
    }
  }

  // ─────────── 합산 ───────────
  function periodRange() {
    const T = todayIso();
    if (period === 'today') return [T, T];
    if (period === 'week') return [weekStartIso(), T];
    if (period === 'month') return [monthStartIso(), T];
    return [customFrom || monthStartIso(), customTo || T];
  }
  /** 진행 중(오늘) 건 + 보관 기록을 합쳐 기간 내 항목을 돌려준다 */
  function entriesInRange(from, to) {
    const acts = active.map(j => ({
      id: j.id, date: j.date, label: j.label, fare: j.fare, cargoDesc: cargoDescOf(j), tripId: null, active: true,
    }));
    return [...acts, ...log].filter(e => e.date >= from && e.date <= to);
  }
  function tripsInRange(from, to) { return trips.filter(t => t.date >= from && t.date <= to); }
  function sumFare(entries) { return entries.reduce((s, e) => s + (e.fare || 0), 0); }

  // ─────────── 화면 주입 ───────────
  function inject() {
    const tabs = $('#tabs');
    const main = document.querySelector('main.container');
    if (!tabs || !main || $('#panel-log')) return;

    // 탭 버튼 + 패널
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.dataset.tab = 'log';
    btn.textContent = '기록';
    tabs.appendChild(btn);
    btn.addEventListener('click', () => { switchTab('log'); renderLog(); });

    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.id = 'panel-log';
    panel.innerHTML = '<div id="log-body"></div>';
    main.appendChild(panel);

    // 경로 탭: 배송지 카드 아래(경로 계산 버튼 위)에 운송료 카드
    const routeCard = document.createElement('div');
    routeCard.id = 'job-card-route';
    $('#panel-route').insertBefore(routeCard, $('#btn-optimize'));

    // 운행 탭: 운행 종료 버튼 위에 운송료 카드
    const driveCard = document.createElement('div');
    driveCard.id = 'job-card-drive';
    $('#drive-active').insertBefore(driveCard, $('#btn-end-trip'));

    // 운행 탭을 열 때마다 최신 내용으로 (app.js의 기존 운행 탭 버튼에 살짝 얹는다)
    const driveTab = document.querySelector('#tabs .tab[data-tab="drive"]');
    if (driveTab) driveTab.addEventListener('click', renderJobCards);
  }

  // ─────────── 운송료 카드 (경로·운행 탭 공용) ───────────
  function jobRowHtml(j) {
    const desc = cargoDescOf(j);
    const items = (typeof cargoItems !== 'undefined' ? cargoItems : []);
    const open = openCargo.has(j.id);
    const cargoBtnLabel = (j.cargoIds || []).length
      ? `📦 실은 화물 ${j.cargoIds.length}종 연결됨 ✓`
      : '📦 실은 화물 연결 (선택사항 — 안 해도 됨)';
    const selector = !open ? '' : `
      <div class="cargo-select">
        <p class="hint" style="margin-bottom:4px">이 배차에 실은 짐만 체크하세요 (체크하면 바로 저장됩니다)</p>
        ${items.length ? items.map(it => `
          <label class="cargo-opt">
            <input type="checkbox" data-job="${j.id}" data-cid="${it.id}" ${(j.cargoIds || []).includes(it.id) ? 'checked' : ''}>
            <span>${esc(itemLabel(it))}${it.from ? ` <span class="hint">(${esc(it.from)})</span>` : ''}</span>
          </label>`).join('')
          : '<p class="hint">적재 탭에 담긴 화물이 없습니다.</p>'}
        <button class="btn secondary full" data-cargo-done="${j.id}" style="margin-top:6px">✓ 완료 (접기)</button>
      </div>`;
    return `
      <div class="job-row">
        <div class="row gap">
          <button class="job-label grow" data-job-edit="${j.id}" title="눌러서 이름 수정">🚚 ${esc(j.label)}</button>
          <button class="icon-btn" data-job-del="${j.id}" title="이 건 삭제">✕</button>
        </div>
        <div class="money-wrap top8">
          <input type="text" class="input money" inputmode="numeric" placeholder="운송료 입력 — 예) 70000 또는 7만"
                 data-job-fare="${j.id}" value="${j.fare != null ? j.fare : ''}">
          <span class="money-suffix">원</span>
        </div>
        ${desc ? `<div class="hint top8">📦 ${esc(desc)}</div>` : ''}
        <button class="chip cargo-link top8" data-job-cargo="${j.id}">${cargoBtnLabel}</button>
        ${selector}
      </div>`;
  }

  function jobCardHtml() {
    if (!Membership.hasPaidAccess()) {
      return `
        <div class="card lock-card">
          <h2 class="card-title">💰 운송료 기록 <span class="paid-badge">유료</span></h2>
          <button class="btn secondary full" data-lock="운행 기록(운송료)">🔒 유료 회원이 되면 열립니다 — 자세히 보기</button>
        </div>`;
    }
    const todayEntries = entriesInRange(todayIso(), todayIso());
    const totalLine = todayEntries.length
      ? `오늘 합계 <b>${todayEntries.length}건 · ${won(sumFare(todayEntries))}</b>`
      : '오늘 기록된 운송료가 없습니다';
    const trialNote = !Membership.isPaid() && Membership.trialDaysLeft() > 0
      ? `<span class="paid-badge trial">${Membership.statusLabel()}</span>` : '';
    return `
      <div class="card">
        <h2 class="card-title">💰 운송료 기록 ${trialNote}
          <span class="hint">(건마다 입력 → 기록 탭에 자동 합산)</span></h2>
        ${active.map(jobRowHtml).join('')}
        <button class="btn secondary full ${active.length ? 'top8' : ''}" data-job-add>＋ 전화로만 받은 배차 추가</button>
        <div class="row space-between top8">
          <span class="hint" data-job-total>${totalLine}</span>
          <button class="mini-btn" data-goto-log>📒 기록 보기</button>
        </div>
      </div>`;
  }

  function bindJobCard(root) {
    root.querySelectorAll('[data-lock]').forEach(b =>
      b.addEventListener('click', () => Membership.showUpsell(b.dataset.lock)));
    root.querySelectorAll('[data-job-add]').forEach(b => b.addEventListener('click', () => {
      // 이름은 자동으로 붙는다 (🚚 이름 줄을 누르면 언제든 수정 가능) — 입력창 없이 바로 생성
      addJob(suggestLabel());
      renderJobCards();
      toast('🚚 배차 건을 추가했습니다 — 금액만 입력하세요 (이름은 🚚 줄을 눌러 수정)', 4000);
    }));
    root.querySelectorAll('[data-cargo-done]').forEach(b => b.addEventListener('click', () => {
      openCargo.delete(b.dataset.cargoDone);
      renderJobCards();
    }));
    root.querySelectorAll('[data-goto-log]').forEach(b => b.addEventListener('click', () => {
      switchTab('log'); renderLog();
    }));
    root.querySelectorAll('[data-job-edit]').forEach(b => b.addEventListener('click', () => {
      const j = active.find(x => x.id === b.dataset.jobEdit);
      if (!j) return;
      const v = prompt('건 이름 수정', j.label);
      if (v == null || !v.trim()) return;
      j.label = v.trim(); saveAll(); renderJobCards();
    }));
    root.querySelectorAll('[data-job-del]').forEach(b => b.addEventListener('click', () => {
      const j = active.find(x => x.id === b.dataset.jobDel);
      if (!j) return;
      if (j.fare != null && !confirm(`"${j.label}" (${won(j.fare)}) 건을 삭제할까요?`)) return;
      active = active.filter(x => x !== j);
      saveAll(); renderJobCards();
    }));
    root.querySelectorAll('[data-job-fare]').forEach(inp => inp.addEventListener('change', () => {
      const j = active.find(x => x.id === inp.dataset.jobFare);
      if (!j) return;
      const n = parseMoney(inp.value);
      j.fare = n;
      inp.value = n != null ? n : '';
      saveAll();
      // 입력 도중 전체를 다시 그리면 커서가 풀리므로 합계 문구만 갱신한다
      const todayEntries = entriesInRange(todayIso(), todayIso());
      document.querySelectorAll('[data-job-total]').forEach(el => {
        el.innerHTML = `오늘 합계 <b>${todayEntries.length}건 · ${won(sumFare(todayEntries))}</b>`;
      });
      if (n != null) toast(`💰 ${j.label} — ${won(n)} 저장`, 2200);
    }));
    root.querySelectorAll('[data-job-cargo]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.jobCargo;
      if (openCargo.has(id)) openCargo.delete(id); else openCargo.add(id);
      renderJobCards();
    }));
    root.querySelectorAll('.cargo-opt input[type="checkbox"]').forEach(ch => ch.addEventListener('change', () => {
      const j = active.find(x => x.id === ch.dataset.job);
      if (!j) return;
      j.cargoIds = j.cargoIds || [];
      if (ch.checked) { if (!j.cargoIds.includes(ch.dataset.cid)) j.cargoIds.push(ch.dataset.cid); }
      else j.cargoIds = j.cargoIds.filter(c => c !== ch.dataset.cid);
      saveAll();
      renderJobCards();   // 선택 개수·연결 표시를 바로 갱신 (선택창은 열린 채 유지)
    }));
  }

  function renderJobCards() {
    const html = jobCardHtml();
    const r = $('#job-card-route'), d = $('#job-card-drive');
    if (r) { r.innerHTML = html; bindJobCard(r); }
    if (d) { d.innerHTML = html; bindJobCard(d); }
  }

  // ─────────── 기록 탭 ───────────
  function renderLog() {
    const box = $('#log-body');
    if (!box) return;

    // 무료 회원: 잠금 화면 + 안내 (클릭 시 유료 안내 모달)
    // 그동안 쌓인 운송료 합계를 보여준다 — "내 기록 다시 보려면" 전환 유도의 핵심
    if (!Membership.hasPaidAccess()) {
      const saved = [...active, ...log];
      const savedFare = sumFare(saved);
      const savedLine = saved.length
        ? `<div class="lock-saved">지금까지 기록된 운송료<br><b>${saved.length}건 · ${won(savedFare)}</b><br><span class="hint">지워지지 않고 안전하게 보관 중입니다</span></div>`
        : '';
      box.innerHTML = `
        <div class="card center-card">
          <p class="big-emoji">🔒</p>
          <p style="font-weight:800;font-size:17px">운행 기록은 유료 회원에게 열립니다</p>
          ${savedLine}
          <p class="hint top8">한 건 한 건 운송료를 저장하고<br>오늘·일주일·한 달·원하는 기간으로 자동 합산해 드립니다.</p>
          <button class="btn primary full top8" id="btn-log-upsell">⭐ 유료 회원 안내 보기</button>
          <p class="fine-print top8">경로·적재·주유소 등 기본 기능은 앞으로도 계속 무료입니다.</p>
        </div>`;
      $('#btn-log-upsell').addEventListener('click', () => Membership.showUpsell('운행 기록'));
      return;
    }

    const [from, to] = periodRange();
    const entries = entriesInRange(from, to);
    const rangeTrips = tripsInRange(from, to);
    const total = sumFare(entries);
    const missing = entries.filter(e => e.fare == null).length;
    const kmSum = rangeTrips.reduce((s, t) => s + (t.distance || 0), 0);

    // 이 기간에 기록이 없을 때: 전체 보관 기록을 알려줘 "사라진 게 아님"을 분명히 한다
    const allSaved = [...active, ...log];
    const emptyHtml = allSaved.length
      ? `<div class="center-card"><p class="big-emoji">📭</p>
           <p style="font-weight:800">이 기간(${fmtDateK(from)}~${fmtDateK(to)})에는 기록이 없습니다.</p>
           <div class="lock-saved" style="max-width:320px">전체 기록 <b>${allSaved.length}건 · ${won(sumFare(allSaved))}</b><br><span class="hint">안전하게 보관돼 있어요 — 다른 날짜에 있습니다</span></div>
           <div class="row gap top8" style="justify-content:center">
             <button class="chip" data-period="today">오늘 보기</button>
             <button class="chip" data-period="month">이번 달 보기</button>
           </div></div>`
      : `<div class="center-card"><p class="big-emoji">📭</p><p>아직 기록이 없습니다.</p><p class="hint">경로 탭에서 배송지를 입력하고 운송료를 적으면 여기에 쌓입니다.</p></div>`;

    const trialBanner = !Membership.isPaid() && Membership.trialDaysLeft() > 0 ? `
      <div class="trial-banner">
        <span>🎁 무료 체험 <b>D-${Membership.trialDaysLeft()}</b> — 체험이 끝나면 기록이 잠깁니다 (기록은 보존)</span>
        <button class="mini-btn" id="btn-trial-join">유료 전환</button>
      </div>` : '';

    const chips = [
      ['today', '오늘'], ['week', '이번 주'], ['month', '이번 달'], ['custom', '기간 지정'],
    ].map(([k, l]) => `<button class="chip ${period === k ? 'active' : ''}" data-period="${k}">${l}</button>`).join('');

    const customHtml = period !== 'custom' ? '' : `
      <div class="grid2 top8">
        <label class="field"><span class="field-label">시작일</span>
          <input type="date" class="input" id="log-from" value="${customFrom || monthStartIso()}"></label>
        <label class="field"><span class="field-label">종료일</span>
          <input type="date" class="input" id="log-to" value="${customTo || todayIso()}"></label>
      </div>`;

    // 날짜별 묶음 (최신 날짜부터)
    const dates = [...new Set([...entries.map(e => e.date), ...rangeTrips.map(t => t.date)])].sort().reverse();
    const listHtml = dates.map(date => {
      const dayEntries = entries.filter(e => e.date === date);
      const dayTrips = rangeTrips.filter(t => t.date === date);
      const daySum = sumFare(dayEntries);
      const rows = dayEntries.map(e => `
        <div class="log-entry ${e.active ? 'active-job' : ''}">
          <div class="grow">
            <div class="log-label">${esc(e.label)}${e.active ? ' <span class="paid-badge trial">진행 중</span>' : ''}</div>
            ${e.cargoDesc ? `<div class="hint">📦 ${esc(e.cargoDesc)}</div>` : ''}
          </div>
          <button class="fare-chip ${e.fare == null ? 'missing' : ''}" data-fare-edit="${e.id}" title="눌러서 금액 수정">
            ${e.fare == null ? '금액 미입력' : won(e.fare)}</button>
          <button class="icon-btn" data-entry-del="${e.id}" title="삭제">✕</button>
        </div>`).join('');
      const tripRows = dayTrips.map(t => `
        <div class="log-trip">🚛 운행 ${new Date(t.startedAt).toTimeString().slice(0, 5)}~${new Date(t.endedAt).toTimeString().slice(0, 5)}
          · ${t.doneCount}/${t.stopCount}곳 완료 · ${fmtKm(t.distance)} · 운전 ${fmtDur(t.duration)}</div>`).join('');
      return `
        <div class="log-day">
          <div class="log-date-head"><span>${fmtDateK(date)}</span>
            <span>${dayEntries.length}건 · <b>${won(daySum)}</b></span></div>
          ${rows}${tripRows}
        </div>`;
    }).join('');

    box.innerHTML = `
      <div class="card">
        <div class="row space-between">
          <h2 class="card-title accent">📒 운행 기록</h2>
          <span class="paid-badge">${Membership.statusLabel()}</span>
        </div>
        ${trialBanner}
        <div class="row gap wrap top8">${chips}</div>
        ${customHtml}
        <div class="totals top8">
          <div class="total-chip"><div class="v">${won(total)}</div><div class="k">운송료 합계</div></div>
          <div class="total-chip"><div class="v">${entries.length}건</div><div class="k">운행 건수</div></div>
          <div class="total-chip"><div class="v">${rangeTrips.length}회</div><div class="k">운행(시작~종료)</div></div>
          ${kmSum ? `<div class="total-chip"><div class="v">${fmtKm(kmSum)}</div><div class="k">운행 거리</div></div>` : ''}
        </div>
        ${missing ? `<p class="fine-print">⚠️ 금액 미입력 ${missing}건 — 아래 목록에서 [금액 미입력]을 눌러 채워주세요. (합계에는 0원으로 계산)</p>` : ''}
      </div>
      <div class="card">
        ${listHtml || emptyHtml}
        <p class="fine-print top8">기록은 이 휴대폰에 저장됩니다. 서버 백업·기기 간 동기화는 준비 중입니다.</p>
      </div>`;

    // 이벤트 연결
    const joinBtn = $('#btn-trial-join');
    if (joinBtn) joinBtn.addEventListener('click', () => Membership.showUpsell('유료 회원 전환'));
    box.querySelectorAll('[data-period]').forEach(b => b.addEventListener('click', () => {
      period = b.dataset.period; renderLog();
    }));
    const fromInp = $('#log-from'), toInp = $('#log-to');
    if (fromInp) fromInp.addEventListener('change', () => { customFrom = fromInp.value; renderLog(); });
    if (toInp) toInp.addEventListener('change', () => { customTo = toInp.value; renderLog(); });

    box.querySelectorAll('[data-fare-edit]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.fareEdit;
      const target = active.find(j => j.id === id) || log.find(e => e.id === id);
      if (!target) return;
      const v = prompt('운송료(원)를 입력하세요 — 예) 70000 또는 7만', target.fare != null ? target.fare : '');
      if (v == null) return;
      target.fare = parseMoney(v);
      saveAll(); renderLog(); renderJobCards();
    }));
    box.querySelectorAll('[data-entry-del]').forEach(b => b.addEventListener('click', () => {
      const id = b.dataset.entryDel;
      const entry = active.find(j => j.id === id) || log.find(e => e.id === id);
      if (!entry) return;
      if (!confirm(`"${entry.label}" 기록을 삭제할까요?`)) return;
      active = active.filter(j => j.id !== id);
      log = log.filter(e => e.id !== id);
      saveAll(); renderLog(); renderJobCards();
    }));
  }

  // ─────────── app.js와의 연결 고리 (코드 수정 없이 동작) ───────────
  // 방금(같은 붙여넣기에서) 적재함에 담긴 화물을 추적한다 — 자동 연결의 재료
  let recentCargo = { ids: [], at: 0 };
  function hookCargoAdd() {
    if (typeof addCargoItems !== 'function') return;
    const orig = addCargoItems;
    window.addCargoItems = function (items, fromLabel) {
      const before = new Set((cargoItems || []).map(i => i.id));
      orig(items, fromLabel);
      recentCargo = { ids: (cargoItems || []).filter(i => !before.has(i.id)).map(i => i.id), at: Date.now() };
    };
  }

  // [지우고 새 배차 시작]을 누르면: 금액 입력된 건은 기록 탭에 보관하고 운송료 칸을 비운다
  function hookNewRoute() {
    document.addEventListener('click', (e) => {
      if (!e.target.closest || !e.target.closest('#btn-new-route')) return;
      const beforeLen = (state.stops || []).length;
      const hadResult = !!state.result;
      setTimeout(() => {
        const cleared = (state.stops || []).length < beforeLen || (hadResult && !state.result);
        if (!cleared || !active.length) return;   // 확인창에서 취소했으면 그대로 둔다
        const withFare = active.filter(j => j.fare != null);
        withFare.forEach(j => archiveJob(j, null));
        removeLinkedCargo(withFare);
        active = [];
        saveAll();
        renderJobCards();
        if (withFare.length) toast(`📒 입력해 둔 운송료 ${withFare.length}건은 기록 탭에 저장했습니다`, 4500);
      }, 0);
    }, true);
  }

  function hookEndTrip() {
    // 캡처 단계는 버튼 자체 리스너(app.js)보다 먼저 실행된다.
    // 누르기 직전의 운행 상태를 복사해 두고, app.js가 확인창에서 '확인'을 받아
    // 운행을 실제로 지운 경우에만(다음 틱에 state.trip === null) 기록으로 저장한다.
    document.addEventListener('click', (e) => {
      if (!e.target.closest || !e.target.closest('#btn-end-trip')) return;
      if (!state.trip || state.trip.endedAt) return;
      const snap = JSON.parse(JSON.stringify(state.trip));
      setTimeout(() => { if (state.trip === null) onTripEnded(snap); }, 0);
    }, true);
  }

  function hookStopList() {
    // 배송지가 추가되면(문자 인식이든 직접 입력이든) 운송료 입력 칸을 자동으로 만든다
    const list = $('#stop-list');
    if (!list) return;
    let lastCount = (state.stops || []).length;
    new MutationObserver(() => {
      const n = (state.stops || []).length;
      if (n > lastCount && Membership.hasPaidAccess()) {
        if (!active.some(j => j.fare == null)) {
          const j = addJob(suggestLabel());
          // 이번 붙여넣기에서 '방금' 담긴 화물만 자동 연결한다
          // (예전부터 적재함에 남아 있던 화물은 주소가 같아도 연결하지 않음)
          j.cargoIds = (Date.now() - recentCargo.at < 8000) ? recentCargo.ids.slice() : [];
          recentCargo = { ids: [], at: 0 };
          saveAll();
          toast(j.cargoIds.length
            ? '💰 운송료 칸을 만들고 실은 화물도 자동 연결했습니다 — 금액만 입력하세요'
            : '💰 운송료 칸을 만들었습니다 — 금액을 입력하면 기록 탭에 자동 합산됩니다', 4500);
        }
        renderJobCards();
      }
      lastCount = n;
    }).observe(list, { childList: true });
  }

  // ─────────── 초기화 ───────────
  loadAll();
  rollover();
  inject();
  renderJobCards();
  hookEndTrip();
  hookStopList();
  hookCargoAdd();
  hookNewRoute();
  Membership.onChange(() => { renderJobCards(); renderLog(); });

  return { renderLog, renderJobCards, addJob };
})();
