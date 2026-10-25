// app.js — логика генератора.
// Ключевые принципы скорости:
//  • ВСЕ онлайн-запросы запускаются ПАРАЛЛЕЛЬНО (пул обещаний), а не по одному;
//  • локальные карточки появляются мгновенно, живые доходят по мере готовности;
//  • у каждого сетевого запроса таймаут 6 с (см. api.js) — зависший источник
//    не тормозит выдачу;
//  • пачки слов из Викисловарей кэшируются (30 слов за 1 запрос);
//  • картинки грузятся лениво (loading=lazy) и дозаменяются на реальные из
//    Wikimedia Commons в фоне.

const TYPE_LABELS = { word: "Слово", phrase: "Выражение", collocation: "Словосочетание" };
const usedTerms = new Set(); // для режима «без повторов»

// Живые темы для запросов к API по каждой сфере.
const LIVE_TOPICS = {
  it: ["Программирование", "Информационные технологии", "Интернет", "Искусственный интеллект", "Компьютер"],
  everyday: ["Быт", "Повседневная жизнь", "Дом", "Еда", "Семья"],
  science: ["Наука", "Физика", "Химия", "Биология", "Астрономия"],
  business: ["Экономика", "Бизнес", "Менеджмент", "Маркетинг", "Финансы"],
  medicine: ["Медицина", "Здоровый образ жизни", "Кардиология", "Хирургия", "Психика"],
  culture: ["Искусство", "Музыка", "Литература", "Кино", "Театр"],
  sports: ["Спорт", "Футбол", "Олимпийские игры", "Лёгкая атлетика", "Плавание"],
  travel: ["Туризм", "Путешествия", "Города", "Достопримечательности", "Транспорт"],
};

// Темы для цитат / новостей по сферам.
const QUOTE_TOPICS = {
  it: "программирование компьютер время", everyday: "жизнь человек время дом",
  science: "наука знания учёный физика", business: "бизнес деньги успех рынок",
  medicine: "здоровье врач жизнь", culture: "искусство музыка литература кино",
  sports: "спорт победа чемпион", travel: "путешествия дорога странствие город",
};

// --- Инициализация чекбоксов сфер ---
const domainsBox = document.getElementById("domains");
Object.entries(DOMAINS).forEach(([key, label]) => {
  const lbl = document.createElement("label");
  lbl.className = "chk";
  lbl.innerHTML = `<input type="checkbox" value="${key}" checked> ${label}`;
  domainsBox.appendChild(lbl);
});

document.getElementById("selectAll").onclick = () =>
  domainsBox.querySelectorAll("input").forEach(i => (i.checked = true));
document.getElementById("selectNone").onclick = () =>
  domainsBox.querySelectorAll("input").forEach(i => (i.checked = false));

// --- Слайдер количества ---
const countRange = document.getElementById("countRange");
const countLabel = document.getElementById("countLabel");
countRange.oninput = () => (countLabel.textContent = countRange.value);

// --- Пользовательская тема (строковый поиск): Enter = сгенерировать ---
const topicInput = document.getElementById("topicInput");
topicInput.addEventListener("keydown", e => { if (e.key === "Enter") generate(); });

// --- Генерация ---
document.getElementById("generateBtn").onclick = generate;

function getSelectedDomains() {
  return [...domainsBox.querySelectorAll("input:checked")].map(i => i.value);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function localCard(w, domainKey) {
  const art = Articles.pick(domainKey, w.term);   // статейник вместо захардкоженной ссылки
  return {
    source: "local",
    type: w.type,
    term: w.term,
    desc: w.desc,
    related: w.related,
    infoUrl: w.infoUrl,
    articleUrl: art.url,
    articleName: art.name,
    imgSeed: w.imgSeed || w.term,
    imageUrl: null,
    domainLabel: DOMAINS[domainKey],
  };
}

async function generate() {
  const userTopic = topicInput.value.trim();
  const selected = getSelectedDomains();
  if (!selected.length && !userTopic) {
    showNotice("⚠️ Выберите хотя бы одну сферу в чекбоксах или впишите свою тему строкой.");
    return;
  }

  const type = document.querySelector('input[name="wordType"]:checked').value;
  const count = Number(countRange.value);
  const noDup = document.getElementById("noDuplicates").checked;
  const mode = document.querySelector('input[name="dataSource"]:checked').value; // local | live | mix

  const btn = document.getElementById("generateBtn");
  btn.disabled = true;
  btn.textContent = "Генерация…";

  try {
    await buildAndRender({ selected, type, count, noDup, mode, userTopic });
  } finally {
    btn.disabled = false;
    btn.textContent = "Сгенерировать ✨";
  }
}

// --- Параллельная сборка карточек ---
async function buildAndRender({ selected, type, count, noDup, mode, userTopic }) {
  const results = document.getElementById("results");
  results.innerHTML = "";

  const wantLocal = mode === "local" || mode === "mix";
  const wantLive = mode === "live" || mode === "mix";

  // 1) Локальные карточки — мгновенно (если режим это позволяет)
  let pool = WORDS_DB.filter(w => selected.includes(w.domain));
  if (type !== "all") pool = pool.filter(w => w.type === type);
  if (noDup) pool = pool.filter(w => !usedTerms.has(w.term));
  pool = shuffle(pool);

  const cards = [];
  const seen = new Set();
  if (wantLocal) {
    for (const w of pool) {
      if (cards.length >= count) break;
      const c = localCard(w, w.domain);
      if (noDup) usedTerms.add(c.term);
      seen.add(c.term);
      cards.push(c);
    }
    render(cards); // сразу показываем то, что уже есть
  }

  const need = wantLive ? count - cards.length : 0;
  if (need <= 0) return;

  // 2) Скелетоны на недостающие карточки
  const skels = appendSkeletons(results, need);

  // 3) Пул параллельных задач: создаём сразу ~2–3× больше нужного,
  //    берём первые успешно завершившиеся. Провалившиеся — тихо отсекаем.
  const tasks = [];
  const taskCount = need + Math.ceil(need / 2) + 2; // ~1.5x запас на промахи
  for (let i = 0; i < taskCount; i++) {
    tasks.push(makeLiveCard(selected, userTopic, noDup ? usedTerms : null, seen));
  }

  let placed = 0;
  let finished = false;
  const overallTimer = setTimeout(() => finish(), 8000); // жёсткий лимит 8 с
  // «Мягкий» дедлайн: если к нему пришли не все, но хоть что-то —
  // останавливаем ожидание и отдаём готовое (быстрее отдача пользователю).
  // В режиме «только онлайн» даём живым источникам чуть больше времени (6 с),
  // чтобы выдача была полной; в mix локальные карточки уже на экране.
  const softMs = mode === "live" ? 6000 : 4500;
  const softTimer = setTimeout(() => { if (placed > 0) finish(); }, softMs);

  let lastRenderedCount = cards.length; // сколько карточек уже показано
  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(overallTimer);
    clearTimeout(softTimer);
    skels.forEach(s => s.isConnected && s.remove()); // доубираем недозаполненные скелетоны
    if (cards.length !== lastRenderedCount) {       // перерисовываем только если пришли новые
      render(cards);
      lastRenderedCount = cards.length;
    }
    if (cards.length < count) {
      showNoticeExtra(results, `Показано ${cards.length} из ${count}: часть источников не ответила вовремя — попробуйте ещё раз.`);
    }
  }

  // Дозаполняем по мере готовности каждой задачи.
  // ВАЖНО: здесь нет await — функция возвращается сразу, как только
  // собраны все карточки (или сработал дедлайн). Опоздавшие ответы
  // досчитываются в cards, но не блокируют кнопку «Сгенерировать».
  Promise.allSettled(tasks.map(p => p.then(card => {
    if (!card || finished || placed >= need) return;
    if (type !== "all" && card.type !== type) return;
    if (seen.has(card.term)) return;
    seen.add(card.term);
    if (noDup) usedTerms.add(card.term);
    cards.push(card);
    placed++;
    // мгновенно заменяем очередной скелетон реальной карточкой
    const skel = skels.shift();
    if (skel) skel.replaceWith(createCardEl(card, cards.length - 1));
    else results.appendChild(createCardEl(card, cards.length - 1));
    if (placed >= need) finish();
  }))).catch(() => {});

  // В чисто онлайн-режиме ждём fill-цикл (он завершится сам: либо когда
  // придут все карточки, либо по дедлайну). В mix-режиме локальные карточки
  // уже показаны — живые доходят фоном, кнопку не блокируем.
  if (mode === "live") {
    await new Promise(r => { const check = () => (finished ? r() : setTimeout(check, 50)); check(); });
  } else {
    await new Promise(r => setTimeout(r, 0));
    finish();
  }
}

// Одна задача = одна случайная карточка из случайного источника
async function makeLiveCard(selected, userTopic, dupSet, seen) {
  const domain = selected[Math.floor(Math.random() * selected.length)] || "science";
  let card = null;
  try {
    if (userTopic) {
      // Пользовательская тема: подбираем слова именно под неё
      const r = Math.random();
      if (r < 0.6) card = await Api.topicCard(userTopic, domain);
      else if (r < 0.75) card = await quoteCard(domain, userTopic);
      else if (r < 0.9) card = await newsCard(domain, userTopic);
      else card = await wikidataCard(domain, userTopic);
    } else {
      const topics = LIVE_TOPICS[domain] || ["Наука"];
      const topic = topics[Math.floor(Math.random() * topics.length)];
      const src = Math.floor(Math.random() * 8);
      if (src === 0) card = await nextDictCard(domain);              // Викисловарь ru
      else if (src === 1) card = await Api.buildCard(topic, domain); // Википедия ru
      else if (src === 2) card = await nextEnDictCard(domain);       // Wiktionary en
      else if (src === 3) card = await quoteCard(domain);            // Wikiquote
      else if (src === 4) card = await simpleWikiToCard(domain);     // Simple Wikipedia
      else if (src === 5) card = await dictApiCard(domain);          // Free Dictionary
      else if (src === 6) card = await newsCard(domain);             // WikiNews
      else card = await wikidataCard(domain);                        // Wikidata
    }
  } catch (e) { return null; }
  if (!card) return null;
  if (dupSet && dupSet.has(card.term)) return null;
  if (seen && seen.has(card.term)) return null;
  card.domainLabel = card.domainLabel || DOMAINS[domain];
  return card;
}

// --- Кэш слов из Викисловаря: пачку случайных слов + определения грузим одним запросом ---
let dictQueue = [];
let dictRefill = null;
async function refillDictQueue() {
  const terms = await Api.wiktRandomBatch(30);
  if (!terms.length) throw new Error("empty wiktionary batch");
  const defs = await Api.wiktDefinitions(terms);
  dictQueue = terms
    .filter(t => defs[t] && defs[t].length > 15)
    .map(t => ({ term: t, def: defs[t] }));
}
async function ensureDictQueue() {
  if (dictQueue.length >= 3) return;
  if (!dictRefill) {                       // дедупликация параллельных дозаправок
    dictRefill = refillDictQueue().finally(() => { dictRefill = null; });
  }
  await dictRefill.catch(() => {});
  if (!dictQueue.length) throw new Error("no dict queue");
}

async function nextDictCard(domain) {
  await ensureDictQueue();
  const idx = Math.floor(Math.random() * dictQueue.length);
  const { term, def } = dictQueue.splice(idx, 1)[0];
  const url = "https://ru.wiktionary.org/wiki/" + encodeURIComponent(term);
  const art = Articles.pick(domain, term);
  return {
    source: "live-dict",
    type: Api.classify(term),
    term,
    desc: def.slice(0, 400),
    related: [],
    infoUrl: url,
    articleUrl: art.url,
    articleName: art.name,
    imageUrl: null,
    imgSeed: term,
    domainLabel: DOMAINS[domain],
  };
}

// --- Английский Викисловарь (batch) ---
let enDictQueue = [];
let enDictRefill = null;
async function refillEnDictQueue() {
  const terms = await Api.enWiktRandomBatch(30);
  if (!terms.length) throw new Error("empty en-wiktionary batch");
  const defs = await Api.enWiktDefinitions(terms);
  enDictQueue = terms
    .filter(t => defs[t] && defs[t].length > 15)
    .map(t => ({ term: t, def: defs[t] }));
}
async function ensureEnDictQueue() {
  if (enDictQueue.length >= 3) return;
  if (!enDictRefill) {
    enDictRefill = refillEnDictQueue().finally(() => { enDictRefill = null; });
  }
  await enDictRefill.catch(() => {});
  if (!enDictQueue.length) throw new Error("no en dict queue");
}

async function nextEnDictCard(domain) {
  await ensureEnDictQueue();
  const idx = Math.floor(Math.random() * enDictQueue.length);
  const { term, def } = enDictQueue.splice(idx, 1)[0];
  const url = "https://en.wiktionary.org/wiki/" + encodeURIComponent(term);
  const art = Articles.pick(domain, term);
  const related = await Api.datamuseRelated(term).catch(() => []);
  return {
    source: "live-endict",
    type: Api.classify(term),
    term,
    desc: def.slice(0, 400),
    related,
    infoUrl: url,
    articleUrl: art.url,
    articleName: art.name,
    imageUrl: null,
    imgSeed: term,
    domainLabel: DOMAINS[domain],
  };
}

// --- Wikiquote: крылатое выражение / цитата ---
async function quoteCard(domain, topicOverride) {
  const topic = topicOverride || QUOTE_TOPICS[domain] || "жизнь";
  const { title, quote } = await Api.randomQuote(topic);
  const url = "https://ru.wikiquote.org/wiki/" + encodeURIComponent(title);
  const m = quote.match(/^(.{10,90}?)(?:\s+[—:-]\s+.+)?$/u);
  const term = (m ? m[1] : quote).replace(/[«»"“”]/g, "").trim();
  const art = Articles.pick(domain, term);
  return {
    source: "live-quote",
    type: "phrase",
    term: term.length > 90 ? term.slice(0, 87) + "…" : term,
    desc: quote,
    related: [],
    infoUrl: url,
    articleUrl: art.url,
    articleName: art.name,
    imageUrl: null,
    imgSeed: title,
    domainLabel: DOMAINS[domain],
  };
}

// --- Simple English Wikipedia ---
async function simpleWikiToCard(domain) {
  const { title, extract, url } = await Api.simpleWikiCard();
  const art = Articles.pick(domain, title);
  return {
    source: "live-simple",
    type: Api.classify(title),
    term: title,
    desc: extract,
    related: await Api.datamuseRelated(title.split(" ")[0]).catch(() => []),
    infoUrl: url,
    articleUrl: art.url,
    articleName: art.name,
    imageUrl: null,
    imgSeed: title,
    domainLabel: DOMAINS[domain],
  };
}

// --- Free Dictionary API + Datamuse ---
const COMMON_EN_WORDS = ["serendipity", "eloquent", "journey", "curiosity", "harmony",
  "wisdom", "adventure", "silence", "gratitude", "horizon", "spark", "balance"];
async function dictApiCard(domain) {
  const word = COMMON_EN_WORDS[Math.floor(Math.random() * COMMON_EN_WORDS.length)];
  const info = await Api.freeDictInfo(word);
  if (!info || !info.definition) throw new Error("free dictionary miss");
  const related = await Api.datamuseRelated(word).catch(() => []);
  const parts = [info.definition];
  if (info.example) parts.push("Пример: «" + info.example + "»");
  if (info.phonetic) parts.unshift(info.phonetic + (info.partOfSpeech ? " · " + info.partOfSpeech : ""));
  const art = Articles.pick(domain, word);
  return {
    source: "live-freedict",
    type: "word",
    term: word,
    desc: parts.join("\n"),
    related,
    infoUrl: "https://www.merriam-webster.com/dictionary/" + encodeURIComponent(word),
    articleUrl: art.url,
    articleName: art.name,
    imageUrl: null,
    imgSeed: word,
    domainLabel: DOMAINS[domain],
  };
}

// --- WikiNews: новость по теме → «выражение» ---
async function newsCard(domain, topicOverride) {
  const topic = topicOverride || LIVE_TOPICS[domain]?.[0] || "наука";
  const { title, extract, url } = await Api.randomNews(topic);
  const art = Articles.pick(domain, title);
  return {
    source: "live-news",
    type: Api.classify(title) === "word" ? "collocation" : "phrase",
    term: title.length > 90 ? title.slice(0, 87) + "…" : title,
    desc: extract,
    related: [],
    infoUrl: url,
    articleUrl: art.url,
    articleName: art.name,
    imageUrl: null,
    imgSeed: title,
    domainLabel: DOMAINS[domain],
  };
}

// --- Wikidata: метка + описание на русском ---
async function wikidataCard(domain, topicOverride) {
  const item = await Api.randomWikidataItem();
  const art = Articles.pick(domain, item.label + " " + (topicOverride || ""));
  return {
    source: "live-wikidata",
    type: Api.classify(item.label),
    term: item.label,
    desc: item.desc,
    related: [],
    infoUrl: item.infoUrl,
    articleUrl: art.url,
    articleName: art.name,
    imageUrl: null,
    imgSeed: item.label,
    domainLabel: DOMAINS[domain],
  };
}

// --- Отрисовка ---
const SOURCE_LABELS = {
  local: "Локальная база",
  live: "Википедия (онлайн)",
  "live-dict": "Викисловарь ru (онлайн)",
  "live-endict": "Wiktionary en (онлайн)",
  "live-quote": "Wikiquote (онлайн)",
  "live-simple": "Simple Wikipedia (онлайн)",
  "live-freedict": "Free Dictionary + Datamuse",
  "live-news": "WikiNews (онлайн)",
  "live-wikidata": "Wikidata (онлайн)",
};

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function picsumFor(seed) {
  return `https://picsum.photos/seed/${encodeURIComponent(seed || "word")}/640/300`;
}

function createCardEl(w, idx) {
  const showImages = document.getElementById("showImages").checked;
  const card = document.createElement("article");
  card.className = "card";
  card.style.animationDelay = `${Math.min(idx, 8) * 0.06}s`;

  let imgHtml = "";
  if (showImages) {
    const primary = w.imageUrl || picsumFor(w.imgSeed || w.term);
    const fallback = picsumFor(w.imgSeed || w.term);
    // onerror: если картинка не загружается — подставим другую из интернета
    imgHtml = `<img class="card-img" src="${esc(primary)}" alt="Иллюстрация к «${esc(w.term)}»" loading="lazy"
      data-term="${esc(w.term)}" data-fallback="${esc(fallback)}"
      onload="this.dataset.loaded='1'"
      onerror="window.__imgFail(this)">`;
  }

  const relatedHtml = (w.related && w.related.length)
    ? `<div class="related">
         <strong>Похожие и связанные слова:</strong>
         ${w.related.map(r => `<button type="button" class="chip" title="Нажмите, чтобы скопировать">${esc(r)}</button>`).join("")}
       </div>`
    : "";

  card.innerHTML = `
    ${imgHtml}
    <div class="card-body">
      <div class="badges">
        <span class="badge badge-type">${TYPE_LABELS[w.type]}</span>
        <span class="badge badge-domain">${esc(w.domainLabel || "")}</span>
        <span class="badge badge-source">${SOURCE_LABELS[w.source] || ""}</span>
      </div>
      <h3 class="term">${esc(w.term)}</h3>
      <p class="desc">${esc(w.desc)}</p>
      ${relatedHtml}
      <div class="links">
        <a href="${esc(w.infoUrl)}" target="_blank" rel="noopener">ℹ️ Информационный ресурс</a>
        <a href="${esc(w.articleUrl)}" target="_blank" rel="noopener">📄 Статья: ${esc(w.articleName || "по теме")}</a>
      </div>
    </div>`;

  card.querySelectorAll(".chip").forEach(chip => {
    chip.onclick = () => {
      navigator.clipboard?.writeText(chip.textContent).then(() => {
        chip.classList.add("copied");
        setTimeout(() => chip.classList.remove("copied"), 900);
      });
    };
  });

  // Фоновая «умная» подмена: если у карточки нет тематической картинки
  // (стоит picsum-заглушка) — через пару секунд тянем настоящую картинку
  // из Wikimedia Commons по термину.
  const img = card.querySelector(".card-img");
  if (img && !w.imageUrl) {
    setTimeout(async () => {
      if (img.dataset.loaded === "1" && img.dataset.upgraded) return;
      try {
        const real = await Api.commonsImage(w.term);
        if (real && img.isConnected) {
          img.dataset.upgraded = "1";
          img.src = real;
        }
      } catch (e) { /* оставляем picsum */ }
    }, 2500);
  }
  return card;
}

// Глобальный обработчик ошибок картинок: сначала пробуем реальную картинку
// из Commons («взять с интернета»), затем — запасной picsum.
window.__imgFail = async (imgEl) => {
  if (imgEl.dataset.triedFallback) {
    imgEl.src = imgEl.dataset.fallback || picsumFor("word");
    imgEl.onerror = null;
    return;
  }
  imgEl.dataset.triedFallback = "1";
  try {
    const real = await Api.commonsImage(imgEl.dataset.term || "");
    if (real) {
      imgEl.src = real;
      imgEl.onerror = () => { imgEl.src = imgEl.dataset.fallback; imgEl.onerror = null; };
      return;
    }
  } catch (e) { /* ignore */ }
  imgEl.src = imgEl.dataset.fallback || picsumFor("word");
  imgEl.onerror = null;
};

function appendSkeletons(container, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const sk = document.createElement("div");
    sk.className = "card skeleton";
    sk.innerHTML = `<div class="sk-img"></div><div class="sk-body"><div class="sk-line w40"></div><div class="sk-line w80"></div><div class="sk-line w60"></div></div>`;
    container.appendChild(sk);
    out.push(sk);
  }
  return out;
}

function render(items) {
  const results = document.getElementById("results");
  results.innerHTML = "";
  items.forEach((w, idx) => results.appendChild(createCardEl(w, idx)));
  if (!items.length) showNotice("Ничего не найдено.");
}

function showNotice(text) {
  document.getElementById("results").innerHTML = `<div class="notice">${text}</div>`;
}
function showNoticeExtra(container, text) {
  const n = document.createElement("div");
  n.className = "notice";
  n.textContent = text;
  container.prepend(n);
}

// Первая генерация при загрузке
generate();
