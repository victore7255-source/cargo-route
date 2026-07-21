/* ══════════════ app.js — 화물 혼적 경로: 메인 앱 로직 ══════════════ */

// ─────────── 유틸 ───────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function fmtKm(m) { return (m / 1000).toFixed(1).replace(/\.0$/, '') + 'km'; }
function fmtDur(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}
function fmtWon(n) { return n.toLocaleString('ko-KR') + '원'; }
function fmtTime(d) { return d.toTimeString().slice(0, 5); }
function fmtClock(sec) {
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// ─────────── 방문 날짜 (당상내착 등 일정 → 실제 날짜) ───────────
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDateK(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const day = '일월화수목금토'[new Date(y, m - 1, d).getDay()];
  return `${m}/${d}(${day})`;
}
function nextMonday() {
  const d = new Date();
  d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
  return d;
}
/** 일정 라벨 → 상차일/하차일(ISO). confirm=true면 날짜 확인이 필요한 추정치(월상 등) */
function scheduleDates(label) {
  if (!label) return { load: null, unload: null };
  const plus = n => { const d = new Date(); d.setDate(d.getDate() + n); return isoDate(d); };
  const mon = isoDate(nextMonday());
  switch (label) {
    case '당상당착': return { load: plus(0), unload: plus(0) };
    case '당상내착': return { load: plus(0), unload: plus(1) };
    case '내상내착': case '내상': return { load: plus(1), unload: plus(1) };
    case '내착': return { load: plus(0), unload: plus(1) };
    case '당착': case '당상': return { load: plus(0), unload: plus(0) };
    case '당상월착': return { load: plus(0), unload: mon, confirm: true };
    case '월상월착': case '월상': return { load: mon, unload: mon, confirm: true };
  }
  // "7/21 상차" 형태
  const m = label.match(/^(\d{1,2})\/(\d{1,2})\s*(상차|하차)$/);
  if (m) {
    const d = new Date();
    d.setMonth(+m[1] - 1, +m[2]);
    if (isoDate(d) < isoDate(new Date())) d.setFullYear(d.getFullYear() + 1);
    const iso = isoDate(d);
    return m[3] === '상차' ? { load: iso, unload: iso } : { load: null, unload: iso };
  }
  return { load: null, unload: null };
}
/** 오늘보다 뒤 날짜에 방문하는 지점인가 (오늘 경로에서 제외) */
function isFutureStop(s) {
  return !!(s.visitDate && s.visitDate > isoDate(new Date()));
}

// ─────────── 상태 ───────────
const STATE_KEY = 'cargo-app-state-v1';

const state = {
  origin: null,   // {label, lat, lng}
  stops: [],      // {id, label, lat, lng, type:'하차'|'상차', workMin}
  result: null,   // {order, legs, distance, duration, toll, geometry, schedule, departAt, approx}
  trip: null,     // {startedAt, endedAt?, events:{stopId:{arrivedAt,doneAt}}, snapshot}
};

function saveState() {
  if (state._demo) return; // 체험 모드에서는 실제 데이터를 덮어쓰지 않는다
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({
      origin: state.origin, stops: state.stops, result: state.result, trip: state.trip,
    }));
  } catch (e) { /* ignore */ }
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
    if (s) Object.assign(state, s);
  } catch (e) { /* ignore */ }
}

// ─────────── 탭 ───────────
$$('#tabs .tab').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});
function switchTab(name) {
  $$('#tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  if (name === 'drive') renderDrive();
  if (name === 'route' && map) setTimeout(() => map.invalidateSize(), 100);
}

// ─────────── 출발지 ───────────
function setOriginStatus(msg, cls = '') {
  const el = $('#origin-status');
  el.textContent = msg;
  el.className = 'geo-status ' + cls;
}

$('#btn-gps').addEventListener('click', async () => {
  setOriginStatus('📡 현재 위치 확인 중…');
  try {
    const pos = await Geo.currentPosition();
    state.origin = { label: pos.display, lat: pos.lat, lng: pos.lng };
    $('#origin-input').value = pos.display;
    setOriginStatus('✓ 출발지: ' + pos.display, 'ok');
    saveState();
  } catch (e) {
    setOriginStatus('✗ ' + e.message, 'err');
  }
});

async function geocodeOrigin() {
  const q = $('#origin-input').value.trim();
  if (!q) { state.origin = null; setOriginStatus(''); return; }
  if (state.origin && state.origin.label === q) return;
  setOriginStatus('🔍 주소 확인 중…');
  const r = await Geo.geocode(q).catch(() => null);
  if (r) {
    state.origin = { label: q, lat: r.lat, lng: r.lng };
    setOriginStatus('✓ ' + r.display, 'ok');
    saveState();
  } else {
    state.origin = null;
    setOriginStatus('✗ 주소를 찾지 못했습니다. 시/구/동 단위로 다시 입력해 보세요.', 'err');
  }
}
$('#origin-input').addEventListener('change', geocodeOrigin);

// ─────────── 배송지 ───────────
$('#btn-add-stops').addEventListener('click', addStopsFromInput);
$('#stops-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !$('#stops-input').value.includes('\n')) {
    e.preventDefault();
    addStopsFromInput();
  }
});
// 입력한 배송지나 계산된 경로가 있을 때만 맨 위에 "새 배차 시작" 버튼을 보여준다
function updateNewRouteBtn() {
  const has = (state.stops && state.stops.length) || state.result;
  $('#btn-new-route').classList.toggle('hidden', !has);
}
$('#btn-new-route').addEventListener('click', () => {
  if (!confirm('지금 입력한 배송지와 경로를 지우고 새 배차를 시작할까요?\n(내일 예정 배송지는 남습니다)')) return;
  const futureCount = state.stops.filter(isFutureStop).length;
  state.stops = state.stops.filter(isFutureStop);   // 내일 예정 지점은 보존
  state.result = null;
  $('#result-area').classList.add('hidden');
  $('#sms-input').value = '';
  $('#stops-input').value = '';
  $('#sms-preview').classList.add('hidden');
  saveState();
  renderStops();
  toast(futureCount
    ? `🆕 새 배차를 입력하세요. (예정 배송지 ${futureCount}곳은 남겨뒀습니다)`
    : '🆕 새 배차를 입력하세요', 4000);
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

async function addStopsFromInput() {
  const raw = $('#stops-input').value;
  const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length) { toast('주소를 입력해 주세요'); return; }

  // 배차 문자를 통째로 붙여넣은 것 같으면 (주소가 아닌 줄이 여럿) 문자 자동 인식으로 넘긴다
  const nonAddr = lines.filter(l => !SmsParser.looksLikeAddress(l));
  if (nonAddr.length >= 2 || (nonAddr.length >= 1 && lines.length >= 4)) {
    $('#stops-input').value = '';
    $('#sms-input').value = raw;
    $('#btn-parse-sms').click();
    $('#sms-input').scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast('💬 배차 문자로 보여 자동 인식으로 전환했습니다. 내용을 확인하고 추가를 누르세요.', 5000);
    return;
  }
  $('#stops-input').value = '';
  const defaultWork = parseInt($('#default-work').value, 10);

  // 일정 버튼이 선택돼 있으면 직접 입력한 배송지(기본 하차)에도 하차일을 적용
  const dates = scheduleDates(manualSched);
  const pending = lines.map(label => ({
    id: uid(), label, lat: null, lng: null, type: '하차', workMin: defaultWork, status: 'pending',
    schedule: manualSched || '', visitDate: dates.unload,
  }));
  if (pending.some(isFutureStop)) {
    toast(`📅 ${manualSched} — 하차일(${fmtDateK(dates.unload)})이 내일 이후라 오늘 경로에서 제외됩니다`, 4500);
  }
  resetSchedPicker();
  state.stops.push(...pending);
  renderStops();
  await geocodePending(pending);
}

/** 추가된 배송지들의 주소를 순서대로 좌표로 바꾼다 (문자 붙여넣기와 직접 입력이 공용) */
async function geocodePending(pending) {
  for (let i = 0; i < pending.length; i++) {
    const stop = pending[i];
    setOptStatus(`🔍 주소 확인 중… (${i + 1}/${pending.length}) ${stop.label}`);
    const r = await Geo.geocode(stop.label).catch(() => null);
    if (r) {
      stop.lat = r.lat; stop.lng = r.lng; stop.status = 'ok'; stop.display = r.display;
    } else {
      stop.status = 'error';
    }
    renderStops();
  }
  setOptStatus('');
  const failed = pending.filter(s => s.status === 'error').length;
  if (failed) toast(`⚠️ 주소 ${failed}건을 찾지 못했습니다. 빨간 항목을 수정해 주세요.`);
  saveState();
}

// ─────────── 문자 붙여넣기 ───────────
let smsParsed = [];
let smsMeta = { schedule: null, items: [] };

// 일정 미리 선택: 문자에 일정 표기가 없을 때 이 값을 적용한다 (당상내착이 흔해서 버튼으로 제공)
let manualSched = '';
const SCHED_DETAILS = { '당상당착': '오늘 상차 → 오늘 하차', '당상내착': '오늘 상차 → 내일 하차' };
$$('#sched-picker [data-sched]').forEach(b => b.addEventListener('click', () => {
  manualSched = b.dataset.sched;
  $$('#sched-picker [data-sched]').forEach(x => x.classList.toggle('active', x === b));
  if (manualSched) toast(`📅 ${manualSched} — 문자에 일정 표기가 없으면 이 일정으로 적용합니다`);
}));

/** 배송지 추가가 끝나면 일정 선택을 '자동 인식'으로 되돌린다 (다음 배차에 잘못 적용 방지) */
function resetSchedPicker() {
  if (!manualSched) return;
  manualSched = '';
  $$('#sched-picker [data-sched]').forEach(x => x.classList.toggle('active', x.dataset.sched === ''));
}

$('#btn-parse-sms').addEventListener('click', () => {
  const text = $('#sms-input').value.trim();
  if (!text) { toast('받은 문자를 붙여넣어 주세요'); return; }
  const full = SmsParser.parseFull(text);
  if (!full.schedule && manualSched) {
    full.schedule = { label: manualSched, detail: SCHED_DETAILS[manualSched] + ' · 직접 선택' };
  }
  smsParsed = full.stops;
  smsMeta = { schedule: full.schedule, items: full.items };
  if (!smsParsed.length) {
    $('#sms-preview').classList.add('hidden');
    toast('주소를 찾지 못했습니다. 문자에 "시/구/로" 형태의 주소가 있는지 확인해 주세요.');
    return;
  }
  renderSmsPreview();
});

function itemLabel(it) {
  return `${it.kind === 'plt' ? '파레트' : '박스'} ${it.w}×${it.d}×${it.h}cm × ${it.count}개${it.totalKg ? ` (${it.totalKg}kg)` : ''}`;
}

function renderSmsPreview() {
  const box = $('#sms-preview');
  if (!smsParsed.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

  let metaHtml = '';
  if (smsMeta.schedule) {
    metaHtml += `<div class="sms-meta">📅 <b>${esc(smsMeta.schedule.label)}</b> — ${esc(smsMeta.schedule.detail)}</div>`;
  }
  if (smsMeta.items.length) {
    metaHtml += `<div class="sms-meta">📦 ${smsMeta.items.map(itemLabel).map(esc).join(' · ')} <span class="hint">→ 배송지 추가 시 적재 탭에 함께 담깁니다</span></div>`;
  }
  const guessed = smsParsed.some(s => s.guessed);

  box.innerHTML = metaHtml
    + '<ul class="stop-list top8">'
    + smsParsed.map((s, i) => {
      const sub = [
        s.contactName,
        s.phone ? '📞 ' + s.phone : '',
        s.cargo ? '📦 ' + s.cargo : '',
        s.podPhone ? '📸 인수증 → ' + s.podPhone : '',
      ].filter(Boolean).map(esc).join(' · ');
      const notes = (s.notes && s.notes.length)
        ? `<br>⚠️ <span class="note">${s.notes.map(esc).join(' / ')}</span>` : '';
      return `
      <li class="stop-item ${s.type === '상차' ? 'load' : 'unload'}">
        <div class="si-head">
          <span class="si-icon">💬</span>
          <button class="badge ${s.type === '상차' ? 'load' : 'unload'}" data-sms-type="${i}" title="눌러서 상차/하차 전환">${s.type}</button>
          <button class="icon-btn si-del" data-sms-del="${i}" title="제외">✕</button>
        </div>
        <div class="si-text">${esc(s.address)}</div>
        <div class="sub">${sub || '추출된 부가정보 없음'}${notes}</div>
      </li>`;
    }).join('')
    + '</ul>'
    + `<p class="fine-print">${guessed ? '상차/하차 표기가 없어 <b>맨 위 주소를 상차지</b>, 아래를 하차지로 추정했습니다. ' : ''}내용을 확인하고, 상차/하차가 잘못됐으면 배지를 눌러 바꿔주세요.</p>`
    + `<button class="btn primary full top8" id="btn-add-sms">＋ 위 ${smsParsed.length}곳을 배송지에 추가</button>`;

  box.querySelectorAll('[data-sms-type]').forEach(b => b.addEventListener('click', () => {
    const s = smsParsed[+b.dataset.smsType];
    s.type = s.type === '하차' ? '상차' : '하차';
    renderSmsPreview();
  }));
  box.querySelectorAll('[data-sms-del]').forEach(b => b.addEventListener('click', () => {
    smsParsed.splice(+b.dataset.smsDel, 1);
    renderSmsPreview();
  }));
  $('#btn-add-sms').addEventListener('click', addSmsStops);
}

async function addSmsStops() {
  const defaultWork = parseInt($('#default-work').value, 10);
  const schedLabel = smsMeta.schedule ? smsMeta.schedule.label : '';
  const dates = scheduleDates(schedLabel);
  const pending = smsParsed.map(p => ({
    id: uid(), label: p.address, lat: null, lng: null,
    type: p.type, workMin: defaultWork, status: 'pending',
    phone: p.phone || '', contactName: p.contactName || '',
    cargo: p.cargo || '', podPhone: p.podPhone || '',
    notes: p.notes || [], schedule: schedLabel,
    visitDate: p.type === '상차' ? dates.load : dates.unload,
  }));
  if (dates.confirm) {
    toast(`📅 "${schedLabel}" 일정 — 월요일(${fmtDateK(isoDate(nextMonday()))})로 잡았습니다. 지정일이 다르면 날짜 배지를 눌러 수정하세요.`, 5000);
  } else if (pending.some(isFutureStop)) {
    toast(`📅 ${schedLabel} — 내일 이후 방문 지점은 오늘 경로에서 자동 제외됩니다`, 4500);
  }
  if (smsMeta.items.length) {
    addCargoItems(smsMeta.items, pending[0] ? pending[0].label : '');
  }
  smsParsed = [];
  smsMeta = { schedule: null, items: [] };
  $('#sms-input').value = '';
  $('#sms-preview').classList.add('hidden');
  resetSchedPicker();
  state.stops.push(...pending);
  renderStops();
  await geocodePending(pending);
}

/** 지오코딩 결과의 긴 전체 주소를 화면용으로 짧게 줄인다 */
function shortDisplay(d) {
  if (!d) return '';
  const s = String(d).split(',').map(p => p.trim()).slice(0, 3).join(' ');
  return s.length > 42 ? s.slice(0, 42) + '…' : s;
}

function telLink(phone) { return 'tel:' + String(phone).replace(/[^0-9+]/g, ''); }
function smsLink(phone, body) {
  const n = String(phone).replace(/[^0-9+]/g, '');
  // iOS는 sms:번호&body=, 안드로이드는 sms:번호?body= 형식을 쓴다
  const sep = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? '&' : '?';
  return `sms:${n}${sep}body=${encodeURIComponent(body)}`;
}

function renderStops() {
  const ul = $('#stop-list');
  ul.innerHTML = '';
  const today = state.stops.map((s, i) => ({ s, i })).filter(x => !isFutureStop(x.s));
  const future = state.stops.map((s, i) => ({ s, i })).filter(x => isFutureStop(x.s));

  const makeLi = ({ s, i }, isFuture) => {
    const li = document.createElement('li');
    li.dataset.i = i;
    li.className = 'stop-item ' + (s.type === '상차' ? 'load' : 'unload') + (s.status === 'error' ? ' error' : '') + (isFuture ? ' future' : '');
    const statusIcon = s.status === 'pending' ? '⏳' : s.status === 'error' ? '⚠️' : isFuture ? '📅' : '📍';
    const info = [
      s.schedule && !s.visitDate ? '📅 ' + s.schedule : '',
      s.contactName,
      s.phone ? '📞 ' + s.phone : '',
      s.cargo ? '📦 ' + s.cargo : '',
      s.podPhone ? '📸 인수증 → ' + s.podPhone : '',
    ].filter(Boolean).map(esc).join(' · ');
    const notes = (s.notes && s.notes.length)
      ? `<br>⚠️ <span class="note">${s.notes.map(esc).join(' / ')}</span>` : '';
    const dateBadge = s.visitDate
      ? `<button class="badge sched" data-act="date" data-i="${i}" title="눌러서 방문 날짜 변경">📅 ${fmtDateK(s.visitDate)}</button>` : '';
    li.innerHTML = `
      <div class="si-head">
        <span class="si-icon">${statusIcon}</span>
        <button class="badge ${s.type === '상차' ? 'load' : 'unload'}" data-act="type" data-i="${i}">${s.type}</button>
        ${dateBadge}
        <button class="icon-btn si-del" data-act="del" data-i="${i}" title="삭제">✕</button>
      </div>
      <div class="si-text">${esc(s.label)}</div>
      <div class="sub">${s.status === 'error' ? '주소를 찾지 못함 — 눌러서 수정' : esc(shortDisplay(s.display))}${info ? '<br>' + info : ''}${notes}</div>`;
    return li;
  };

  today.forEach(x => ul.appendChild(makeLi(x, false)));
  if (future.length) {
    const div = document.createElement('li');
    div.className = 'stop-divider';
    div.textContent = `📅 예정 방문 ${future.length}곳 — 오늘 경로에서 제외됩니다 (날짜가 되면 자동 포함)`;
    ul.appendChild(div);
    future.forEach(x => ul.appendChild(makeLi(x, true)));
  }

  ul.querySelectorAll('[data-act="date"]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation(); // 주소 수정(오류 항목) 클릭과 겹치지 않게
    const s = state.stops[+b.dataset.i];
    const input = prompt('방문 날짜를 입력하세요.\n예) 2026-07-21 또는 7/21 — 오늘 경로에 넣으려면 "오늘"', s.visitDate || '');
    if (input == null) return;
    const t = input.trim();
    if (t === '오늘' || t === '') s.visitDate = null;
    else {
      let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/) || t.match(/^(\d{1,2})[\/.](\d{1,2})$/);
      if (!m) { toast('날짜 형식을 확인해 주세요 (예: 7/21)'); return; }
      const d = m.length === 4
        ? new Date(+m[1], +m[2] - 1, +m[3])
        : (() => { const x = new Date(); x.setMonth(+m[1] - 1, +m[2]); if (isoDate(x) < isoDate(new Date())) x.setFullYear(x.getFullYear() + 1); return x; })();
      s.visitDate = isoDate(d);
    }
    renderStops(); saveState();
  }));
  ul.querySelectorAll('[data-act="type"]').forEach(b => b.addEventListener('click', () => {
    const s = state.stops[+b.dataset.i];
    s.type = s.type === '하차' ? '상차' : '하차';
    renderStops(); saveState();
  }));
  ul.querySelectorAll('[data-act="del"]').forEach(b => b.addEventListener('click', () => {
    state.stops.splice(+b.dataset.i, 1);
    renderStops(); saveState();
  }));
  ul.querySelectorAll('.stop-item.error').forEach(li => {
    const el = li.querySelector('.si-text');
    el.style.cursor = 'pointer';
    el.addEventListener('click', async () => {
      const stop = state.stops[+li.dataset.i];
      const fixed = prompt('주소를 수정해 주세요 (시/구/동 단위 권장)', stop.label);
      if (!fixed) return;
      stop.label = fixed.trim(); stop.status = 'pending';
      renderStops();
      const r = await Geo.geocode(stop.label).catch(() => null);
      if (r) { stop.lat = r.lat; stop.lng = r.lng; stop.status = 'ok'; stop.display = r.display; }
      else stop.status = 'error';
      renderStops(); saveState();
    });
  });
  renderFinalDestSelect();
  updateNewRouteBtn();
}

function renderFinalDestSelect() {
  const sel = $('#final-dest');
  const prev = sel.value;
  sel.innerHTML = '<option value="">자동 최적화 (지정 안 함)</option>'
    + state.stops.filter(s => !isFutureStop(s)).map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('');
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

// ─────────── 최적 경로 계산 ───────────
function setOptStatus(msg, cls = '') {
  const el = $('#optimize-status');
  el.textContent = msg;
  el.className = 'geo-status center ' + cls;
}

$('#btn-optimize').addEventListener('click', async () => {
  await geocodeOrigin();
  if (!state.origin) { toast('먼저 출발지를 입력하거나 📡 현재위치를 눌러 주세요'); return; }
  // 오늘 방문할 지점만 경로에 넣는다 (당상내착 하차지 등 예정 지점은 제외)
  const todayStops = state.stops.filter(s => !isFutureStop(s));
  const futureCount = state.stops.length - todayStops.length;
  const ready = todayStops.filter(s => s.status === 'ok');
  if (ready.length < 1) {
    toast(futureCount ? '오늘 방문할 배송지가 없습니다 (예정 배송지만 있음)' : '배송지를 1곳 이상 추가해 주세요');
    return;
  }
  if (todayStops.some(s => s.status === 'error')) {
    toast('⚠️ 주소를 찾지 못한 배송지가 있습니다. 수정하거나 삭제해 주세요.');
    return;
  }
  if (todayStops.some(s => s.status === 'pending')) {
    toast('주소 확인이 끝날 때까지 잠시 기다려 주세요');
    return;
  }

  const btn = $('#btn-optimize');
  btn.disabled = true;
  setOptStatus('🤖 AI가 최적 방문 순서를 계산하는 중…');

  try {
    const finalId = $('#final-dest').value;
    const finalTodayIdx = finalId ? todayStops.findIndex(s => s.id === finalId) : null;
    const resToday = await Router.optimize(state.origin, todayStops,
      (finalTodayIdx != null && finalTodayIdx >= 0) ? finalTodayIdx : null);
    // 순서를 전체 stops 배열 기준 인덱스로 되돌린다
    const res = { ...resToday, order: resToday.order.map(i => state.stops.indexOf(todayStops[i])) };

    // 출발 시각 결정
    const timeVal = $('#depart-time').value;
    const departAt = new Date();
    if (timeVal) {
      const [h, m] = timeVal.split(':').map(Number);
      departAt.setHours(h, m, 0, 0);
      if (departAt < new Date()) departAt.setDate(departAt.getDate() + 1);
    }

    state.result = {
      ...res,
      departAt: departAt.getTime(),
      schedule: buildSchedule(res, departAt),
    };
    state.trip = null;
    saveState();
    renderResult();
    const notice = [];
    if (res.approx) notice.push('⚠️ 경로 서버 연결이 원활하지 않아 직선거리 기반 추정치입니다.');
    if (futureCount) notice.push(`📅 예정 배송지 ${futureCount}곳은 오늘 경로에서 제외했습니다.`);
    setOptStatus(notice.join(' '));
    $('#result-area').classList.remove('hidden');
    $('#result-area').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    setOptStatus('✗ 경로 계산에 실패했습니다: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

/**
 * 시간대별 교통 보정 계수. OSRM 예상치는 정체를 반영하지 못하므로
 * 출퇴근·점심 시간대 통계 배율을 곱해 실제 소요시간에 가깝게 보정한다.
 * (실시간 교통 반영은 TMAP·카카오모빌리티 등 유료 API 연동 시 가능)
 */
function trafficFactor(date) {
  const day = date.getDay();
  const h = date.getHours() + date.getMinutes() / 60;
  const weekday = day >= 1 && day <= 5;
  if (weekday) {
    if (h >= 6.5 && h < 9.5) return 1.5;    // 출근 정체
    if (h >= 16.5 && h < 19.5) return 1.45; // 퇴근 정체
    if (h >= 11.5 && h < 14) return 1.15;   // 점심
    if (h >= 22 || h < 5) return 0.85;      // 심야
    return 1.1;
  }
  if (h >= 10 && h < 20) return 1.2;        // 주말 낮
  if (h >= 22 || h < 6) return 0.85;
  return 1.05;
}

/** 방문 순서에 따라 도착/출발 예정시각 계산 (구간마다 그 시각의 교통 계수를 적용) */
function buildSchedule(res, departAt) {
  const schedule = [];
  let t = departAt.getTime();
  res.order.forEach((stopIdx, i) => {
    const stop = state.stops[stopIdx];
    const leg = res.legs[i];
    const factor = trafficFactor(new Date(t));
    const legDuration = leg.duration * factor;
    t += legDuration * 1000;
    const arrive = t;
    t += (stop.workMin || 20) * 60 * 1000;
    schedule.push({ stopId: stop.id, arrive, depart: t, legDistance: leg.distance, legDuration, baseDuration: leg.duration, factor });
  });
  return schedule;
}

function orderedStops() {
  if (!state.result) return [];
  return state.result.order.map(i => state.stops[i]).filter(Boolean);
}

function renderResult() {
  const res = state.result;
  if (!res) return;

  // 합계 (운전 시간은 시간대 교통 보정치)
  const arriveLast = res.schedule.length ? new Date(res.schedule[res.schedule.length - 1].arrive) : null;
  const adjDuration = res.schedule.reduce((s, x) => s + (x.legDuration || 0), 0) || res.duration;
  $('#result-totals').innerHTML = `
    <div class="total-chip"><div class="v">${fmtKm(res.distance)}</div><div class="k">총 이동거리</div></div>
    <div class="total-chip"><div class="v">${fmtDur(adjDuration)}</div><div class="k">운전(교통 반영)</div></div>
    <div class="total-chip"><div class="v">${res.toll > 0 ? fmtWon(res.toll) : '없음'}</div><div class="k">예상 통행료</div></div>
    <div class="total-chip"><div class="v">${arriveLast ? fmtTime(arriveLast) : '-'}</div><div class="k">최종 도착 예정</div></div>`;

  // 방문 순서
  const ol = $('#visit-list');
  ol.innerHTML = '';
  const originLi = document.createElement('li');
  originLi.className = 'visit-item';
  originLi.innerHTML = `
    <div class="visit-num origin">출</div>
    <div class="visit-body">
      <div class="visit-name">${esc(state.origin.label)}</div>
      <div class="visit-meta">${fmtTime(new Date(res.departAt))} 출발</div>
    </div>`;
  ol.appendChild(originLi);

  res.order.forEach((stopIdx, i) => {
    const stop = state.stops[stopIdx];
    const sch = res.schedule[i];
    const li = document.createElement('li');
    li.className = 'visit-item';
    li.innerHTML = `
      <div class="visit-num">${i + 1}</div>
      <div class="visit-body">
        <div class="visit-name">${esc(stop.label)} <span class="badge ${stop.type === '상차' ? 'load' : 'unload'}" style="cursor:default">${stop.type}</span>${stop.schedule ? ` <span class="badge sched" style="cursor:default">📅 ${esc(stop.schedule)}</span>` : ''}</div>
        <div class="visit-meta">도착 ${fmtTime(new Date(sch.arrive))} · 작업 ${stop.workMin}분 · 출발 ${fmtTime(new Date(sch.depart))}</div>
        ${stop.cargo || stop.phone ? `<div class="visit-meta">${[stop.cargo ? '📦 ' + stop.cargo : '', stop.phone ? '📞 ' + (stop.contactName ? stop.contactName + ' ' : '') + stop.phone : ''].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
        ${stop.notes && stop.notes.length ? `<div class="visit-meta note">⚠️ ${stop.notes.map(esc).join(' / ')}</div>` : ''}
        <div class="visit-leg">↳ 이동 ${fmtKm(sch.legDistance)} · ${fmtDur(sch.legDuration)}${sch.factor && sch.factor > 1.25 ? ' <b>(정체 시간대)</b>' : ''}</div>
      </div>`;
    ol.appendChild(li);
  });

  renderMap();
  renderAiTips();
  updateNewRouteBtn();
}

// ─────────── 지도 ───────────
let map = null, mapLayers = [];
function renderMap() {
  if (typeof L === 'undefined' || !state.result) return;
  if (!map) {
    map = L.map('map', { zoomControl: true, attributionControl: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  }
  mapLayers.forEach(l => map.removeLayer(l));
  mapLayers = [];

  const res = state.result;
  const line = L.polyline(res.geometry, { color: '#3b82f6', weight: 5, opacity: 0.85 });
  line.addTo(map); mapLayers.push(line);

  const mk = (p, text, cls) => {
    const m = L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: 'map-marker ' + cls, html: text, iconSize: [36, 36], iconAnchor: [18, 18] }),
    }).addTo(map);
    mapLayers.push(m);
  };
  mk(state.origin, '출', 'origin');
  res.order.forEach((stopIdx, i) => mk(state.stops[stopIdx], String(i + 1), ''));
  // 컨테이너가 방금 표시된 경우 크기 계산이 늦으므로 잠시 후 범위를 맞춘다
  setTimeout(() => {
    map.invalidateSize();
    map.fitBounds(line.getBounds(), { padding: [30, 30] });
  }, 120);
}

// ─────────── AI 추천 ───────────
async function renderAiTips() {
  const res = state.result;
  const ul = $('#ai-tips');
  const tips = [];
  const depart = new Date(res.departAt);
  const hour = depart.getHours() + depart.getMinutes() / 60;
  const day = depart.getDay();
  const isWeekday = day >= 1 && day <= 5;

  // 출발 시간 추천
  if (isWeekday && hour >= 6.5 && hour < 9.5) {
    tips.push({ icon: '⏰', text: `출근 정체 시간대 출발입니다. 예상시간이 20~30% 늘어날 수 있어요. 가능하면 오전 9시 30분 이후 출발을 추천합니다.` });
  } else if (isWeekday && hour >= 16.5 && hour < 19.5) {
    tips.push({ icon: '⏰', text: `퇴근 정체 시간대와 겹칩니다. 주요 구간 정체를 감안해 여유시간을 30분 이상 확보하세요.` });
  } else {
    tips.push({ icon: '✅', text: `정체가 적은 시간대입니다. 계산된 예상시간대로 운행이 가능할 것으로 보입니다.` });
  }

  // 교통 보정 안내
  const adjDur = res.schedule.reduce((s, x) => s + (x.legDuration || 0), 0);
  if (adjDur > res.duration * 1.08) {
    tips.push({ icon: '⏱️', text: `시간대 교통량을 반영해 운전 시간을 ${fmtDur(res.duration)} → ${fmtDur(adjDur)}로 보정했습니다. 실시간 교통까지 반영하려면 유료 지도 API(TMAP·카카오모빌리티) 연동이 필요합니다.` });
  }

  // 통행료
  if (res.toll > 0) {
    tips.push({ icon: '💰', text: `고속도로 이용이 포함된 경로입니다(통행료 약 ${fmtWon(res.toll)}). 시간 여유가 있다면 국도 우회로 통행료를 아낄 수 있지만, 소요시간이 늘어납니다.` });
  } else {
    tips.push({ icon: '💰', text: `대부분 일반도로 경로로 통행료 부담이 거의 없습니다.` });
  }

  // 작업 배분
  const loads = state.stops.filter(s => s.type === '상차').length;
  const unloads = state.stops.filter(s => s.type === '하차').length;
  if (loads && unloads) {
    tips.push({ icon: '📦', text: `상차 ${loads}곳 · 하차 ${unloads}곳 혼적 운행입니다. 상차지에서 하차 순서 역순으로 싣으면(나중에 내릴 짐을 안쪽에) 하차가 빨라집니다.` });
  }

  ul.innerHTML = tips.map(t => `<li data-icon="${t.icon}">${esc(t.text)}</li>`).join('');

  // 강수 예보 (Open-Meteo 무료 API — 실패해도 무시)
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${state.origin.lat}&longitude=${state.origin.lng}&hourly=precipitation_probability&forecast_days=1&timezone=Asia%2FSeoul`;
    const data = await (await fetch(url)).json();
    const hh = depart.getHours();
    const probs = (data.hourly && data.hourly.precipitation_probability || []).slice(hh, hh + Math.ceil(res.duration / 3600) + 1);
    const maxProb = Math.max(0, ...probs);
    if (maxProb >= 50) {
      ul.insertAdjacentHTML('beforeend',
        `<li data-icon="🌧️">운행 시간대 강수확률 ${maxProb}% — 빗길 감속을 감안해 예상시간에 15% 이상 여유를 두고, 급제동에 주의하세요.</li>`);
    }
  } catch (e) { /* 날씨는 부가 정보 — 실패 무시 */ }
}

// ─────────── 내비게이션 연동 ───────────
// 세 앱 모두 "출발지 = 휴대폰 현재위치"로 자동 설정되며, 여기서는 도착지만 전달한다.
// 좌표 파라미터 순서: TMAP goalx=경도/goaly=위도, 카카오 ep=위도,경도, 네이버 dlat=위도/dlng=경도
function naviLinks(dest) {
  if (!dest || !Number.isFinite(dest.lat) || !Number.isFinite(dest.lng)
    || Math.abs(dest.lat) > 90 || Math.abs(dest.lng) > 180) return null;
  const lat = (+dest.lat).toFixed(6), lng = (+dest.lng).toFixed(6);
  const name = encodeURIComponent(String(dest.label || '목적지').slice(0, 100));
  return {
    tmap: `tmap://route?goalname=${name}&goalx=${lng}&goaly=${lat}`,
    kakao: `kakaomap://route?ep=${lat},${lng}&by=CAR`,
    naver: `nmap://route/car?dlat=${lat}&dlng=${lng}&dname=${name}&appname=cargo.route.web`,
  };
}

/** 내비 버튼 3종 + 실행 전 목적지 확인 문구. navi-grid 컨테이너 안에 넣는다. */
function naviButtonsHtml(dest) {
  const links = naviLinks(dest);
  if (!links) {
    return `<div class="fine-print" style="grid-column:1/-1">⚠️ 이 목적지의 좌표가 확인되지 않아 내비를 실행할 수 없습니다. 경로 탭에서 주소를 수정한 뒤 경로를 다시 계산해 주세요.</div>`;
  }
  const sub = dest.display && dest.display !== dest.label ? `<br><span class="hint">확인된 위치: ${esc(shortDisplay(dest.display))}</span>` : '';
  return `
    <div class="fine-print" style="grid-column:1/-1;margin:0">🎯 안내 목적지: <b>${esc(dest.label)}</b>${sub}</div>
    <a class="navi-btn tmap" href="${links.tmap}">TMAP<br>실행</a>
    <a class="navi-btn kakao" href="${links.kakao}">카카오맵<br>실행</a>
    <a class="navi-btn naver" href="${links.naver}">네이버지도<br>실행</a>`;
}

/** 네이버지도 전체 경로 URL: 현재위치 → 경유지(최대 5) → 최종 목적지 */
function naverFullRouteUrl(stops) {
  const valid = stops.filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  if (valid.length < 2) return null;
  const nm = (s) => encodeURIComponent(String(s.label || '목적지').slice(0, 60));
  const dest = valid[valid.length - 1];
  const vias = valid.slice(0, -1).slice(0, 5);   // 네이버 경유지 최대 5곳
  let url = `nmap://route/car?dlat=${(+dest.lat).toFixed(6)}&dlng=${(+dest.lng).toFixed(6)}&dname=${nm(dest)}`;
  vias.forEach((v, i) => {
    url += `&v${i + 1}lat=${(+v.lat).toFixed(6)}&v${i + 1}lng=${(+v.lng).toFixed(6)}&v${i + 1}name=${nm(v)}`;
  });
  url += '&appname=cargo.route.web';
  return { url, dropped: (valid.length - 1) - vias.length };
}

$('#btn-copy-order').addEventListener('click', () => {
  const res = state.result;
  if (!res) return;
  const lines = [`🚚 화물 혼적 경로 — 방문 순서`, `출발: ${state.origin.label} (${fmtTime(new Date(res.departAt))})`];
  res.order.forEach((stopIdx, i) => {
    const s = state.stops[stopIdx];
    const sch = res.schedule[i];
    lines.push(`${i + 1}. [${s.type}] ${s.label}${s.phone ? ` (담당 ${s.contactName ? s.contactName + ' ' : ''}${s.phone})` : ''} — 도착 ${fmtTime(new Date(sch.arrive))}`);
  });
  lines.push(`총거리 ${fmtKm(res.distance)} · 운전 ${fmtDur(res.duration)} · 통행료 약 ${fmtWon(res.toll)}`);
  navigator.clipboard.writeText(lines.join('\n'))
    .then(() => toast('📋 방문 순서를 복사했습니다'))
    .catch(() => toast('복사에 실패했습니다'));
});

// ─────────── 운행 ───────────
$('#btn-start-trip').addEventListener('click', () => {
  if (!state.result) return;
  state.trip = {
    startedAt: Date.now(),
    events: {},
    snapshot: {
      origin: state.origin,
      // 구간별 계획 거리·시간을 함께 저장해 운행 중 경유지 추가 시 재계산에 쓴다
      stops: orderedStops().map((s, i) => ({
        ...s,
        planLegDistance: state.result.schedule[i] ? state.result.schedule[i].legDistance : 0,
        planLegDuration: state.result.schedule[i] ? state.result.schedule[i].legDuration : 0,
      })),
      distance: state.result.distance,
      duration: state.result.duration,
      toll: state.result.toll,
    },
  };
  saveState();
  switchTab('drive');
  toast('🚛 운행을 시작합니다. 안전운전 하세요!');
});

let driveTimerId = null;
function renderDrive() {
  const trip = state.trip;
  const active = trip && !trip.endedAt;
  $('#drive-empty').classList.toggle('hidden', !!trip);
  $('#drive-active').classList.toggle('hidden', !active);

  clearInterval(driveTimerId);
  if (active) {
    const tick = () => { $('#drive-timer').textContent = fmtClock((Date.now() - trip.startedAt) / 1000); };
    tick();
    driveTimerId = setInterval(tick, 1000);
    renderDriveChecklist();
  }
}

function renderDriveChecklist() {
  const trip = state.trip;
  const stops = trip.snapshot.stops;
  const done = stops.filter(s => trip.events[s.id] && trip.events[s.id].doneAt).length;

  $('#drive-progress').innerHTML = `
    <div class="total-chip"><div class="v">${done} / ${stops.length}</div><div class="k">완료한 배송지</div></div>
    <div class="total-chip"><div class="v">${fmtKm(trip.snapshot.distance)}</div><div class="k">계획 거리</div></div>
    <div class="total-chip"><div class="v">${fmtDur(trip.snapshot.duration)}</div><div class="k">계획 운전시간</div></div>`;

  // 다음 목적지
  const next = stops.find(s => !(trip.events[s.id] && trip.events[s.id].doneAt));
  if (next) {
    const idx = stops.indexOf(next);
    $('#next-stop-card').classList.remove('hidden');
    // 받는 사람이 '누가·무슨 화물인지' 알 수 있게 화물·담당자 정보를 문자에 넣는다
    const act = next.type === '상차' ? '상차' : '하차';
    const who = [next.cargo, next.contactName ? next.contactName + ' 담당' : ''].filter(Boolean).join(' · ');
    const arriveMsg = `안녕하세요, 화물 기사입니다.${who ? `\n[${who}]` : ''}\n이 건으로 ${act}하러 가는 길입니다. 약 5분 후 도착 예정입니다.`;

    // 네이버로 남은 경로 전체(경유지 포함) 안내 버튼
    const remaining = stops.filter(s => !(trip.events[s.id] && trip.events[s.id].doneAt));
    const nf = naverFullRouteUrl(remaining);
    const nbtn = $('#btn-naver-full');
    if (nf) { nbtn.style.display = ''; nbtn.href = nf.url; }
    else { nbtn.style.display = 'none'; }

    const contactHtml = next.phone ? `
      <div class="row gap" style="margin-bottom:8px">
        <a class="mini-btn" href="${telLink(next.phone)}">📞 ${esc(next.contactName || '담당자')} 전화</a>
        <a class="mini-btn" href="${smsLink(next.phone, arriveMsg)}">✉️ 곧 도착 문자</a>
      </div>` : '';
    // 이 카드에서 바로 도착·완료 처리 → 완료하면 다음 목적지로 넘어간다
    const nev = trip.events[next.id] || {};
    const actionHtml = `
      <div class="row gap" style="margin:4px 0 10px">
        ${!nev.arrivedAt ? `<button class="btn secondary grow" data-act="arrive" data-id="${next.id}">📍 도착했어요</button>` : ''}
        <button class="btn primary grow" data-act="done" data-id="${next.id}">✅ ${act} 끝 → 다음 목적지</button>
      </div>`;
    $('#next-stop-info').innerHTML = `
      <div class="visit-name" style="font-size:17px;margin-bottom:8px">${idx + 1}. ${esc(next.label)}
        <span class="badge ${next.type === '상차' ? 'load' : 'unload'}" style="cursor:default">${next.type}</span>${next.schedule ? ` <span class="badge sched" style="cursor:default">📅 ${esc(next.schedule)}</span>` : ''}</div>
      ${next.cargo ? `<div class="visit-meta" style="margin-bottom:8px">📦 ${esc(next.cargo)}</div>` : ''}
      ${next.notes && next.notes.length ? `<div class="visit-meta note" style="margin-bottom:8px">⚠️ ${next.notes.map(esc).join(' / ')}</div>` : ''}
      ${actionHtml}
      ${contactHtml}`;
    $('#drive-navi').innerHTML = naviButtonsHtml(next);
  } else {
    $('#next-stop-card').classList.add('hidden');
  }

  // 체크리스트
  const ul = $('#drive-checklist');
  ul.innerHTML = '';
  stops.forEach((s, i) => {
    const ev = trip.events[s.id] || {};
    const li = document.createElement('li');
    li.className = 'visit-item';
    const waitMin = (ev.arrivedAt && ev.doneAt) ? Math.round((ev.doneAt - ev.arrivedAt) / 60000) : null;
    let meta = '';
    if (ev.arrivedAt) meta += `도착 ${fmtTime(new Date(ev.arrivedAt))}`;
    if (ev.doneAt) meta += ` · ${s.type} 완료 ${fmtTime(new Date(ev.doneAt))} · 작업 ${waitMin}분`;
    li.innerHTML = `
      <div class="visit-num ${ev.doneAt ? 'done' : ''}">${ev.doneAt ? '✓' : i + 1}</div>
      <div class="visit-body">
        <div class="visit-name">${esc(s.label)} <span class="badge ${s.type === '상차' ? 'load' : 'unload'}" style="cursor:default">${s.type}</span></div>
        <div class="visit-meta">${meta || '대기 중'}</div>
        ${s.notes && s.notes.length && !ev.doneAt ? `<div class="visit-meta note">⚠️ ${s.notes.map(esc).join(' / ')}</div>` : ''}
      </div>
      <div class="visit-actions">
        ${ev.doneAt ? '' : `<button class="mini-btn" data-act="done" data-id="${s.id}">${s.type} 완료</button>`}
        ${s.phone ? `<a class="mini-btn" href="${telLink(s.phone)}" title="${esc(s.contactName || '담당자')} 전화">📞</a>` : ''}
        ${ev.doneAt && s.podPhone ? `<a class="mini-btn" href="${smsLink(s.podPhone, '안녕하세요, 화물 기사입니다. 인수증 사진 보내드립니다. (사진을 첨부해 주세요)')}">📸 인수증 전송</a>` : ''}
      </div>`;
    ul.appendChild(li);
  });
  // 다음 목적지 카드 + 체크리스트의 모든 도착·완료 버튼에 동작 연결
  $('#drive-active').querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const ev = state.trip.events[b.dataset.id] || (state.trip.events[b.dataset.id] = {});
    if (b.dataset.act === 'arrive') ev.arrivedAt = Date.now();
    if (b.dataset.act === 'done') {
      if (!ev.arrivedAt) ev.arrivedAt = Date.now();
      ev.doneAt = Date.now();
      const s = state.trip.snapshot.stops.find(x => x.id === b.dataset.id);
      if (s && s.podPhone) toast(`📸 인수증 싸인 사진을 ${s.podPhone} 로 보내주세요 — 아래 [인수증 전송] 버튼을 누르세요`, 5000);
    }
    saveState();
    renderDriveChecklist();
  }));
}

// ─────────── 운행 중 화물(경유지) 추가 ───────────
// 운행 도중 새로 잡은 배차를 붙여넣으면, 현재 위치 기준으로
// 아직 방문하지 않은 지점 + 새 지점을 묶어 남은 경로를 다시 최적화한다.
$('#btn-drive-add').addEventListener('click', driveAddStops);

async function driveAddStops() {
  const trip = state.trip;
  if (!trip || trip.endedAt) return;
  const text = $('#drive-add-input').value.trim();
  if (!text) { toast('추가할 배차 문자나 주소를 붙여넣어 주세요'); return; }

  const st = (msg, cls = '') => {
    const el = $('#drive-add-status');
    el.textContent = msg;
    el.className = 'geo-status ' + cls;
  };
  const btn = $('#btn-drive-add');
  btn.disabled = true;

  try {
    const full = SmsParser.parseFull(text);
    const defaultWork = parseInt($('#default-work').value, 10) || 20;
    let specs;
    if (full.stops.length) {
      const schedLabel = full.schedule ? full.schedule.label : '';
      const dates = scheduleDates(schedLabel);
      specs = full.stops.map(p => ({
        label: p.address, type: p.type,
        phone: p.phone || '', contactName: p.contactName || '',
        cargo: p.cargo || '', podPhone: p.podPhone || '',
        notes: p.notes || [], schedule: schedLabel,
        visitDate: p.type === '상차' ? dates.load : dates.unload,
      }));
    } else {
      const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
      specs = lines.map((label, i) => ({
        label, type: lines.length >= 2 && i === 0 ? '상차' : '하차',
        phone: '', contactName: '', cargo: '', podPhone: '', notes: [], schedule: '',
      }));
    }

    // 주소 → 좌표
    const newStops = [];
    for (let i = 0; i < specs.length; i++) {
      st(`🔍 주소 확인 중… (${i + 1}/${specs.length}) ${specs[i].label}`);
      const r = await Geo.geocode(specs[i].label).catch(() => null);
      if (!r) { toast(`⚠️ 주소를 찾지 못해 제외: ${specs[i].label}`); continue; }
      newStops.push({
        id: uid(), ...specs[i], lat: r.lat, lng: r.lng, display: r.display,
        status: 'ok', workMin: defaultWork,
      });
    }
    if (!newStops.length) { st('✗ 추가할 수 있는 주소가 없습니다. 주소를 확인해 주세요.', 'err'); return; }

    // 내일 이후 방문 지점(당상내착 하차지 등)은 오늘 운행 경로에 넣지 않고 예정 목록으로만 보관
    const todayNew = newStops.filter(s => !isFutureStop(s));
    const futureNew = newStops.filter(isFutureStop);
    if (!todayNew.length) {
      state.stops.push(...newStops.map(s => ({ ...s })));
      if (full.items && full.items.length) addCargoItems(full.items, newStops[0].label);
      $('#drive-add-input').value = '';
      st('');
      saveState(); renderStops();
      toast(`📅 ${futureNew.length}곳 모두 내일 이후 방문 — 경로 탭 예정 목록에 담아두었습니다`, 5000);
      return;
    }

    // 재계산 기준점: GPS 현재 위치 → 실패 시 마지막 완료 지점 → 출발지
    st('📡 현재 위치 확인 중…');
    let cur;
    try {
      const p = await Geo.currentPosition();
      cur = { label: p.display, lat: p.lat, lng: p.lng };
    } catch (e) {
      const done = trip.snapshot.stops.filter(s => trip.events[s.id] && trip.events[s.id].doneAt);
      cur = done.length ? done[done.length - 1] : trip.snapshot.origin;
      toast('현재 위치를 가져오지 못해 마지막 완료 지점 기준으로 계산합니다');
    }

    const isDone = s => trip.events[s.id] && trip.events[s.id].doneAt;
    const remaining = trip.snapshot.stops.filter(s => !isDone(s));
    const all = [...remaining, ...todayNew];

    st(`🤖 남은 ${all.length}곳의 경로를 다시 계산하는 중…`);
    const res = await Router.optimize(cur, all, null);
    const ordered = res.order.map(i => all[i]).map((s, i) => ({
      ...s,
      planLegDistance: res.legs[i] ? res.legs[i].distance : 0,
      planLegDuration: res.legs[i] ? res.legs[i].duration : 0,
    }));
    const done = trip.snapshot.stops.filter(isDone);
    const doneDistance = done.reduce((s, x) => s + (x.planLegDistance || 0), 0);
    const doneDuration = done.reduce((s, x) => s + (x.planLegDuration || 0), 0);
    trip.snapshot.stops = [...done, ...ordered];
    trip.snapshot.distance = doneDistance + res.distance;
    trip.snapshot.duration = doneDuration + res.duration;

    // 경로 탭 배송지 목록·적재 탭 화물 목록에도 반영
    state.stops.push(...newStops.map(s => ({ ...s })));
    if (full.items && full.items.length) {
      addCargoItems(full.items, newStops[0].label);
    }

    $('#drive-add-input').value = '';
    st(res.approx ? '⚠️ 경로 서버 연결이 원활하지 않아 직선거리 기반 추정치입니다.' : '');
    saveState();
    renderStops();
    renderDriveChecklist();
    toast(`✅ ${todayNew.length}곳 추가 — 남은 경로를 다시 계산했습니다.`
      + (futureNew.length ? ` 내일 이후 ${futureNew.length}곳은 예정 목록에 보관했습니다.` : ''), 5000);
  } catch (e) {
    st('✗ 재계산에 실패했습니다: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

$('#btn-end-trip').addEventListener('click', () => {
  if (!confirm('운행을 종료할까요?\n(끝난 배송지와 경로 결과는 지워지고, 새 경로를 바로 입력할 수 있어요. 내일 예정 배송지는 남습니다.)')) return;
  state.trip = null;
  // 끝난 경로 정리 — 내일 이후 예정(당상내착 등) 지점만 남기고 오늘 것과 결과는 비운다
  const futureCount = state.stops.filter(isFutureStop).length;
  state.stops = state.stops.filter(isFutureStop);
  state.result = null;
  $('#result-area').classList.add('hidden');
  saveState();
  renderStops();
  renderDrive();
  switchTab('route');
  toast(futureCount
    ? `🏁 운행 종료 — 새 경로를 입력하세요. (예정 배송지 ${futureCount}곳은 남겨뒀습니다)`
    : '🏁 운행을 종료했습니다. 새 경로를 입력하세요. 수고하셨습니다!', 5000);
});

// ─────────── 적재 계산 ───────────
const TRUCK_KEY = 'cargo-truck-v1';
const ITEMS_KEY = 'cargo-items-v1';

const TRUCK_PRESETS = [
  { name: '봉고3 EV / 1톤 카고 (개방형)', l: 286, w: 163, h: 120, payload: 1000 },
  { name: '1톤 탑차', l: 280, w: 160, h: 170, payload: 1000 },
  { name: '1톤 저상 탑차', l: 280, w: 160, h: 140, payload: 1000 },
  { name: '1톤 윙바디', l: 280, w: 160, h: 170, payload: 1000 },
  { name: '1톤 저상 윙바디', l: 285, w: 165, h: 125, payload: 1000 },
  { name: '다마스 밴', l: 165, w: 110, h: 105, payload: 400 },
  { name: '라보', l: 220, w: 134, h: 100, payload: 550 },
  { name: '2.5톤 카고', l: 430, w: 186, h: 160, payload: 2500 },
  { name: '2.5톤 윙바디', l: 430, w: 205, h: 185, payload: 2500 },
  { name: '5톤 카고', l: 620, w: 230, h: 230, payload: 5000 },
  { name: '5톤 윙바디', l: 620, w: 235, h: 240, payload: 5000 },
  { name: '직접 입력', l: null, w: null, h: null, payload: null },
];

function loadMyTruck() {
  try { return JSON.parse(localStorage.getItem(TRUCK_KEY) || 'null'); } catch (e) { return null; }
}

function truckOptions() {
  const my = loadMyTruck();
  return my ? [{ ...my, name: '💾 내 차량 — ' + my.name, mine: true }, ...TRUCK_PRESETS] : TRUCK_PRESETS.slice();
}

function renderTruckSelect(selectMine) {
  const sel = $('#truck-select');
  const opts = truckOptions();
  sel.innerHTML = opts.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
  if (selectMine && opts[0] && opts[0].mine) sel.value = '0';
  applyTruckPreset();
}

function applyTruckPreset() {
  const p = truckOptions()[+$('#truck-select').value];
  if (p && p.l) {
    $('#truck-l').value = p.l; $('#truck-w').value = p.w;
    $('#truck-h').value = p.h; $('#truck-payload').value = p.payload;
  }
  updateTruckCbm();
}

/** 차량 치수 아래에 적재함 용적(CBM)을 항상 보여준다 */
function updateTruckCbm() {
  const l = parseFloat($('#truck-l').value), w = parseFloat($('#truck-w').value), h = parseFloat($('#truck-h').value);
  const el = $('#truck-cbm');
  if (l > 0 && w > 0 && h > 0) {
    el.innerHTML = `📐 적재함 용적: <b>${(l * w * h / 1e6).toFixed(2)} CBM</b> (${l} × ${w} × ${h}cm)`;
  } else {
    el.textContent = '';
  }
}

// ── 화물 목록 (문자에서 자동 수집 + 직접 추가, localStorage 유지) ──
let cargoItems = [];
function loadItems() {
  try { cargoItems = JSON.parse(localStorage.getItem(ITEMS_KEY) || '[]'); } catch (e) { cargoItems = []; }
}
function saveItems() {
  try { localStorage.setItem(ITEMS_KEY, JSON.stringify(cargoItems)); } catch (e) { /* ignore */ }
}

/** 문자 파싱 결과의 화물들을 목록에 누적한다 (경로·운행 탭에서 호출) */
function addCargoItems(items, fromLabel) {
  items.forEach(it => cargoItems.push({
    id: uid(), kind: it.kind, w: it.w, d: it.d, h: it.h,
    count: it.count, totalKg: it.totalKg || 0,
    stack: 1, from: fromLabel || '',
  }));
  saveItems();
  renderCargoItems();
  toast(`📦 화물 ${items.length}건을 적재 탭 목록에 추가했습니다`);
}

function renderCargoItems() {
  const ul = $('#cargo-item-list');
  if (!cargoItems.length) {
    ul.innerHTML = '<li class="stop-item"><div class="si-head"><span class="si-icon">📭</span></div><div class="si-text">담긴 화물이 없습니다</div><div class="sub">문자를 붙여넣으면 치수·수량이 자동으로 담깁니다</div></li>';
    return;
  }
  ul.innerHTML = cargoItems.map((it, i) => {
    const sub = [it.from ? '출처: ' + it.from : '', it.kind === 'plt' ? (it.stack >= 2 ? '2단 허용' : '1단(기본)') : ''].filter(Boolean).map(esc).join(' · ');
    return `
    <li class="stop-item">
      <div class="si-head">
        <span class="si-icon">${it.kind === 'plt' ? '🟫' : '📦'}</span>
        ${it.kind === 'plt' ? `<button class="badge ${it.stack >= 2 ? 'load' : 'unload'}" data-item-stack="${i}" title="파레트 겹침 허용 전환">${it.stack >= 2 ? '2단' : '1단'}</button>` : ''}
        <button class="icon-btn si-del" data-item-del="${i}" title="삭제">✕</button>
      </div>
      <div class="si-text">${esc(itemLabel(it))}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ''}
    </li>`;
  }).join('');
  ul.querySelectorAll('[data-item-stack]').forEach(b => b.addEventListener('click', () => {
    const it = cargoItems[+b.dataset.itemStack];
    it.stack = it.stack >= 2 ? 1 : 2;
    saveItems(); renderCargoItems();
  }));
  ul.querySelectorAll('[data-item-del]').forEach(b => b.addEventListener('click', () => {
    cargoItems.splice(+b.dataset.itemDel, 1);
    saveItems(); renderCargoItems();
  }));
}

function initCargo() {
  renderTruckSelect(true);
  $('#truck-select').addEventListener('change', applyTruckPreset);
  $('#btn-save-truck').addEventListener('click', () => {
    const l = parseFloat($('#truck-l').value), w = parseFloat($('#truck-w').value),
          h = parseFloat($('#truck-h').value), payload = parseFloat($('#truck-payload').value) || 0;
    if (!(l > 0 && w > 0 && h > 0)) { toast('적재함 길이·폭·높이를 먼저 입력해 주세요'); return; }
    const prev = loadMyTruck();
    const name = prompt('차량 이름을 입력하세요 (예: 1톤 저상 윙바디)', prev ? prev.name : '1톤 저상 윙바디');
    if (!name) return;
    try { localStorage.setItem(TRUCK_KEY, JSON.stringify({ name: name.trim(), l, w, h, payload })); } catch (e) { /* ignore */ }
    renderTruckSelect(true);
    toast(`💾 내 차량으로 저장했습니다 (적재함 ${(l * w * h / 1e6).toFixed(2)} CBM). 다음부터 자동으로 선택됩니다.`);
  });
  ['#truck-l', '#truck-w', '#truck-h'].forEach(sel => $(sel).addEventListener('input', updateTruckCbm));
  loadItems();
  renderCargoItems();

  // 박스/파레트 선택 버튼
  let itemKind = 'box';
  $$('#item-kind-picker [data-kind]').forEach(b => b.addEventListener('click', () => {
    itemKind = b.dataset.kind;
    $$('#item-kind-picker [data-kind]').forEach(x => x.classList.toggle('active', x === b));
  }));

  $('#btn-add-item').addEventListener('click', () => {
    const it = {
      kind: itemKind,
      w: parseFloat($('#item-w').value), d: parseFloat($('#item-d').value), h: parseFloat($('#item-h').value),
      count: parseInt($('#item-count').value, 10),
      totalKg: parseFloat($('#item-weight').value) || 0,
    };
    if (!(it.w > 0 && it.d > 0 && it.h > 0 && it.count > 0)) { toast('화물 치수와 수량을 입력해 주세요'); return; }
    addCargoItems([it], '직접 입력');
    // 다음 화물을 지우는 과정 없이 바로 입력할 수 있게 전부 비운다
    ['#item-count', '#item-w', '#item-d', '#item-h', '#item-weight'].forEach(sel => { $(sel).value = ''; });
  });

  // 숫자칸은 탭하면 기존 값이 전체 선택되어 지우지 않고 바로 덮어쓸 수 있다
  $$('input[type="number"]').forEach(inp => inp.addEventListener('focus', () => {
    setTimeout(() => { try { inp.select(); } catch (e) { /* ignore */ } }, 0);
  }));
  $('#btn-clear-items').addEventListener('click', () => {
    if (!cargoItems.length) return;
    if (!confirm('화물 목록을 모두 비울까요?')) return;
    cargoItems = [];
    saveItems(); renderCargoItems();
    $('#cargo-result').classList.add('hidden');
  });
}

/**
 * 한 화물의 실을 자리를 계산한다 — 단순 부피(CBM)가 아니라
 * "폭에 몇 줄 × 높이에 몇 단 × 길이 방향 몇 열"의 실제 쌓기 기준.
 * 파레트는 기본 1단(stack으로 2단 허용), 박스는 높이가 허용하는 만큼 쌓는다.
 */
function placeItem(item, TW, TH) {
  const { w, d, h, count } = item;
  const maxStack = item.kind === 'plt' ? (item.stack || 1) : Infinity;
  let best = null;
  for (const [x, y] of [[w, d], [d, w]]) {   // 세운 상태에서 가로/세로 회전만 허용
    const across = Math.floor(TW / x);
    const layers = Math.min(Math.floor(TH / h), maxStack);
    if (across < 1 || layers < 1) continue;
    const cols = Math.ceil(count / (across * layers));
    const usedLen = cols * y;
    if (!best || usedLen < best.usedLen) best = { across, layers, cols, usedLen, x, y };
  }
  if (!best) {
    return { fit: false, reason: h > TH ? `높이 ${h}cm가 적재함 높이 ${TH}cm를 넘습니다` : `가로·세로(${w}×${d}cm)가 적재함 폭 ${TW}cm를 넘습니다` };
  }
  return { fit: true, ...best, wastedH: TH - best.layers * h };
}

const DIAGRAM_COLORS = ['#3b82f6', '#f59e0b', '#8b5cf6', '#10b981', '#ec4899', '#84cc16'];

/** 적재함 배치도(위에서 본 모습 + 옆에서 본 모습). results는 순차 적재 계산 결과. */
function cargoDiagramSvg(results, TL, TW, TH) {
  const fits = results.filter(r => r.loaded > 0);
  if (!fits.length) return '';
  const CAB = 36, PAD = 4;
  const hasLeft = results.some(r => r.left > 0);

  // ── 위에서 본 모습 ──
  const W1 = CAB + TL + PAD * 2, H1 = TW + PAD * 2;
  let top = `<rect x="${CAB}" y="${PAD}" width="${TL}" height="${TW}" rx="4" fill="var(--card-sub)" stroke="var(--line)" stroke-width="1.5"/>`;
  top += `<rect x="${PAD}" y="${PAD + TW * 0.15}" width="${CAB - 12}" height="${TW * 0.7}" rx="8" fill="var(--brand-soft)" stroke="var(--line)"/>`
    + `<text x="${PAD + (CAB - 12) / 2}" y="${PAD + TW / 2}" text-anchor="middle" dominant-baseline="central" font-size="13" fill="var(--brand)">앞</text>`;
  let cursor = CAB;
  fits.forEach((r, idx) => {
    const p = r.place;
    const color = DIAGRAM_COLORS[results.indexOf(r) % DIAGRAM_COLORS.length];
    let remaining = r.loaded;
    for (let j = 0; j < r.usedCols; j++) {
      for (let k = 0; k < p.across && remaining > 0; k++) {
        const stackH = Math.min(p.layers, remaining);
        remaining -= stackH;
        top += `<rect x="${(cursor + 0.8).toFixed(1)}" y="${(PAD + k * p.x + 0.8).toFixed(1)}" width="${(p.y - 1.6).toFixed(1)}" height="${(p.x - 1.6).toFixed(1)}" rx="2" fill="${color}" fill-opacity="${stackH === p.layers ? 0.85 : 0.4}" stroke="${color}" stroke-width="1"/>`;
      }
      cursor += p.y;
    }
  });
  const freeLen = CAB + TL - cursor;
  if (freeLen > 8) {
    const c = hasLeft ? 'var(--red)' : 'var(--green)';
    top += `<rect x="${cursor + 2}" y="${PAD + 2}" width="${freeLen - 4}" height="${TW - 4}" rx="4" fill="none" stroke="${c}" stroke-width="1.5" stroke-dasharray="6 5"/>`;
    const cx = cursor + freeLen / 2;
    const txt = hasLeft ? '부족' : '남는 공간';
    top += freeLen > 60
      ? `<text x="${cx}" y="${PAD + TW / 2 - 9}" text-anchor="middle" dominant-baseline="central" font-size="15" font-weight="700" fill="${c}">${txt}<tspan x="${cx}" dy="19">${Math.round(freeLen)}cm</tspan></text>`
      : `<text x="${cx}" y="${PAD + TW / 2}" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="700" fill="${c}">${Math.round(freeLen)}</text>`;
  } else if (hasLeft) {
    top += `<text x="${CAB + TL - 5}" y="${PAD + TW / 2}" text-anchor="end" dominant-baseline="central" font-size="14" font-weight="700" fill="var(--red)">⚠️</text>`;
  }

  // ── 옆에서 본 모습 (몇 단으로 쌓이는지) ──
  const W2 = CAB + TL + PAD * 2, H2 = TH + PAD * 2;
  const GROUND = PAD + TH;
  let side = `<rect x="${CAB}" y="${PAD}" width="${TL}" height="${TH}" rx="4" fill="var(--card-sub)" stroke="var(--line)" stroke-width="1.5"/>`;
  side += `<rect x="${PAD}" y="${PAD + TH * 0.25}" width="${CAB - 12}" height="${TH * 0.75}" rx="8" fill="var(--brand-soft)" stroke="var(--line)"/>`
    + `<text x="${PAD + (CAB - 12) / 2}" y="${PAD + TH * 0.62}" text-anchor="middle" dominant-baseline="central" font-size="13" fill="var(--brand)">앞</text>`;
  cursor = CAB;
  fits.forEach((r) => {
    const p = r.place, it = r.it;
    const color = DIAGRAM_COLORS[results.indexOf(r) % DIAGRAM_COLORS.length];
    for (let l = 0; l < p.layers; l++) {
      side += `<rect x="${(cursor + 0.8).toFixed(1)}" y="${(GROUND - (l + 1) * it.h + 0.8).toFixed(1)}" width="${(r.usedLen - 1.6).toFixed(1)}" height="${(it.h - 1.6).toFixed(1)}" rx="2" fill="${color}" fill-opacity="0.85" stroke="${color}" stroke-width="1"/>`;
    }
    if (r.usedLen > 34) {
      side += `<text x="${cursor + r.usedLen / 2}" y="${GROUND - p.layers * it.h / 2}" text-anchor="middle" dominant-baseline="central" font-size="14" font-weight="700" fill="#fff">${p.layers}단</text>`;
    }
    // 블록 위의 못 쓰는 공간 표시
    const wasted = TH - p.layers * it.h;
    if (wasted >= 25 && r.usedLen > 60) {
      side += `<text x="${cursor + r.usedLen / 2}" y="${PAD + wasted / 2}" text-anchor="middle" dominant-baseline="central" font-size="10" fill="var(--ink-dim)">↕ ${Math.round(wasted)}cm 빈 공간</text>`;
    }
    cursor += r.usedLen;
  });
  if (freeLen > 8) {
    const c = hasLeft ? 'var(--red)' : 'var(--green)';
    side += `<rect x="${cursor + 2}" y="${PAD + 2}" width="${freeLen - 4}" height="${TH - 4}" rx="4" fill="none" stroke="${c}" stroke-width="1.5" stroke-dasharray="6 5"/>`;
  }

  // ── 범례 ──
  const legendHtml = results.map((r, idx) => {
    if (!(r.loaded > 0)) return '';
    const color = DIAGRAM_COLORS[idx % DIAGRAM_COLORS.length];
    const extra = r.left > 0 ? ` · <b style="color:var(--red)">${r.left}개 못 실음</b>` : '';
    return `<span class="diagram-key"><i style="background:${color}"></i>${esc(itemLabel(r.it))} — ${r.place.layers}단${extra}</span>`;
  }).join('')
    + (fits.some(r => r.place.layers > 1) ? '<span class="diagram-key hint">연한 칸 = 위 단이 덜 찬 자리</span>' : '');

  return `<div class="cargo-diagram">
    <p class="diagram-cap">🔽 위에서 본 배치</p>
    <svg viewBox="0 0 ${W1} ${H1}" role="img" aria-label="적재함 배치도 (위)">${top}</svg>
    <p class="diagram-cap">➡️ 옆에서 본 모습 (쌓는 단수)</p>
    <svg viewBox="0 0 ${W2} ${H2}" role="img" aria-label="적재함 배치도 (옆)">${side}</svg>
    <div class="diagram-legend">${legendHtml}</div>
  </div>`;
}

$('#btn-calc-cargo').addEventListener('click', () => {
  const TL = parseFloat($('#truck-l').value), TW = parseFloat($('#truck-w').value),
        TH = parseFloat($('#truck-h').value), payload = parseFloat($('#truck-payload').value) || 0;
  if (!(TL > 0 && TW > 0 && TH > 0)) { toast('차량 치수를 입력해 주세요'); return; }
  if (!cargoItems.length) { toast('화물을 1건 이상 추가해 주세요 (문자 붙여넣기 시 자동 수집됩니다)'); return; }

  // 목록 순서대로 앞에서부터 채워 넣는다 — 공간이 모자라면 몇 개까지 실리는지 계산
  let remainLen = TL;
  const results = cargoItems.map(it => {
    const place = placeItem(it, TW, TH);
    if (!place.fit) return { it, place, loaded: 0, left: it.count, usedLen: 0, usedCols: 0 };
    const perCol = place.across * place.layers;
    const colsFit = Math.max(0, Math.floor(remainLen / place.y));
    const loaded = Math.min(it.count, colsFit * perCol);
    const usedCols = Math.ceil(loaded / perCol);
    const usedLen = usedCols * place.y;
    remainLen -= usedLen;
    return { it, place, loaded, left: it.count - loaded, usedLen, usedCols };
  });

  const blocked = results.filter(r => !r.place.fit);
  const partial = results.filter(r => r.place.fit && r.left > 0);
  const usedLen = TL - remainLen;
  const lenRate = (usedLen / TL) * 100;
  const totalKg = cargoItems.reduce((s, i) => s + (i.totalKg || 0), 0);
  const weightOk = !payload || !totalKg || totalKg <= payload;
  const loadedCbm = results.reduce((s, r) => s + r.it.w * r.it.d * r.it.h * r.loaded, 0) / 1e6;
  const remainCbm = (remainLen * TW * TH) / 1e6;

  let verdict;
  if (blocked.length) {
    verdict = `<div class="verdict bad">🔴 실을 수 없는 화물이 있습니다 — ${blocked.map(r => esc(itemLabel(r.it)) + ' (' + esc(r.place.reason) + ')').join(', ')}</div>`;
  } else if (partial.length) {
    verdict = `<div class="verdict bad">🔴 공간 부족 — ${partial.map(r =>
      `${r.it.kind === 'plt' ? '파레트' : '박스'} ${r.it.count}개 중 <b>${r.loaded}개만 적재, ${r.left}개 못 실음</b>`).join(' · ')}. 남는 짐은 2회차 운행을 검토하세요.</div>`;
  } else if (!weightOk) {
    verdict = `<div class="verdict bad">🔴 중량 초과 — 총 ${totalKg.toFixed(0)}kg / 최대적재 ${payload}kg (${(totalKg - payload).toFixed(0)}kg 초과)</div>`;
  } else if (lenRate > 90) {
    verdict = `<div class="verdict warn">⚠️ 아슬아슬하게 전량 적재 — 바닥 길이 ${Math.round(usedLen)}cm / ${TL}cm (여유 ${Math.round(remainLen)}cm). 실제 쌓을 때 빈틈 손실을 감안하세요.</div>`;
  } else {
    verdict = `<div class="verdict ok">✅ 전량 적재 가능 — 바닥 길이 ${Math.round(usedLen)}cm / ${TL}cm 사용 (여유 ${Math.round(remainLen)}cm)</div>`;
  }

  const rows = results.map(r => {
    if (!r.place.fit) return [itemLabel(r.it), '❌ ' + r.place.reason];
    const p = r.place;
    let txt = `폭 ${p.across}줄 × ${p.layers}단 × 길이 ${r.usedCols}열 → 바닥 ${Math.round(r.usedLen)}cm`;
    if (r.left > 0) txt = `<b style="color:var(--red)">${r.loaded}개 적재 / ${r.left}개 못 실음</b> · ` + txt;
    if (p.wastedH >= 30 && p.wastedH < r.it.h) txt += ` · 위 ${Math.round(p.wastedH)}cm는 활용 불가`;
    return [itemLabel(r.it), txt];
  });
  rows.push(['바닥 길이 합계', `${Math.round(usedLen)}cm / ${TL}cm (${Math.min(999, lenRate).toFixed(0)}%)`]);
  rows.push(['실은 화물 부피', `${loadedCbm.toFixed(2)} CBM / 적재함 ${(TL * TW * TH / 1e6).toFixed(2)} CBM`]);
  rows.push(['남은 공간', remainLen >= 1
    ? `길이 ${Math.round(remainLen)} × 폭 ${TW} × 높이 ${TH}cm = <b>${remainCbm.toFixed(2)} CBM</b>`
    : '없음']);
  if (totalKg) rows.push(['총중량', `${totalKg.toFixed(0)}kg / 최대 ${payload}kg`]);

  $('#cargo-output').innerHTML = verdict
    + `<div class="gauge"><div style="width:${Math.min(100, lenRate)}%"></div></div>`
    + cargoDiagramSvg(results, TL, TW, TH)
    + '<table class="result-table">' + rows.map(r => `<tr><td>${esc(r[0])}</td><td>${r[1]}</td></tr>`).join('') + '</table>'
    + `<p class="fine-print top8">💡 화물별로 구간을 나눠 싣는 기준의 근사 계산입니다. 하차 순서가 늦은 짐부터 안쪽에 실으세요. 파레트 위에 박스를 겹쳐 실을 수 있으면 실제로는 더 여유가 생깁니다.</p>`;
  $('#cargo-result').classList.remove('hidden');
});

// ─────────── 체험 모드 ───────────
function seedDemo() {
  state._demo = true;
  state.origin = { label: '서울 강서구 마곡동', lat: 37.5609, lng: 126.8259 };
  state.stops = [
    { id: 'demo1', label: '서울 강남구 테헤란로 123', lat: 37.5006, lng: 127.0364, type: '상차', workMin: 20, status: 'ok', display: '서울특별시 강남구 역삼동', contactName: '김철수', phone: '010-1234-5678', cargo: '파레트 5개 / 2.5톤' },
    { id: 'demo2', label: '성남시 분당구 판교역로 235', lat: 37.3947, lng: 127.1114, type: '하차', workMin: 20, status: 'ok', display: '경기도 성남시 분당구 삼평동', contactName: '박영희', phone: '010-9876-5432', podPhone: '010-1111-2222' },
    { id: 'demo3', label: '수원시 영통구', lat: 37.2749, lng: 127.0468, type: '하차', workMin: 30, status: 'ok', display: '경기도 수원시 영통구' },
  ];
  const legs = [
    { distance: 24800, duration: 2520 },
    { distance: 14300, duration: 1440 },
    { distance: 18900, duration: 1800 },
  ];
  const res = {
    order: [0, 1, 2], legs,
    distance: 58000, duration: 5760, toll: 2300,
    geometry: [[37.5609, 126.8259], [37.5006, 127.0364], [37.3947, 127.1114], [37.2749, 127.0468]],
    approx: false,
  };
  const departAt = new Date();
  departAt.setHours(9, 0, 0, 0);
  state.result = { ...res, departAt: departAt.getTime(), schedule: buildSchedule(res, departAt) };
  state.trip = null;
}

// ─────────── 홈 화면 설치 (PWA) ───────────
// 안드로이드 크롬: beforeinstallprompt를 받아 버튼 하나로 설치.
// 아이폰 사파리: 자동 설치 API가 없어 공유 → 홈 화면에 추가 방법을 안내한다.
let deferredInstall = null;
const INSTALL_HIDE_KEY = 'cargo-install-hide';

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
});
window.addEventListener('appinstalled', () => {
  $('#install-card').classList.add('hidden');
  try { localStorage.setItem(INSTALL_HIDE_KEY, '1'); } catch (e) { /* ignore */ }
  toast('📲 설치 완료! 홈 화면에서 열어보세요');
});

function initInstall() {
  if (isStandalone() || localStorage.getItem(INSTALL_HIDE_KEY)) return; // 이미 설치했거나 닫은 경우
  const card = $('#install-card');
  card.classList.remove('hidden');

  $('#btn-install-close').addEventListener('click', () => {
    card.classList.add('hidden');
    try { localStorage.setItem(INSTALL_HIDE_KEY, '1'); } catch (e) { /* ignore */ }
  });

  $('#btn-install').addEventListener('click', async () => {
    // 안드로이드: 설치 창을 바로 띄운다
    if (deferredInstall) {
      deferredInstall.prompt();
      const choice = await deferredInstall.userChoice.catch(() => null);
      deferredInstall = null;
      if (choice && choice.outcome === 'accepted') {
        card.classList.add('hidden');
        try { localStorage.setItem(INSTALL_HIDE_KEY, '1'); } catch (e) { /* ignore */ }
      }
      return;
    }
    // 아이폰 등 자동 설치가 안 되는 브라우저: 방법 안내
    const g = $('#install-guide');
    const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    g.innerHTML = ios
      ? '아이폰은 애플 정책상 버튼 설치가 안 됩니다.<br>사파리 아래 <b>공유 버튼(⬆️)</b> → <b>"홈 화면에 추가"</b>를 눌러주세요.'
      : '브라우저 메뉴(⋮)를 열고 <b>"홈 화면에 추가"</b> 또는 <b>"앱 설치"</b>를 눌러주세요.';
    g.classList.remove('hidden');
  });
}

// ─────────── 테마 전환 ───────────
function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyThemeIcon() {
  // 아이콘만으로는 무슨 버튼인지 알기 어려워 글자를 함께 보여준다
  const dark = currentTheme() === 'dark';
  $('#btn-theme').textContent = dark ? '☀️ 밝게' : '🌙 어둡게';
  $('#btn-theme').title = dark ? '밝은 화면으로 전환' : '어두운 화면으로 전환';
}
$('#btn-theme').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('cargo-theme', next);
  applyThemeIcon();
});

// ─────────── 초기화 ───────────
function init() {
  applyThemeIcon();
  loadState();
  // 체험 모드(?demo): 서버 호출 없이 예시 데이터로 화면을 보여준다
  if (new URLSearchParams(location.search).has('demo')) seedDemo();
  // 이전 세션에서 주소 확인이 끝나지 않은 항목 정리
  state.stops.forEach(s => {
    if (s.status === 'pending') s.status = (s.lat != null) ? 'ok' : 'error';
  });
  initCargo();
  initInstall();

  if (state.origin) {
    $('#origin-input').value = state.origin.label;
    setOriginStatus('✓ 출발지: ' + state.origin.label, 'ok');
  }
  renderStops();
  if (state.result) {
    renderResult();
    $('#result-area').classList.remove('hidden');
  }
  if (state.trip && !state.trip.endedAt) {
    switchTab('drive');
  }
  // 출발 시각 기본값 = 지금
  $('#depart-time').value = fmtTime(new Date());
}
init();
