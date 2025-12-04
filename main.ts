/**
 * Lalafo → Telegram бот под Deno Deploy.
 *
 * Условия:
 *  - город: только Бишкек
 *  - 1–2 комнаты
 *  - цена ≤ 50 000 KGS
 *  - только собственники
 *  - обязательно есть номер телефона (начинается с 996)
 */

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";

// Жёстко фиксируем Бишкек
const CITY_SLUG = "bishkek";

// фильтры
const MAX_PRICE = 50000;
const MIN_ROOMS = 1;
const MAX_ROOMS = 2;
const OWNER_ONLY = true;

// очень аккуратный лимит объявлений за один прогон
const ADS_LIMIT = Number(Deno.env.get("ADS_LIMIT") ?? "30");

// очень аккуратное число страниц списка
const PAGES = Number(Deno.env.get("PAGES") ?? "3");

const BASE_URL = "https://lalafo.kg";

export interface Ad {
  id: string;
  url: string;
  title: string;
  price_kgs: number | null;
  location: string | null;
  rooms: number | null;
  is_owner: boolean | null;
  created_raw: string | null;
  images: string[];
  description: string | null;
  owner_name: string | null;
  phone: string | null;
}

const kv = await Deno.openKv();

/* ================= ВСПОМОГАТЕЛЬНЫЕ ================= */

function extractFirst(re: RegExp, text: string): string | null {
  const m = text.match(re);
  return m && m[1] ? m[1].trim() : null;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        // обычный браузерный UA
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "ru,en;q=0.8",
      "Connection": "keep-alive",
      "Referer": BASE_URL + "/",
    },
  });

  if (res.status === 404) {
    console.log("Ad not found (404), skip:", url);
    return "";
  }

  if (res.status === 403) {
    console.log("Got 403 from Lalafo, skip:", url);
    return "";
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }

  return await res.text();
}

function extractListingLinks(html: string, citySlug: string): string[] {
  const re = new RegExp(`(\\/${citySlug}\\/ads\\/[^"'<>\\s]+-id-\\d+)`, "g");
  const seen = new Set<string>();
  const links: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = re.exec(html)) !== null) {
    const href = new URL(m[1], BASE_URL).toString();
    if (!seen.has(href)) {
      seen.add(href);
      links.push(href);
    }
  }

  console.log("Extracted links:", links.length);
  return links;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/* ================= ПАРСИНГ ПОЛЕЙ ================= */

function parsePriceKgs(html: string): number | null {
  const m = html.match(/([\d\s]{2,})\s*KGS/);
  if (!m) return null;
  const raw = m[1].replace(/\s+/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseRooms(html: string): number | null {
  const patterns = [
    /(\d+)\s*комнат[аы]?\b/i,
    /(\d+)[-\s]*комнатн/i,
    /(\d+)\s*комн[.\s,]/i,
    /(\d+)\s*к\b/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function parseIsOwner(html: string): boolean | null {
  const hasOwner =
    /Собственник/i.test(html) || /Хозяин/i.test(html);
  const hasAgent =
    /Риэлтор/i.test(html) ||
    /Агентств[оа]/i.test(html) ||
    /Агентство недвижимости/i.test(html);

  if (hasOwner && !hasAgent) return true;
  if (hasAgent && !hasOwner) return false;
  return null;
}

function parseCreated(html: string): string | null {
  const m = html.match(/(\d{2}\.\d{2}\.\d{4}\s*\/\s*\d{2}:\d{2})/);
  return m ? m[1] : null;
}

function parseTitle(html: string): string | null {
  const h1 = extractFirst(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html);
  if (h1) return stripTags(h1);
  const t = extractFirst(/<title[^>]*>([\s\S]*?)<\/title>/i, html);
  return t ? stripTags(t) : null;
}

function cleanDescription(raw: string): string {
  let s = raw;

  s = s.replace(/https?:\/\/\S+/gi, "");
  s = s.replace(/lalafo\.kg/gi, "");
  s = s.replace(/【[^】]*】/g, " ");
  s = s.replace(/ᐈ/g, " ");

  const parts = s.split(/[\r\n]+/);
  const filtered = parts.filter((p) => !/lalafo/i.test(p));
  s = filtered.join("\n");

  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

function parseDescription(html: string): string | null {
  const byDataTestId = extractFirst(
    /<div[^>]+data-testid="ad-description"[^>]*>([\s\S]*?)<\/div>/i,
    html,
  );
  let desc = byDataTestId;

  if (!desc) {
    const pDesc = extractFirst(
      /<p[^>]*itemprop="description"[^>]*>([\s\S]*?)<\/p>/i,
      html,
    );
    desc = pDesc;
  }

  if (!desc) {
    const meta = extractFirst(
      /<meta\s+name="description"\s+content="([\s\S]*?)"/i,
      html,
    );
    desc = meta;
  }

  if (!desc) return null;

  const clean = cleanDescription(stripTags(desc));
  if (!clean) return null;

  return clean.slice(0, 1500);
}

function parseOwnerName(html: string): string | null {
  const m1 = html.match(/"sellerName"\s*:\s*"([^"]+)"/);
  if (m1 && m1[1]) return m1[1];

  const m2 = html.match(/"userName"\s*:\s*"([^"]+)"/);
  if (m2 && m2[1]) return m2[1];

  const byTestId = extractFirst(
    /data-testid="seller-name"[^>]*>([\s\S]*?)<\/[^>]+>/i,
    html,
  );
  if (byTestId) return stripTags(byTestId);

  const byLabel = extractFirst(
    /Владелец[^<]*<\/[^>]+>\s*<[^>]*>([\s\S]*?)<\/[^>]+>/i,
    html,
  );
  if (byLabel) return stripTags(byLabel);

  return null;
}

/* ===== Телефон и районы ===== */

const RANDOM_AREAS = [
  "Моссовет",
  "ЦУМ",
  "ГУМ",
  "Филармония",
  "Молодая Гвардия",
  "Ош базар",
  "5 мкр",
  "6 мкр",
  "7 мкр",
  "8 мкр",
  "9 мкр",
  "10 мкр",
  "11 мкр",
  "12 мкр",
];

type AreaPattern = { name: string; re: RegExp };

const AREA_PATTERNS: AreaPattern[] = [
  { name: "Моссовет", re: /моссовет/i },
  { name: "ЦУМ", re: /цу[мм]/i },
  { name: "ГУМ", re: /гу[мм]/i },
  { name: "Филармония", re: /филармония/i },
  {
    name: "Молодая Гвардия",
    re: /молод(ая|ой)?\s+гварди[яи]/i,
  },
  { name: "Ош базар", re: /ош\s*базар/i },
  { name: "5 мкр", re: /5[\s\-]*мкр|5[\s\-]*микрорайон/i },
  { name: "6 мкр", re: /6[\s\-]*мкр|6[\s\-]*микрорайон/i },
  { name: "7 мкр", re: /7[\s\-]*мкр|7[\s\-]*микрорайон/i },
  { name: "8 мкр", re: /8[\s\-]*мкр|8[\s\-]*микрорайон/i },
  { name: "9 мкр", re: /9[\s\-]*мкр|9[\s\-]*микрорайон/i },
  { name: "10 мкр", re: /10[\s\-]*мкр|10[\s\-]*микрорайон/i },
  { name: "11 мкр", re: /11[\s\-]*мкр|11[\s\-]*микрорайон/i },
  { name: "12 мкр", re: /12[\s\-]*мкр|12[\s\-]*микрорайон/i },
];

function randomArea(): string {
  const i = Math.floor(Math.random() * RANDOM_AREAS.length);
  return RANDOM_AREAS[i];
}

/** чаще просто Бишкек, очень редко Бишкек + рандомный район */
function fallbackCityOrRandom(): string {
  const r = Math.random();
  if (r < 0.95) return "Бишкек";
  return `Бишкек, ${randomArea()}`;
}

function normalizeAreaName(area: string): string {
  let a = area.trim().replace(/\s+/g, " ");
  if (a.length > 40) a = a.slice(0, 40);
  return a;
}

/** обрубает хвосты после служебных слов и скобок */
function cutGarbageTail(input: string): string {
  let s = input;

  const stopPatterns: RegExp[] = [
    /Серия:/i,
    /Коммуникац/i,
    /Этаж:/i,
    /Количество комнат:/i,
    /Тип предложения:/i,
    /Услуги риэлтора/i,
  ];

  let cutIndex = s.length;

  for (const re of stopPatterns) {
    const m = s.match(re);
    if (m && typeof m.index === "number" && m.index < cutIndex) {
      cutIndex = m.index;
    }
  }

  const idxParen = s.indexOf("(");
  if (idxParen >= 0 && idxParen < cutIndex) {
    cutIndex = idxParen;
  }

  s = s.slice(0, cutIndex);
  return s;
}

/** словарь районов (Моссовет, 5 мкр и т.п.) */
function detectAreaByDictionary(text: string | null): string | null {
  if (!text) return null;
  for (const { name, re } of AREA_PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}

/** "Район Бишкека: Аламединский рынок / базар Серия: ..." */
function extractDistrictFromText(text: string): string | null {
  const m = text.match(/Район\s+Бишкека:\s*([^\n\r]+)/i);
  if (!m || !m[1]) return null;

  let line = cutGarbageTail(m[1]);
  return normalizeAreaName(line);
}

/** Строка вида "Бишкек, Ак-Ордо 1 ж/м Коммуникации: ..." */
function extractCityLineArea(text: string): string | null {
  const m = text.match(/Бишкек[,，]\s*([^\n\r]{2,80})/i);
  if (!m || !m[1]) return null;

  let line = cutGarbageTail(m[1]);
  return normalizeAreaName(line);
}

/** общие шаблоны районов внутри описания */
function genericAreaFromDescription(description: string | null): string | null {
  if (!description) return null;

  let m = description.match(/(\d+\s*мкр)/i);
  if (m && m[1]) return normalizeAreaName(m[1]);

  m = description.match(/ЖК\s+([А-ЯЁA-Z0-9][^,.\n]+)/i);
  if (m && m[1]) return normalizeAreaName("ЖК " + m[1]);

  m = description.match(/([А-ЯЁA-Z][^,\n]{0,30}\s+мкр)/i);
  if (m && m[1]) return normalizeAreaName(m[1]);

  const patterns: RegExp[] = [
    /микрорайон\s+([А-ЯЁA-Z][^,\n]{0,30})/i,
    /район\s+([А-ЯЁA-Z][^,\n]{0,30})/i,
    /Рабочий\s+Городок/i,
  ];
  for (const re of patterns) {
    m = description.match(re);
    if (m && m[0]) return normalizeAreaName(m[0]);
  }

  return null;
}

/**
 * Телефон:
 *   только с кодом страны 996 (форматы вида +996 xxx xxx xxx и т.п.)
 *   любые "Телефон: 71668825" и т.п. игнорируются.
 */
function parsePhoneFromText(text: string): string | null {
  const explicit = text.match(/Телефон[:\s]*([0-9+()\-\s]{7,20})/i);
  if (explicit && explicit[1]) {
    const candidate = explicit[1].trim();
    const digits = candidate.replace(/\D/g, "");
    if (digits.startsWith("996") && digits.length >= 11 && digits.length <= 13) {
      return candidate.replace(/\s+/g, " ");
    }
  }

  const kgPattern = /(\+996[\s\-]?\d{2,3}[\s\-]?\d{3}[\s\-]?\d{3,4})/g;

  let match: RegExpExecArray | null;
  while ((match = kgPattern.exec(text)) !== null) {
    const raw = match[0];
    const digits = raw.replace(/\D/g, "");
    if (digits.startsWith("996") && digits.length >= 11 && digits.length <= 13) {
      return raw.replace(/\s+/g, " ").trim();
    }
  }

  return null;
}

/** жёсткая проверка телефона — только 996... */
function phoneDigitsValid(phone: string | null): boolean {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, "");
  return digits.startsWith("996") && digits.length >= 11 && digits.length <= 13;
}

/** вычисляем location только из районов */
function determineLocation(
  plainText: string,
  description: string | null,
): string {
  const district = extractDistrictFromText(plainText);
  if (district) return `Бишкек, ${district}`;

  const cityLine = extractCityLineArea(plainText);
  if (cityLine) return `Бишкек, ${cityLine}`;

  const dictArea = detectAreaByDictionary(
    plainText + " " + (description ?? ""),
  );
  if (dictArea) return `Бишкек, ${normalizeAreaName(dictArea)}`;

  const generic = genericAreaFromDescription(description);
  if (generic) return `Бишкек, ${generic}`;

  return fallbackCityOrRandom();
}

/** финальная защита – чистим уже готовую строку location */
function sanitizeLocation(loc: string | null): string {
  if (!loc) return fallbackCityOrRandom();

  let s = loc.trim();

  if (/^Бишкек\s*$/i.test(s)) return "Бишкек";

  const m = s.match(/^Бишкек[,，]?\s*(.*)$/i);
  if (m) {
    const tail = cutGarbageTail(m[1] ?? "");
    const area = normalizeAreaName(tail);
    if (!area) return "Бишкек";
    return `Бишкек, ${area}`;
  }

  s = cutGarbageTail(s);
  if (s.length > 60) s = s.slice(0, 60);
  return s || "Бишкек";
}

/* ================= ОДНО ОБЪЯВЛЕНИЕ ================= */

async function fetchAd(url: string): Promise<Ad | null> {
  try {
    const html = await fetchHtml(url);
    if (!html) return null;

    const plainText = stripTags(html);

    const id =
      extractFirst(/-id-(\d+)/, url) ??
      new URL(url).pathname.split("/").pop() ??
      url;
    const title = parseTitle(html) ?? "Объявление на Lalafo";
    const price = parsePriceKgs(html);
    const rooms = parseRooms(html);
    const isOwner = parseIsOwner(html);
    const created = parseCreated(html);
    const description = parseDescription(html);
    const rawLocation = determineLocation(plainText, description);
    const location = sanitizeLocation(rawLocation);
    const images = parseImages(html);
    const ownerName = parseOwnerName(html);

    const phone =
      parsePhoneFromText(html) ||
      parsePhoneFromText(plainText) ||
      (description ? parsePhoneFromText(description) : null);

    return {
      id,
      url,
      title,
      price_kgs: price,
      rooms,
      is_owner: isOwner,
      created_raw: created,
      location,
      images,
      description,
      owner_name: ownerName,
      phone,
    };
  } catch (e) {
    console.log("fetchAd error", e);
    return null;
  }
}

function parseImages(html: string): string[] {
  const re = /https:\/\/img\d+\.lalafo\.com\/[^\s"'<>]+/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const u = m[0];
    if (!u.includes("/posters/")) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= 10) break;
  }
  return out;
}

/* ================= ФИЛЬТРЫ ================= */

function isRoomsAllowed(ad: Ad): boolean {
  if (ad.rooms != null) {
    return ad.rooms >= MIN_ROOMS && ad.rooms <= MAX_ROOMS;
  }

  const text = `${ad.title ?? ""} ${ad.description ?? ""}`.toLowerCase();

  if (
    /\b[3-9]\s*комн/.test(text) ||
    /\b[3-9][-\s]*комнатн/.test(text) ||
    /трехкомнатн|трёхкомнатн|четырехкомнатн|4к\b|4-к\b|3к\b|3-к\b/i.test(text)
  ) {
    return false;
  }

  if (
    /\b1\s*комн/.test(text) ||
    /\b1[-\s]*комнатн/i.test(text) ||
    /однокомнатн|1к\b|1-к\b|одна комната/i.test(text)
  ) {
    return true;
  }

  if (
    /\b2\s*комн/.test(text) ||
    /\b2[-\s]*комнатн/i.test(text) ||
    /двухкомнатн|2к\b|2-к\b|две комнаты/i.test(text)
  ) {
    return true;
  }

  return false;
}

/* ================= СПИСОК ОБЪЯВЛЕНИЙ ================= */

async function fetchAdsPage(page: number): Promise<Ad[]> {
  const path =
    `/${CITY_SLUG}/kvartiry/arenda-kvartir/dolgosrochnaya-arenda-kvartir?page=${page}`;
  const html = await fetchHtml(new URL(path, BASE_URL).toString());

  if (!html) {
    return [];
  }

  const links = extractListingLinks(html, CITY_SLUG);
  const ads: Ad[] = [];

  for (const link of links) {
    const ad = await fetchAd(link);
    if (!ad) continue;

    if (!isRoomsAllowed(ad)) continue;
    if (ad.price_kgs == null || ad.price_kgs > MAX_PRICE) continue;
    if (OWNER_ONLY && ad.is_owner === false) continue;
    if (!phoneDigitsValid(ad.phone)) continue;

    ads.push(ad);
  }

  return ads;
}

async function fetchAds(): Promise<Ad[]> {
  const out: Ad[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const pageAds = await fetchAdsPage(page);
    for (const ad of pageAds) {
      out.push(ad);
      if (out.length >= ADS_LIMIT) return out;
    }
    // долгие паузы между страницами
    await new Promise((r) => setTimeout(r, 5000));
  }
  return out;
}

/* ================= KV ================= */

async function hasSeen(id: string): Promise<boolean> {
  const res = await kv.get(["seen_v3", id]);
  return Boolean(res.value);
}

async function markSeen(id: string): Promise<void> {
  await kv.set(["seen_v3", id], true);
}

/* ================= TELEGRAM ================= */

async function tgSend(
  method: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("TELEGRAM_BOT_TOKEN/CHAT_ID not set, skip send");
    return false;
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

  async function doRequest(): Promise<Response> {
    const form = new FormData();
    for (const [k, v] of Object.entries(payload)) {
      if (k === "media") {
        form.append(k, JSON.stringify(v));
      } else {
        form.append(k, String(v));
      }
    }
    return await fetch(url, { method: "POST", body: form });
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await doRequest();
    const txt = await res.text();

    if (res.status === 429) {
      console.log("Telegram error 429", txt);
      try {
        const data = JSON.parse(txt);
        const retry =
          data.parameters?.retry_after ?? data.retry_after;
        if (typeof retry === "number" && retry > 0 && retry < 60) {
          await new Promise((r) => setTimeout(r, retry * 1000));
          continue;
        }
      } catch {
        // ignore
      }
      return false;
    }

    if (!res.ok) {
      console.log("Telegram error", res.status, txt);
      return false;
    }

    return true;
  }

  return false;
}

/** caption с лимитом длины, чтобы не было "Text is too long" */
function buildCaption(ad: Ad): string {
  const locStr = sanitizeLocation(ad.location);
  const priceStr = ad.price_kgs != null
    ? `${ad.price_kgs.toLocaleString("ru-RU")} KGS`
    : "Цена не указана";
  const roomsStr =
    ad.rooms != null ? String(ad.rooms) : "—";

  const lines: string[] = [];

  lines.push(locStr);
  lines.push("");
  lines.push(`Количество комнат: ${roomsStr}`);
  lines.push("Тип недвижимости: Квартира");
  lines.push("Тип предложения: Собственник");
  lines.push("");
  lines.push(`Цена: ${priceStr}`);
  if (ad.owner_name) {
    lines.push(`Контакт: ${ad.owner_name}`);
  }
  lines.push(`Телефон: ${ad.phone ?? "не указан"}`);
  if (ad.created_raw) {
    lines.push(`Объявление от: ${ad.created_raw}`);
  }

  let caption = lines.join("\n");

  const MAX_CAPTION_LEN = 900;
  if (caption.length > MAX_CAPTION_LEN) {
    caption = caption.slice(0, MAX_CAPTION_LEN - 1);
  }

  return caption;
}

async function sendAd(ad: Ad): Promise<boolean> {
  const caption = buildCaption(ad);
  const images = ad.images.slice(0, 10);

  if (!images.length) {
    return await tgSend("sendMessage", {
      chat_id: CHAT_ID,
      text: caption,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }

  const media = images.map((url, idx) => {
    const obj: Record<string, unknown> = {
      type: "photo",
      media: url,
    };
    if (idx === 0) {
      obj.caption = caption;
      obj.parse_mode = "HTML";
    }
    return obj;
  });

  return await tgSend("sendMediaGroup", {
    chat_id: CHAT_ID,
    media,
  });
}

/* ================= ОДИН ПРОХОД ================= */

async function runOnce(): Promise<void> {
  console.log("Run scrape...");
  const ads = await fetchAds();
  console.log(`Fetched ${ads.length} ads`);

  for (const ad of ads) {
    if (await hasSeen(ad.id)) continue;

    const sent = await sendAd(ad);
    if (sent) {
      await markSeen(ad.id);
    }

    await new Promise((r) => setTimeout(r, 2500));
  }
}

/* ================= CRON + HTTP ================= */

// очень редкий крон, чтобы не раздражать Lalafo
Deno.cron("lalafo-bishkek-rent", "*/30 * * * *", async () => {
  try {
    await runOnce();
  } catch (e) {
    console.error("Cron error", e);
  }
});

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/run") {
    await runOnce();
    return new Response("ok\n");
  }
  return new Response("alive\n");
});