/**
 * Раз в сутки (через GitHub Actions) открывает сайты headless-браузером,
 * вытаскивает мероприятия и записывает их в Google Таблицу.
 *
 * ВАЖНО: сайты вроде event.pravo.ru рендерят список через JS (React/SPA),
 * поэтому простым fetch/HTML-парсингом их не взять — нужен реальный браузер.
 * Playwright = headless Chrome, поэтому это работает.
 *
 * Селекторы ниже — широкие, эвристические (ищем блоки, где рядом есть
 * дата + заголовок + ссылка). Если на каком-то сайте верстка нестандартная,
 * для него можно прописать отдельную функцию-парсер (см. SOURCES).
 */
const { chromium } = require('playwright');
const { google } = require('googleapis');

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = 'Events';

// Список источников. Каждый — либо обычная страница (generic-парсер),
// либо кастомная функция parse(page) -> [{title, date, place, link}]
const SOURCES = [
  { name: 'Право.ru — Конференции', url: 'https://event.pravo.ru/', topic: 'Юридические конференции' },
  { name: 'Форум Право-300', url: 'https://forum300.pravo.ru/', topic: 'Юридический форум' },
  { name: 'Event.law.ru', url: 'https://event.law.ru/', topic: 'Вебинары для юристов' },
  { name: 'All-Events (тема Право)', url: 'https://all-events.ru/events/calendar/theme-is-pravo/', topic: 'Юр. мероприятия' },
  { name: 'Московская биржа — мероприятия', url: 'https://www.moex.com/s1194', topic: 'Рынки капиталов' },
  { name: 'НАУФОР — мероприятия', url: 'https://www.naufor.ru/tree.asp?n=21097', topic: 'Рынок ценных бумаг' },
];

const DATE_RE = /(\d{1,2}\s?[-–]?\s?\d{0,2}\s?(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-я]*\s?\d{0,4})/i;

// Слова-маркеры мусора: если ссылка или её текст содержит что-то из этого —
// почти наверняка не карточка мероприятия, а навигация/футер/контакты.
const JUNK_RE = /(контакт|ваканси|cookie|перепечат|конфиденциальн|политик|реклам|подпис|telegram|вконтакте|vk\.com|t\.me|tel:|mailto:|\+7\s?\(|свидетельств|фс\s?77)/i;

async function genericParse(page) {
  return await page.evaluate((dateRegexSrc, junkRegexSrc) => {
    const dateRe = new RegExp(dateRegexSrc, 'i');
    const junkRe = new RegExp(junkRegexSrc, 'i');
    // Карточкой считаем только элемент, у которого явно "карточный" класс/тег —
    // обычный <div> или весь документ не годится, иначе ловим футер целиком.
    const CARD_SELECTOR = 'article, li, [class*="card" i], [class*="event" i], [class*="item" i], [class*="conf" i]';

    const seen = new Set();
    const out = [];
    const cards = Array.from(document.querySelectorAll(CARD_SELECTOR));

    for (const card of cards) {
      // Пропускаем гигантские контейнеры (типа целого футера или сайдбара
      // со списком всех страниц) — у реальной карточки мероприятия текст компактный.
      const text = (card.innerText || '').trim();
      if (!text || text.length > 600) continue;

      const dateMatch = text.match(dateRe);
      if (!dateMatch) continue;

      const link = card.querySelector('a[href]');
      if (!link) continue;
      const href = link.href;
      if (junkRe.test(href) || junkRe.test(text)) continue;
      if (seen.has(href)) continue;

      // Заголовок — либо текст самой ссылки, либо текст заголовка внутри карточки
      const headingEl = card.querySelector('h1, h2, h3, h4, [class*="title" i], [class*="name" i]');
      let title = (headingEl ? headingEl.innerText : link.innerText || '').trim();
      if (!title || title.length < 10 || title.length > 200) continue;
      if (junkRe.test(title)) continue;
      if (seen.has(title)) continue;

      seen.add(href);
      seen.add(title);
      out.push({ title, date: dateMatch[0].trim(), link: href });
      if (out.length >= 30) break;
    }
    return out;
  }, DATE_RE.source, JUNK_RE.source);
}

async function scrapeSource(browser, source) {
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (compatible; EventsBot/1.0)' });
  try {
    await page.goto(source.url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2000); // дать SPA дорендериться
    const events = await genericParse(page);
    return events.map(e => ({ ...e, source: source.name, topic: source.topic }));
  } catch (err) {
    console.error(`Ошибка при обработке ${source.url}:`, err.message);
    return [];
  } finally {
    await page.close();
  }
}

async function writeToSheet(rows) {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const header = [['Дата мероприятия', 'Название', 'Тематика', 'Источник', 'Ссылка', 'Обновлено']];
  const updatedAt = new Date().toLocaleString('ru-RU');
  const values = rows.map(r => [r.date, r.title, r.topic, r.source, r.link, updatedAt]);

  // Полностью перезаписываем лист — проще, чем дедуплицировать построчно
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:F` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [...header, ...values] },
  });
}

(async () => {
  const browser = await chromium.launch();
  let all = [];
  for (const source of SOURCES) {
    const events = await scrapeSource(browser, source);
    console.log(`${source.name}: найдено ${events.length} мероприятий`);
    all = all.concat(events);
  }
  await browser.close();

  if (all.length === 0) {
    console.log('Ничего не найдено — лист не трогаем (чтобы не затирать старые данные ошибочно).');
    return;
  }
  await writeToSheet(all);
  console.log(`Готово. Всего записано: ${all.length} строк.`);
})();
