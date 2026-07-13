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

// ─────────── 상태 ───────────
const STATE_KEY = 'cargo-app-state-v1';
const HISTORY_KEY = 'cargo-history-v1';

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
function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch (e) { return []; }
}
function setHistory(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}

// ─────────── 탭 ───────────
$$('#tabs .tab').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});
function switchTab(name) {
  $$('#tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  if (name === 'history') renderHistory();
  if (name === 'drive') renderDrive();
  if (name === 'ev') renderEvIfReady();
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
$('#btn-clear-stops').addEventListener('click', () => {
  if (!state.stops.length) return;
  if (!confirm('배송지를 모두 삭제할까요?')) return;
  state.stops = [];
  state.result = null;
  $('#result-area').classList.add('hidden');
  renderStops();
  saveState();
});

async function addStopsFromInput() {
  const lines = $('#stops-input').value.split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length) { toast('주소를 입력해 주세요'); return; }
  $('#stops-input').value = '';
  const defaultWork = parseInt($('#default-work').value, 10);

  const pending = lines.map(label => ({
    id: uid(), label, lat: null, lng: null, type: '하차', workMin: defaultWork, status: 'pending',
  }));
  state.stops.push(...pending);
  renderStops();

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

function renderStops() {
  const ul = $('#stop-list');
  ul.innerHTML = '';
  state.stops.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'stop-item' + (s.status === 'error' ? ' error' : '');
    const statusIcon = s.status === 'pending' ? '⏳' : s.status === 'error' ? '⚠️' : '📍';
    li.innerHTML = `
      <span>${statusIcon}</span>
      <span class="label">${esc(s.label)}
        <span class="sub">${s.status === 'error' ? '주소를 찾지 못함 — 눌러서 수정' : esc(s.display || '')}</span>
      </span>
      <button class="badge ${s.type === '상차' ? 'load' : 'unload'}" data-act="type" data-i="${i}">${s.type}</button>
      <button class="icon-btn" data-act="del" data-i="${i}" title="삭제">✕</button>`;
    ul.appendChild(li);
  });
  ul.querySelectorAll('[data-act="type"]').forEach(b => b.addEventListener('click', () => {
    const s = state.stops[+b.dataset.i];
    s.type = s.type === '하차' ? '상차' : '하차';
    renderStops(); saveState();
  }));
  ul.querySelectorAll('[data-act="del"]').forEach(b => b.addEventListener('click', () => {
    state.stops.splice(+b.dataset.i, 1);
    renderStops(); saveState();
  }));
  ul.querySelectorAll('.stop-item.error .label').forEach((el, idx) => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', async () => {
      const errStops = state.stops.filter(s => s.status === 'error');
      const stop = errStops[idx];
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
}

function renderFinalDestSelect() {
  const sel = $('#final-dest');
  const prev = sel.value;
  sel.innerHTML = '<option value="">자동 최적화 (지정 안 함)</option>'
    + state.stops.map(s => `<option value="${s.id}">${esc(s.label)}</option>`).join('');
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
  const ready = state.stops.filter(s => s.status === 'ok');
  if (ready.length < 1) { toast('배송지를 1곳 이상 추가해 주세요'); return; }
  if (state.stops.some(s => s.status === 'error')) {
    toast('⚠️ 주소를 찾지 못한 배송지가 있습니다. 수정하거나 삭제해 주세요.');
    return;
  }
  if (state.stops.some(s => s.status === 'pending')) {
    toast('주소 확인이 끝날 때까지 잠시 기다려 주세요');
    return;
  }

  const btn = $('#btn-optimize');
  btn.disabled = true;
  setOptStatus('🤖 AI가 최적 방문 순서를 계산하는 중…');

  try {
    const finalId = $('#final-dest').value;
    const finalIdx = finalId ? state.stops.findIndex(s => s.id === finalId) : null;
    const res = await Router.optimize(state.origin, state.stops, finalIdx);

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
    setOptStatus(res.approx ? '⚠️ 경로 서버 연결이 원활하지 않아 직선거리 기반 추정치입니다.' : '');
    $('#result-area').classList.remove('hidden');
    $('#result-area').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    setOptStatus('✗ 경로 계산에 실패했습니다: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

/** 방문 순서에 따라 도착/출발 예정시각 계산 */
function buildSchedule(res, departAt) {
  const schedule = [];
  let t = departAt.getTime();
  res.order.forEach((stopIdx, i) => {
    const stop = state.stops[stopIdx];
    const leg = res.legs[i];
    t += leg.duration * 1000;
    const arrive = t;
    t += (stop.workMin || 20) * 60 * 1000;
    schedule.push({ stopId: stop.id, arrive, depart: t, legDistance: leg.distance, legDuration: leg.duration });
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

  // 합계
  const arriveLast = res.schedule.length ? new Date(res.schedule[res.schedule.length - 1].arrive) : null;
  $('#result-totals').innerHTML = `
    <div class="total-chip"><div class="v">${fmtKm(res.distance)}</div><div class="k">총 이동거리</div></div>
    <div class="total-chip"><div class="v">${fmtDur(res.duration)}</div><div class="k">운전 시간</div></div>
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
        <div class="visit-name">${esc(stop.label)} <span class="badge ${stop.type === '상차' ? 'load' : 'unload'}" style="cursor:default">${stop.type}</span></div>
        <div class="visit-meta">도착 ${fmtTime(new Date(sch.arrive))} · 작업 ${stop.workMin}분 · 출발 ${fmtTime(new Date(sch.depart))}</div>
        <div class="visit-leg">↳ 이동 ${fmtKm(sch.legDistance)} · ${fmtDur(sch.legDuration)}</div>
      </div>`;
    ol.appendChild(li);
  });

  renderMap();
  renderAiTips();
  renderNaviButtons($('#navi-buttons'), 0);
  renderEvIfReady();
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
      icon: L.divIcon({ className: 'map-marker ' + cls, html: text, iconSize: [26, 26] }),
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

  // EV 잔량 체크
  const ev = loadEvSettings();
  if (ev && ev.range > 0) {
    if (ev.range < (res.distance / 1000) * 1.15) {
      tips.push({ icon: '🔋', text: `계기판 주행가능거리 약 ${Math.round(ev.range)}km — 이번 경로(${fmtKm(res.distance)})에 충전이 필요할 수 있습니다. EV 탭에서 충전 계획을 확인하세요.` });
    }
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
  const sub = dest.display && dest.display !== dest.label ? `<br><span class="hint">확인된 위치: ${esc(dest.display)}</span>` : '';
  return `
    <div class="fine-print" style="grid-column:1/-1;margin:0">🎯 안내 목적지: <b>${esc(dest.label)}</b>${sub}</div>
    <a class="navi-btn tmap" href="${links.tmap}">TMAP<br>실행</a>
    <a class="navi-btn kakao" href="${links.kakao}">카카오맵<br>실행</a>
    <a class="navi-btn naver" href="${links.naver}">네이버지도<br>실행</a>`;
}

function renderNaviButtons(container, orderPos) {
  const stops = orderedStops();
  const dest = stops[orderPos];
  if (!dest) { container.innerHTML = ''; return; }
  container.innerHTML = naviButtonsHtml(dest);
}

$('#btn-copy-order').addEventListener('click', () => {
  const res = state.result;
  if (!res) return;
  const lines = [`🚚 화물 혼적 경로 — 방문 순서`, `출발: ${state.origin.label} (${fmtTime(new Date(res.departAt))})`];
  res.order.forEach((stopIdx, i) => {
    const s = state.stops[stopIdx];
    const sch = res.schedule[i];
    lines.push(`${i + 1}. [${s.type}] ${s.label} — 도착 ${fmtTime(new Date(sch.arrive))}`);
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
      stops: orderedStops().map(s => ({ ...s })),
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
  $('#drive-summary').classList.toggle('hidden', !(trip && trip.endedAt));

  clearInterval(driveTimerId);
  if (active) {
    const tick = () => { $('#drive-timer').textContent = fmtClock((Date.now() - trip.startedAt) / 1000); };
    tick();
    driveTimerId = setInterval(tick, 1000);
    renderDriveChecklist();
  } else if (trip && trip.endedAt) {
    renderTripSummary();
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
    $('#next-stop-info').innerHTML = `
      <div class="visit-name" style="font-size:17px;margin-bottom:8px">${idx + 1}. ${esc(next.label)}
        <span class="badge ${next.type === '상차' ? 'load' : 'unload'}" style="cursor:default">${next.type}</span></div>`;
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
      </div>
      <div class="visit-actions">
        ${!ev.arrivedAt ? `<button class="mini-btn" data-act="arrive" data-id="${s.id}">📍 도착</button>` : ''}
        ${ev.arrivedAt && !ev.doneAt ? `<button class="mini-btn" data-act="done" data-id="${s.id}">✅ ${s.type} 완료</button>` : ''}
      </div>`;
    ul.appendChild(li);
  });
  ul.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
    const ev = state.trip.events[b.dataset.id] || (state.trip.events[b.dataset.id] = {});
    if (b.dataset.act === 'arrive') ev.arrivedAt = Date.now();
    if (b.dataset.act === 'done') { if (!ev.arrivedAt) ev.arrivedAt = Date.now(); ev.doneAt = Date.now(); }
    saveState();
    renderDriveChecklist();
  }));
}

$('#btn-end-trip').addEventListener('click', () => {
  if (!confirm('운행을 종료할까요?')) return;
  state.trip.endedAt = Date.now();
  saveState();
  renderDrive();
});

function renderTripSummary() {
  const trip = state.trip;
  const durSec = (trip.endedAt - trip.startedAt) / 1000;
  const km = trip.snapshot.distance / 1000;
  const avgKmh = durSec > 0 ? km / (durSec / 3600) : 0;
  $('#summary-totals').innerHTML = `
    <div class="total-chip"><div class="v">${fmtKm(trip.snapshot.distance)}</div><div class="k">이동거리(계획)</div></div>
    <div class="total-chip"><div class="v">${fmtDur(durSec)}</div><div class="k">총 운행시간</div></div>
    <div class="total-chip"><div class="v">${avgKmh.toFixed(1)}km/h</div><div class="k">평균속도</div></div>
    <div class="total-chip"><div class="v">${Object.values(trip.events).filter(e => e.doneAt).length}곳</div><div class="k">완료 배송지</div></div>`;
  $('#sum-toll').value = trip.snapshot.toll || 0;
}

$('#btn-save-trip').addEventListener('click', () => {
  const trip = state.trip;
  const record = {
    id: uid(),
    date: new Date(trip.startedAt).toISOString(),
    startedAt: trip.startedAt,
    endedAt: trip.endedAt,
    distance: trip.snapshot.distance,
    durationSec: (trip.endedAt - trip.startedAt) / 1000,
    toll: parseInt($('#sum-toll').value, 10) || 0,
    chargeCost: parseInt($('#sum-charge-cost').value, 10) || 0,
    chargeCount: parseInt($('#sum-charge-count').value, 10) || 0,
    memo: $('#sum-memo').value.trim(),
    origin: trip.snapshot.origin.label,
    stops: trip.snapshot.stops.map(s => ({
      label: s.label, type: s.type,
      arrivedAt: (trip.events[s.id] || {}).arrivedAt || null,
      doneAt: (trip.events[s.id] || {}).doneAt || null,
    })),
  };
  const history = getHistory();
  history.unshift(record);
  setHistory(history);
  state.trip = null;
  saveState();
  renderDrive();
  switchTab('history');
  toast('💾 운행 기록을 저장했습니다');
});

$('#btn-discard-trip').addEventListener('click', () => {
  if (!confirm('이번 운행 기록을 저장하지 않고 버릴까요?')) return;
  state.trip = null;
  saveState();
  renderDrive();
});

// ─────────── 기록 ───────────
function renderHistory() {
  const history = getHistory();
  const now = new Date();
  const thisMonth = history.filter(r => {
    const d = new Date(r.date);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
  const sum = (arr, f) => arr.reduce((s, r) => s + f(r), 0);
  $('#history-stats').innerHTML = `
    <div class="total-chip"><div class="v">${thisMonth.length}회</div><div class="k">운행 횟수</div></div>
    <div class="total-chip"><div class="v">${fmtKm(sum(thisMonth, r => r.distance))}</div><div class="k">총 이동거리</div></div>
    <div class="total-chip"><div class="v">${fmtWon(sum(thisMonth, r => r.toll))}</div><div class="k">통행료</div></div>
    <div class="total-chip"><div class="v">${fmtWon(sum(thisMonth, r => r.chargeCost))}</div><div class="k">충전비</div></div>`;

  const wrap = $('#history-list');
  if (!history.length) {
    wrap.innerHTML = '<div class="card center-card"><p class="big-emoji">📋</p><p>저장된 운행 기록이 없습니다.</p></div>';
    return;
  }
  wrap.innerHTML = history.map(r => {
    const d = new Date(r.date);
    const dateStr = `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(d)}`;
    const avgKmh = r.durationSec > 0 ? (r.distance / 1000) / (r.durationSec / 3600) : 0;
    const stopsHtml = r.stops.map((s, i) =>
      `${i + 1}. [${s.type}] ${esc(s.label)}${s.doneAt ? ' ✓ ' + fmtTime(new Date(s.doneAt)) : ''}`).join('<br>');
    return `<details class="history-item">
      <summary><span>${esc(r.origin)} 출발 · ${r.stops.length}곳</span><span class="history-date">${dateStr}</span></summary>
      <div class="history-detail">
        <b>${fmtKm(r.distance)}</b> · ${fmtDur(r.durationSec)} · 평균 <b>${avgKmh.toFixed(1)}km/h</b><br>
        통행료 ${fmtWon(r.toll)} · 충전비 ${fmtWon(r.chargeCost)} (${r.chargeCount}회)<br>
        ${r.memo ? '메모: ' + esc(r.memo) + '<br>' : ''}
        <div style="margin-top:6px">${stopsHtml}</div>
        <button class="mini-btn top8" data-del="${r.id}">🗑️ 이 기록 삭제</button>
      </div>
    </details>`;
  }).join('');
  wrap.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    if (!confirm('이 기록을 삭제할까요?')) return;
    setHistory(getHistory().filter(r => r.id !== b.dataset.del));
    renderHistory();
  }));
}

$('#btn-export-history').addEventListener('click', () => {
  const data = JSON.stringify(getHistory(), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `운행기록_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ─────────── EV ───────────
const EV_KEY = 'cargo-ev-v2';

function loadEvSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(EV_KEY) || 'null');
    if (saved && saved.range > 0) return saved;
    // 구버전(배터리용량·전비 방식) 데이터 이전
    const old = JSON.parse(localStorage.getItem('cargo-ev-v1') || 'null');
    if (old && old.capacity && old.efficiency && old.battery) {
      return { range: Math.round(old.capacity * (old.battery / 100) * old.efficiency), battery: old.battery };
    }
    return null;
  } catch (e) { return null; }
}
function saveEvSettings() {
  localStorage.setItem(EV_KEY, JSON.stringify({
    range: parseFloat($('#ev-range').value) || 0,
    battery: parseFloat($('#ev-battery').value) || null,
  }));
}

function initEv() {
  const saved = loadEvSettings();
  if (saved) {
    $('#ev-range').value = saved.range || '';
    $('#ev-battery').value = saved.battery || '';
  }
}

$('#btn-calc-ev').addEventListener('click', () => {
  if (!(parseFloat($('#ev-range').value) > 0)) {
    toast('계기판에 표시된 주행가능거리(km)를 입력해 주세요');
    return;
  }
  saveEvSettings();
  renderEv();
});

function renderEvIfReady() {
  const ev = loadEvSettings();
  if (ev && ev.range > 0 && state.result) {
    $('#ev-range').value = ev.range;
    if (ev.battery) $('#ev-battery').value = ev.battery;
    renderEv();
  }
}

function renderEv() {
  const range = parseFloat($('#ev-range').value) || 0;
  let battery = parseFloat($('#ev-battery').value) || null;
  if (battery != null) battery = Math.min(100, Math.max(1, battery));
  const SAFE = 0.85; // 계기판 표시치의 오차·우회를 감안한 15% 여유

  const rows = [
    ['현재 주행가능거리 (계기판)', `${Math.round(range)}km`],
    ['안전 주행거리 (15% 여유)', `약 ${Math.round(range * SAFE)}km`],
  ];
  if (battery) rows.push(['현재 배터리', `${battery}%`]);
  let verdict = '';
  let extraHtml = '';

  if (state.result) {
    const totalKm = state.result.distance / 1000;
    const remainKm = range - totalKm;
    // 계기판 거리는 현재 잔량 기준이므로, 경로만큼 달리면 그 비율만큼 배터리를 쓴다
    const endPct = battery ? battery * (1 - totalKm / range) : null;
    rows.push(['이번 경로 거리', fmtKm(state.result.distance)]);
    rows.push(['완주 시 남는 거리', remainKm > 0 ? `약 ${Math.round(remainKm)}km` : '부족']);
    if (endPct != null) rows.push(['도착 시 배터리 (예상)', endPct > 0 ? `약 ${Math.round(endPct)}%` : '방전']);

    if (totalKm <= range * SAFE) {
      verdict = `<div class="verdict ok">✅ 충전 없이 완주 가능 — 도착 후에도 약 ${Math.round(remainKm)}km 여유${endPct != null ? ` (배터리 약 ${Math.round(endPct)}%)` : ''}</div>`;
    } else {
      // 어느 지점에서 충전이 필요한지 계산
      let cum = 0, chargeBeforeIdx = -1;
      const safeKm = range * SAFE;
      const stops = orderedStops();
      for (let i = 0; i < state.result.legs.length; i++) {
        cum += state.result.legs[i].distance / 1000;
        if (cum > safeKm) { chargeBeforeIdx = i; break; }
      }
      const where = chargeBeforeIdx >= 0 && stops[chargeBeforeIdx]
        ? `<b>${chargeBeforeIdx + 1}번째 목적지(${esc(stops[chargeBeforeIdx].label)})</b> 도착 전`
        : '경로 후반부';
      verdict = totalKm <= range
        ? `<div class="verdict warn">⚠️ 아슬아슬하게 완주 가능 (여유 약 ${Math.round(remainKm)}km) — ${where} 충전을 권장합니다</div>`
        : `<div class="verdict bad">🔴 충전 없이 완주 불가 (약 ${Math.round(-remainKm)}km 부족) — ${where} 반드시 충전하세요</div>`;

      const chargePoint = chargeBeforeIdx > 0 && stops[chargeBeforeIdx - 1]
        ? stops[chargeBeforeIdx - 1] : state.origin;
      const q = encodeURIComponent('전기차충전소');
      extraHtml += `
        <div class="navi-grid top8">
          <a class="navi-btn kakao" href="kakaomap://search?q=${q}&p=${chargePoint.lat},${chargePoint.lng}">카카오맵<br>충전소 검색</a>
          <a class="navi-btn tmap" href="tmap://search?name=${q}">TMAP<br>충전소 검색</a>
          <a class="navi-btn naver" href="nmap://search?query=${q}&appname=cargo.route.web">네이버<br>충전소 검색</a>
        </div>
        <p class="fine-print">충전 지점 근처(${esc(chargePoint.label || '출발지')})에서 급속충전소를 검색합니다. 충전 후 계기판의 주행가능거리를 다시 입력하고 [충전 계획 분석]을 누르면 재계산됩니다.</p>`;
    }
  } else {
    verdict = '<div class="verdict warn">경로를 먼저 계산하면 이번 운행의 충전 필요 여부를 분석해 드립니다.</div>';
  }

  $('#ev-output').innerHTML = verdict
    + '<table class="result-table">' + rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('') + '</table>'
    + extraHtml;
  $('#ev-result').classList.remove('hidden');
}

// ─────────── 적재 계산 ───────────
const TRUCK_PRESETS = [
  { name: '봉고3 EV / 1톤 카고 (개방형)', l: 286, w: 163, h: 120, payload: 1000 },
  { name: '1톤 탑차', l: 280, w: 160, h: 170, payload: 1000 },
  { name: '1톤 저상 탑차', l: 280, w: 160, h: 140, payload: 1000 },
  { name: '1톤 윙바디', l: 280, w: 160, h: 170, payload: 1000 },
  { name: '다마스 밴', l: 165, w: 110, h: 105, payload: 400 },
  { name: '라보', l: 220, w: 134, h: 100, payload: 550 },
  { name: '2.5톤 카고', l: 430, w: 186, h: 160, payload: 2500 },
  { name: '2.5톤 윙바디', l: 430, w: 205, h: 185, payload: 2500 },
  { name: '5톤 카고', l: 620, w: 230, h: 230, payload: 5000 },
  { name: '5톤 윙바디', l: 620, w: 235, h: 240, payload: 5000 },
  { name: '직접 입력', l: null, w: null, h: null, payload: null },
];

function initCargo() {
  const sel = $('#truck-select');
  sel.innerHTML = TRUCK_PRESETS.map((p, i) => `<option value="${i}">${p.name}</option>`).join('');
  const apply = () => {
    const p = TRUCK_PRESETS[+sel.value];
    if (p.l) {
      $('#truck-l').value = p.l; $('#truck-w').value = p.w;
      $('#truck-h').value = p.h; $('#truck-payload').value = p.payload;
    }
  };
  sel.addEventListener('change', apply);
  apply();
}

$('#btn-calc-cargo').addEventListener('click', () => {
  const TL = parseFloat($('#truck-l').value), TW = parseFloat($('#truck-w').value),
        TH = parseFloat($('#truck-h').value), payload = parseFloat($('#truck-payload').value) || 0;
  const bw = parseFloat($('#box-w').value), bd = parseFloat($('#box-d').value),
        bh = parseFloat($('#box-h').value);
  const count = parseInt($('#box-count').value, 10);
  const unitWeight = parseFloat($('#box-weight').value) || 0;

  if (!(TL > 0 && TW > 0 && TH > 0 && bw > 0 && bd > 0 && bh > 0 && count > 0)) {
    toast('차량과 박스 치수를 모두 입력해 주세요');
    return;
  }

  // 6가지 방향으로 배치해 최대 적재 수 탐색
  const orientations = [
    [bw, bd, bh], [bd, bw, bh],           // 정방향 (권장 — 박스를 세운 상태)
    [bw, bh, bd], [bh, bw, bd],           // 옆으로 눕힘
    [bd, bh, bw], [bh, bd, bw],
  ];
  let best = null;
  orientations.forEach(([x, y, z], oi) => {
    const nx = Math.floor(TL / x), ny = Math.floor(TW / y), nz = Math.floor(TH / z);
    const cap = nx * ny * nz;
    const upright = oi < 2;
    if (!best || cap > best.cap || (cap === best.cap && upright && !best.upright)) {
      best = { cap, nx, ny, nz, x, y, z, upright };
    }
  });

  const boxVol = bw * bd * bh;                       // cm³
  const cbm = (boxVol * count) / 1e6;                // m³
  const truckCbm = (TL * TW * TH) / 1e6;
  const rate = Math.min(999, (cbm / truckCbm) * 100);
  const fitsVolume = count <= best.cap;
  const totalWeight = unitWeight * count;
  const fitsWeight = !unitWeight || totalWeight <= payload;

  let verdict;
  if (fitsVolume && fitsWeight) {
    verdict = `<div class="verdict ok">✅ 적재 가능 — ${count}개 전량 실을 수 있습니다 (최대 ${best.cap}개)</div>`;
  } else if (!fitsVolume) {
    verdict = `<div class="verdict bad">🔴 공간 부족 — 최대 ${best.cap}개까지 가능, ${count - best.cap}개 초과</div>`;
  } else {
    verdict = `<div class="verdict bad">🔴 중량 초과 — 총 ${totalWeight.toFixed(0)}kg / 최대적재 ${payload}kg (${(totalWeight - payload).toFixed(0)}kg 초과)</div>`;
  }

  const dirText = best.upright ? '세운 상태(정방향)' : `눕혀서 ${best.x}×${best.y}cm 면을 바닥으로`;
  const rows = [
    ['총 부피 (CBM)', `${cbm.toFixed(2)} m³`],
    ['적재함 용적', `${truckCbm.toFixed(2)} m³`],
    ['적재율', `${rate.toFixed(0)}%`],
    ['최대 적재 가능 수', `${best.cap}개 (가로 ${best.nx} × 세로 ${best.ny} × ${best.nz}단)`],
  ];
  if (unitWeight) {
    rows.push(['예상 총중량', `${totalWeight.toFixed(0)}kg / 최대 ${payload}kg`]);
  }

  const layers = Math.min(best.nz, Math.ceil(count / (best.nx * best.ny)));
  const tip = fitsVolume
    ? `박스를 ${dirText}로 놓고, 바닥에 가로 ${best.nx}개 × 세로 ${best.ny}개(층당 ${best.nx * best.ny}개)씩 ${layers}단으로 쌓으세요. 하차 순서가 늦은 짐부터 안쪽에 싣는 것을 잊지 마세요.`
    : `공간이 부족합니다. 박스를 ${dirText}로 최대한 채우고, 남는 ${count - best.cap}개는 2회차 운행 또는 상위 차종을 검토하세요.`;

  $('#cargo-output').innerHTML = verdict
    + `<div class="gauge"><div style="width:${Math.min(100, rate)}%"></div></div>`
    + '<table class="result-table">' + rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('') + '</table>'
    + `<p class="fine-print top8">💡 추천 적재 방법: ${tip}</p>`;
  $('#cargo-result').classList.remove('hidden');
});

// ─────────── 체험 모드 ───────────
function seedDemo() {
  state._demo = true;
  state.origin = { label: '서울 강서구 마곡동', lat: 37.5609, lng: 126.8259 };
  state.stops = [
    { id: 'demo1', label: '서울 강남구 테헤란로 123', lat: 37.5006, lng: 127.0364, type: '상차', workMin: 20, status: 'ok', display: '서울특별시 강남구 역삼동' },
    { id: 'demo2', label: '성남시 분당구 판교역로 235', lat: 37.3947, lng: 127.1114, type: '하차', workMin: 20, status: 'ok', display: '경기도 성남시 분당구 삼평동' },
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

// ─────────── 테마 전환 ───────────
function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyThemeIcon() {
  $('#btn-theme').textContent = currentTheme() === 'dark' ? '☀️' : '🌙';
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
  initEv();
  initCargo();

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
