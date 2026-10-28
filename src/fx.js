// D12·D13 CNY→HKD 환율: 영수증일 기준 네이버 매매기준율
// 네이버는 원화 기준 고시만 제공하므로 CNY/KRW ÷ HKD/KRW 로 교차환율을 구한다.
// 휴일·주말 등 고시가 없는 날은 그 이전 가장 가까운 고시일 값을 쓴다.
// 2026-10 옛 일별 시세 페이지(exchangeDailyQuote)가 410(폐지)을 돌려줘, 네이버 증권의 일별 시세 JSON을 먼저 쓰고
// 옛 페이지는 마지막 예비로만 남긴다. 어느 출처를 썼는지는 source에 남겨 승인 카드에 보인다.

const SOURCES = [
  // 2026-10-28 브라우저로 확인: 배열 [{localTradedAt:'2026-10-23', closePrice:'198.83', …}] 최신순
  { name: '네이버 증권', url: (code, page) => `https://api.stock.naver.com/marketindex/exchange/FX_${code}KRW/prices?page=${page}&pageSize=10` },
  // 같은 데이터의 모바일 경로 (pageSize는 10 이상이어야 함)
  { name: '네이버 증권 모바일', url: (code, page) => `https://m.stock.naver.com/front-api/marketIndex/prices?category=exchange&reutersCode=FX_${code}KRW&page=${page}&pageSize=10` },
  { name: '네이버 금융', url: (code, page) => `https://finance.naver.com/marketindex/exchangeDailyQuote.naver?marketindexCd=FX_${code}KRW&page=${page}`, html: true },
];

/** 옛 일별 시세 HTML → [{date:'2026-10-22', rate:193.21}] (매매기준율 = 날짜 다음 첫 숫자 칸) */
export function parseDailyQuote(html) {
  const out = [];
  const re = /<td class="date">\s*(\d{4})\.(\d{2})\.(\d{2})\s*<\/td>\s*<td class="num">\s*([\d,]+(?:\.\d+)?)\s*<\/td>/g;
  let m;
  while ((m = re.exec(html))) out.push({ date: `${m[1]}-${m[2]}-${m[3]}`, rate: Number(m[4].replace(/,/g, '')) });
  return out;
}

const DATE_KEYS = ['localTradedAt', 'tradeDate', 'localDate', 'date', 'bizdate', 'dt'];
const PRICE_KEYS = ['closePrice', 'basePrice', 'calcPrice', 'price', 'close'];
function toYmd(v) {
  const m = String(v ?? '').match(/(\d{4})[-.]?(\d{2})[-.]?(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
/** 네이버 증권 JSON(배열이든 {result:[…]}든) → [{date, rate}] 최신순 */
export function parsePriceJson(json) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const dk = DATE_KEYS.find((k) => k in v); const pk = PRICE_KEYS.find((k) => k in v);
    const date = dk && toYmd(v[dk]); const rate = pk && Number(String(v[pk]).replace(/,/g, ''));
    if (date && rate > 0) { out.push({ date, rate }); return; }
    Object.values(v).forEach(walk);
  };
  walk(json);
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function createFx({ fetchImpl = fetch, maxPages = 30, log = console } = {}) {
  const pages = new Map(); // `${src}:${code}:${page}` -> {at, rows}
  async function page(src, code, n) {
    const key = `${src.name}:${code}:${n}`;
    const c = pages.get(key);
    if (c && Date.now() - c.at < 30 * 60 * 1000) return c.rows;
    const res = await fetchImpl(src.url(code, n), { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://m.stock.naver.com/' } });
    if (!res.ok) throw new Error(`${src.name} ${res.status}`);
    const rows = src.html
      ? parseDailyQuote(Buffer.from(await res.arrayBuffer()).toString('latin1'))
      : parsePriceJson(await res.json());
    pages.set(key, { at: Date.now(), rows });
    return rows;
  }
  /** 한 출처에서 date 이하 가장 최근 고시 */
  async function rateFrom(src, code, date) {
    for (let n = 1; n <= maxPages; n++) {
      const rows = await page(src, code, n);
      if (!rows.length) break;
      const hit = rows.find((r) => r.date <= date);
      if (hit) return hit;
    }
    throw new Error(`${src.name}: ${date} 이전 ${code} 고시 없음`);
  }
  /** @returns {{rate:number, basisDate:string, source:string}} */
  async function cnyToHkd(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('영수증 날짜가 없어 환율 기준일을 정할 수 없음');
    const errors = [];
    for (const src of SOURCES) {
      try {
        const [cny, hkd] = await Promise.all([rateFrom(src, 'CNY', date), rateFrom(src, 'HKD', date)]);
        return { rate: cny.rate / hkd.rate, basisDate: cny.date, source: `${src.name} 매매기준율 ${cny.date} (CNY ${cny.rate} / HKD ${hkd.rate} KRW)` };
      } catch (e) { errors.push(e.message); }
    }
    log.warn?.('환율 출처 모두 실패', errors.join(' | '));
    throw new Error(`네이버 환율 조회 실패: ${errors.join(' | ')}`);
  }
  return { cnyToHkd };
}
