// api.js — живые источники данных (все бесплатные, без ключей):
//   1) Википедия (ru) — статьи по сферам жизни: описание, картинка, связанные темы
//   2) Викисловарь (ru) — случайная лексика с определениями
//   3) English Wiktionary — английские слова + определения (batch-запросы)
//   4) Wikiquote (ru) — крылатые выражения и цитаты
//   5) Simple English Wikipedia — простые определения на английском
//   6) Datamuse — похожие / тематически связанные английские слова
//   7) Free Dictionary API — определения, произношение, примеры
// Слова подгружаются из API в реальном времени, поэтому их количество
// не ограничено локальным файлом.

const Api = (() => {
  const WIKI_REST = "https://ru.wikipedia.org/api/rest_v1";
  const WIKI_API = "https://ru.wikipedia.org/w/api.php";
  const DICT_API = "https://ru.wiktionary.org/w/api.php";
  const ENWIKT_API = "https://en.wiktionary.org/w/api.php";
  const QUOTE_API = "https://ru.wikiquote.org/w/api.php";
  const SIMPLE_API = "https://simple.wikipedia.org/w/api.php";

  async function getJson(url) {
    const res = await fetch(url, {
      headers: { "User-Agent": "WordExpressionGenerator/1.0 (educational demo)" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
    return res.json();
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
    const d = await getJson(`${DICT_API}?action=query&list=random&rnnamespace=0` +
      `&rnlimit=${limit}&format=json&origin=*`);
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
    const d = await getJson(`${ENWIKT_API}?action=query&list=random&rnnamespace=0` +
      `&rnlimit=${limit}&format=json&origin=*`);
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
    const d = await getJson(`${SIMPLE_API}?action=query&list=random&rnnamespace=0&rnlimit=8&format=json&origin=*`);
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
      const d = await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
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

  // --- Классификация: слово / выражение / словосочетание ---
  function classify(term) {
    const words = term.trim().split(/\s+/);
    if (words.length === 1) return "word";
    // два и более слова, где второе — строчная буква (зависимое) → словосочетание
    if (/^[А-ЯЁ][а-яё]+\s+[а-яё]/.test(term)) return "collocation";
    return "phrase";
  }

  // --- Собираем готовую карточку из живых источников (Википедия) ---
  async function buildCard(topic) {
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
    return {
      source: "live",
      type: classify(title),
      term: title,
      desc: summary.extract || "",
      related,
      infoUrl: url,
      articleUrl: url,
      imageUrl: img,
    };
  }

  return {
    buildCard, wiktRandomBatch, wiktDefinitions, randomWikiTitle, classify,
    enWiktRandomBatch, enWiktDefinitions, randomQuote, simpleWikiCard,
    datamuseRelated, freeDictInfo,
  };
})();
