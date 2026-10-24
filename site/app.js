const TYPE_LABELS = { word: "Слово", phrase: "Выражение", collocation: "Словосочетание" };
const usedTerms = new Set(); // для режима «без повторов»

// Живые темы для запросов к Википедии/Викисловарю по каждой сфере.
// API-источники дают практически неограниченное число слов — локальный файл лишь стартовый набор.
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

// Темы для цитат (Wikiquote) по сферам — дают крылатые выражения и фразеологию.
const QUOTE_TOPICS = {
  it: "программирование компьютер", everyday: "жизнь человек время",
  science: "наука знания учёный", business: "бизнес деньги успех",
  medicine: "здоровье врач жизнь", culture: "искусство музыка литература",
  sports: "спорт победа", travel: "путешествия дорога странствие",
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
  return {
    source: "local",
    type: w.type,
    term: w.term,
    desc: w.desc,
    related: w.related,
    infoUrl: w.infoUrl,
    articleUrl: w.articleUrl,
    imgSeed: w.imgSeed,
    imageUrl: null,
    domainLabel: DOMAINS[domainKey],
  };
}

async function generate() {
  const selected = getSelectedDomains();
  if (!selected.length) {
    showNotice("⚠️ Выберите хотя бы одну сферу (область) в чекбоксах.");
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
    const cards = await buildCards({ selected, type, count, noDup, mode });
    if (!cards.length) {
      showNotice("😕 Не удалось собрать карточки. Попробуйте добавить сферы, сменить тип лексики или снять ограничение «без повторов».");
      return;
    }
    render(cards);
  } finally {
    btn.disabled = false;
    btn.textContent = "Сгенерировать ✨";
  }
}

async function buildCards({ selected, type, count, noDup, mode }) {
  // Стартовый локальный пул
  let pool = WORDS_DB.filter(w => selected.includes(w.domain));
  if (type !== "all") pool = pool.filter(w => w.type === type);
  if (noDup) pool = pool.filter(w => !usedTerms.has(w.term));
  pool = shuffle(pool);

  const wantLocal = mode === "local" || mode === "mix";
  const wantLive = mode === "live" || mode === "mix";

  const cards = [];
  if (wantLocal) {
    for (const w of pool) {
      if (cards.length >= count) break;
      cards.push(localCard(w, w.domain));
      if (noDup) usedTerms.add(w.term);
    }
  }

  // Подгружаем недостающее из живых источников (Википедия / Викисловарь)
  if (wantLive && cards.length < count) {
    showSkeleton(count - cards.length);
    let attempts = 0;
    while (cards.length < count && attempts < count * 5) {
      attempts++;
      const domain = selected[Math.floor(Math.random() * selected.length)];
      const topics = LIVE_TOPICS[domain] || ["Наука"];
      const topic = topics[Math.floor(Math.random() * topics.length)];
      let card = null;
      try {
        // Ротация живых источников: Википедия, рус./англ. Викисловарь, Wikiquote, Simple Wikipedia
        const src = attempts % 6;
        if (src === 0) card = await nextDictCard(domain);          // Викисловарь (ru)
        else if (src === 1) card = await Api.buildCard(topic);      // Википедия (ru)
        else if (src === 2) card = await nextEnDictCard(domain);    // Wiktionary (en)
        else if (src === 3) card = await quoteCard(domain);         // Wikiquote (ru)
        else if (src === 4) card = await simpleWikiToCard(domain);  // Simple English Wikipedia
        else card = await dictApiCard(domain);                      // Free Dictionary + Datamuse
      } catch (e) { continue; }
      if (!card) continue;
      if (type !== "all" && card.type !== type) continue;
      if (noDup && usedTerms.has(card.term)) continue;
      if (cards.some(c => c.term === card.term)) continue;
      card.domainLabel = DOMAINS[domain];
      cards.push(card);
      if (noDup) usedTerms.add(card.term);
    }
  }
  return cards;
}

// --- Кэш слов из Викисловаря: пачку случайных слов + определения грузим одним запросом ---
let dictQueue = [];
async function refillDictQueue() {
  const terms = await Api.wiktRandomBatch(20);
  if (!terms.length) throw new Error("empty wiktionary batch");
  const defs = await Api.wiktDefinitions(terms);
  dictQueue = terms
    .filter(t => defs[t] && defs[t].length > 15)
    .map(t => ({ term: t, def: defs[t] }));
}

async function nextDictCard(domain) {
  if (!dictQueue.length) await refillDictQueue();
  const idx = Math.floor(Math.random() * dictQueue.length);
  const { term, def } = dictQueue.splice(idx, 1)[0];
  const url = "https://ru.wiktionary.org/wiki/" + encodeURIComponent(term);
  return {
    source: "live-dict",
    type: Api.classify(term),
    term,
    desc: def.slice(0, 400),
    related: [],
    infoUrl: url,
    articleUrl: url,
    imageUrl: null,
    imgSeed: term,
    domainLabel: DOMAINS[domain],
  };
}

// --- Английский Викисловарь: пачка случайных слов + определения одним запросом ---
let enDictQueue = [];
async function refillEnDictQueue() {
  const terms = await Api.enWiktRandomBatch(20);
  if (!terms.length) throw new Error("empty en-wiktionary batch");
  const defs = await Api.enWiktDefinitions(terms);
  enDictQueue = terms
    .filter(t => defs[t] && defs[t].length > 15)
    .map(t => ({ term: t, def: defs[t] }));
}

async function nextEnDictCard(domain) {
  if (!enDictQueue.length) await refillEnDictQueue();
  if (!enDictQueue.length) throw new Error("no usable en definitions");
  const idx = Math.floor(Math.random() * enDictQueue.length);
  const { term, def } = enDictQueue.splice(idx, 1)[0];
  const url = "https://en.wiktionary.org/wiki/" + encodeURIComponent(term);
  return {
    source: "live-endict",
    type: Api.classify(term),
    term,
    desc: def.slice(0, 400),
    related: await Api.datamuseRelated(term).catch(() => []),
    infoUrl: url,
    articleUrl: url,
    imageUrl: null,
    imgSeed: term,
    domainLabel: DOMAINS[domain],
  };
}

// --- Wikiquote: крылатое выражение / цитата по сфере ---
async function quoteCard(domain) {
  const topic = QUOTE_TOPICS[domain] || "жизнь";
  const { title, quote } = await Api.randomQuote(topic);
  const url = "https://ru.wikiquote.org/wiki/" + encodeURIComponent(title);
  // Термин — первая часть цитаты до тире/двоеточия (автор), либо вся цитата целиком
  const m = quote.match(/^(.{10,90}?)(?:\s+[—:-]\s+.+)?$/u);
  const term = (m ? m[1] : quote).replace(/[«»"“”]/g, "").trim();
  return {
    source: "live-quote",
    type: "expression",
    term: term.length > 90 ? term.slice(0, 87) + "…" : term,
    desc: quote,
    related: [],
    infoUrl: url,
    articleUrl: url,
    imageUrl: null,
    imgSeed: title,
    domainLabel: DOMAINS[domain],
  };
}

// --- Simple English Wikipedia: статья с простым определением ---
async function simpleWikiToCard(domain) {
  const { title, extract, url } = await Api.simpleWikiCard();
  return {
    source: "live-simple",
    type: Api.classify(title),
    term: title,
    desc: extract,
    related: await Api.datamuseRelated(title.split(" ")[0]).catch(() => []),
    infoUrl: url,
    articleUrl: url,
    imageUrl: null,
    imgSeed: title,
    domainLabel: DOMAINS[domain],
  };
}

// --- Free Dictionary API + Datamuse: английское слово из случайной пачки Wiktionary ---
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
  return {
    source: "live-freedict",
    type: "word",
    term: word,
    desc: parts.join("\n"),
    related,
    infoUrl: "https://www.merriam-webster.com/dictionary/" + encodeURIComponent(word),
    articleUrl: "https://dictionaryapi.dev/",
    imageUrl: null,
    imgSeed: word,
    domainLabel: DOMAINS[domain],
  };
}

function showSkeleton(n) {
  const results = document.getElementById("results");
  results.innerHTML = Array.from({ length: n })
    .map(() => `<div class="card skeleton"><div class="sk-img"></div><div class="sk-body"><div class="sk-line w40"></div><div class="sk-line w80"></div><div class="sk-line w60"></div></div></div>`)
    .join("");
}

function showNotice(text) {
  document.getElementById("results").innerHTML =
    `<div class="notice">${text}</div>`;
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

const SOURCE_LABELS = {
  local: "Локальная база",
  live: "Википедия (онлайн)",
  "live-dict": "Викисловарь ru (онлайн)",
  "live-endict": "Wiktionary en (онлайн)",
  "live-quote": "Wikiquote (онлайн)",
  "live-simple": "Simple Wikipedia (онлайн)",
  "live-freedict": "Free Dictionary + Datamuse",
};

function render(items) {
  const showImages = document.getElementById("showImages").checked;
  const results = document.getElementById("results");
  results.innerHTML = "";

  items.forEach((w, idx) => {
    const card = document.createElement("article");
    card.className = "card";
    card.style.animationDelay = `${idx * 0.08}s`;

    // Картинка: для живых карточек — изображение из Википедии, для остальных — picsum по seed
    let imgHtml = "";
    if (showImages) {
      const src = w.imageUrl ||
        `https://picsum.photos/seed/${encodeURIComponent(w.imgSeed || w.term)}/640/300`;
      imgHtml = `<img class="card-img" src="${esc(src)}" alt="Иллюстрация к «${esc(w.term)}»" loading="lazy">`;
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
          <a href="${esc(w.articleUrl)}" target="_blank" rel="noopener">📄 Статья по теме</a>
        </div>
      </div>`;

    // Копирование похожих слов по клику
    card.querySelectorAll(".chip").forEach(chip => {
      chip.onclick = () => {
        navigator.clipboard?.writeText(chip.textContent).then(() => {
          chip.classList.add("copied");
          setTimeout(() => chip.classList.remove("copied"), 900);
        });
      };
    });

    results.appendChild(card);
  });

  if (!items.length) showNotice("Ничего не найдено.");
}

// Первая генерация при загрузке
generate();
