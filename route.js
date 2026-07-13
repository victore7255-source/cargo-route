/* ══════════════ route.js — 방문 순서 최적화(TSP) · 경로 계산 · 통행료 추정 ══════════════
 * OSRM 공개 데모 서버 사용(API 키 불필요).
 *  1) /table  : 모든 지점 간 실제 도로 소요시간 행렬
 *  2) TSP 풀이: 지점 12개 이하는 완전탐색(DP, Held-Karp)으로 정확해,
 *               그 이상은 최근접 이웃 + 2-opt 개선
 *  3) /route  : 확정된 순서로 실제 경로(거리·시간·선형) 조회
 * 서버 장애 시 직선거리(하버사인) 기반으로 자동 대체한다.
 */

const Router = (() => {
  const OSRM = 'https://router.project-osrm.org';

  // ── 하버사인 직선거리 (m) ──
  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const s = Math.sin(dLat / 2) ** 2
      + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function coordStr(points) {
    return points.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  }

  // ── 소요시간 행렬 ──
  async function durationMatrix(points) {
    try {
      const url = `${OSRM}/table/v1/driving/${coordStr(points)}?annotations=duration`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.code !== 'Ok' || !data.durations) throw new Error(data.message || 'table 오류');
      return { matrix: data.durations, approx: false };
    } catch (e) {
      // 대체: 직선거리 / 평균 50km/h → 초
      const n = points.length;
      const m = Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) =>
          i === j ? 0 : haversine(points[i], points[j]) * 1.35 / (50 / 3.6)));
      return { matrix: m, approx: true };
    }
  }

  // ── TSP: 정확해 (Held-Karp DP). start 고정, end는 인덱스 또는 null(자유) ──
  function heldKarp(dur, endIdx) {
    const n = dur.length;               // 0 = 출발지
    const mids = [];
    for (let i = 1; i < n; i++) if (i !== endIdx) mids.push(i);
    const m = mids.length;
    const FULL = 1 << m;
    const INF = Infinity;
    // dp[mask][j] = 출발지에서 mask 집합을 방문하고 mids[j]에서 끝나는 최소시간
    const dp = Array.from({ length: FULL }, () => new Float64Array(m).fill(INF));
    const parent = Array.from({ length: FULL }, () => new Int16Array(m).fill(-1));
    for (let j = 0; j < m; j++) dp[1 << j][j] = dur[0][mids[j]];
    for (let mask = 1; mask < FULL; mask++) {
      for (let j = 0; j < m; j++) {
        if (!(mask & (1 << j)) || dp[mask][j] === INF) continue;
        for (let k = 0; k < m; k++) {
          if (mask & (1 << k)) continue;
          const nm = mask | (1 << k);
          const cost = dp[mask][j] + dur[mids[j]][mids[k]];
          if (cost < dp[nm][k]) { dp[nm][k] = cost; parent[nm][k] = j; }
        }
      }
    }
    // 종점 처리
    let best = INF, bestJ = -1;
    const last = FULL - 1;
    for (let j = 0; j < m; j++) {
      const tail = endIdx != null ? dur[mids[j]][endIdx] : 0;
      const cost = (m === 0 ? 0 : dp[last][j]) + tail;
      if (cost < best) { best = cost; bestJ = j; }
    }
    const order = [];
    if (m > 0) {
      let mask = last, j = bestJ;
      while (j !== -1) {
        order.unshift(mids[j]);
        const pj = parent[mask][j];
        mask ^= (1 << j);
        j = pj;
      }
    }
    if (endIdx != null) order.push(endIdx);
    return [0, ...order];
  }

  // ── TSP: 근사해 (최근접 이웃 + 2-opt) ──
  function nearestNeighbor(dur, endIdx) {
    const n = dur.length;
    const visited = new Set([0]);
    if (endIdx != null) visited.add(endIdx);
    const order = [0];
    let cur = 0;
    while (visited.size < n) {
      let best = -1, bestD = Infinity;
      for (let i = 1; i < n; i++) {
        if (visited.has(i)) continue;
        if (dur[cur][i] < bestD) { bestD = dur[cur][i]; best = i; }
      }
      order.push(best); visited.add(best); cur = best;
    }
    if (endIdx != null) order.push(endIdx);
    return order;
  }

  function pathCost(dur, order) {
    let c = 0;
    for (let i = 0; i < order.length - 1; i++) c += dur[order[i]][order[i + 1]];
    return c;
  }

  function twoOpt(dur, order) {
    let improved = true;
    const o = order.slice();
    while (improved) {
      improved = false;
      for (let i = 1; i < o.length - 2; i++) {
        for (let k = i + 1; k < o.length - 1; k++) {
          const cand = o.slice(0, i).concat(o.slice(i, k + 1).reverse(), o.slice(k + 1));
          if (pathCost(dur, cand) < pathCost(dur, o) - 0.001) {
            o.splice(0, o.length, ...cand);
            improved = true;
          }
        }
      }
    }
    return o;
  }

  /** 방문 순서 최적화. points[0]=출발지. endIdx: 마지막으로 고정할 인덱스(선택). */
  function solveOrder(dur, endIdx) {
    const midCount = dur.length - 1 - (endIdx != null ? 1 : 0);
    if (midCount <= 1) {
      return endIdx != null ? nearestNeighbor(dur, endIdx) : nearestNeighbor(dur, null);
    }
    if (midCount <= 12) return heldKarp(dur, endIdx);
    return twoOpt(dur, nearestNeighbor(dur, endIdx));
  }

  // ── 확정 순서로 실제 경로 조회 ──
  async function fetchRoute(orderedPoints) {
    try {
      const url = `${OSRM}/route/v1/driving/${coordStr(orderedPoints)}?overview=full&geometries=geojson&steps=false`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.code !== 'Ok' || !data.routes || !data.routes.length) throw new Error('route 오류');
      const r = data.routes[0];
      return {
        legs: r.legs.map(l => ({ distance: l.distance, duration: l.duration })),
        distance: r.distance,
        duration: r.duration,
        geometry: r.geometry.coordinates.map(c => [c[1], c[0]]), // [lat,lng]
        approx: false,
      };
    } catch (e) {
      // 대체: 직선거리 추정
      const legs = [];
      for (let i = 0; i < orderedPoints.length - 1; i++) {
        const d = haversine(orderedPoints[i], orderedPoints[i + 1]) * 1.35;
        legs.push({ distance: d, duration: d / (50 / 3.6) });
      }
      return {
        legs,
        distance: legs.reduce((s, l) => s + l.distance, 0),
        duration: legs.reduce((s, l) => s + l.duration, 0),
        geometry: orderedPoints.map(p => [p.lat, p.lng]),
        approx: true,
      };
    }
  }

  /** 통행료 추정(원). 구간 평균속도로 고속도로 주행분을 추정한다. 1종(승용/소형화물) 기준. */
  function estimateToll(legs) {
    let highwayKm = 0;
    for (const l of legs) {
      const km = l.distance / 1000;
      const kmh = l.duration > 0 ? km / (l.duration / 3600) : 0;
      if (kmh >= 75) highwayKm += km * 0.85;
      else if (kmh >= 60) highwayKm += km * 0.45;
    }
    if (highwayKm < 5) return 0;
    const toll = 900 + highwayKm * 44.3; // 기본요금 + 주행요금(1종 폐쇄식 기준)
    return Math.round(toll / 100) * 100;
  }

  /**
   * 전체 최적화 파이프라인.
   * @param origin {lat,lng,...}  @param stops [{lat,lng,...}]  @param finalStopId stops 배열 안 id 또는 null
   * @returns { order: stops 배열 인덱스 순서, legs, distance, duration, toll, geometry, approx }
   */
  async function optimize(origin, stops, finalStopIndex) {
    const points = [origin, ...stops];
    const endIdx = (finalStopIndex != null && finalStopIndex >= 0) ? finalStopIndex + 1 : null;
    const { matrix, approx: tableApprox } = await durationMatrix(points);
    const orderFull = solveOrder(matrix, endIdx);          // points 인덱스 (0=출발지)
    const orderedPoints = orderFull.map(i => points[i]);
    const route = await fetchRoute(orderedPoints);
    return {
      order: orderFull.slice(1).map(i => i - 1),           // stops 배열 인덱스 순서
      legs: route.legs,
      distance: route.distance,
      duration: route.duration,
      toll: estimateToll(route.legs),
      geometry: route.geometry,
      approx: tableApprox || route.approx,
    };
  }

  return { optimize, haversine, estimateToll };
})();
