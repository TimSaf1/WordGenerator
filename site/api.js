// api.js — живые источники данных (все бесплатные, без ключей):
//   1)  Википедия (ru) — статьи по сферам жизни: описание, картинка, связанные темы
//   2)  Викисловарь (ru) — случайная лексика с определениями
//   3)  English Wiktionary — английские слова + определения (batch-запросы)
//   4)  Wikiquote (ru) — крылатые выражения и цитаты
//   5)  Simple English Wikipedia — простые определения на английском
//   6)  Datamuse — похожие / тематически связанные английские слова
//   7)  Free Dictionary API — определения, произношение, примеры
//   8)  WikiNews (ru) — случайные новости-выражения по темам
//   9)  Wikidata — случайные элементы с русскими метками и описаниями
//   10) Wikimedia Commons — поиск реальных тематических картинок
// Слова подгружаются из API в реальном времени, поэтому их количество
// не ограничено локальным файлом. Все запросы выполняются ПАРАЛЛЕЛЬНО
// (см. app.js: pool + settle-цикл), поэтому страница загружается быстро.

const Api = (() => {
  const WIKI_REST = "https://ru.wikipedia.org/api/rest_v1";
  const WIKI_API = "https://ru.wikipedia.org/w/api.php";
  const DICT_API = "https://ru.wiktionary.org/w/api.php";
  const ENWIKT_API = "https://en.wiktionary.org/w/api.php";
  const QUOTE_API = "https://ru.wikiquote.org/w/api.php";
  const SIMPLE_API = "https://simple.wikipedia.org/w/api.php";
  const NEWS_API = "https://ru.wikinews.org/w/api.php";
  const WDATA_API = "https://www.wikidata.org/w/api.php";
  const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

  // Таймаут любого сетевого запроса — 6 секунд: зависший источник
  // не блокирует генерацию, карточка придёт из другого источника.
  async function getJson(url, timeoutMs = 6000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { "User-Agent": "WordExpressionGenerator/1.0 (educational demo)" },
      });
      if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Защита от «мягких» отказов API (лимиты, HTML-ошибки вместо JSON):
  // источник помечается недоступным на 2 минуты и в этой сессии не дёргается.
  const cooldowns = new Map();
  async function guarded(name, fn, minResult = 1) {
    if ((cooldowns.get(name) || 0) > Date.now()) throw new Error(name + " on cooldown");
    let r;
    try {
      r = await fn();
    } catch (e) {
      if (/abort|not valid JSON|Unexpected token|Failed to fetch/i.test(String(e?.message))) {
        cooldowns.set(name, Date.now() + 120000);
      }
      throw e;
    }
    const size = Array.isArray(r) ? r.length : (r && Object.keys(r).length);
    if (size < minResult) { cooldowns.set(name, Date.now() + 120000); throw new Error(name + " empty"); }
    return r;
  }

  // --- Википедия: случайная статья по теме (сфера жизни) ---
  // 1) категория «Тема» → list=categorymembers; 2) поиск по интитулу/тексту.
  async function randomWikiTitle(topic) {
    let d;
    try {
      d = await getJson(`${WIKI_API}?action=query&list=categorymembers` +
        `&cmtitle=${encodeURIComponent("Категория:" + topic)}&cmlimit=50&format=json&origin=*`);
      const ms = (d?.query?.categorymembers || [])
        .map(m => m.title)
        .filter(t => t && !t.includes(":") && !/\(/.test(t));
      if (ms.length) return ms[Math.floor(Math.random() * ms.length)];
    } catch (e) { /* fallthrough */ }
    d = await getJson(`${WIKI_API}?action=query&list=search&srsearch=${encodeURIComponent(topic)}` +
      `&srlimit=30&srenablerewrite=1&format=json&origin=*`);
    const sr = (d?.query?.search || []).map(s => s.title).filter(Boolean);
    if (!sr.length) throw new Error("no wiki results for topic: " + topic);
    return sr[Math.floor(Math.random() * Math.min(sr.length, 15))];
  }

  // --- Википедия: краткое описание статьи ---
  async function wikiSummary(title) {
    return getJson(`${WIKI_REST}/page/summary/${encodeURIComponent(title)}`);
  }

  // --- Википедия: картинка (главное изображение статьи) ---
  async function wikiImage(title) {
    const d = await getJson(
      `${WIKI_API}?action=query&prop=pageimages&piprop=thumbnail&pithumbsize=640` +
      `&redirects=1&titles=${encodeURIComponent(title)}&format=json&origin=*`);
    const pages = d?.query?.pages || {};
    const page = Object.values(pages)[0];
    return page?.thumbnail?.source || null;
  }

  // --- Википедия: связанные темы (для блока «похожие слова») ---
  async function wikiRelated(title) {
    const d = await getJson(
      `${WIKI_API}?action=query&prop=links&pllimit=20` +
      `&redirects=1&titles=${encodeURIComponent(title)}&format=json&origin=*`);
    const pages = d?.query?.pages || {};
    const page = Object.values(pages)[0];
    const links = (page?.links || [])
      .map(l => l.title)
      .filter(t => t && !t.includes(":"));
    return links.sort(() => Math.random() - 0.5).slice(0, 6);
  }

  // --- Викисловарь: пачка случайных слов за один запрос (экономит обращения к API) ---
  async function wiktRandomBatch(limit = 20) {
    const d = await guarded("wikt-ru", () => getJson(`${DICT_API}?action=query&list=random&rnnamespace=0` +
      `&rnlimit=${limit}&format=json&origin=*`));
    return (d?.query?.random || [])
      .map(r => r.title)
      .filter(t => t && /[а-яё]{3,}/i.test(t) && !t.includes("/"));
  }

  // --- Викисловарь: определения сразу для пачки слов (batch через titles=) ---
  async function wiktDefinitions(terms) {
    const d = await getJson(
      `${DICT_API}?action=query&prop=extracts&explaintext=1&exsectionformat=plain` +
      `&redirects=1&titles=${encodeURIComponent(terms.join("|"))}&format=json&origin=*`);
    const pages = d?.query?.pages || {};
    const out = {};
    for (const page of Object.values(pages)) {
      const text = page?.extract || "";
      const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
      const skip = /^(Русский|Украинский|Английский|Существительное|Глагол|Прилагательное|Наречие|Местоимение|Предлог|Союз|Единственное|Множественное|Произнесение|Значение|Синонимы|Антонимы|Перевод|Этимология|Фразеологизмы|Общее|Лексическое значение|\d+[.)]?)/i;
      const def = lines.find(l => l.length > 15 && /^[а-яёA-Za-z]/.test(l) && !skip.test(l));
      out[page.title] = def || (lines[0] || "").slice(0, 300);
    }
    return out;
  }

  // --- English Wiktionary: пачка случайных английских слов + определения (batch) ---
  async function enWiktRandomBatch(limit = 20) {
    const d = await guarded("wikt-en", () => getJson(`${ENWIKT_API}?action=query&list=random&rnnamespace=0` +
      `&rnlimit=${limit}&format=json&origin=*`));
    return (d?.query?.random || [])
      .map(r => r.title)
      .filter(t => t && /^[a-zA-Z][a-zA\- ]{2,24}$/.test(t) && !t.includes(":"));
  }

  async function enWiktDefinitions(terms) {
    const d = await getJson(
      `${ENWIKT_API}?action=query&prop=extracts&explaintext=1&exchars=350` +
      `&redirects=1&titles=${encodeURIComponent(terms.join("|"))}&format=json&origin=*`);
    const pages = d?.query?.pages || {};
    const out = {};
    for (const page of Object.values(pages)) {
      if (!page?.extract) continue;
      const lines = page.extract.split("\n").map(s => s.trim()).filter(Boolean);
      const def = lines.find(l => l.length > 20 && /[a-z]/.test(l));
      if (def) out[page.title] = def;
    }
    return out;
  }

  // --- Wikiquote (ru): крылатые выражения / цитаты по теме ---
  async function randomQuote(topic) {
    let titles = [];
    try {
      const d = await getJson(`${QUOTE_API}?action=query&list=search&srsearch=${encodeURIComponent(topic)}` +
        `&srlimit=20&format=json&origin=*`);
      titles = (d?.query?.search || []).map(s => s.title).filter(Boolean);
    } catch (e) { /* ignore */ }
    if (!titles.length) {
      const d = await getJson(`${QUOTE_API}?action=query&list=random&rnnamespace=0&rnlimit=10&format=json&origin=*`);
      titles = (d?.query?.random || []).map(r => r.title).filter(Boolean);
    }
    if (!titles.length) throw new Error("no wikiquote results");
    const title = titles[Math.floor(Math.random() * titles.length)];
    const d2 = await getJson(`${QUOTE_API}?action=query&prop=extracts&explaintext=1&exsectionformat=plain` +
      `&redirects=1&titles=${encodeURIComponent(title)}&format=json&origin=*`);
    const page = Object.values(d2?.query?.pages || {})[0];
    const text = page?.extract || "";
    const quotes = text.split("\n")
      .map(s => s.replace(/\[\d+\]/g, "").trim())
      .filter(s => s.length >= 30 && s.length <= 220 && (s.includes("—") || s.includes(":") || s.includes("«")));
    if (!quotes.length) throw new Error("empty quote extract");
    const q = quotes[Math.floor(Math.random() * quotes.length)];
    return { title, quote: q };
  }

  // --- Simple English Wikipedia: случайная статья с простым определением ---
  async function simpleWikiCard() {
    const d = await guarded("simplewiki", () => getJson(`${SIMPLE_API}?action=query&list=random&rnnamespace=0&rnlimit=8&format=json&origin=*`));
    const titles = (d?.query?.random || []).map(r => r.title).filter(t => t && !t.includes(":"));
    if (!titles.length) throw new Error("no simple wiki pages");
    const title = titles[Math.floor(Math.random() * titles.length)];
    const d2 = await getJson(`${SIMPLE_API}?action=query&prop=extracts&explaintext=1&exintro=1&redirects=1` +
      `&titles=${encodeURIComponent(title)}&format=json&origin=*`);
    const page = Object.values(d2?.query?.pages || {})[0];
    const extract = (page?.extract || "").trim();
    if (extract.length < 40) throw new Error("short simple extract");
    return {
      title,
      extract: extract.slice(0, 400),
      url: "https://simple.wikipedia.org/wiki/" + encodeURIComponent(title),
    };
  }

  // --- Datamuse: похожие / тематически связанные слова (для блока «похожие») ---
  async function datamuseRelated(word, max = 6) {
    try {
      const d = await getJson(`https://api.datamuse.com/words?rel_trt=${encodeURIComponent(word)}&max=${max}`);
      const list = Array.isArray(d) ? d.map(x => x.word) : [];
      if (list.length >= 2) return list;
      const d2 = await getJson(`https://api.datamuse.com/words?ml=${encodeURIComponent(word)}&max=${max}`);
      return Array.isArray(d2) ? d2.map(x => x.word) : [];
    } catch (e) {
      return [];
    }
  }

  // --- Free Dictionary API: определения / произношение / примеры ---
  async function freeDictInfo(word) {
    try {
      const d = await guarded("freedict", () => getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`));
      const entry = Array.isArray(d) ? d[0] : null;
      if (!entry) return null;
      const mean = (entry.meanings || [])[0];
      const defObj = mean?.definitions?.[0];
      return {
        definition: defObj?.definition || "",
        partOfSpeech: mean?.partOfSpeech || "",
        example: defObj?.example || "",
        phonetic: entry.phonetic || entry.phonetics?.find(p => p.text)?.text || "",
        audio: entry.phonetics?.find(p => p.audio)?.audio || "",
      };
    } catch (e) {
      return null;
    }
  }

  // --- WikiNews (ru): случайная новость по теме → заголовок как «выражение» ---
  async function randomNews(topic) {
    let d;
    try {
      d = await getJson(`${NEWS_API}?action=query&list=search&srsearch=${encodeURIComponent(topic)}` +
        `&srlimit=20&format=json&origin=*`);
    } catch (e) {
      d = await getJson(`${NEWS_API}?action=query&list=random&rnnamespace=0&rnlimit=10&format=json&origin=*`);
      return pickNewsTitle(d);
    }
    const titles = (d?.query?.search || []).map(s => s.title).filter(t => t && !t.includes("/"));
    if (!titles.length) {
      const d2 = await getJson(`${NEWS_API}?action=query&list=random&rnnamespace=0&rnlimit=10&format=json&origin=*`);
      return pickNewsTitle(d2);
    }
    const title = titles[Math.floor(Math.random() * titles.length)];
    const d3 = await getJson(`${NEWS_API}?action=query&prop=extracts&explaintext=1&exintro=1&redirects=1` +
      `&titles=${encodeURIComponent(title)}&format=json&origin=*`);
    const page = Object.values(d3?.query?.pages || {})[0];
    const extract = (page?.extract || "").trim();
    return {
      title,
      extract: extract.slice(0, 400) || title,
      url: "https://ru.wikinews.org/wiki/" + encodeURIComponent(title),
    };
  }
  function pickNewsTitle(d) {
    const titles = (d?.query?.random || []).map(r => r.title).filter(t => t && !t.includes("/"));
    if (!titles.length) throw new Error("no wikinews pages");
    const title = titles[Math.floor(Math.random() * titles.length)];
    return { title, extract: title, url: "https://ru.wikinews.org/wiki/" + encodeURIComponent(title) };
  }

  // --- Wikidata: случайный элемент с русской меткой и описанием ---
  async function randomWikidataItem() {
    const d = await guarded("wikidata", () => getJson(`${WDATA_API}?action=query&list=random&rnnamespace=0` +
      `&rnlimit=15&format=json&origin=*`));
    const ids = (d?.query?.random || []).map(r => r.id).filter(Boolean);
    if (!ids.length) throw new Error("no wikidata random");
    const d2 = await getJson(`${WDATA_API}?action=wbgetentities&ids=${encodeURIComponent(ids.join("|"))}` +
      `&props=labels|descriptions|sitelinks&languages=ru|en&format=json&origin=*`);
    const items = Object.values(d2?.entities || {});
    const good = items.filter(e => e?.labels?.ru?.value && e?.descriptions?.ru?.value &&
      e.labels.ru.value.length <= 60);
    if (!good.length) throw new Error("no ru wikidata labels");
    const e = good[Math.floor(Math.random() * good.length)];
    const ruTitle = e?.sitelinks?.ruwiki?.title;
    return {
      label: e.labels.ru.value,
      desc: e.descriptions.ru.value,
      infoUrl: ruTitle
        ? "https://ru.wikipedia.org/wiki/" + encodeURIComponent(ruTitle)
        : "https://www.wikidata.org/wiki/" + e.id,
    };
  }

  // --- Wikimedia Commons: реальная тематическая картинка по запросу ---
  async function commonsImage(query) {
    const d = await getJson(`${COMMONS_API}?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}` +
      `&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url|mime&iiurlwidth=640&format=json&origin=*`);
    const pages = Object.values(d?.query?.pages || {});
    const imgs = pages
      .filter(p => /^image\//.test(p?.imageinfo?.[0]?.mime || "") &&
                   !/\.(svg|gif|tif)/i.test(p?.imageinfo?.[0]?.url || ""))
      .map(p => p.imageinfo[0].thumburl || p.imageinfo[0].url);
    if (!imgs.length) throw new Error("no commons images");
    return imgs[Math.floor(Math.random() * Math.min(imgs.length, 3))];
  }

  // --- Классификация: слово / выражение / словосочетание ---
  function classify(term) {
    const words = term.trim().split(/\s+/);
    if (words.length === 1) return "word";
    // два и более слова, где второе — строчная буква (зависимое) → словосочетание
    if (/^[А-ЯЁ][а-яё]+\s+[а-яё]/.test(term)) return "collocation";
    return "phrase";
  }

  // --- Собираем готовую карточку из живых источников (Википедия) ---
  // articleUrl больше НЕ ведёт на Википедию — его подбирает модуль Articles
  // (нормальные статейники: Хабр, N+1, WikiHow, РБК Тренды и т.д.).
  async function buildCard(topic, domainKey) {
    const title = await randomWikiTitle(topic);
    let summary;
    try { summary = await wikiSummary(title); }
    catch (e) { return null; }
    let img = null, related = [];
    const [imgR, relR] = await Promise.allSettled([wikiImage(title), wikiRelated(title)]);
    if (imgR.status === "fulfilled") img = imgR.value;
    if (relR.status === "fulfilled") related = relR.value;
    const url = summary.content_urls?.desktop?.page ||
      "https://ru.wikipedia.org/wiki/" + encodeURIComponent(title);
    const art = Articles.pick(domainKey, title);
    return {
      source: "live",
      type: classify(title),
      term: title,
      desc: summary.extract || "",
      related,
      infoUrl: url,
      articleUrl: art.url,
      articleName: art.name,
      imageUrl: img,
      imgSeed: title,
    };
  }

  // --- Карточка по пользовательской теме (строковый поиск): случайная
  // статья Википедии, подходящая по теме + цитата + новость ---
  async function topicCard(userTopic, domainKey) {
    const title = await randomWikiTitle(userTopic);
    let summary = null;
    try { summary = await wikiSummary(title); } catch (e) { /* fallback ниже */ }
    if (!summary || !summary.extract) {
      // REST summary мог не найтись — возьмём extract через API
      const d = await getJson(`${WIKI_API}?action=query&prop=extracts&explaintext=1&exintro=1` +
        `&redirects=1&titles=${encodeURIComponent(title)}&format=json&origin=*`);
      const page = Object.values(d?.query?.pages || {})[0];
      summary = { extract: (page?.extract || "").slice(0, 400) };
    }
    let img = null, related = [];
    const [imgR, relR] = await Promise.allSettled([wikiImage(title), wikiRelated(title)]);
    if (imgR.status === "fulfilled") img = imgR.value;
    if (relR.status === "fulfilled") related = relR.value;
    const url = "https://ru.wikipedia.org/wiki/" + encodeURIComponent(title);
    const art = Articles.pick(domainKey, title + " " + userTopic);
    return {
      source: "live",
      type: classify(title),
      term: title,
      desc: summary.extract || "",
      related,
      infoUrl: url,
      articleUrl: art.url,
      articleName: art.name,
      imageUrl: img,
      imgSeed: title,
    };
  }

  // --- Случайная страница Википедии (для «Эрудито»: угадай, о чём статья) ---
  async function wikiRandomPage(exclude = []) {
    const d = await getJson(`${WIKI_API}?action=query&list=random` +
      `&rnnamespace=0&rnlimit=${12 + exclude.length}&format=json&origin=*`);
    const ms = (d?.query?.random || [])
      .map(r => r.title)
      .filter(t => t && !t.includes(":") && !exclude.includes(t));
    if (!ms.length) throw new Error("wiki random empty");
    return ms[Math.floor(Math.random() * ms.length)];
  }

  // --- Случайный объект Wikidata с русской подписью (для «Эрудито») ---
  async function wikidataRandomEntity(exclude = []) {
    for (let i = 0; i < 3; i++) {
      const qid = "Q" + (100000 + Math.floor(Math.random() * 9500000));
      if (exclude.includes(qid)) continue;
      try {
        const d = await getJson(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
        const ent = d?.entities?.[qid];
        const label = ent?.labels?.ru?.value;
        const desc = ent?.descriptions?.ru?.value;
        if (!label || !desc) continue;
        if (/^Q\d+$/.test(label)) continue; // недозаполненные элементы
        let img = null;
        try { img = await commonsImage(label); } catch (e) { /* без картинки тоже ок */ }
        return { qid, label, desc, sitelink: ent?.sitelinks?.ruwiki ? "https://ru.wikipedia.org/wiki/" + encodeURIComponent(ent.sitelinks.ruwiki.title) : null, claims: ent?.claims || {}, imageUrl: img };
      } catch (e) { /* следующий id */ }
    }
    throw new Error("wikidata random failed");
  }

  // ===== Официальные словарные источники для игры «Переводы» =====
  // Слова берутся из Викисловаря (ru/en), упрощённой Википедии (Simple English —
  // базовая лексика, уровень A1–A2) и тематических категорий уровня
  // («Категория:Русские существительные» и т.п.). Перевод тянется из
  // межъязыковых ссылок (langlinks) + поля перевода статьи ru.wikt.

  // Пачка случайных слов из категории указанного языка (официальный корпус)
  async function wiktCategoryWords(langCode, limit = 20) {
    const catMap = {
      ru: ["Категория:Русские существительные", "Категория:Русские глаголы", "Категория:Русские прилагательные"],
      en: ["Category:English nouns", "Category:English verbs", "Category:English adjectives"],
      de: ["Category:German nouns", "Category:German verbs"],
      fr: ["Category:French nouns", "Category:French verbs"],
      es: ["Category:Spanish nouns", "Category:Spanish verbs"],
    };
    const cats = catMap[langCode] || catMap.ru;
    const cat = cats[Math.floor(Math.random() * cats.length)];
    const api = langCode === "ru" ? DICT_API : ENWIKT_API;
    const d = await guarded("wikt-cat-" + langCode, () => getJson(
      `${api}?action=query&list=categorymembers&cmtitle=${encodeURIComponent(cat)}` +
      `&cmtype=page&cmlimit=${limit}&format=json&origin=*`), 3);
    const words = (d?.query?.categorymembers || [])
      .map(m => m.title)
      .filter(t => t && /^[А-Яа-яЁёA-Za-z][А-Яа-яЁёa-z\- ]{2,20}$/i.test(t) && !t.includes(":"));
    if (!words.length) throw new Error("empty category");
    return words.sort(() => Math.random() - 0.5);
  }

  // Базовые слова уровня A1–A2: Simple English Wikipedia (упрощённый словарь)
  async function basicLevelWords(limit = 12) {
    const d = await guarded("simplewiki-basic", () => getJson(
      `${SIMPLE_API}?action=query&list=random&rnnamespace=0&rnlimit=${limit}&format=json&origin=*`));
    const titles = (d?.query?.random || []).map(r => r.title)
      .filter(t => t && /^[a-z][a-z\s-]{2,25}$/i.test(t) && !t.includes("("));
    if (!titles.length) throw new Error("no basic words");
    return titles;
  }

  // Уровень слова по частотным признакам (эвристика по официальной базе):
  // короткие общеупотребительные слова из Simple wiki → elementary,
  // термины из категорий → intermediate/advanced
  function estimateLevel(word, source) {
    if (source === "basic") return "elementary";
    const w = word.toLowerCase();
    const common = /^(дом|вода|хлеб|день|нод|мать|отец|глаз|рука|город|друг|книга|время|человек|house|water|bread|day|mother|father|eye|hand|city|book|time)$/;
    if (common.test(w)) return "elementary";
    if (word.length > 9 || /[а-яё]аци|ость|ество|tion|ment|ness$/i.test(w)) return "advanced";
    return "intermediate";
  }

  // Определение из Free Dictionary API (официальный Merriam-Webster consortium)
  async function freeDictDefinition(word) {
    try {
      const d = await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`, 5000);
      const meaning = Array.isArray(d) ? d[0]?.meanings?.[0] : null;
      const def = meaning?.definitions?.[0]?.definition || "";
      const pos = meaning?.partOfSpeech || "";
      return def ? { def, pos } : null;
    } catch (e) { return null; }
  }

  // Пары переводов пачкой: берём N слов категории + их определения одним
  // batch-запросом + langlinks тоже батчем (1 запрос на всю пачку) — быстро.
  async function fetchTranslationBatch(langCode, level) {
    let words;
    const src = level === "elementary" ? "basic" : "category";
    if (src === "basic") {
      words = await basicLevelWords(12);
    } else {
      words = await wiktCategoryWords(langCode === "ru" ? "ru" : langCode, 24);
    }
    if (level === "advanced") words = words.filter(w => w.length > 7).concat(words);
    if (level === "elementary") words = words.filter(w => w.length <= 9).concat(words);
    if (!words.length) throw new Error("no words for level");

    const pairs = [];
    // batch определений
    let defs = {};
    try { defs = await wiktDefinitions(words.slice(0, 10)); } catch (e) { /* ок без defs */ }
    // batch langlinks (до 10 заголовков за один запрос)
    let llMap = {};
    try {
      const api = langCode === "ru" ? DICT_API : ENWIKT_API;
      const targetLang = langCode === "ru" ? "en" : "ru";
      const d = await getJson(`${api}?action=query&prop=langlinks&lllang=${targetLang}&lllimit=1` +
        `&redirects=1&titles=${encodeURIComponent(words.slice(0, 10).join("|"))}&format=json&origin=*`);
      for (const page of Object.values(d?.query?.pages || {})) {
        if (page?.langlinks?.[0]?.title) llMap[page.title] = page.langlinks[0].title;
      }
    } catch (e) { /* нет переводов — частично доберём ниже */ }

    for (const w of words.slice(0, 10)) {
      const tr = llMap[w];
      const def = defs[w] || "";
      if (!tr) continue;
      if (!/^[А-Яа-яЁёA-Za-z][А-Яа-яЁёA-Za-z\s'’-]{1,40}$/.test(tr)) continue;
      pairs.push({
        ru: langCode === "ru" ? w : tr,
        en: langCode === "ru" ? tr : w,
        def: def || "",
        level: estimateLevel(w, src),
        source: src === "basic" ? "Simple English Wiki (базовый словарь)" : "Викисловарь (категории языка)",
      });
    }
    if (!pairs.length) throw new Error("batch produced no pairs");
    return pairs;
  }

  // --- Перевод слова через Wiktionary interlang links (для игры «Переводы») ---
  // Возвращает { ru, en } — русское слово и его английский перевод.
  async function pickTranslationPair() {
    const terms = await wiktRandomBatch(20);
    const defs = await guarded("wikt-defs", () => wiktDefinitions(terms.slice(0, 8)));
    for (const term of terms) {
      const def = defs[term] || "";
      if (!def || def.length < 15) continue;
      try {
        const d = await getJson(`${DICT_API}?action=query&prop=langlinks&lllimit=1&lllang=en` +
          `&redirects=1&titles=${encodeURIComponent(term)}&format=json&origin=*`);
        const page = Object.values(d?.query?.pages || {})[0];
        const en = page?.langlinks?.[0]?.title;
        if (en && /^[a-zA-Z][a-zA-Z\s'-]{1,40}$/.test(en) && !/[а-яё]/i.test(term)) {
          return { ru: term, en, def };
        }
      } catch (e) { /* следующее слово */ }
    }
    throw new Error("no translation pair found");
  }

  return {
    buildCard, topicCard, wiktRandomBatch, wiktDefinitions, randomWikiTitle, classify,
    enWiktRandomBatch, enWiktDefinitions, randomQuote, simpleWikiCard,
    datamuseRelated, freeDictInfo, randomNews, randomWikidataItem, commonsImage,
    wikiRandomPage, wikidataRandomEntity, pickTranslationPair,
    wiktCategoryWords, basicLevelWords, fetchTranslationBatch, freeDictDefinition,
  };
})();
