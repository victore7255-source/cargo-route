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

  // 시/도 이름으로 시작하거나, "○○시 ○○구/동/로/길" 형태면 주소로 본다.
  // 주의: "인천특송물류센터"처럼 시/도 이름이 낱말 앞에 붙기만 한 것은 주소가 아니므로,
  //       시/도 뒤에 (광역시/도 등 접미사) 또는 (공백+구/군/시)가 와야 주소로 인정한다.
  const SIDO = '서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주';
  const ADDR_RE = new RegExp(
    '((' + SIDO + ')(특별시|광역시|특별자치시|특별자치도|도|시)\\s*[가-힣0-9].*'          // 인천광역시 중구 ...
    + '|(' + SIDO + ')\\s+[가-힣]{1,5}(시|군|구)(?=[\\s,]|$).*'                          // 인천 중구 ..., 경기 성남시 ...
    + '|[가-힣]{1,10}(시|군|구)\\s+[가-힣0-9]+(시|군|구|로|길|동|읍|면|리|가)(?=[\\s\\d,.]|$).*)' // 수원시 영통구, 중구 공항동로 ...
  );

  // 주소에 이어지는 건물·게이트 등 위치 상세 (별도 배송지가 아니라 앞 주소에 붙인다)
  const PLACE_DETAIL_RE = /(센터|게이트|물류|창고|공장|빌딩|타워|정문|후문|하치장|상하차장|터미널|부두|가는길|입구|주차장)/;

  const CARGO_RE = /(파레트|팔레트|빠레트|PLT|plt|박스|BOX|box|카톤|톤\b|kg|KG|Kg|㎏|수량|중량|품명|품목|화물\s*[:：]|냉동|냉장|목재|철재|기계|자재)/;

  // 특이사항: 기사에게 하는 요청·주의 문구가 든 줄을 찾는다
  const NOTE_RE = /(꼭|반드시|필수|주의|엄수|금지|파손|직접|수작업|손하차|손상차|지게차|리프트|호이스트|착불|선불|현불|원본|서류|송장|거래명세|안전화|안전조끼|납품|전달|서명|늦지\s*않|미리\s*전화|전화\s*주|연락\s*주|카톡|문자\s*주|보내\s*주|주세요|주십시오|바랍니다|부탁)/;

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
    const info = { type, address: '', phone: '', contactName: '', cargo: '', podPhone: '', notes: [] };
    const cargoLines = [];

    for (const raw of lines) {
      const line = stripLabel(raw);
      if (!line) continue;

      // 인수증 관련 줄: 번호가 있으면 인수증 보낼 번호, 없으면 요청 문구는 특이사항으로
      if (POD_KEYS.some(k => line.includes(k))) {
        const p = findPhones(line);
        if (p.length) info.podPhone = info.podPhone || p[0];
        else if (NOTE_RE.test(line)) info.notes.push(line);
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

      // 특이사항 (요청·주의 문구)
      if (NOTE_RE.test(line)) info.notes.push(line);
    }
    info.cargo = cargoLines.slice(0, 2).join(' / ');
    info.notes = [...new Set(info.notes)].slice(0, 5);
    return info;
  }

  /** 줄이 상차/하차 구역의 시작인지 판정. 시작이면 타입과 남은 내용(같은 줄 뒷부분)을 돌려준다 */
  function sectionStart(line) {
    // "* ..." 로 시작하는 줄과 인수증 관련 줄은 요청사항이지 구역 제목이 아니다
    if (/^\s*\*/.test(line) || POD_KEYS.some(k => line.includes(k))) return null;
    // "지게차 하차 필수" 같은 문구를 구역 제목으로 오인하지 않도록,
    // 앞머리 기호를 뗀 뒤 키워드가 사실상 줄 맨 앞에 있을 때만 구역 시작으로 본다
    const s = line.replace(/^[\s\d.\-•▶■□○●◆★☆·=~\[(（【]+/, '');
    const check = (k) => {
      const idx = s.indexOf(k);
      if (idx < 0 || idx > 1) return false;
      if (idx > 0 && /[가-힣]/.test(s[idx - 1])) return false;
      // "상차시간: 17시" 처럼 키워드 뒤에 다른 낱말이 이어지면 구역 제목이 아니다
      const after = s[idx + k.length];
      return !(after && /[가-힣]/.test(after));
    };
    for (const k of LOAD_KEYS) {
      if (check(k)) return { type: '상차', rest: s.slice(s.indexOf(k) + k.length) };
    }
    for (const k of UNLOAD_KEYS) {
      if (check(k)) return { type: '하차', rest: s.slice(s.indexOf(k) + k.length) };
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
      // 구역은 있는데 주소를 하나도 못 찾았으면 문자 전체를 주소 스캔으로 다시 읽는다
      if (!stops.length) {
        stops = scanAddresses(lines);
        guessTypes(stops);
      } else if (!stops.some(s => s.type === '상차')) {
        // 상차지 주소가 구역 밖(문자 맨 위)에 적힌 문자: 헤더의 주소를 상차지로 복원
        const h = parseSection('상차', header);
        if (h.address) stops.unshift(h);
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
      // 헤더(첫 구역 이전)의 특이사항은 첫 지점에 붙인다
      const headerNotes = header
        .filter(l => NOTE_RE.test(l) && !POD_KEYS.some(k => l.includes(k)) && !cleanAddress(stripLabel(l)))
        .map(stripLabel);
      if (headerNotes.length && stops[0]) {
        stops[0].notes = [...new Set([...(stops[0].notes || []), ...headerNotes])].slice(0, 5);
      }
    } else {
      // 2) 키워드가 없는 문자: 주소로 보이는 줄마다 지점 하나
      stops = scanAddresses(lines);
      guessTypes(stops);
    }

    return stops;
  }

  /** 상차/하차 표기가 없을 때: 관례상 맨 위 주소 = 상차지, 아래 = 하차지로 추정 */
  function guessTypes(stops) {
    if (stops.length >= 2) {
      stops[0].type = '상차';
      stops.forEach(s => { s.guessed = true; });
    }
  }

  /** 구역 키워드 없이 줄들을 훑어 주소마다 지점 하나씩 만든다 */
  function scanAddresses(lines) {
    const stops = [];
    let pending = null;
    for (const line of lines) {
      const clean = stripLabel(line);
      const ca = cleanAddress(clean);
      if (ca) {
        if (pending) stops.push(pending);
        const p = findPhones(clean);
        pending = {
          type: '하차', address: ca.addr,
          phone: p[0] || '', contactName: '', cargo: '', podPhone: '', notes: [],
        };
        const nm = clean.match(NAME_RE);
        const nm2 = nm ? null : clean.match(NAME_RE2);
        if (nm) pending.contactName = nm[2];
        else if (nm2) pending.contactName = nm2[1] + nm2[2];
        const tailCargo = ca.tail.replace(PHONE_RE, '').replace(/[()（）]/g, '').replace(/연락처|문의/g, '').trim();
        if (tailCargo && CARGO_RE.test(tailCargo)) pending.cargo = tailCargo;
      } else if (pending) {
        // 주소 다음 줄의 건물·게이트 등 위치 상세는 별도 지점이 아니라 앞 주소에 붙인다
        if (PLACE_DETAIL_RE.test(clean) && !findPhones(clean).length
          && !POD_KEYS.some(k => clean.includes(k)) && !NOTE_RE.test(clean)) {
          if (!pending.address.includes(clean)) pending.address += ' ' + clean;
          continue;
        }
        // 인수증 관련 줄의 번호는 연락처가 아니라 인수증 보낼 번호. 번호가 없으면 특이사항으로
        if (POD_KEYS.some(k => clean.includes(k))) {
          const pp = findPhones(clean);
          if (pp.length && !pending.podPhone) pending.podPhone = pp[0];
          else if (!pp.length && NOTE_RE.test(clean)) pending.notes = [...new Set([...pending.notes, clean])].slice(0, 5);
          continue;
        }
        const p = findPhones(clean);
        if (p.length && !pending.phone) pending.phone = p[0];
        const nm = clean.match(NAME_RE);
        const nm2 = nm ? null : clean.match(NAME_RE2);
        if (nm && !pending.contactName) pending.contactName = nm[2];
        else if (nm2 && !pending.contactName) pending.contactName = nm2[1] + nm2[2];
        if (CARGO_RE.test(clean) && !pending.cargo && !PHONE_RE.test(clean)) pending.cargo = clean;
        if (NOTE_RE.test(clean) && !POD_KEYS.some(k => clean.includes(k))) {
          pending.notes = [...new Set([...pending.notes, clean])].slice(0, 5);
        }
      }
    }
    if (pending) stops.push(pending);
    return stops;
  }

  /* ── 상·하차 일정 유형 인식 (당상당착 / 당상내착 / 내상내착 / 월상 등) ── */
  function detectSchedule(text) {
    const t = String(text).replace(/\s+/g, '');
    const table = [
      [/당상당[착차]|당일상차당일하차|당일상[착차]당일착/, '당상당착', '오늘 상차 → 오늘 하차'],
      [/당상내[착차]|당일상차(익일|내일)하차/, '당상내착', '오늘 상차 → 내일 하차'],
      [/내상내[착차]|내일상차내일하차/, '내상내착', '내일 상차 → 내일 하차'],
      [/당상월[착차]/, '당상월착', '오늘 상차 → 월요일 하차 (지정일인지 문자 확인)'],
      [/월상월[착차]/, '월상월착', '월요일 상차 → 월요일 하차 (지정일인지 문자 확인)'],
      [/월상/, '월상', '다음 주 월요일 상차 (지정일인지 문자 확인)'],
      [/내일상차|명일상차|내상/, '내상', '내일 상차'],
      [/익일하차|익일착|내일하차|내착/, '내착', '내일 하차'],
      [/당착|당일착|당일하차/, '당착', '오늘 하차'],
      [/당상|당일상차/, '당상', '오늘 상차'],
    ];
    for (const [re, label, detail] of table) {
      if (re.test(t)) return { label, detail };
    }
    // 날짜가 명시된 경우: "7/21 상차" "7월 21일 하차"
    const dm = String(text).match(/(\d{1,2})\s*[/.월]\s*(\d{1,2})\s*일?\s*(?:\([월화수목금토일]\))?\s*(상차|하차)/);
    if (dm) return { label: `${dm[1]}/${dm[2]} ${dm[3]}`, detail: `${dm[1]}월 ${dm[2]}일 ${dm[3]}` };
    return null;
  }

  /* ── 화물 치수 파싱: "60x40x45 30개 250kg" → {kind, w, d, h, count, totalKg} ── */
  function parseItems(text) {
    const items = [];
    const DIM_RE = /(\d{2,4}(?:\.\d+)?)\s*[x×X*]\s*(\d{2,4}(?:\.\d+)?)\s*[x×X*]\s*(\d{2,4}(?:\.\d+)?)/g;
    for (const line of String(text).split('\n')) {
      DIM_RE.lastIndex = 0;
      let m;
      while ((m = DIM_RE.exec(line))) {
        let w = +m[1], d = +m[2], h = +m[3];
        // 세 자리를 넘는 치수는 mm로 보고 cm로 환산 (예: 1100×1100×1300)
        if (w >= 400 || d >= 400 || h >= 400) { w /= 10; d /= 10; h /= 10; }
        const isPlt = /파레트|팔레트|빠레트|빠렛|파렛|PLT/i.test(line);
        const after = line.slice(m.index + m[0].length);
        const cm = after.match(/(\d+)\s*(개|박스|BOX|box|장|EA|ea|파레트|팔레트|PLT|plt)/)
          || line.match(/수량\s*[:：]?\s*(\d+)/);
        const count = Math.min(2000, cm ? parseInt(cm[1], 10) : 1);
        const wm = line.match(/(\d+(?:\.\d+)?)\s*(kg|KG|Kg|㎏|키로|톤)/);
        let totalKg = 0;
        if (wm) {
          totalKg = parseFloat(wm[1]);
          if (wm[2] === '톤') totalKg *= 1000;
          if (/개당|각(?![가-힣])/.test(line)) totalKg *= count;
        }
        if (w > 0 && d > 0 && h > 0 && count > 0) {
          items.push({ kind: isPlt ? 'plt' : 'box', w, d, h, count, totalKg });
        }
      }
    }
    return items.slice(0, 10);
  }

  /** 문자 전체 → { stops, schedule, items } (특이사항은 각 stop.notes에 포함) */
  function parseFull(text) {
    return { stops: parse(text), schedule: detectSchedule(text), items: parseItems(text) };
  }

  /** 한 줄이 주소로 보이는지 (배송지 직접 입력과 배차 문자를 구분할 때 사용) */
  function looksLikeAddress(line) {
    return !!cleanAddress(stripLabel(String(line)));
  }

  return { parse, parseFull, looksLikeAddress };
})();
