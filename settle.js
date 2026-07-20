/* ══════════════ settle.js — 화물기사 정산관리 시스템 ══════════════
 * 배차가 아니라 "내 돈이 어디 있는지"를 5초 안에 보는 것이 목표.
 * 서버 없이 localStorage에 저장한다. app.js의 $, esc, toast, fmtWon, uid 를 재사용한다.
 *
 * 운송건 상태(우선순위):
 *   보류(검정) > 입금완료(초록) > 입금확인필요(주황) > 세금계산서대기(파랑)
 *   > 미수금(빨강, 예정일 지남) > 입금예정(노랑)
 */
const Settle = (() => {
  const KEY = 'cargo-settle-v1';
  const PAY_METHODS = ['인수증', '카드', '계좌이체', '선불', '착불'];

  const STATUS = {
    paid:    { label: '입금완료',     cls: 'st-paid',  dot: '🟢' },
    confirm: { label: '입금확인 필요', cls: 'st-confirm', dot: '🟠' },
    tax:     { label: '계산서 대기',   cls: 'st-tax',   dot: '🔵' },
    overdue: { label: '미수금',       cls: 'st-overdue', dot: '🔴' },
    due:     { label: '입금예정',     cls: 'st-due',   dot: '🟡' },
    hold:    { label: '보류',         cls: 'st-hold',  dot: '⚫' },
  };

  // ── 저장/로드 ──
  let items = [];
  function load() {
    try { items = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { items = []; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) { /* ignore */ }
  }

  // ── 날짜 유틸 ──
  function today() { return isoDate(new Date()); }
  function addDaysIso(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d + n);
    return isoDate(dt);
  }
  function daysBetween(a, b) { // b - a (일)
    const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
    return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
  }

  // ── 금액 계산 ──
  function taxTotal(r) { return Math.round((r.amount || 0) * 1.1); }          // 세금계산서 발행금액(부가세 포함)
  function expectedAmount(r) {                                                // 예상 입금금액
    const gross = r.tax ? taxTotal(r) : (r.amount || 0);
    return Math.max(0, gross - (r.fee || 0));
  }
  function receivedAmount(r) { return r.confirmed ? (r.paidAmount || expectedAmount(r)) : 0; }

  // ── 상태 판정 ──
  function statusOf(r) {
    if (r.hold) return 'hold';
    if (r.confirmed) return 'paid';
    if (r.paidDate) return 'confirm';
    if (r.tax && !r.taxDate) return 'tax';
    if (r.expectedDate && r.expectedDate < today()) return 'overdue';
    return 'due';
  }
  function isUnpaid(r) { return !r.confirmed && !r.hold; }

  // ── 기간 필터 ──
  function periodRange(kind) {
    const now = new Date();
    const t = today();
    const day = (now.getDay() + 6) % 7; // 월=0
    if (kind === 'today') return [t, t];
    if (kind === 'week') return [addDaysIso(t, -day), addDaysIso(t, 6 - day)];
    if (kind === 'month') {
      const y = now.getFullYear(), m = now.getMonth();
      return [isoDate(new Date(y, m, 1)), isoDate(new Date(y, m + 1, 0))];
    }
    return [null, null]; // all
  }
  function inRange(r, kind) {
    const [s, e] = periodRange(kind);
    if (!s) return true;
    const d = r.shipDate || r.dispatchDate || '';
    return d >= s && d <= e;
  }

  // ── 집계 ──
  function summarize(list) {
    const s = { count: list.length, amount: 0, received: 0, unpaid: 0, fee: 0, taxIssued: 0 };
    list.forEach(r => {
      s.amount += r.amount || 0;
      s.fee += r.fee || 0;
      if (r.confirmed) s.received += receivedAmount(r);
      else if (!r.hold) s.unpaid += expectedAmount(r);
      if (r.tax) s.taxIssued += taxTotal(r);
    });
    return s;
  }

  // ── 공개 API ──
  function all() { return items.slice(); }
  function unpaidTotal() { return items.filter(isUnpaid).reduce((a, r) => a + expectedAmount(r), 0); }

  function upsert(rec) {
    if (rec.id) {
      const i = items.findIndex(x => x.id === rec.id);
      if (i >= 0) items[i] = { ...items[i], ...rec };
      else items.push(rec);
    } else {
      rec.id = uid();
      rec.no = rec.no || nextNo();
      items.push(rec);
    }
    save();
    return rec;
  }
  function remove(id) { items = items.filter(x => x.id !== id); save(); }
  function get(id) { return items.find(x => x.id === id); }

  let seq = null;
  function nextNo() {
    if (seq == null) {
      seq = items.reduce((m, r) => {
        const n = parseInt(String(r.no || '').replace(/\D/g, ''), 10);
        return Number.isFinite(n) ? Math.max(m, n) : m;
      }, 0);
    }
    seq += 1;
    return 'S' + String(seq).padStart(4, '0');
  }

  /** 입금확인 처리 — 미수금에서 자동 차감된다(집계가 confirmed를 제외하므로) */
  function confirmPaid(id, paidAmount, paidDate) {
    const r = get(id);
    if (!r) return;
    r.paidDate = paidDate || today();
    r.paidAmount = (paidAmount != null && paidAmount !== '') ? Number(paidAmount) : expectedAmount(r);
    r.confirmed = true;
    r.hold = false;
    save();
  }
  function undoPaid(id) {
    const r = get(id);
    if (!r) return;
    r.confirmed = false; r.paidDate = ''; r.paidAmount = 0;
    save();
  }

  // ── 업체별 요약 ──
  function byCompany() {
    const map = {};
    items.forEach(r => {
      const key = (r.company || '미지정').trim() || '미지정';
      const c = map[key] || (map[key] = { name: key, count: 0, amount: 0, received: 0, unpaid: 0, payDaysSum: 0, payDaysN: 0, lastDate: '' });
      c.count += 1;
      c.amount += r.amount || 0;
      if (r.confirmed) {
        c.received += receivedAmount(r);
        if (r.shipDate && r.paidDate) { c.payDaysSum += daysBetween(r.shipDate, r.paidDate); c.payDaysN += 1; }
      } else if (!r.hold) c.unpaid += expectedAmount(r);
      const d = r.shipDate || r.dispatchDate || '';
      if (d > c.lastDate) c.lastDate = d;
    });
    return Object.values(map).map(c => ({
      ...c, avgPayDays: c.payDaysN ? Math.round(c.payDaysSum / c.payDaysN) : null,
    })).sort((a, b) => b.unpaid - a.unpaid || b.amount - a.amount);
  }

  // ── 입금 예정 캘린더: 해당 월의 날짜별 예상 입금액 ──
  function expectedByDate(year, month /* 0-based */) {
    const map = {};
    items.filter(isUnpaid).forEach(r => {
      if (!r.expectedDate) return;
      const [y, m] = r.expectedDate.split('-').map(Number);
      if (y === year && m - 1 === month) {
        (map[r.expectedDate] = map[r.expectedDate] || { total: 0, list: [] });
        map[r.expectedDate].total += expectedAmount(r);
        map[r.expectedDate].list.push(r);
      }
    });
    return map;
  }

  load();
  return {
    PAY_METHODS, STATUS,
    all, get, upsert, remove, confirmPaid, undoPaid,
    statusOf, isUnpaid, expectedAmount, taxTotal, receivedAmount,
    summarize, inRange, byCompany, unpaidTotal, expectedByDate,
    periodRange, today, addDaysIso, daysBetween,
  };
})();
