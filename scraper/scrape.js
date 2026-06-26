/**
 * Раз в сутки (через GitHub Actions) открывает сайты headless-браузером,
 * вытаскивает мероприятия и записывает их в Google Таблицу.
 *
 * Селекторы — эвристические (ищем компактные карточные блоки с датой внутри
 * + ссылкой). Жёсткие правила ниже специально отбраковывают: навигацию,
 * футер, контакты, "вложенные" дубли одной и той же карточки, и мусорные
 * "даты" вида "00 21 октября" (когда регулярка случайно склеила время и дату
 * из разных мест текста).
 */
const { chromium } = require('playwright');
const { google } = require('googleapis');

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = 'Events';

// type: 'generic' — обычный сайт (эвристика по карточкам).
// type: 'telegram' — публичный веб-просмотр канала t.me/s/<name> (стабильная вёрстка).
const SOURCES = [
  { name: 'Право.ru — Конференции', url: 'https://event.pravo.ru/', topic: 'Юридические конференции', type: 'generic' },
  { name: 'Форум Право-300', url: 'https://forum300.pravo.ru/', topic: 'Юридический форум', type: 'generic' },
  { name: 'Event.law.ru', url: 'https://event.law.ru/seminar', topic: 'Вебинары для юристов', type: 'generic' },
  { name: 'All-Events (Москва, тема Право)', url: 'https://all-events.ru/events/calendar/city-is-moskva/theme-is-pravo/', topic: 'Юр. мероприятия', type: 'generic' },
  { name: 'Statut.ru — мероприятия', url: 'https://statut.ru/events/', topic: 'Юридические конференции', type: 'generic' },
  { name: 'Zakon.ru — конференции', url: 'https://zakon.ru/Conference/List', topic: 'Юридические конференции', type: 'generic' },
  { name: 'Московская биржа — мероприятия', url: 'https://www.moex.com/s1194', topic: 'Рынки капиталов', type: 'generic' },
  { name: 'НАУФОР — мероприятия', url: 'https://www.naufor.ru/tree.asp?n=21097', topic: 'Рынок ценных бумаг', type: 'generic' },
  { name: 'Aesthetics of Law (Telegram)', url: 'https://t.me/s/aestheticsoflawevents', topic: 'Юр. мероприятия', type: 'telegram' },
];

// День (1-31), не приклеенный слева к ":" (чтобы не цеплять "10:00"),
// сразу за которым (не дальше 5 символов) идёт название месяца.
const DATE_RE = /(?<![:\d])([0-3]?\d)(\s*[-–]\s*[0-3]?\d)?\s{0,3}(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-я]*(\s?\d{4})?/i;

const JUNK_RE = /(контакт|ваканси|cookie|перепечат|конфиденциальн|^политик|реклам|подпис|вконтакте|vk\.com|t\.me\/(?!s\/)|tel:|mailto:|\+7\s?\(|свидетельств|фс\s?77|войти|регистраци[яи]\s*$|личный кабинет)/i;

async function genericParse(page) {
  return await page.evaluate((dateRegexSrc, junkRegexSrc) => {
    const dateRe = new RegExp(dateRegexSrc, 'i');
    const junkRe = new RegExp(junkRegexSrc, 'i');
    const CARD_SELECTOR = 'article, li, [class*="card" i], [class*="event" i], [class*="item" i], [class*="conf" i]';

    const cards = Array.from(document.querySelectorAll(CARD_SELECTOR));

    // Шаг 1: собираем всех кандидатов без отбраковки дублей.
    const candidates = [];
    for (const card of cards) {
      const text = (card.innerText || '').trim();
      if (!text || text.length > 400) continue;

      const dateMatch = text.match(dateRe);
      if (!dateMatch) continue;

      const link = card.querySelector('a[href]') || card.closest('a[href]');
      if (!link) continue;
      const href = link.href;
      if (junkRe.test(href) || junkRe.test(text)) continue;

      const headingEl = card.querySelector('h1, h2, h3, h4, [class*="title" i], [class*="name" i]');
      let title = (headingEl ? headingEl.innerText : link.innerText || '').trim().replace(/\s+/g, ' ');
      if (!title || title.length < 12 || title.length > 200) continue;
      if (junkRe.test(title)) continue;
      if (/^\d/.test(title) && title.length < 25) continue;

      candidates.push({ text, title, date: dateMatch[0].replace(/\s+/g, ' ').trim(), href });
    }

    // Шаг 2: если карточка-контейнер случайно тоже подошла по правилам (её
    // текст просто включает в себя текст другой, более мелкой карточки) —
    // это дубль одного мероприятия. Оставляем самый компактный вариант.
    candidates.sort((a, b) => a.text.length - b.text.length);
    const kept = [];
    for (const c of candidates) {
      const isContainerOfExisting = kept.some(k => k !== c && c.text.includes(k.text) && c.text.length > k.text.length);
      if (isContainerOfExisting) continue;
      kept.push(c);
    }

    // Шаг 3: финальная дедупликация по ссылке/заголовку.
    const seenHref = new Set();
    const seenTitle = new Set();
    const out = [];
    for (const c of kept) {
      if (seenHref.has(c.href) || seenTitle.has(c.title)) continue;
      seenHref.add(c.href);
      seenTitle.add(c.title);
      out.push({ title: c.title, date: c.date, link: c.href });
      if (out.length >= 25) break;
    }
    return out;
  }, DATE_RE.source, JUNK_RE.source);
}

async function telegramParse(page) {
  // t.me/s/<channel> — стабильная публичная вёрстка, без JS-рендера.
  return await page.evaluate(() => {
    const out = [];
    const posts = Array.from(document.querySelectorAll('.tgme_widget_message'));
    for (const post of posts) {
      const textEl = post.querySelector('.tgme_widget_message_text');
      const timeEl = post.querySelector('.tgme_widget_message_date time');
      const postLinkEl = post.querySelector('.tgme_widget_message_date');
      if (!textEl || !timeEl || !postLinkEl) continue;
      const text = textEl.innerText.trim().replace(/\s+/g, ' ');
      if (text.length < 15) continue;

      // Ищем в тексте поста первую ссылку на внешний ресурс (не на сам Telegram) —
      // это, как правило, страница регистрации/описания мероприятия.
      const linksInText = Array.from(textEl.querySelectorAll('a[href]'));
      const externalLink = linksInText.find(a => !/t\.me|telegram\.me|telegram\.org/i.test(a.href));
      const link = externalLink ? externalLink.href : postLinkEl.href;

      out.push({
        title: text.slice(0, 180),
        date: new Date(timeEl.getAttribute('datetime')).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }),
        link,
      });
    }
    return out.slice(-25); // последние 25 постов канала
  });
}

async function scrapeSource(browser, source) {
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (compatible; EventsBot/1.0)' });
  try {
    await page.goto(source.url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2000);
    const events = source.type === 'telegram' ? await telegramParse(page) : await genericParse(page);
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
