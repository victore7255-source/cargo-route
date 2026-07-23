/* ══════════════ stations.js — 주유소·충전소 탭 ══════════════
 * 차량 종류(전기차/LPG/디젤)에 맞춰, 지금 위치에서 남은 목적지(상차지·하차지)로
 * 가는 경로 주변의 주유소·충전소를 3곳 추천한다. 탭을 열면 자동으로 찾는다.
 *
 * 데이터: OpenStreetMap Overpass API (무료, 키 불필요).
 *   전기차 → amenity=charging_station
 *   LPG    → amenity=fuel + fuel:lpg=yes (이름에 LPG/충전 포함 시설 포함)
 *   디젤   → amenity=fuel (국내 주유소는 사실상 전부 경유 취급)
 * 가격 정보는 OSM에 없다 — 오피넷(유가) 연동은 API 키 필요, 추후 과제.
 *
 * 이 파일은 스스로 탭 버튼(주유소)과 화면을 만들어 붙인다. app.js 수정 불필요.
 * (app.js의 전역 state / Geo / Router.haversine / orderedStops / hasCoord 사용)
 */

const Stations = (() => {
  const FUEL_KEY = 'cargo-fuel-type-v1';
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];
  const FETCH_TIMEOUT = 20000;  // ms — 느린 서버는 끊고 다음 서버로
  const MAX_SHOW = 3;          // 추천 개수
  const NEARBY_RADIUS = 7000;  // 경로가 없을 때 '내 주변' 검색 반경(m)
  const TYPES = {
    ev:     { label: '⚡ 전기차', unit: '충전소', radius: 5000 },
    lpg:    { label: '🔥 LPG',   unit: '충전소', radius: 7000 },
    diesel: { label: '⛽ 디젤',   unit: '주유소', radius: 3000 },
  };

  let fuelType = 'ev';
  try { fuelType = localStorage.getItem(FUEL_KEY) || 'ev'; } catch (e) { /* ignore */ }
  if (!TYPES[fuelType]) fuelType = 'ev';

  let loading = false;
  let lastLoadedKey = '';   // 같은 상황이면 탭을 다시 열어도 재검색하지 않기 위한 키

  // ─────────── 화면 주입 (탭 버튼 + 패널) ───────────
  function inject() {
    const tabs = document.querySelector('#tabs');
    const main = document.querySelector('main.container');
    if (!tabs || !main || document.querySelector('#panel-fuel')) return;

    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.dataset.tab = 'fuel';
    btn.textContent = '주유소';
    tabs.appendChild(btn);
    btn.addEventListener('click', () => {
      switchTab('fuel');
      refresh(false);       // 탭을 열면 자동 검색
    });

    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.id = 'panel-fuel';
    panel.innerHTML = `
      <div class="card">
        <h2 class="card-title">차량 종류 <span class="hint">(연료에 맞는 곳만 찾습니다)</span></h2>
        <div class="row gap" id="fuel-type-picker">
          ${Object.entries(TYPES).map(([k, t]) =>
            `<button class="chip kind ${k === fuelType ? 'active' : ''}" data-fuel="${k}">${t.label}</button>`).join('')}
        </div>
      </div>
      <div class="card">
        <div class="row space-between">
          <h2 class="card-title" id="fuel-title">경로 주변 추천</h2>
          <button class="mini-btn" id="btn-fuel-refresh">🔄 새로고침</button>
        </div>
        <div class="geo-status" id="fuel-status"></div>
        <div id="fuel-list"></div>
        <p class="fine-print top8">지도 데이터(OpenStreetMap) 기준이라 최근 개업·폐업이 반영되지 않았을 수 있습니다.
        실시간 유가·충전요금 표시는 준비 중입니다.</p>
      </div>`;
    main.appendChild(panel);

    panel.querySelectorAll('[data-fuel]').forEach(b => b.addEventListener('click', () => {
      fuelType = b.dataset.fuel;
      try { localStorage.setItem(FUEL_KEY, fuelType); } catch (e) { /* ignore */ }
      panel.querySelectorAll('[data-fuel]').forEach(x => x.classList.toggle('active', x === b));
      refresh(true);
    }));
    panel.querySelector('#btn-fuel-refresh').addEventListener('click', () => refresh(true));
  }

  function setStatus(msg, cls = '') {
    const el = document.querySelector('#fuel-status');
    if (el) { el.textContent = msg; el.className = 'geo-status ' + cls; }
  }

  // ─────────── 현재 위치 · 경로 만들기 ───────────
  /** 지금 출발 기준점: GPS → (운행 중) 마지막 완료 지점 → 경로 탭 출발지 */
  async function currentPoint() {
    try {
      const p = await Geo.currentPosition();
      return { lat: p.lat, lng: p.lng, label: p.display, src: 'gps' };
    } catch (e) {
      const d = (typeof driveStartCoord === 'function') ? driveStartCoord() : null;
      if (d && hasCoord(d)) return { lat: d.lat, lng: d.lng, label: d.label, src: 'trip' };
      if (state.origin && hasCoord(state.origin)) return { ...state.origin, src: 'origin' };
      return null;
    }
  }

  /** 남은 목적지들 (운행 중이면 미완료 지점, 아니면 계산된 방문 순서) */
  function remainingStops() {
    const trip = state.trip;
    if (trip && !trip.endedAt && trip.snapshot) {
      return trip.snapshot.stops.filter(s =>
        !(trip.events[s.id] && trip.events[s.id].doneAt) && hasCoord(s));
    }
    if (state.result && typeof orderedStops === 'function') {
      return orderedStops().filter(hasCoord);
    }
    return [];
  }

  /** 현재 위치→목적지들을 잇는 선을 8km 간격 점으로 펼친다 (경로 corridor 검색용) */
  function buildLine(cur, wps) {
    const pts = [cur, ...wps.map(s => ({ lat: s.lat, lng: s.lng }))];
    const line = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const n = Math.min(20, Math.max(1, Math.round(Router.haversine(a, b) / 8000)));
      for (let k = 1; k <= n; k++) {
        line.push({ lat: a.lat + (b.lat - a.lat) * k / n, lng: a.lng + (b.lng - a.lng) * k / n });
      }
    }
    // Overpass 요청이 너무 길어지지 않게 최대 80점으로 솎아낸다
    const step = Math.ceil(line.length / 80);
    const slim = step > 1 ? line.filter((_, i) => i % step === 0 || i === line.length - 1) : line;
    // 각 점까지의 누적 거리(m) — "앞으로 몇 km 지점" 표시용
    const cum = [0];
    for (let i = 1; i < slim.length; i++) cum.push(cum[i - 1] + Router.haversine(slim[i - 1], slim[i]));
    return { line: slim, cum };
  }

  // ─────────── Overpass 검색 ───────────
  function overpassQuery(type, line, radius) {
    const around = `(around:${radius},${line.map(p => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(',')})`;
    let sel;
    if (type === 'ev') {
      sel = `nwr["amenity"="charging_station"]${around};`;
    } else if (type === 'lpg') {
      sel = `nwr["amenity"="fuel"]["fuel:lpg"="yes"]${around};`
          + `nwr["amenity"="fuel"]["name"~"LPG|엘피지|충전"]${around};`;
    } else {
      sel = `nwr["amenity"="fuel"]${around};`;
    }
    return `[out:json][timeout:25];(${sel});out center tags 60;`;
  }

  async function fetchOverpass(query) {
    let lastErr = null;
    for (const ep of ENDPOINTS) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
      try {
        const res = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error('서버 응답 ' + res.status);
        const data = await res.json();
        return data.elements || [];
      } catch (e) {
        lastErr = (e && e.name === 'AbortError') ? new Error('서버 응답 지연') : e;
      } finally { clearTimeout(timer); }
    }
    throw lastErr || new Error('검색 서버에 연결하지 못했습니다');
  }

  /** 추천 순위: 경로에서 벗어나는 거리(우회)를 가장 무겁게 보고,
   *  같은 조건이면 앞쪽(빨리 닿는 곳)을 우선한다 */
  function rank(elements, line, cum) {
    const out = [];
    for (const el of elements) {
      const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
      const lng = el.lon != null ? el.lon : (el.center && el.center.lon);
      if (lat == null || lng == null) continue;
      let best = Infinity, bi = 0;
      line.forEach((q, i) => {
        const d = Router.haversine({ lat, lng }, q);
        if (d < best) { best = d; bi = i; }
      });
      out.push({ el, lat, lng, detour: best, progress: cum[bi] });
    }
    out.sort((a, b) => (a.detour * 3 + a.progress * 0.2) - (b.detour * 3 + b.progress * 0.2));
    const seen = new Set(), picked = [];
    for (const s of out) {
      const name = (s.el.tags && s.el.tags.name) || '';
      const key = (name || 'noname') + '|' + s.lat.toFixed(2) + ',' + s.lng.toFixed(2);
      if (seen.has(key)) continue;   // 같은 시설이 노드+건물로 중복 등록된 경우 제거
      seen.add(key);
      picked.push(s);
      if (picked.length >= MAX_SHOW) break;
    }
    return picked;
  }

  // ─────────── 표시 ───────────
  function evInfo(tags) {
    const parts = [];
    if (tags.capacity) parts.push(`충전기 ${tags.capacity}기`);
    const socks = [];
    if (tags['socket:type2_combo'] || tags['socket:ccs'] || tags['socket:type1_combo']) socks.push('DC콤보(급속)');
    if (tags['socket:chademo']) socks.push('차데모');
    if (tags['socket:type2'] || tags['socket:type1']) socks.push('완속');
    if (socks.length) parts.push(socks.join('·'));
    if (tags.fee === 'no') parts.push('무료');
    if (tags.operator || tags.brand) parts.push(tags.operator || tags.brand);
    return parts.join(' · ');
  }
  function fuelInfo(tags) {
    const parts = [];
    if (tags.brand || tags.operator) parts.push(tags.brand || tags.operator);
    if (tags.opening_hours === '24/7') parts.push('24시간');
    if (fuelType === 'lpg' && tags['fuel:lpg'] === 'yes') parts.push('LPG 취급');
    return parts.join(' · ');
  }

  function naviLinks(cur, s, name) {
    const nm = encodeURIComponent(String(name).slice(0, 40));
    const tmap = `tmap://route?goalname=${nm}&goalx=${s.lng.toFixed(6)}&goaly=${s.lat.toFixed(6)}`;
    const kakao = `kakaomap://route?sp=${cur.lat.toFixed(6)},${cur.lng.toFixed(6)}&ep=${s.lat.toFixed(6)},${s.lng.toFixed(6)}&by=car`;
    const naver = `nmap://route/car?dlat=${s.lat.toFixed(6)}&dlng=${s.lng.toFixed(6)}&dname=${nm}&appname=cargo.route.web`;
    return `
      <a class="mini-btn" href="${kakao}">카카오맵</a>
      <a class="mini-btn" href="${naver}">네이버지도</a>
      <a class="mini-btn" href="${tmap}">TMAP</a>`;
  }

  function render(picked, cur, hasRoute) {
    const t = TYPES[fuelType];
    const box = document.querySelector('#fuel-list');
    if (!picked.length) {
      box.innerHTML = `<div class="center-card"><p class="big-emoji">🔍</p>
        <p>${hasRoute ? '경로 주변' : '내 주변'}에서 ${t.unit}를 찾지 못했습니다.</p>
        <p class="hint">지도 데이터에 등록이 없을 수 있어요. 새로고침하거나 차량 종류를 확인해 주세요.</p></div>`;
      return;
    }
    box.innerHTML = picked.map((s, i) => {
      const tags = s.el.tags || {};
      const name = tags.name || tags.operator || tags.brand || `이름 미등록 ${t.unit}`;
      const info = fuelType === 'ev' ? evInfo(tags) : fuelInfo(tags);
      const detourTxt = s.detour < 950 ? Math.round(s.detour) + 'm' : (s.detour / 1000).toFixed(1) + 'km';
      const where = hasRoute
        ? `${s.progress < 500 ? '지금 위치 근처' : '앞으로 약 ' + (s.progress / 1000).toFixed(1) + 'km 지점'} · 경로에서 ${detourTxt} 벗어남`
        : `내 위치에서 약 ${detourTxt}`;
      return `
        <div class="stn-card">
          <div class="stn-rank">${i + 1}</div>
          <div class="stn-body">
            <div class="stn-name">${esc(name)}</div>
            <div class="stn-meta">📍 ${esc(where)}</div>
            ${info ? `<div class="stn-meta">${esc(info)}</div>` : ''}
            <div class="row gap wrap top8">${naviLinks(cur, s, name)}</div>
          </div>
        </div>`;
    }).join('');
  }

  // ─────────── 메인 흐름 ───────────
  async function refresh(force) {
    if (loading) return;
    const t = TYPES[fuelType];
    const titleEl = document.querySelector('#fuel-title');

    loading = true;
    setStatus('📡 현재 위치 확인 중…');
    try {
      const cur = await currentPoint();
      if (!cur) {
        setStatus('✗ 위치를 알 수 없습니다. 위치 권한을 허용하거나 경로 탭에서 출발지를 입력해 주세요.', 'err');
        document.querySelector('#fuel-list').innerHTML = '';
        lastLoadedKey = '';
        return;
      }
      const wps = remainingStops();
      const hasRoute = wps.length > 0;

      // 같은 조건(연료·위치 1km 단위·목적지 수)이면 재검색 생략 — 탭 여닫을 때 서버 부담 방지
      const key = [fuelType, cur.lat.toFixed(2), cur.lng.toFixed(2), wps.map(s => s.id || s.label).join('|')].join('/');
      if (!force && key === lastLoadedKey) { setStatus(''); return; }

      titleEl.textContent = hasRoute
        ? `경로 주변 추천 ${t.unit} (남은 목적지 ${wps.length}곳 기준)`
        : `내 주변 추천 ${t.unit}`;
      setStatus(`🔎 ${hasRoute ? '가는 길 주변' : '내 주변'} ${t.unit} 찾는 중…`);

      const { line, cum } = hasRoute
        ? buildLine(cur, wps)
        : { line: [{ lat: cur.lat, lng: cur.lng }], cum: [0] };
      const radius = hasRoute ? t.radius : NEARBY_RADIUS;
      const elements = await fetchOverpass(overpassQuery(fuelType, line, radius));
      const picked = rank(elements, line, cum);

      render(picked, cur, hasRoute);
      lastLoadedKey = key;
      setStatus(picked.length
        ? `✓ ${cur.src === 'gps' ? '현재 위치' : esc(cur.label || '출발지')} 기준 · ${new Date().toTimeString().slice(0, 5)} 갱신`
        : '', picked.length ? 'ok' : '');
    } catch (e) {
      setStatus('✗ 검색에 실패했습니다: ' + e.message + ' — 새로고침을 눌러 다시 시도해 주세요.', 'err');
    } finally {
      loading = false;
    }
  }

  inject();
  return { refresh };
})();
