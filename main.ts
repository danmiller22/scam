/**
 * Lalafo → Telegram бот под Deno Deploy / GitHub Actions.
 *
 * Условия:
 *  - город: только Бишкек
 *  - 1–2 комнаты
 *  - цена ≤ 50 000 KGS
 *
 * Фильтры по "собственник" и телефону ослаблены, чтобы было больше объявлений.
 */

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID") ?? "";

// Город – Бишкек
const CITY_SLUG = "bishkek";

// Базовый URL Lalafo
const BASE_URL = "https://lalafo.kg";

// Категория – аренда квартир
const CATEGORY_PATH =
  "/bishkek/kvartiry/arenda-kvartir/dolgosrochnaya-arenda-kvartir";

// Ограничения по цене (KGS)
const MAX_PRICE = 50000;

// Разрешённое количество комнат
const ALLOWED_ROOMS = new Set([1, 2]);

// Лимиты для парсинга (можно переопределять через env)
const ADS_LIMIT = Number(Deno.env.get("ADS_LIMIT") ?? "60"); // максимум объявлений за прогон
const PAGES = Number(Deno.env.get("PAGES") ?? "5"); // сколько страниц смотреть

// Структура объявления
interface Ad {
  id: string;
  url: string;
  title: string;
  price: number | null;
  rooms: number | null;
  city: string | null;
  isOwner: boolean | null;
  createdAt: string | null;
  phone: string | null;
  images: string[];
  description: string | null;
}

/* ============ KV (fallback, если openKv нет) ============ */

type KvLike = {
  get: (key: unknown[]) => Promise<{ value: unknown | null }>;
  set: (key: unknown[], value: unknown) => Promise<void>;
} | null;

let kv: KvLike = null;

if (typeof (Deno as any).openKv === "function") {
  kv = await (Deno as any).openKv();
  console.log("KV storage enabled");
} else {
  console.log("Deno.openKv not available, running without KV (no persistence)");
}

/* ================= ВСПОМОГАТЕЛЬНЫЕ ================= */

function extractFirst(re: RegExp, text: string): string | null {
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function extractAll(re: RegExp, text: string): string[] {
  const res: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    res.push(m[1].trim());
  }
  return res;
}

function safeNumber(s: string | null): number | null {
  if (!s) return null;
  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/* ================= ПАРСИНГ СПИСКА ================= */

async function fetchPage(page: number): Promise<string> {
  const url = `${BASE_URL}${CATEGORY_PATH}?page=${page}`;
  console.log("Fetch page:", url);

  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  if (resp.status === 403 || resp.status === 429) {
    console.log(`Got ${resp.status} from Lalafo, skip: ${url}`);
    return "";
  }

  if (!resp.ok) {
    console.warn("Failed to fetch page", resp.status, url);
    return "";
  }

  return await resp.text();
}

function parseList(html: string): string[] {
  if (!html) return [];

  const links: string[] = [];

  const re =
    /<a[^>]+href="(\/bishkek\/kvartiry\/arenda-kvartir\/[0-9\-]+)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (!links.includes(href)) {
      links.push(href);
    }
  }

  return links;
}

/* ================= ПАРСИНГ КАРТОЧКИ ================= */

async function fetchAd(urlPath: string): Promise<string | null> {
  const url = `${BASE_URL}${urlPath}`;
  console.log("Fetch ad:", url);

  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  if (resp.status === 404) {
    console.log("Ad 404, skip:", url);
    return null;
  }

  if (resp.status === 403 || resp.status === 429) {
    console.log(`Got ${resp.status} from Lalafo, skip: ${url}`);
    return null;
  }

  if (!resp.ok) {
    console.warn("Failed to fetch ad", resp.status, url);
    return null;
  }

  return await resp.text();
}

function parseAd(html: string, urlPath: string): Ad | null {
  if (!html) return null;

  const id = extractFirst(/"ad_id":\s*"(\d+)"/, html)
    ?? extractFirst(/data-ad-id="(\d+)"/, html)
    ?? extractFirst(/"id":\s*(\d+)/, html);

  if (!id) {
    console.warn("No ad id", urlPath);
    return null;
  }

  const title =
    extractFirst(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html)
      ?? extractFirst(
        /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i,
        html,
      )
      ?? extractFirst(
        /<meta[^>]+name="title"[^>]+content="([^"]+)"/i,
        html,
      )
      ?? "";

  const priceStr =
    extractFirst(
      /"price":\s*\{\s*"amount":\s*"?([\d\s]+)"?/,
      html,
    )
      ?? extractFirst(
        /<meta[^>]+itemprop="price"[^>]+content="([^"]+)"/i,
        html,
      )
      ?? extractFirst(
        /<div[^>]*class="[^"]*price[^"]*"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/i,
        html,
      );

  const price = safeNumber(priceStr);

  const city =
    extractFirst(/"city":\s*"([^"]+)"/, html)
      ?? extractFirst(
        /<span[^>]*class="[^"]*city[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
        html,
      );

  const roomsStr =
    extractFirst(
      /"rooms":\s*"?(\d+)"?/,
      html,
    )
      ?? extractFirst(
        /(1|2|3|4|5)\s*ком(?:ната|наты|нат)/i,
        html,
      );

  const rooms = roomsStr ? Number(roomsStr) : null;

  const phone =
    extractFirst(
      /(?:\+?996|\b996)(\d{9})/,
      html,
    )
      ?? extractFirst(/"phone":\s*"(\+?996\d{9})"/, html);

  const desc =
    extractFirst(
      /<div[^>]*class="[^"]*ad-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      html,
    )
      ?? extractFirst(
        /<meta[^>]+name="description"[^>]+content="([^"]+)"/i,
        html,
      )
      ?? "";

  let isOwner: boolean | null = null;

  const ownerBlock =
    extractFirst(
      /<div[^>]*class="[^"]*author-info[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      html,
    )
      ?? "";

  if (ownerBlock) {
    const hasAgency =
      /агентств[ао]? недвижимости|риелтор|риэлтор|риэлт/i.test(ownerBlock);
    const hasOwner =
      /собственник|хозяин|owner/i.test(ownerBlock);

    if (hasAgency && !hasOwner) {
      isOwner = false;
    } else if (hasOwner && !hasAgency) {
      isOwner = true;
    }
  }

  const images: string[] = [];
  const imgMatches = extractAll(
    /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/gi,
    html,
  );
  for (const url of imgMatches) {
    if (!images.includes(url)) images.push(url);
  }

  const createdAt =
    extractFirst(
      /"created_at":\s*"([^"]+)"/,
      html,
    )
      ?? extractFirst(
        /Опубликовано:\s*<\/span>\s*<span[^>]*>([^<]+)<\/span>/i,
        html,
      )
      ?? null;

  return {
    id,
    url: `${BASE_URL}${urlPath}`,
    title,
    price,
    rooms,
    city,
    isOwner,
    createdAt,
    phone,
    images,
    description: desc,
  };
}

/* ================= ФИЛЬТРАЦИЯ ================= */

function isCityOk(ad: Ad): boolean {
  if (!ad.city) return false;
  const c = ad.city.toLowerCase();
  return (
    c.includes("бишкек") || c.includes("bishkek") ||
    c.includes("бiшкек")
  );
}

function isPriceOk(ad: Ad): boolean {
  if (ad.price == null) return false;
  return ad.price <= MAX_PRICE;
}

function isRoomsOk(ad: Ad): boolean {
  if (ad.rooms == null) return false;
  return ALLOWED_ROOMS.has(ad.rooms);
}

// Оставляем, но не используем — фильтр по собственнику и телефону отключён
function isOwnerOk(_ad: Ad): boolean {
  return true;
}

function isPhoneOk(_ad: Ad): boolean {
  return true;
}

function isAdOk(ad: Ad): boolean {
  if (!isCityOk(ad)) return false;
  if (!isPriceOk(ad)) return false;
  if (!isRoomsOk(ad)) return false;
  // Фильтры по owner/phone отключены для увеличения числа объявлений
  return true;
}

/* ================= KV ОБЁРТКИ ================= */

async function hasSeen(id: string): Promise<boolean> {
  if (!kv) return false;
  const res = await kv.get(["seen_v3", id]);
  return Boolean(res.value);
}

async function markSeen(id: string): Promise<void> {
  if (!kv) return;
  await kv.set(["seen_v3", id], true);
}

/* ================= TELEGRAM ================= */

async function tgSend(method: string, payload: unknown): Promise<Response> {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    console.error("Telegram error", resp.status, await resp.text());
  }

  return resp;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendAd(ad: Ad): Promise<boolean> {
  const title = escapeHtml(ad.title ?? "");
  const price = ad.price != null
    ? `${ad.price.toLocaleString("ru-RU")} KGS`
    : "—";
  const rooms = ad.rooms != null ? `${ad.rooms} комн.` : "—";
  const city = ad.city ?? "—";
  const phone = ad.phone ?? "—";
  const created = ad.createdAt ?? "—";
  const desc = ad.description ? escapeHtml(ad.description) : "";

  const caption = [
    `<b>${title}</b>`,
    ``,
    `<b>Цена:</b> ${price}`,
    `<b>Комнат:</b> ${rooms}`,
    `<b>Город:</b> ${escapeHtml(city)}`,
    `<b>Телефон:</b> ${escapeHtml(phone)}`,
    `<b>Опубликовано:</b> ${escapeHtml(created)}`,
    ``,
    desc ? `<b>Описание:</b>\n${desc}` : "",
    ``,
    `<a href="${escapeHtml(ad.url)}">Открыть объявление</a>`,
  ].filter(Boolean).join("\n");

  if (!ad.images.length) {
    const res = await tgSend("sendMessage", {
      chat_id: CHAT_ID,
      text: caption,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    });

    return res.ok;
  }

  if (ad.images.length === 1) {
    const res = await tgSend("sendPhoto", {
      chat_id: CHAT_ID,
      photo: ad.images[0],
      caption,
      parse_mode: "HTML",
    });
    return res.ok;
  }

  const media = ad.images.map((url, idx) => {
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

  const res = await tgSend("sendMediaGroup", {
    chat_id: CHAT_ID,
    media,
  });

  return res.ok;
}

/* ================= ОСНОВНОЙ ПРОГОН ================= */

async function fetchAds(): Promise<Ad[]> {
  const ads: Ad[] = [];
  const visited = new Set<string>();

  for (let page = 1; page <= PAGES; page++) {
    const html = await fetchPage(page);
    if (!html) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    const links = parseList(html);
    console.log(`Page ${page}: found ${links.length} links`);

    for (const path of links) {
      if (ads.length >= ADS_LIMIT) {
        console.log("ADS_LIMIT reached, stop collecting");
        return ads;
      }
      if (visited.has(path)) continue;
      visited.add(path);

      const adHtml = await fetchAd(path);
      if (!adHtml) {
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }

      const ad = parseAd(adHtml, path);
      if (!ad) {
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }

      if (!isAdOk(ad)) {
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }

      ads.push(ad);

      await new Promise((r) => setTimeout(r, 2500));
    }

    await new Promise((r) => setTimeout(r, 5000));
  }

  return ads;
}

async function runOnce() {
  console.log("Run scrape...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("No BOT_TOKEN or CHAT_ID");
    return;
  }

  const ads = await fetchAds();
  console.log(`Total matched ads: ${ads.length}`);

  for (const ad of ads) {
    if (await hasSeen(ad.id)) continue;

    const sent = await sendAd(ad);
    if (sent) {
      await markSeen(ad.id);
    }

    await new Promise((r) => setTimeout(r, 2500));
  }

  console.log("Done");
}

/* ================= ENTRYPOINT ================= */

async function main() {
  await runOnce();
}

// GitHub Actions: env GITHUB_ACTIONS = "true"
const isGithubActions = Deno.env.get("GITHUB_ACTIONS") === "true";

if (isGithubActions) {
  // В GitHub Actions — один прогон и выход
  await main();
  Deno.exit(0);
} else {
  // Режим Deno Deploy / обычный сервер
  if ((Deno as any).cron) {
    (Deno as any).cron("lalafo-scan", "*/30 * * * *", async () => {
      try {
        await runOnce();
      } catch (e) {
        console.error("Cron error", e);
      }
    });
  }

  Deno.serve(async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/run") {
      await runOnce();
      return new Response("ok\n");
    }
    return new Response("alive\n");
  });
}
