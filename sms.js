/* ══════════════ sms.js — 화주·포워딩 문자에서 상차지/하차지 정보 자동 추출 ══════════════
 * 서버 없이 정규식 패턴 매칭만으로 동작한다. 추출 결과는 화면에서 확인 후 경로에 추가된다.
 *
 * 추출 항목: 상차/하차 구분, 주소, 담당자 이름·연락처, 화물 정보, 인수증 사진 보낼 번호
 */

const SmsParser = (() => {
  const PHONE_RE = /0\d{1,2}[-.\s)]?\d{3,4}[-.\s]?\d{4}/g;

  const LOAD_KEYS = ['상차지', '상차', '출발지', '픽업', '선적지', '발지'];
  const UNLOAD_KEYS = ['하차지', '하차', '도착지', '납품처', '납품지', '배송지', '인도지', '착지'];
  const POD_KEYS = ['인수증', '싸인', '사인', '서명', '인수확인', '인수 확인'];
  const NAME_RE = /(담당자?|기사|소장|과장|팀장|실장|사장)\s*[:：]?\s*([가-힣]{2,4})(?:\s*(님|씨))?/;
  // 주의: JS의 \b는 한글에 동작하지 않으므로 (?=...) 전방탐색으로 낱말 끝을 확인한다
  const NAME_RE2 = /([가-힣]{1,3})\s?(소장|과장|팀장|실장|사장|기사)(님)?(?=[\s,:：.]|$)/;

  // 시/도 이름으로 시작하거나, "○○시 ○○구/동/로/길" 형태면 주소로 본다
  const ADDR_RE = new RegExp(
    '((서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)(특별시|광역시|특별자치시|특별자치도|도|시)?\\s*[가-힣0-9].*'
    + '|[가-힣]{1,10}(시|군|구)\\s+[가-힣0-9]+(시|군|구|로|길|동|읍|면|리|가)(?=[\\s\\d,.]|$).*)'
  );

  const CARGO_RE = /(파레트|팔레트|빠레트|PLT|plt|박스|BOX|box|카톤|톤\b|kg|KG|Kg|㎏|수량|중량|품명|품목|화물\s*[:：]|냉동|냉장|목재|철재|기계|자재)/;

  function stripLabel(line) {
    // "주소 : ..." / "[상차지] ..." / "- ..." 같은 앞머리 제거
    return line
      .replace(/^[\s\-•*▶■□○●◆★☆·=~:：]+/, '')
      .replace(/^[\[(（【]?(상차지|상차|하차지|하차|출발지|도착지|납품처|납품지|배송지|인도지|픽업|주소|장소|위치)[\])）】]?\s*[:：]?\s*/, '')
      .replace(/^[\s:：]+/, '')
      .trim();
  }

  function findPhones(text) {
    return (text.match(PHONE_RE) || []).map(p => p.replace(/[\s)]/g, ''));
  }

  /**
   * 주소가 든 줄에서 주소 부분만 잘라낸다.
   * 전화번호·괄호·담당자·화물 단어가 나오면 그 앞까지를 주소로 보고, 나머지는 tail로 돌려준다.
   */
  function cleanAddress(line) {
    const m = line.match(ADDR_RE);
    if (!m) return null;
    const pre = line.slice(0, m.index);
    let addr = line.slice(m.index);
    let cut = addr.length;
    for (const re of [PHONE_RE, NAME_RE, NAME_RE2, CARGO_RE, /[(（]/]) {
      const idx = addr.search(re);
      if (idx > 5) cut = Math.min(cut, idx);
    }
    const tail = pre + ' ' + addr.slice(cut);
    addr = addr.slice(0, cut).replace(/[\s,/·\-]+$/, '').trim();
    return { addr, tail: tail.trim() };
  }

  /** 한 구역(상차 또는 하차)의 줄들에서 세부 정보를 뽑는다 */
  function parseSection(type, lines) {
    const info = { type, address: '', phone: '', contactName: '', cargo: '', podPhone: '' };
    const cargoLines = [];

    for (const raw of lines) {
      const line = stripLabel(raw);
      if (!line) continue;

      // 인수증 관련 줄: 여기 있는 번호는 인수증 보낼 번호
      if (POD_KEYS.some(k => line.includes(k))) {
        const p = findPhones(line);
        if (p.length) info.podPhone = info.podPhone || p[0];
        continue;
      }

      // 주소 (아직 못 찾았을 때만 — 첫 주소 줄 채택)
      if (!info.address) {
        const ca = cleanAddress(line);
        if (ca) {
          info.address = ca.addr;
          // 주소 줄에 섞인 전화번호·담당자·화물 정보도 함께 수거한다
          const p = findPhones(line);
          if (p.length && !info.phone) info.phone = p[0];
          const anm = line.match(NAME_RE);
          const anm2 = anm ? null : line.match(NAME_RE2);
          if (!info.contactName) {
            if (anm) info.contactName = anm[2];
            else if (anm2) info.contactName = anm2[1] + anm2[2];
          }
          const tailCargo = ca.tail.replace(PHONE_RE, '').replace(/[()（）]/g, '').replace(/연락처|문의/g, '').trim();
          if (tailCargo && CARGO_RE.test(tailCargo)) cargoLines.push(tailCargo);
          continue;
        }
      }

      // 담당자 이름
      const nm = line.match(NAME_RE);
      if (nm && !info.contactName) info.contactName = nm[2];
      const nm2 = !nm && line.match(NAME_RE2);
      if (nm2 && !info.contactName) info.contactName = nm2[1] + nm2[2];

      // 전화번호
      const phones = findPhones(line);
      if (phones.length && !info.phone) info.phone = phones[0];

      // 화물 정보 (하차 구역에도 품목이 적히는 경우가 있어 둘 다 수집)
      if (CARGO_RE.test(line) && !PHONE_RE.test(line)) {
        cargoLines.push(line.replace(/^(화물|품명|품목|내용)\s*[:：]\s*/, ''));
      }
    }
    info.cargo = cargoLines.slice(0, 2).join(' / ');
    return info;
  }

  /** 줄이 상차/하차 구역의 시작인지 판정. 시작이면 타입과 남은 내용(같은 줄 뒷부분)을 돌려준다 */
  function sectionStart(line) {
    const head = line.slice(0, 8); // 키워드는 줄 앞머리에 있어야 구역 제목으로 본다
    for (const k of LOAD_KEYS) {
      if (head.includes(k)) return { type: '상차', rest: line.slice(line.indexOf(k) + k.length) };
    }
    for (const k of UNLOAD_KEYS) {
      if (head.includes(k)) return { type: '하차', rest: line.slice(line.indexOf(k) + k.length) };
    }
    return null;
  }

  /**
   * 문자 전체 → [{type, address, phone, contactName, cargo, podPhone}]
   * 상차/하차 키워드가 없으면 주소 줄마다 하차지 하나로 취급한다.
   */
  function parse(text) {
    const lines = String(text).replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);

    // 1) 키워드 기준으로 구역 나누기
    const sections = [];
    let current = null;
    const header = []; // 첫 구역 이전의 줄들
    for (const line of lines) {
      const start = sectionStart(line);
      if (start) {
        if (current) sections.push(current);
        current = { type: start.type, lines: [] };
        const rest = stripLabel(start.rest);
        if (rest) current.lines.push(rest);
      } else if (current) {
        current.lines.push(line);
      } else {
        header.push(line);
      }
    }
    if (current) sections.push(current);

    let stops = [];
    if (sections.length) {
      stops = sections.map(s => parseSection(s.type, s.lines)).filter(s => s.address);
      // 구역은 있는데 주소를 못 찾았으면 헤더의 주소라도 써 본다
      if (!stops.length) {
        const h = parseSection('하차', header);
        if (h.address) stops.push(h);
      }
      // 헤더의 화물 정보를 상차지에 보충
      const headerInfo = parseSection('상차', header);
      if (headerInfo.cargo) {
        const first = stops.find(s => s.type === '상차') || stops[0];
        if (first && !first.cargo) first.cargo = headerInfo.cargo;
      }
      // 인수증 번호가 어느 구역에도 없으면 전체에서 찾아 마지막 하차지에 붙인다
      if (!stops.some(s => s.podPhone)) {
        for (const line of lines) {
          if (POD_KEYS.some(k => line.includes(k))) {
            const p = findPhones(line);
            if (p.length) {
              const lastUnload = [...stops].reverse().find(s => s.type === '하차');
              if (lastUnload) lastUnload.podPhone = p[0];
              break;
            }
          }
        }
      }
    } else {
      // 2) 키워드가 없는 문자: 주소로 보이는 줄마다 하차지 하나
      let pending = null;
      for (const line of lines) {
        const clean = stripLabel(line);
        const ca = cleanAddress(clean);
        if (ca) {
          if (pending) stops.push(pending);
          const p = findPhones(clean);
          pending = {
            type: '하차', address: ca.addr,
            phone: p[0] || '', contactName: '', cargo: '', podPhone: '',
          };
          const nm = clean.match(NAME_RE);
          const nm2 = nm ? null : clean.match(NAME_RE2);
          if (nm) pending.contactName = nm[2];
          else if (nm2) pending.contactName = nm2[1] + nm2[2];
          const tailCargo = ca.tail.replace(PHONE_RE, '').replace(/[()（）]/g, '').replace(/연락처|문의/g, '').trim();
          if (tailCargo && CARGO_RE.test(tailCargo)) pending.cargo = tailCargo;
        } else if (pending) {
          const p = findPhones(clean);
          if (p.length && !pending.phone) pending.phone = p[0];
          const nm = clean.match(NAME_RE);
          const nm2 = nm ? null : clean.match(NAME_RE2);
          if (nm && !pending.contactName) pending.contactName = nm[2];
          else if (nm2 && !pending.contactName) pending.contactName = nm2[1] + nm2[2];
          if (CARGO_RE.test(clean) && !pending.cargo && !PHONE_RE.test(clean)) pending.cargo = clean;
        }
      }
      if (pending) stops.push(pending);
    }

    return stops;
  }

  return { parse };
})();
