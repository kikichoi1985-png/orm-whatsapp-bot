// D12·D13 CNY→HKD 환율: 영수증일 기준 네이버 은행고시환율(매매기준율)
// 네이버는 원화 기준 고시만 제공하므로 CNY/KRW ÷ HKD/KRW 로 교차환율을 구한다.
// 휴일·주말 등 고시가 없는 날은 그 이전 가장 가까운 고시일 값을 쓴다.

const URL = (code, page) => `https://finance.naver.com/marketindex/exchangeDailyQuote.naver?marketindexCd=FX_${code}KRW&page=${page}`;

/** 일별 시세 HTML → [{date:'2026-10-22', rate:193.21}] (매매기준율 = 날짜 다음 첫 숫자 칸) */
export function parseDailyQuote(html) {
  const out = [];
  const re = /<td class="date">\s*(\d{4})\.(\d{2})\.(\d{2})\s*<\/td>\s*<td class="num">\s*([\d,]+(?:\.\d+)?)\s*<\/td>/g;
  let m;
  while ((m = re.exec(html))) out.push({ date: `${m[1]}-${m[2]}-${m[3]}`, rate: Number(m[4].replace(/,/g, '')) });
  return out;
}

export function createFx({ fetchImpl = fetch, maxPages = 40, log = console } = {}) {
  const pages = new Map(); // `${code}:${page}` -> {at, rows}
  async function page(code, n) {
    const key = `${code}:${n}`;
    const c = pages.get(key);
    if (c && Date.now() - c.at < 30 * 60 * 1000) return c.rows;
    const res = await fetchImpl(URL(code, n), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`네이버 환율 조회 실패 ${res.status}`);
    const html = Buffer.from(await res.arrayBuffer()).toString('latin1'); // 날짜·숫자만 쓰므로 인코딩 무관
    const rows = parseDailyQuote(html);
    pages.set(key, { at: Date.now(), rows });
    return rows;
  }
  /** date 이하에서 가장 최근 고시 */
  async function rateOn(code, date) {
    for (let n = 1; n <= maxPages; n++) {
      const rows = await page(code, n);
      if (!rows.length) break;
      const hit = rows.find((r) => r.date <= date);
      if (hit) return hit;
    }
    throw new Error(`${date} 이전 ${code} 고시를 찾지 못함`);
  }
  /** @returns {{rate:number, basisDate:string, source:string}} */
  async function cnyToHkd(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('영수증 날짜가 없어 환율 기준일을 정할 수 없음');
    const [cny, hkd] = await Promise.all([rateOn('CNY', date), rateOn('HKD', date)]);
    return { rate: cny.rate / hkd.rate, basisDate: cny.date, source: `네이버 매매기준율 ${cny.date} (CNY ${cny.rate} / HKD ${hkd.rate} KRW)` };
  }
  return { cnyToHkd };
}
