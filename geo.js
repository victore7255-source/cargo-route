/* ══════════════ geo.js — 주소 → 좌표 변환(지오코딩) · GPS ══════════════
 * Nominatim(OpenStreetMap) 공개 API 사용. API 키 불필요.
 * 이용 정책상 초당 1회로 요청 간격을 제한한다.
 */

const Geo = (() => {
  const CACHE_KEY = 'cargo-geo-cache-v1';
  const MIN_INTERVAL = 1100; // ms — Nominatim 정책(1 req/sec)
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch (e) { cache = {}; }

  let queue = Promise.resolve();
  let lastCall = 0;

  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* 저장공간 부족 시 무시 */ }
  }

  function normalize(q) {
    return q.trim().replace(/\s+/g, ' ');
  }

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
    return {
      lat: parseFloat(data[0].lat),
      lng: parseFloat(data[0].lon),
      display: data[0].display_name,
    };
  }

  /** 주소 문자열 → {lat, lng, display} | null. 순차 큐로 실행된다. */
  function geocode(query) {
    const q = normalize(query);
    if (!q) return Promise.resolve(null);
    if (cache[q]) return Promise.resolve(cache[q]);

    const job = queue.then(async () => {
      if (cache[q]) return cache[q];
      let result = await fetchGeocode(q);
      // 상세 주소가 검색되지 않으면 뒷부분(호수·상세)을 줄여가며 재시도
      if (!result) {
        const words = q.split(' ');
        for (let cut = words.length - 1; cut >= 2 && !result; cut--) {
          result = await fetchGeocode(words.slice(0, cut).join(' '));
        }
      }
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

  return { geocode, reverse, currentPosition };
})();
