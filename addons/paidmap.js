/* ══════════════ paidmap.js — 유료 지도(TMAP)로 정확한 도착 예정 시간 ══════════════
 * 유료 회원 전용: 경로 계산 뒤 각 구간의 소요시간·거리·통행료를
 * TMAP(SK오픈API) 실시간 교통 반영 값으로 바꿔치기해 도착 예정 시간을 정확하게 만든다.
 *
 * 켜는 법: TMAP appKey를 아래 APP_KEY 상수에 넣거나,
 *          브라우저 콘솔에서 PaidMap.setKey('발급받은키') 실행.
 *   키 발급: https://openapi.sk.com (TMAP — '자동차 경로안내' API, 무료 쿼터 있음)
 * 키가 없거나 무료 회원이면 아무 일도 하지 않는다 (기존 OSRM 무료 경로 그대로).
 *
 * 동작 방식 (app.js·route.js 수정 없이):
 *  - Router.optimize를 감싸, 결과의 legs를 TMAP 값으로 보정하고 trafficIncluded 표시
 *  - buildSchedule을 감싸, 보정된 결과에는 자체 교통 배율(trafficFactor)을 곱하지 않는다
 * ⚠️ 반드시 route.js·app.js·membership.js보다 뒤에 로드해야 한다.
 */

const PaidMap = (() => {
  const APP_KEY = '';                 // ← TMAP appKey를 여기 넣으면 활성화 (또는 setKey 사용)
  const KEY_STORE = 'cargo-tmap-key';
  const MAX_LEGS = 12;                // 방문지가 아주 많으면 호출 수 제한 (쿼터 보호)

  function getKey() {
    if (APP_KEY) return APP_KEY;
    try { return localStorage.getItem(KEY_STORE) || ''; } catch (e) { return ''; }
  }
  function setKey(k) {
    try { localStorage.setItem(KEY_STORE, String(k || '').trim()); } catch (e) { /* ignore */ }
    return enabled() ? '✓ 유료 지도 활성화됨' : '키 저장됨 (유료 회원 + 키가 모두 있어야 활성화)';
  }
  function enabled() {
    return !!getKey() && typeof Membership !== 'undefined' && Membership.hasPaidAccess();
  }

  /** 한 구간(출발→도착)의 실시간 교통 반영 소요시간·거리·통행료 */
  async function fetchLeg(a, b) {
    const res = await fetch('https://apis.openapi.sk.com/tmap/routes?version=1&format=json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', appKey: getKey() },
      body: JSON.stringify({
        startX: String(a.lng), startY: String(a.lat),
        endX: String(b.lng), endY: String(b.lat),
        reqCoordType: 'WGS84GEO', resCoordType: 'WGS84GEO',
        totalValue: 2,          // 요약값만 (totalDistance·totalTime·totalFare)
      }),
    });
    if (!res.ok) throw new Error('TMAP 응답 ' + res.status);
    const data = await res.json();
    const p = data.features && data.features[0] && data.features[0].properties;
    if (!p || !Number.isFinite(p.totalTime)) throw new Error('TMAP 응답 형식 오류');
    return { distance: p.totalDistance || 0, duration: p.totalTime, toll: p.totalFare || 0 };
  }

  /** OSRM 결과의 구간들을 TMAP 값으로 교체 (방문 순서는 그대로 둔다) */
  async function refine(res, origin, stops) {
    const seq = [origin, ...res.order.map(i => stops[i])];
    if (seq.some(s => !hasCoord(s))) throw new Error('좌표 누락');
    const legs = [];
    let distance = 0, duration = 0, toll = 0;
    for (let i = 0; i < seq.length - 1; i++) {
      const leg = await fetchLeg(seq[i], seq[i + 1]);
      legs.push({ distance: leg.distance, duration: leg.duration });
      distance += leg.distance; duration += leg.duration; toll += leg.toll;
      if (i < seq.length - 2) await new Promise(r => setTimeout(r, 120));  // 호출 간격 예의
    }
    return { ...res, legs, distance, duration, toll, approx: false, trafficIncluded: true };
  }

  // ── Router.optimize 감싸기 ──
  if (typeof Router !== 'undefined' && Router.optimize) {
    const origOptimize = Router.optimize.bind(Router);
    Router.optimize = async function (origin, stops, finalIdx) {
      const res = await origOptimize(origin, stops, finalIdx);
      if (!enabled() || !res || !res.order || res.order.length + 1 > MAX_LEGS) return res;
      try {
        const refined = await refine(res, origin, stops);
        if (typeof toast === 'function') toast('⏱️ 유료 지도(실시간 교통)로 도착 시간을 보정했습니다', 3500);
        return refined;
      } catch (e) {
        console.warn('유료 지도 보정 실패 — 무료 경로 값 사용:', e);
        return res;
      }
    };
  }

  // ── buildSchedule 감싸기: TMAP 값에는 자체 교통 배율을 다시 곱하지 않는다 ──
  if (typeof buildSchedule === 'function') {
    const origBuild = buildSchedule;
    window.buildSchedule = function (res, departAt) {
      if (!res || !res.trafficIncluded) return origBuild(res, departAt);
      const schedule = [];
      let t = departAt.getTime();
      res.order.forEach((stopIdx, i) => {
        const stop = state.stops[stopIdx];
        const leg = res.legs[i] || { distance: 0, duration: 0 };
        t += leg.duration * 1000;
        const arrive = t;
        t += (stop.workMin || 20) * 60 * 1000;
        schedule.push({
          stopId: stop.id, arrive, depart: t,
          legDistance: leg.distance, legDuration: leg.duration,
          baseDuration: leg.duration, factor: 1,
        });
      });
      return schedule;
    };
  }

  return { enabled, setKey };
})();
