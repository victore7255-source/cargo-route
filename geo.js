/* ══════════════ geo.js — 주소 → 좌표 변환(지오코딩) · GPS ══════════════
 * 1순위: 카카오 로컬 API (키가 있을 때) — 한국 지번·도로명·건물명에 정확.
 * 2순위: Nominatim(OpenStreetMap) 공개 API — 키 불필요하지만 지번 주소에 약하다.
 *   Nominatim은 이용 정책상 초당 1회로 요청 간격을 제한한다.
 * 결과에 rough=true가 붙으면 '동 단위 대략 위치'라는 뜻 — 화면에 경고를 보여준다.
 *
 * 카카오 키 등록 방법 (셋 중 하나):
 *  1) 아래 KAKAO_KEY 상수에 REST API 키 입력 — 권장, 배포하면 모든 기기에 적용
 *  2) 앱 주소 뒤에 ?kakaokey=발급받은키 를 붙여 한 번 열기 — 그 기기에 저장
 *  3) 브라우저 콘솔에서 Geo.setKakaoKey('발급받은키')
 * 키 발급: developers.kakao.com → 내 애플리케이션 → 앱 추가 → REST API 키 (무료)
 */

const Geo = (() => {
  const CACHE_KEY = 'cargo-geo-cache-v2'; // v2: 카카오 도입 — 이전(부정확할 수 있는) 캐시 폐기
  const MIN_INTERVAL = 1100; // ms — Nominatim 정책(1 req/sec)
  const KAKAO_KEY = '';      // ← 카카오 REST API 키를 넣으면 정확 모드 활성화
  const KAKAO_KEY_STORE = 'cargo-kakao-key';
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch (e) { cache = {}; }

  let queue = Promise.resolve();
  let lastCall = 0;

  // 주소창 ?kakaokey=... 로 한 번 열면 이 기기에 키를 저장한다
  try {
    const k = new URLSearchParams(location.search).get('kakaokey');
    if (k && k.trim()) localStorage.setItem(KAKAO_KEY_STORE, k.trim());
  } catch (e) { /* ignore */ }

  function kakaoKey() {
    if (KAKAO_KEY) return KAKAO_KEY;
    try { return localStorage.getItem(KAKAO_KEY_STORE) || ''; } catch (e) { return ''; }
  }
  function hasKakao() { return !!kakaoKey(); }
  function setKakaoKey(k) {
    try { localStorage.setItem(KAKAO_KEY_STORE, String(k || '').trim()); } catch (e) { /* ignore */ }
    return hasKakao() ? '✓ 카카오 정확 모드 켜짐' : '키가 비어 있습니다';
  }

  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* 저장공간 부족 시 무시 */ }
  }

  function normalize(q) {
    return q.trim().replace(/\s+/g, ' ');
  }

  // ─────────── 카카오 로컬 API ───────────
  async function fetchKakao(url) {
    const res = await fetch(url, { headers: { Authorization: 'KakaoAK ' + kakaoKey() } });
    if (!res.ok) throw new Error('카카오 지오코딩 오류 (' + res.status + ')');
    return res.json();
  }

  /** 주소 검색(뒷말을 줄여가며) → 장소(상호·건물명) 검색 → 행정구역(대략) 순으로 시도 */
  async function kakaoGeocode(q) {
    const enc = encodeURIComponent;
    const words = q.split(' ');
    let region = null;   // 동·구 단위로만 맞은 결과 — 최후의 보루(대략 위치)
    for (let cut = words.length; cut >= 1; cut--) {
      const t = words.slice(0, cut).join(' ');
      const data = await fetchKakao(
        `https://dapi.kakao.com/v2/local/search/address.json?size=1&query=${enc(t)}`).catch(() => null);
      const d = data && data.documents && data.documents[0];
      if (!d) continue;
      const r = { lat: parseFloat(d.y), lng: parseFloat(d.x), display: d.address_name, src: 'kakao' };
      if (d.address_type === 'REGION') {           // 번지 없이 행정구역만 맞음
        if (!region) region = { ...r, rough: true };
        continue;
      }
      return r;                                    // 번지·도로명까지 정확히 맞음
    }
    // 상호·건물명(예: ○○물류센터, 공항 화물터미널)은 장소 검색으로 찾는다
    const kw = await fetchKakao(
      `https://dapi.kakao.com/v2/local/search/keyword.json?size=1&query=${enc(q)}`).catch(() => null);
    const k = kw && kw.documents && kw.documents[0];
    if (k && k.y) {
      return {
        lat: parseFloat(k.y), lng: parseFloat(k.x),
        display: k.place_name + (k.road_address_name ? ' — ' + k.road_address_name : ''),
        src: 'kakao',
      };
    }
    return region;
  }

  // ─────────── Nominatim(OSM) ───────────
  async function fetchGeocode(query) {
    const wait = Math.max(0, lastCall + MIN_INTERVAL - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();

    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=kr&accept-language=ko&q='
      + encodeURIComponent(query);
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('지오코딩 서버 오류 (' + res.status + ')');
    const data = await res.json();
    if (!data.length) return null;
    const d = data[0];
    return {
      lat: parseFloat(d.lat),
      lng: parseFloat(d.lon),
      display: d.display_name,
      src: 'osm',
      // 행정구역 경계·동네 중심이면 대략 위치 (place/house는 정확한 번지)
      rough: d.class === 'boundary' || (d.class === 'place' && d.type !== 'house'),
    };
  }

  async function osmGeocode(q) {
    let result = await fetchGeocode(q);
    // 상세 주소가 검색되지 않으면 뒷부분(호수·상세)을 줄여가며 재시도
    if (!result) {
      const words = q.split(' ');
      for (let cut = words.length - 1; cut >= 2 && !result; cut--) {
        result = await fetchGeocode(words.slice(0, cut).join(' '));
        // 번지 같은 숫자를 버리고서야 찾았다면 대략 위치로 표시
        if (result && /\d/.test(words.slice(cut).join(''))) result.rough = true;
      }
    }
    // 주소에 적힌 번지 숫자가 결과에 없으면 엉뚱한 지점일 수 있다 (OSM은 지번에 약함)
    if (result && !result.rough) {
      const nums = q.match(/\d+(?:-\d+)?/g);
      const bunji = nums && nums[nums.length - 1].split('-')[0];
      if (bunji && !String(result.display).includes(bunji)) result.rough = true;
    }
    return result;
  }

  /** 주소 문자열 → {lat, lng, display, rough?} | null. 순차 큐로 실행된다. */
  function geocode(query) {
    const q = normalize(query);
    if (!q) return Promise.resolve(null);
    const useKakao = hasKakao();
    const ck = useKakao ? 'k:' + q : q;   // 카카오 결과는 별도 캐시 (키 등록 시 재검색되도록)
    if (cache[ck]) return Promise.resolve(cache[ck]);

    const job = queue.then(async () => {
      if (cache[ck]) return cache[ck];
      let result = null;
      if (useKakao) {
        result = await kakaoGeocode(q).catch(() => null);
        if (result) { cache[ck] = result; saveCache(); return result; }
      }
      // 카카오 실패(또는 키 없음) → 무료 OSM 경로
      if (cache[q]) return cache[q];
      result = await osmGeocode(q);
      if (result) { cache[q] = result; saveCache(); }
      return result;
    });
    // 실패해도 큐가 멈추지 않도록 한다
    queue = job.catch(() => {});
    return job;
  }

  /** 좌표 → 행정구역 이름 (역지오코딩) */
  async function reverse(lat, lng) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&accept-language=ko&lat=${lat}&lon=${lng}&zoom=16`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data && data.address) {
        const a = data.address;
        const parts = [a.city || a.county || a.state, a.borough || a.city_district || a.district, a.suburb || a.quarter || a.neighbourhood || a.village || a.town]
          .filter(Boolean);
        if (parts.length) return parts.join(' ');
      }
      return (data && data.display_name) ? data.display_name.split(',').slice(0, 2).join(' ') : '현재 위치';
    } catch (e) {
      return '현재 위치';
    }
  }

  /** GPS 현재 위치 → {lat, lng, display} */
  function currentPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('이 브라우저는 위치 기능을 지원하지 않습니다.'));
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const { latitude: lat, longitude: lng } = pos.coords;
          const display = await reverse(lat, lng);
          resolve({ lat, lng, display });
        },
        (err) => {
          const msg = err.code === 1
            ? '위치 권한이 거부되었습니다. 주소를 직접 입력해 주세요.'
            : '현재 위치를 가져오지 못했습니다. 주소를 직접 입력해 주세요.';
          reject(new Error(msg));
        },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
      );
    });
  }

  return { geocode, reverse, currentPosition, setKakaoKey, hasKakao };
})();
