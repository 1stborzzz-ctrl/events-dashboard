/**
 * Раз в 8 часов (через GitHub Actions) открывает сайты headless-браузером,
 * вытаскивает мероприятия и записывает их в Google Таблицу.
 * Статические мероприятия (из курируемых файлов) включаются всегда.
 */
const { chromium } = require('playwright');
const { google } = require('googleapis');

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = 'Events';

// ─────────────────────────────────────────────────────────────────────────────
// СТАТИЧЕСКИЕ МЕРОПРИЯТИЯ (из ваших Excel-файлов — всегда в дашборде)
// ─────────────────────────────────────────────────────────────────────────────
const STATIC_EVENTS = [
  // ── Профессиональные (юр. право, рынки капиталов, Private Equity) ──────────
  {
    date: '24-25 сентября 2026',
    title: 'V Казанский международный юридический форум',
    topic: 'Юридические конференции',
    place: 'Казань',
    source: 'Прочие мероприятия',
    link: 'https://kazanlegalforum.org/',
    cost: 'Партнер сессии 150 000 руб.',
  },
  {
    date: '24 сентября 2026',
    title: 'XVIII Российский конгресс Private Equity и XVI Форум венчурных инвесторов',
    topic: 'M&A и сделки',
    place: 'Москва',
    source: 'Прочие мероприятия',
    link: 'https://cbonds-congress.ru/',
    cost: 'Партнер/спикер 280 000 руб.',
  },
  {
    date: '6 октября 2026',
    title: 'Семейное и наследственное право: законодательные изменения и актуальная практика',
    topic: 'Юридические конференции',
    place: 'Москва',
    source: 'Прочие мероприятия',
    link: 'https://event.pravo.ru/',
    cost: 'Делегат 28 000 + НДС',
  },
  {
    date: '10 октября 2026',
    title: 'Корпоративное право 2026',
    topic: 'Корпоративное право',
    place: 'Москва',
    source: 'Прочие мероприятия',
    link: 'https://conflaw.ru/',
    cost: 'Делегат очно 30 000 / онлайн 21 000 руб.',
  },
  {
    date: '15 октября 2026',
    title: 'Корпоративное право и корпоративное управление — 2026',
    topic: 'Корпоративное право',
    place: 'Москва',
    source: 'Прочие мероприятия',
    link: 'https://event.pravo.ru/',
    cost: 'Делегат 35 000 + НДС',
  },
  {
    date: '19 ноября 2026',
    title: 'III Форум «Рынок ценных бумаг»',
    topic: 'Рынки капиталов',
    place: 'Москва',
    source: 'Прочие мероприятия',
    link: 'https://acra-forum.ru/events/303?tab=about',
    cost: '65 000 + НДС при оплате до 02.10',
  },
  // ── Региональные ────────────────────────────────────────────────────────────
  {
    date: '26-28 августа 2026',
    title: 'XX Сибирская венчурная ярмарка',
    topic: 'Рынки капиталов',
    place: 'Новосибирск',
    source: 'Прочие мероприятия',
    link: 'https://sibventurefair.ru/',
    cost: '',
  },
  {
    date: '9-10 сентября 2026',
    title: '«Мой Бизнес Форум 2026»',
    topic: 'Бизнес-форум',
    place: 'Санкт-Петербург',
    source: 'Прочие мероприятия',
    link: 'https://mybusiness.spb.ru/',
    cost: '',
  },
  {
    date: '28 сентября — 3 октября 2026',
    title: 'XII Сибирская Юридическая Неделя (SibLegalWeek)',
    topic: 'Юридические конференции',
    place: 'Новосибирск',
    source: 'Прочие мероприятия',
    link: 'https://www.siblegalweek.ru/',
    cost: 'Партнерский пакет от 100 000 руб.',
  },
  {
    date: '28 октября 2026',
    title: 'IX Форум «Финансовые инструменты для сектора роста. Возможности привлечения финансирования для МСП»',
    topic: 'Рынки капиталов',
    place: 'Нижний Новгород',
    source: 'Прочие мероприятия',
    link: '',
    cost: 'Пакет «Официальный партнер» 150 000 руб.',
  },
  // ── Крупные московские форумы (3-4 квартал 2026) ─────────────────────────
  {
    date: '15 сентября 2026',
    title: 'Capital Markets — форум РБК',
    topic: 'Рынки капиталов',
    place: 'Москва',
    source: 'Крупнейшие форумы Москвы',
    link: 'https://capital.rbc.ru/',
    cost: '',
  },
  {
    date: '17-19 ноября 2026',
    title: 'MOSCOW TRADING WEEK',
    topic: 'Рынки капиталов',
    place: 'Москва',
    source: 'Крупнейшие форумы Москвы',
    link: 'https://tradingweek.ru/',
    cost: '',
  },
  {
    date: '14-16 октября 2026',
    title: 'Российская энергетическая неделя',
    topic: 'Бизнес-форум',
    place: 'Москва',
    source: 'Крупнейшие форумы Москвы',
    link: 'https://rusenergyweek.com/',
    cost: '',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// ДИНАМИЧЕСКИЕ ИСТОЧНИКИ (парсинг 3 раза в сутки)
// ─────────────────────────────────────────────────────────────────────────────
const SOURCES = [
  // ── Юридические ──────────────────────────────────────────────────────────────
  { name: 'Право.ru — Конференции',       url: 'https://event.pravo.ru/',                                          topic: 'Юридические конференции', type: 'generic' },
  { name: 'Форум Право-300',              url: 'https://forum300.pravo.ru/',                                        topic: 'Юридические конференции', type: 'generic' },
  { name: 'Event.law.ru',                 url: 'https://event.law.ru/seminar',                                      topic: 'Юридические конференции', type: 'generic' },
  { name: 'All-Events (Москва, Право)',   url: 'https://all-events.ru/events/calendar/city-is-moskva/theme-is-pravo/', topic: 'Юридические конференции', type: 'generic' },
  { name: 'Statut.ru — мероприятия',     url: 'https://statut.ru/events/',                                         topic: 'Юридические конференции', type: 'generic' },
  { name: 'Zakon.ru — конференции',      url: 'https://zakon.ru/Conference/List',                                   topic: 'Юридические конференции', type: 'generic' },

  // ── Рынки капиталов, M&A, Private Equity ─────────────────────────────────────
  { name: 'Cbonds Congress',              url: 'https://cbonds-congress.ru/events/',                                 topic: 'Рынки капиталов',         type: 'generic' },
  { name: 'АКРА Форум',                  url: 'https://acra-forum.ru/events/',                                      topic: 'Рынки капиталов',         type: 'generic' },
  { name: 'НАУФОР — мероприятия',        url: 'https://www.naufor.ru/tree.asp?n=21097',                            topic: 'Рынок ценных бумаг',      type: 'generic' },
  { name: 'Московская биржа',            url: 'https://www.moex.com/s1194',                                        topic: 'Рынки капиталов',         type: 'generic' },
  { name: 'Preqveca — конференции',      url: 'https://www.preqveca.ru/conferences/',                               topic: 'M&A и сделки',            type: 'generic' },

  // ── Деловые форумы (Коммерсантъ, Ведомости, РБК) ─────────────────────────────
  { name: 'Коммерсантъ — мероприятия',   url: 'https://events.kommersant.ru/events/',                              topic: 'Бизнес-форум',            type: 'generic' },
  { name: 'Ведомости — мероприятия',     url: 'https://events.vedomosti.ru/events/',                               topic: 'Бизнес-форум',            type: 'generic' },
  { name: 'РБК — конференции',           url: 'https://www.rbc.ru/conference/',                                    topic: 'Бизнес-форум',            type: 'generic' },

  // ── Telegram ─────────────────────────────────────────────────────────────────
  { name: 'Aesthetics of Law (Telegram)', url: 'https://t.me/s/aestheticsoflawevents',  topic: 'Юр. мероприятия', type: 'telegram' },
  { name: 'ГК Реестр (Telegram)',         url: 'https://t.me/s/aoreestr',               topic: 'ГК Реестр',       type: 'telegram', company: true },
];

// ─────────────────────────────────────────────────────────────────────────────
// КЛАССИФИКАТОР ТЕМ
// Проходит по названию мероприятия и присваивает точную тематику.
// Порядок важен — первое совпадение побеждает.
// ─────────────────────────────────────────────────────────────────────────────
const TOPIC_RULES = [
  { topic: 'Регистраторы и депозитарии',  re: /регистратор|реестр акционер|депозитари/i },
  { topic: 'Корпоративное право',          re: /корпоративн|корпоратив|акционер|устав|общее собрани/i },
  { topic: 'Рынки капиталов',              re: /рынок капитал|capital market|IPO|SPO|листинг|биржа|эмитент|ценн[ые]+\s+бумаг|облигаци|акци[ия]/i },
  { topic: 'M&A и сделки',                re: /M&A|слияни[ея]|поглощени[ея]|сделк[аи]|due diligence|дью дилидженс|private equity|венчур/i },
  { topic: 'Налоги',                       re: /налог|НДС|НДФЛ|налогообложени|трансфертн|офшор|налоговая/i },
  { topic: 'Банкротство',                  re: /банкротств|несостоятельност|реструктуризаци|субсидиарн/i },
  { topic: 'Комплаенс и регулирование',    re: /комплаенс|compliance|регулятор|раскрытие информаци|инсайд|антимонопол|ФАС|ЦБ РФ|Банк России/i },
  { topic: 'Интеллектуальная собственность', re: /интеллектуальн|товарный знак|патент|авторск|ИС\b/i },
  { topic: 'Трудовое право',               re: /трудов[ое]+\s+(право|спор|договор)|кадр[овые]+|персонал|HR\b|увольнени/i },
  { topic: 'Недвижимость',                 re: /недвижимост|девелопмент|строительств|земельн|аренд/i },
  { topic: 'Инвестиции',                   re: /инвестиц|инвестор|венчурн|фонд[ы]+\s+(инвест|прям)/i },
  { topic: 'Финансы и банки',              re: /банк[иов]|финансов|кредит|МФО|лизинг|факторинг|платёжн|страхован/i },
  { topic: 'Цифровая экономика',           re: /цифров|искусственный интеллект|ИИ\b|IT\b|блокчейн|криптовалют|финтех|технологи/i },
  { topic: 'Арбитраж и споры',             re: /арбитраж|судебн|спор[ы]|третейск|медиаци|иск/i },
];

function classifyTopic(title, defaultTopic) {
  for (const rule of TOPIC_RULES) {
    if (rule.re.test(title)) return rule.topic;
  }
  return defaultTopic;
}


const DATE_RE = /(?<![:\d])([0-3]?\d)(\s*[-–]\s*[0-3]?\d)?\s{0,3}(январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)[а-я]*(\s?\d{4})?/i;
const JUNK_RE = /(контакт|ваканси|cookie|перепечат|конфиденциальн|^политик|реклам|вконтакте|vk\.com|t\.me\/(?!s\/)|tel:|mailto:|\+7\s?\(|свидетельств|фс\s?77|войти|личный кабинет)/i;

async function genericParse(page) {
  return await page.evaluate(({ dateRegexSrc, junkRegexSrc }) => {
    const dateRe = new RegExp(dateRegexSrc, 'i');
    const junkRe = new RegExp(junkRegexSrc, 'i');
    const CARD_SELECTOR = 'article, li, [class*="card" i], [class*="event" i], [class*="item" i], [class*="conf" i]';

    const cards = Array.from(document.querySelectorAll(CARD_SELECTOR));

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
      const headingEl = card.querySelector('h1,h2,h3,h4,[class*="title" i],[class*="name" i]');
      let title = (headingEl ? headingEl.innerText : link.innerText || '').trim().replace(/\s+/g, ' ');
      if (!title || title.length < 12 || title.length > 200) continue;
      if (junkRe.test(title)) continue;
      if (/^\d/.test(title) && title.length < 25) continue;
      candidates.push({ text, title, date: dateMatch[0].replace(/\s+/g, ' ').trim(), href });
    }

    // Убираем контейнеры-обёртки — оставляем самый компактный вариант с одинаковым текстом
    candidates.sort((a, b) => a.text.length - b.text.length);
    const kept = [];
    for (const c of candidates) {
      if (kept.some(k => k !== c && c.text.includes(k.text) && c.text.length > k.text.length)) continue;
      kept.push(c);
    }

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
  }, { dateRegexSrc: DATE_RE.source, junkRegexSrc: JUNK_RE.source });
}

async function telegramParse(page, isCompany) {
  // Скроллим вверх несколько раз чтобы подгрузить посты за ~3 месяца назад
  // (анонсы мероприятий публикуются заранее)
  for (var i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1200);
  }

  return await page.evaluate(({ dateRegexSrc, isCompany }) => {
    const dateRe = new RegExp(dateRegexSrc, 'i');
    const out = [];
    const posts = Array.from(document.querySelectorAll('.tgme_widget_message'));
    for (const post of posts) {
      const textEl = post.querySelector('.tgme_widget_message_text');
      const timeEl = post.querySelector('.tgme_widget_message_date time');
      const postLinkEl = post.querySelector('.tgme_widget_message_date');
      if (!textEl || !timeEl || !postLinkEl) continue;
      const text = textEl.innerText.trim().replace(/\s+/g, ' ');
      if (text.length < 15) continue;
      // Для корпоративного канала (@aoreestr) — только посты про реальные мероприятия
      const EVENT_KEYWORDS = /вебинар|семинар|конференц|форум|мероприяти|круглый стол|воркшоп|митап/i;
      if (isCompany && !EVENT_KEYWORDS.test(text)) continue;
      const linksInText = Array.from(textEl.querySelectorAll('a[href]'));
      const externalLink = linksInText.find(a => !/t\.me|telegram\.me|telegram\.org/i.test(a.href));
      const link = externalLink ? externalLink.href : postLinkEl.href;
      const dateInText = text.match(dateRe);
      const date = dateInText
        ? dateInText[0].replace(/\s+/g, ' ').trim()
        : new Date(timeEl.getAttribute('datetime')).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
      out.push({ title: text.slice(0, 180), date, link });
    }
    return out.slice(-25);
  }, { dateRegexSrc: DATE_RE.source, isCompany: !!source.company });
}



async function scrapeSource(browser, source) {
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (compatible; EventsBot/1.0)' });
  try {
    await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3500);
    const events = source.type === 'telegram' ? await telegramParse(page, !!source.company) : await genericParse(page);
    return events.map(e => ({
      ...e,
      place: '',
      source: source.name,
      topic: classifyTopic(e.title, source.topic),
      cost: '',
      company: source.company ? 'aoreestr' : '',
    }));
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

  const header = [['Дата', 'Название', 'Тематика', 'Город', 'Источник', 'Ссылка', 'Стоимость', 'Компания', 'Обновлено']];
  const updatedAt = new Date().toLocaleString('ru-RU');
  const values = rows.map(r => [r.date, r.title, r.topic, r.place || '', r.source, r.link || '', r.cost || '', r.company || '', updatedAt]);

  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:I` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [...header, ...values] },
  });
}

(async () => {
  // 1. Статические мероприятия + уточняем тему
  let all = STATIC_EVENTS.map(e => ({ ...e, topic: classifyTopic(e.title, e.topic) }));
  console.log(`Статических мероприятий: ${all.length}`);

  // 2. Динамический парсинг сайтов
  const browser = await chromium.launch();

  for (const source of SOURCES) {
    const events = await scrapeSource(browser, source);
    console.log(`${source.name}: найдено ${events.length} мероприятий`);
    all = all.concat(events);
  }
  await browser.close();

  // 3. Глобальная дедупликация по заголовку (на случай, если статика
  //    пересекается с тем, что нашёл парсер)
  const seenTitles = new Set();
  all = all.filter(e => {
    const key = e.title.trim().toLowerCase();
    if (seenTitles.has(key)) return false;
    seenTitles.add(key);
    return true;
  });

  await writeToSheet(all);
  console.log(`Готово. Всего записано: ${all.length} строк.`);
})();
