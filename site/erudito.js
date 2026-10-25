// erudito.js — раздел «Эрудито»: тренажёр эрудиции.
// Задачки генерируются из ЖИВЫХ источников (Википедия, Wikidata,
// Wikiquote, Викисловарь, локальная база WORDS_DB) — слова не ограничены
// файлом. Проверка ответа работает по двум уровням:
//   1) Быстрый офлайн-чек (без ИИ): совпадение с ответом, леммы,
//      ключевые слова описания, нечёткое сравнение (Levenshtein).
//   2) Если задан API-ключ Claude/OpenAI (настройки ⚙ на странице) —
//      умная ИИ-проверка: модель оценивает «процент правильности»
//      суждения пользователя и возвращает вердикт {percent, correct}.
// Порог правильности настраивается слайдером (по умолчанию 60%).

const Erudito = (() => {
  const state = {
    task: null,          // текущая задачка
    attempts: 0,         // попытки проверки
    hintLevel: 0,        // сколько подсказок уже выдано
    history: new Set(),  // чтобы не повторять задачи подряд
    score: { solved: 0, total: 0 },
    files: [],           // прикреплённые файлы {name, type, dataUrl?}
  };

  // ---------- Утилиты сравнения ----------
  function norm(s) {
    return String(s || "").toLowerCase()
      .replace(/ё/g, "е").replace(/[^a-zа-я0-9\s]/gi, " ")
      .replace(/\s+/g, " ").trim();
  }
  function levenshtein(a, b) {
    if (a.length > b.length) [a, b] = [b, a];
    let prev = Array.from({ length: a.length + 1 }, (_, i) => i);
    for (let j = 1; j <= b.length; j++) {
      const cur = [j];
      for (let i = 1; i <= a.length; i++) {
        cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[a.length];
  }
  function similarity(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    const d = levenshtein(a, b);
    return 1 - d / Math.max(a.length, b.length);
  }
  // Ключевые слова из описания (существенные, без стоп-слов)
  const STOP = new Set(("и в во не что он на я с со как а то все она так да но ты к у вы у же бы вот этот эта эти мой наш свой его её при для от до над под был есть были очень также который которая которые можно нужно один два более всего время человек дело жизнь часть вид форма способ система процесс"
    ).split(/\s+/));
  function keywords(text, n = 8) {
    return norm(text).split(" ")
      .filter(w => w.length >= 4 && !STOP.has(w))
      .sort((a, b) => b.length - a.length)
      .slice(0, n);
  }

  // ---------- Офлайн-проверка: процент правильности ----------
  function offlineScore(task, answer) {
    if (!answer.trim()) return 0;
    const ans = norm(answer);
    const target = norm(task.answer);
    let score = 0;
    if (ans === target) return 100;
    if (ans.includes(target) || target.includes(ans)) score = Math.max(score, 85);
    score = Math.max(score, Math.round(similarity(answer, task.answer) * 100));
    // Совпадения по ключевым словам описания/ответа
    const kws = [...keywords(task.answer), ...keywords(task.desc || "")].map(norm);
    const hit = kws.filter(k => k.length >= 4 && ans.includes(k)).length;
    if (kws.length) score = Math.max(score, Math.min(80, Math.round(hit / Math.max(3, kws.length * 0.4) * 70)));
    // Допустимые альтернативные ответы
    for (const alt of (task.accept || [])) {
      if (ans === norm(alt)) return 100;
      score = Math.max(score, Math.round(similarity(answer, alt) * 100));
    }
    return Math.min(100, score);
  }

  // ---------- ИИ-проверка (если пользователь добавил ключ) ----------
  function getAIConfig() {
    try { return JSON.parse(localStorage.getItem("erudito_ai") || "null"); } catch { return null; }
  }
  async function aiCheck(task, answer, filesText) {
    const cfg = getAIConfig();
    if (!cfg?.key) return null; // нет ключа — работаем офлайн
    const prompt =
      `Ты проверяешь ответ игрока в викторине на эрудицию.\n` +
      `ЗАДАЧА (${task.kindName}): ${task.question}\n` +
      (filesText ? `Приложенный текст файла от игрока: """${filesText.slice(0, 2000)}"""\n` : "") +
      `ОТВЕТ ИГРОКА: ${answer}\n` +
      `ЭТАЛОННЫЙ ОТВЕТ: ${task.answer}\n` +
      `КРАТКОЕ ОПИСАНИЕ: ${task.desc || ""}\n\n` +
      `Оцени, насколько ответ игрока правильный (учитывай синонимы, перефраз, суть). ` +
      `Ответь СТРОГО JSON вида {"percent": число 0-100, "comment": "одно предложение по-русски"} без markdown.`;
    try {
      let res;
      if (cfg.provider === "openai") {
        res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.key },
          body: JSON.stringify({
            model: cfg.model || "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" }, max_tokens: 120,
          }),
        });
        const d = await res.json();
        const txt = d?.choices?.[0]?.message?.content || "{}";
        return parseVerdict(txt);
      } else { // claude (по умолчанию)
        res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({
            model: cfg.model || "claude-sonnet-4-20250514",
            max_tokens: 200, messages: [{ role: "user", content: prompt }],
          }),
        });
        const d = await res.json();
        const txt = d?.content?.[0]?.text || "{}";
        return parseVerdict(txt);
      }
    } catch (e) { console.warn("AI check failed:", e); return null; }
  }
  function parseVerdict(txt) {
    try {
      const m = txt.match(/\{[\s\S]*\}/);
      const obj = JSON.parse(m ? m[0] : txt);
      let p = Number(obj.percent);
      if (!isFinite(p)) p = 0;
      return { percent: Math.max(0, Math.min(100, Math.round(p))), comment: obj.comment || "" };
    } catch { return null; }
  }

  // ---------- Генерация задачек (любые источники) ----------
  const KINDS = ["word", "article", "algo", "image", "quote"];

  function localRandom(domainKeys) {
    const pool = WORDS_DB.filter(w => !domainKeys?.length || domainKeys.includes(w.domain));
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // Тип 1: «Что это за слово?» — описание без слова, угадай термин
  async function makeWordTask(topic, domainKeys) {
    let item = null;
    try {
      if (topic) item = await Api.topicCard(topic, domainKeys?.[0]);
      else item = await Api.buildCard(domainKeys?.[0] || "Наука", domainKeys?.[0]);
    } catch (e) { /* fallback на локальную базу */ }
    if (!item) item = localRandom(domainKeys);
    if (!item) throw new Error("нет данных для задачки");
    const q = `Как называется это ${item.type === "word" ? "слово" : "понятие / выражение"}? Ответь одним словом или словосочетанием.\n\n«${item.desc}»`;
    return {
      kind: "word", kindName: "Угадай слово",
      question: q, answer: item.term,
      desc: item.desc, accept: item.related || [],
      imageUrl: item.imageUrl, imgSeed: item.imgSeed,
      infoUrl: item.infoUrl, articleUrl: item.articleUrl, articleName: item.articleName,
      hints: buildHints(item.term, item.desc, item.related),
    };
  }

  // Тип 2: «О чём эта статья?» — фрагмент текста, угадай тему/статью
  async function makeArticleTask(topic, domainKeys) {
    let title;
    try {
      title = topic ? await Api.randomWikiTitle(topic) : await Api.wikiRandomPage([...state.history]);
    } catch (e) {
      const loc = localRandom(domainKeys);
      if (!loc) throw new Error("вики недоступна");
      return wordTaskFromLocal(loc);
    }
    state.history.add(title);
    let summary;
    try { summary = await Api.wikiSummary(title); }
    catch (e) { throw new Error("не удалось получить статью"); }
    const extract = (summary.extract || "").slice(0, 500);
    if (!extract || extract.length < 60) return makeArticleTask(topic, domainKeys);
    const firstWords = norm(title).split(" ")[0];
    const masked = extract.replace(new RegExp(firstWords + "\\w*", "gi"), "████");
    return {
      kind: "article", kindName: "О чём эта статья?",
      question: `Прочитай фрагмент статьи и напиши, о чём (или о ком / о чём предмете) в ней речь.\n\n${masked}`,
      answer: title, desc: extract,
      accept: (title.match(/[А-Я][а-яё]{4,}/g) || []).slice(0, 3),
      imageUrl: summary.thumbnail?.source || null, imgSeed: title,
      infoUrl: summary.content_urls?.desktop?.page || "https://ru.wikipedia.org/wiki/" + encodeURIComponent(title),
      articleUrl: Articles.pick(domainKeys?.[0], title).url,
      articleName: Articles.pick(domainKeys?.[0], title).name,
      hints: buildHints(title, extract, []),
    };
  }

  function wordTaskFromLocal(loc) {
    state.history.add(loc.term);
    return {
      kind: "word", kindName: "Угадай слово",
      question: `Что это за понятие? Описание: «${loc.desc}»`,
      answer: loc.term, desc: loc.desc, accept: loc.related,
      imageUrl: null, imgSeed: loc.imgSeed,
      infoUrl: loc.infoUrl, articleUrl: loc.articleUrl, articleName: "Статьи по теме",
      hints: buildHints(loc.term, loc.desc, loc.related),
    };
  }

  // Тип 3: алгоритмическая задачка — мини-задача на логику/код (шаблонная)
  async function makeAlgoTask(topic) {
    const templates = [
      () => {
        const n = 3 + Math.floor(Math.random() * 8);
        const arr = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 40));
        const sorted = [...arr].sort((a, b) => a - b);
        return {
          q: `Дан массив чисел: [${arr.join(", ")}].\nОпиши словами (или кодом), как отсортировать его по возрастанию методом пузырька — какие шаги делает алгоритм, и какой будет результат. Можно приложить файл с кодом.`,
          a: `[${sorted.join(", ")}]`,
          extra: sorted.join(", "),
        };
      },
      () => {
        const seq = ["push(3)", "push(7)", "pop()", "push(5)", "pop()", "pop()"];
        return {
          q: `Мини-задача на структуру данных. Стек: операции push(x) — положить x, pop() — снять верхний элемент (LIFO).\nПоследовательность: ${seq.join(" → ")}. Какие значения вернут pop-операции по порядку? Напиши их списком через запятую.`,
          a: "7, 5, 3", extra: "7 5 3 LIFO last in first out стек стэк",
        };
      },
      () => {
        const words = ["алгоритм", "рекурсия", "итерация", "массив", "функция"];
        const w = words[Math.floor(Math.random() * words.length)];
        const s = w.split("").reverse().join("");
        return {
          q: `Задача на внимание и строки: слово «${w.toUpperCase()}» зашифровали, записав его задом наперёд: «${s.toUpperCase()}». Теперь зашифруй так же фразу «эрудито это классно» (убери пробелы и запиши задом наперёд, буквы как есть).`,
          a: "эрудиэтоэтоклассно".split("").reverse().join(""),
          extra: "эруди это классно",
        };
      },
    ];
    const t = templates[Math.floor(Math.random() * templates.length)]();
    return {
      kind: "algo", kindName: "Алгоритм / логика",
      question: t.q, answer: t.a, desc: t.a,
      accept: [], extraAccept: t.extra,
      imageUrl: null, imgSeed: "algorithm-puzzle",
      infoUrl: "https://ru.wikipedia.org/wiki/%D0%90%D0%BB%D0%B3%D0%BE%D1%80%D0%B8%D1%82%D0%BC",
      articleUrl: "https://habr.com/ru/hubs/algorithms_and_data_structures/",
      articleName: "Хабр · Алгоритмы",
      hints: ["Это задача на пошаговое выполнение — проведи руками первые шаги", "Результат — конкретный список значений/строк", "Подумай, какая структура данных или трюк со строкой тут используется"],
    };
  }

  // Тип 4: картинка — угадай, что изображено (Wikidata/Commons)
  async function makeImageTask(topic) {
    let ent = null;
    try { ent = await Api.wikidataRandomEntity([...state.history]); }
    catch (e) { /* попробуем через тему */ }
    if (!ent && topic) {
      try {
        const title = await Api.randomWikiTitle(topic);
        const [sum, img] = await Promise.all([Api.wikiSummary(title), Api.wikiImage(title).catch(() => null)]);
        if (img) ent = { label: title, desc: sum.extract, imageUrl: img, sitelink: sum.content_urls?.desktop?.page };
      } catch (e) { /* ignore */ }
    }
    if (!ent || !ent.imageUrl) {
      // fallback: известная тема + картинка из Commons
      const titles = ["Трансформатор", "Акварель", "Георгий Победоносец", "Вулкан Эребус", "Бинокль", "Паста карбонара", "Обсерватория"];
      const t = titles[Math.floor(Math.random() * titles.length)];
      let img = null;
      try { img = await Api.commonsImage(t); } catch (e) { /* ignore */ }
      if (!img) throw new Error("не удалось получить картинку");
      ent = { label: t, desc: "", imageUrl: img };
    }
    state.history.add(ent.label);
    return {
      kind: "image", kindName: "Что на картинке?",
      question: `Посмотри на изображение и напиши, что или кто на нём изображён (можно кратко: объект, место, персона, явление).${ent.desc ? "\n\nКонтекст (из свободной базы знаний): " + ent.desc : ""}`,
      answer: ent.label, desc: ent.desc || ent.label,
      accept: norm(ent.label).split(" "),
      imageUrl: ent.imageUrl, imgSeed: ent.label,
      infoUrl: ent.sitelink || "https://www.wikidata.org/wiki/" + (ent.qid || ""),
      articleUrl: Articles.pick(null, ent.label).url,
      articleName: Articles.pick(null, ent.label).name,
      hints: buildHints(ent.label, ent.desc, []),
      hideLabelInHint: true,
    };
  }

  // Тип 5: цитата/выражение — чьё это или что значит (Wikiquote)
  async function makeQuoteTask(topic) {
    let q = null;
    try { q = await Api.randomQuote(topic || "искусство"); } catch (e) { try { q = await Api.randomQuote("жизнь"); } catch (e2) { /* ignore */ } }
    if (!q || !q.quote) throw new Error("цитаты недоступны");
    state.history.add(q.title);
    return {
      kind: "quote", kindName: "Выражение / цитата",
      question: `Перед тобой крылатое выражение (или строка из статьи/цитатника):\n\n«${q.quote}»\n\nНапиши, как понимаешь его смысл и/или о чём оно вообще. Тематическая подсказка скрыта — ответ связан со статьёй «${q.title.length > 3 ? q.title.slice(0, 2) + "…" : q.title}».`,
      answer: q.title, desc: q.quote,
      accept: norm(q.title).split(" ").filter(w => w.length > 3),
      imageUrl: null, imgSeed: q.title,
      infoUrl: q.url || "https://ru.wikiquote.org",
      articleUrl: Articles.pick(null, q.title).url,
      articleName: Articles.pick(null, q.title).name,
      hints: ["Оно связано с темой: " + (norm(q.title).split(" ")[0] || "культура"),
        "Первые буквы ответа: " + q.title.split(/\s+/).map(w => w[0]).join("-").toUpperCase(),
        "В ответе " + q.title.split(/\s+/).length + " сл. и длина ≈ " + q.title.length + " симв."],
    };
  }

  function buildHints(term, desc, related) {
    const h = [];
    const words = norm(term).split(" ");
    h.push(`Ответ состоит из ${words.length} сл.; длина ≈ ${term.length} символов`);
    h.push(`Начинается на «${term[0]?.toUpperCase() || "?"}…»`);
    if (related?.length) h.push("Рядом стоят темы: " + related.slice(0, 3).join(", "));
    else if (desc) {
      const kw = keywords(desc, 3);
      if (kw.length) h.push("Ключевые слова описания: " + kw.join(", "));
    }
    return h;
  }

  async function newTask(kind, topic, domainKeys) {
    const kinds = kind === "any"
      ? [KINDS[Math.floor(Math.random() * KINDS.length)]]
      : [kind];
    // если выбранный тип не удался — автооткат на word
    for (const k of kinds) {
      try {
        switch (k) {
          case "word": return await makeWordTask(topic, domainKeys);
          case "article": return await makeArticleTask(topic, domainKeys);
          case "algo": return await makeAlgoTask(topic);
          case "image": return await makeImageTask(topic);
          case "quote": return await makeQuoteTask(topic);
        }
      } catch (e) { console.warn("kind failed", k, e); }
    }
    try { return await makeWordTask(topic, domainKeys); }
    catch (e) {
      const loc = localRandom(domainKeys);
      if (loc) return wordTaskFromLocal(loc);
      throw e;
    }
  }

  // ---------- Проверка ответа ----------
  async function checkAnswer(userAnswer, threshold) {
    const task = state.task;
    if (!task) return null;
    state.attempts++;
    const filesText = state.files
      .filter(f => f.text)
      .map(f => `--- ${f.name} ---\n${f.text}`).join("\n");
    // склейка: текст ответа + содержимое текстовых файлов
    const combined = userAnswer + (filesText ? "\n" + filesText : "");
    const off = offlineScore({ ...task, answer: task.answer + " " + (task.extraAccept || "") }, combined);
    let verdict = { percent: off, comment: "", ai: false };
    if (getAIConfig()?.key) {
      const ai = await aiCheck(task, userAnswer, filesText);
      if (ai) verdict = { ...ai, ai: true };
    }
    const passed = verdict.percent >= threshold;
    if (passed) { state.score.solved++; }
    state.score.total++;
    return { ...verdict, passed, attempts: state.attempts };
  }

  function nextHint() {
    if (!state.task) return null;
    const h = state.task.hints[state.hintLevel];
    if (h !== undefined) state.hintLevel++;
    return h ?? "Подсказки закончились 😌";
  }

  function revealAnswer() {
    if (!state.task) return null;
    return { answer: state.task.answer, desc: state.task.desc, infoUrl: state.task.infoUrl, articleUrl: state.task.articleUrl, articleName: state.task.articleName };
  }

  function attachFiles(fileList) {
    for (const f of fileList) {
      const entry = { name: f.name, type: f.type, size: f.size, text: null, dataUrl: null };
      if (/^image\//.test(f.type)) {
        const r = new FileReader();
        r.onload = () => { entry.dataUrl = r.result; renderThumbs(); };
        r.readAsDataURL(f);
      } else if (/text|json|csv|javascript|python/.test(f.type) || /\.(txt|md|js|py|csv|json)$/i.test(f.name)) {
        const r = new FileReader();
        r.onload = () => { entry.text = String(r.result).slice(0, 5000); };
        r.readAsText(f);
      }
      state.files.push(entry);
    }
    renderThumbs();
  }
  function clearFiles() { state.files = []; renderThumbs(); }

  function renderThumbs() {
    const box = document.getElementById("fileThumbs");
    if (!box) return;
    box.innerHTML = "";
    for (const f of state.files) {
      const chip = document.createElement("span");
      chip.className = "file-chip";
      if (f.dataUrl) {
        const im = document.createElement("img");
        im.src = f.dataUrl; im.alt = f.name;
        chip.appendChild(im);
      } else {
        chip.textContent = "📄 " + f.name;
      }
      const del = document.createElement("button");
      del.textContent = "×"; del.title = "Убрать";
      del.onclick = () => { state.files = state.files.filter(x => x !== f); renderThumbs(); };
      chip.appendChild(del);
      box.appendChild(chip);
    }
  }

  return {
    state, newTask, checkAnswer, nextHint, revealAnswer,
    attachFiles, clearFiles, similarity,
  };
})();
