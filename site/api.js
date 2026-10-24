// api.js — живые источники данных: Википедия + Викисловарь (бесплатные, без ключей).
// Слова подгружаются из API в реальном времени, поэтому их количество не ограничено локальным файлом.

const Api = (() => {
  const WIKI_REST = "https://ru.wikipedia.org/api/rest_v1";
  const WIKI_API = "https://ru.wikipedia.org/w/api.php";
  const DICT_API = "https://ru.wiktionary.org/w/api.php";

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

  return { buildCard, wiktRandomBatch, wiktDefinitions, randomWikiTitle, classify };
})();
