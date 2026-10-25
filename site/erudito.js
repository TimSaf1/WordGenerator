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
      (task.kind === "describe"
        ? `ЭТАЛОННОЕ ОПИСАНИЕ СЛОВА «${task.termToDescribe}»: ${task.answer}\n` +
          `Задача была: написать СВОЁ описание этого слова. Оцени, насколько описание игрока передаёт суть (своими словами — это хорошо; дословная копия эталона — снижай балл).\n`
        : `ЭТАЛОННЫЙ ОТВЕТ: ${task.answer}\n` +
          `КРАТКОЕ ОПИСАНИЕ: ${task.desc || ""}\n\n`) +
      `Также важно: ответ должен быть УНИКАЛЬНЫМ текстом пользователя (не пустой, не набор символов). ` +
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

  // ---------- Уникальность ответов пользователя ----------
  // Тексты уже отправленных ответов хранятся в localStorage (по задаче).
  // Повторяющийся (или почти повторяющийся) ответ не засчитывается.
  function usedAnswersKey() {
    return "erudito_answers_" + (state.task ? norm(state.task.answer).slice(0, 40) : "none");
  }
  function getUsedAnswers() {
    try { return JSON.parse(localStorage.getItem(usedAnswersKey()) || "[]"); } catch { return []; }
  }
  function rememberAnswer(text) {
    const key = usedAnswersKey();
    const list = getUsedAnswers();
    list.push(norm(text));
    localStorage.setItem(key, JSON.stringify(list.slice(-30)));
  }
  // true — если ответ по сути дублирует уже вводившийся
  function isDuplicateAnswer(text) {
    const a = norm(text);
    if (!a) return false;
    return getUsedAnswers().some(prev => prev && similarity(a, prev) >= 0.92);
  }

  // ---------- Защита от «слива» ответа в тексте задачи ----------
  // Если эталонный ответ замечен прямо в условии — задача бракуется и
  // генерируется новая (в условии может быть только намёк).
  function leaksAnswer(task) {
    const q = norm(task.question || "");
    const a = norm(task.answer || "");
    if (!q || !a) return false;
    if (a.length >= 4 && q.includes(a)) return true;
    for (const alt of (task.accept || [])) {
      const n = norm(alt);
      if (n.length >= 5 && q.includes(n)) return true;
    }
    return false;
  }

  // ---------- Генерация задачек (любые источники) ----------
  const KINDS = ["word", "article", "algo", "image", "quote", "math", "physics", "code", "describe"];

  function localRandom(domainKeys) {
    const pool = WORDS_DB.filter(w => !domainKeys?.length || domainKeys.includes(w.domain));
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // Тип 1: «Что это за слово?» — описание без слова, угадай термин.
  // Текст описания очищается от упоминания самого ответа (только намёк).
  function scrubAnswer(text, term) {
    if (!text || !term) return text;
    let out = String(text);
    const parts = norm(term).split(" ").filter(w => w.length >= 4);
    for (const p of parts) {
      // маскируем слово и его словоформы (первые 5 букв как корень-префикс)
      const root = p.slice(0, Math.min(p.length, 6));
      out = out.replace(new RegExp(root + "[\\w'-]*", "gi"), "████");
    }
    return out;
  }

  async function makeWordTask(topic, domainKeys) {
    let item = null;
    try {
      if (topic) item = await Api.topicCard(topic, domainKeys?.[0]);
      else item = await Api.buildCard(domainKeys?.[0] || "Наука", domainKeys?.[0]);
    } catch (e) { /* fallback на локальную базу */ }
    if (!item) item = localRandom(domainKeys);
    if (!item) throw new Error("нет данных для задачки");
    const cleanDesc = scrubAnswer(item.desc, item.term);
    const q = `Как называется это ${item.type === "word" ? "слово" : "понятие / выражение"}? Ответь одним словом или словосочетанием.\n\n«${cleanDesc}»`;
    return {
      kind: "word", kindName: "Угадай слово",
      question: q, answer: item.term,
      desc: cleanDesc, accept: (item.related || []).filter(r => norm(r) !== norm(item.term)),
      imageUrl: item.imageUrl, imgSeed: item.imgSeed,
      infoUrl: item.infoUrl, articleUrl: item.articleUrl, articleName: item.articleName,
      hints: buildHints(item.term, cleanDesc, item.related),
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

  // Тип 6: математическая задачка — условия с данными, ответ-число
  function makeMathTask() {
    const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
    const variants = [
      () => {
        const a = ri(12, 90), b = ri(3, 15), c = ri(2, 9);
        return { q: `Арифметика с условиями: из числа ${a} вычли ${b}, результат умножили на ${c} и прибавили ${b}. Какое число получилось?`, a: String((a - b) * c + b) };
      },
      () => {
        const x = ri(3, 12), k = ri(2, 9), d = ri(4, 15);
        // Уравнение: k·x − (k+1)·d = (k−1)·x ⟹ ответ x; в условии x не встречается.
        return { q: `Задуманное число x удовлетворяет уравнению: ${k}·x − ${(k + 1) * d} = ${k - 1}·x. Найди x. Ответь числом.`, a: String(x) };
      },
      () => {
        const n = ri(4, 9);
        const sum = (n * (n + 1)) / 2;
        return { q: `Последовательность: сложите все целые числа от 1 до ${n} включительно (без калькулятора — по формуле или перебором). Какой итог?`, a: String(sum) };
      },
      () => {
        const a = ri(2, 9), b = ri(2, 9);
        const root = a * b;
        return { q: `Прямоугольник со сторонами ${a} и ${b} см. Квадрат имеет сторону, равную площади этого прямоугольника (в см). Найдите периметр квадрата (см).`, a: String(root * 4) };
      },
      () => {
        const v = ri(40, 90), t = ri(2, 6);
        return { q: `Задача на движение: поезд идёт со скоростью ${v} км/ч ровно ${t} ч, затем стоянка, потом ещё половина пути. Каков общий путь ПЕРВОЙ части поездки (до стоянки) в км?`, a: String(v * t) };
      },
    ];
    let t;
    for (let i = 0; i < 8; i++) {
      t = variants[Math.floor(Math.random() * variants.length)]();
      const nums = [...t.q.matchAll(/(?<![\d.,-])(\d+)(?![\d.,])/g)].map(m => m[1]);
      if (!(t.a.length >= 2 && nums.includes(t.a))) break; // условие не выдаёт ответ числом
    }
    return {
      kind: "math", kindName: "Математика",
      question: t.q + "\n\nОтветь числом (можно с кратким решением).", answer: t.a, desc: t.a,
      accept: [], imgSeed: "math-puzzle", imageUrl: null,
      infoUrl: "https://ru.wikipedia.org/wiki/%D0%9C%D0%B0%D1%82%D0%B5%D0%BC%D0%B0%D1%82%D0%B8%D0%BA%D0%B0",
      articleUrl: "https://nplus1.ru/rubric/science", articleName: "N+1 · Наука",
      hints: ["Нужен точный числовой ответ", "Разбей условие на шаги и считай последовательно", "Прикинь порядок величины, чтобы проверить себя"],
    };
  }

  // Тип 7: физическая задачка — данные + формула, ответ-число
  function makePhysicsTask() {
    const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
    const variants = [
      () => {
        const m = ri(2, 20), a = ri(2, 10);
        return { q: `Тело массой ${m} кг движется с ускорением ${a} м/с². Какая сила (в ньютонах) на него действует? (Второй закон Ньютона)`, a: String(m * a) };
      },
      () => {
        const v = ri(5, 30), t = ri(3, 15);
        return { q: `Автомобиль идёт равномерно со скоростью ${v} м/с в течение ${t} с. Какой путь он проедет (в метрах)?`, a: String(v * t) };
      },
      () => {
        const m = ri(2, 10), h = ri(2, 20);
        return { q: `Кирпич массой ${m} кг подняли на высоту ${h} м. Чему равна его потенциальная энергия (Дж)? Ускорение свободного падения g = 10 м/с². Формула: E = m·g·h.`, a: String(m * 10 * h) };
      },
      () => {
        const I = ri(2, 9), R = ri(3, 12); // U = I·R — целые всегда
        return { q: `По проводнику с сопротивлением ${R} Ом течёт ток ${I} А. Найдите напряжение на проводнике (В). Закон Ома: U = I·R.`, a: String(I * R) };
      },
      () => {
        const rho = ri(2, 9), V = ri(10, 50);
        return { q: `Объём жидкости ${V} л (≈ ${V} дм³), плотность условного вещества ${rho} кг/дм³. Какова масса (кг)? m = ρ·V.`, a: String(rho * V) };
      },
    ];
    let t;
    for (let i = 0; i < 8; i++) {
      t = variants[Math.floor(Math.random() * variants.length)]();
      const nums = [...t.q.matchAll(/(?<![\d.,-])(\d+)(?![\d.,])/g)].map(m => m[1]);
      if (!(t.a.length >= 2 && nums.includes(t.a))) break; // условие не выдаёт ответ
    }
    return {
      kind: "physics", kindName: "Физика",
      question: t.q + "\n\nОтветь числом с единицей измерения (например: «56 Н»).", answer: t.a, desc: t.a,
      accept: [], imgSeed: "physics-puzzle", imageUrl: null,
      infoUrl: "https://ru.wikipedia.org/wiki/%D0%A4%D0%B8%D0%B7%D0%B8%D0%BA%D0%B0",
      articleUrl: "https://elementy.ru/", articleName: "Элементы · Физика",
      hints: ["Вспомни базовую формулу темы", "Подставь числа пошагово", "Проверь размерность ответа"],
    };
  }

  // Тип 8: задача на программирование — условия, данные, направленность
  function makeCodeTask() {
    const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
    const variants = [
      () => {
        const arr = Array.from({ length: ri(5, 8) }, () => ri(1, 50));
        const mx = Math.max(...arr);
        return {
          q: `Напишите функцию (любой язык — псевдокод тоже подойдёт), которая возвращает максимальный элемент списка. Данные для проверки: [${arr.join(", ")}]. Укажите также ожидаемый результат. Можно приложить файл с кодом (.py/.js).`,
          a: String(mx), extra: "max maximum максимум алгоритм проход цикл сравнение",
        };
      },
      () => {
        const n = ri(3, 7);
        const fact = [1, 1, 2, 6, 24, 120, 720, 5040][n];
        return {
          q: `Реализуйте факториал числа N рекурсивно: f(0)=1, f(n)=n·f(n−1). Для проверки напишите значение f(${n}) и покажите саму функцию (можно файлом).`,
          a: String(fact), extra: "рекурс рекурсия factorial факториал base case",
        };
      },
      () => {
        const s = ["эрудиция", "словарь", "алгоритм", "картинка", "вики"][ri(0, 4)];
        const rev = s.split("").reverse().join("");
        return {
          q: `Напишите функцию-палиндром-проверщик или инвертор строки. Дано слово «${s}». Задание: верните его, записанное задом наперёд (ответ — одно слово без кавычек). Код можно приложить файлом.`,
          a: rev, extra: "reverse переворот строка slice join split",
        };
      },
      () => {
        const words = ["кот", "дом", "кот", "лес", "дом", "кот"];
        return {
          q: `Дан список слов: [${words.map(w => `"${w}"`).join(", ")}]. Напишите идею (или код) подсчёта частоты каждого слова. Какое слово встречается чаще всего и сколько раз? Ответ запишите так: «слово число» (например: «стол 2»).`,
          a: "кот 3", extra: "кот три частота словарь dict counter",
        };
      },
    ];
    const t = variants[Math.floor(Math.random() * variants.length)]();
    return {
      kind: "code", kindName: "Программирование",
      question: t.q, answer: t.a, desc: t.a,
      accept: [], extraAccept: t.extra, imgSeed: "coding-puzzle", imageUrl: null,
      infoUrl: "https://developer.mozilla.org/ru/",
      articleUrl: "https://habr.com/ru/hubs/development/", articleName: "Хабр · Разработка",
      hints: ["Это задача на алгоритм — начни с простого перебора", "Главное — корректный финальный результат", "Можно прикрепить файл с кодом для ИИ-проверки"],
    };
  }

  // Тип 9: обратная задача — дано слово, нужно написать своё описание
  async function makeDescribeTask(topic, domainKeys) {
    let item = null;
    try {
      if (topic) item = await Api.topicCard(topic, domainKeys?.[0]);
      else item = await Api.buildCard(domainKeys?.[0] || "Наука", domainKeys?.[0]);
    } catch (e) { /* fallback */ }
    if (!item) item = localRandom(domainKeys);
    if (!item) throw new Error("нет данных");
    return {
      kind: "describe", kindName: "Опиши своими словами",
      question: `Дано слово / выражение: «${item.term}».\nНапиши СВОЁ краткое описание того, что это такое (2–4 предложения, своими словами — копия из словаря не подойдёт). Чем полнее и точнее, тем выше процент правильности.`,
      answer: item.desc, desc: item.desc,
      termToDescribe: item.term,
      accept: item.related || [],
      imageUrl: item.imageUrl, imgSeed: item.imgSeed,
      infoUrl: item.infoUrl, articleUrl: item.articleUrl, articleName: item.articleName,
      hints: buildHints(item.term, scrubAnswer(item.desc, item.term), item.related),
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
      ? [...KINDS].sort(() => Math.random() - 0.5) // «любые» — перемешиваем все типы
      : [kind];
    let lastTask = null;
    // если выбранный тип не удался — автооткат на word
    for (const k of kinds) {
      try {
        let task = null;
        switch (k) {
          case "word": task = await makeWordTask(topic, domainKeys); break;
          case "article": task = await makeArticleTask(topic, domainKeys); break;
          case "algo": task = await makeAlgoTask(topic); break;
          case "image": task = await makeImageTask(topic); break;
          case "quote": task = await makeQuoteTask(topic); break;
          case "math": task = makeMathTask(); break;
          case "physics": task = makePhysicsTask(); break;
          case "code": task = makeCodeTask(); break;
          case "describe": task = await makeDescribeTask(topic, domainKeys); break;
        }
        if (!task) continue;
        // «Опиши своими словами» легально содержит термин в условии — для него проверка не нужна
        if (task.kind !== "describe" && leaksAnswer(task)) {
          console.warn("leaky task rejected:", task.kind, task.answer);
          continue; // в условии мелькнул ответ — берём другую задачку
        }
        return task;
      } catch (e) { console.warn("kind failed", k, e); }
    }
    try {
      lastTask = await makeWordTask(topic, domainKeys);
      if (lastTask && !leaksAnswer(lastTask)) return lastTask;
    } catch (e) { /* fallback ниже */ }
    const loc = localRandom(domainKeys);
    if (loc) return wordTaskFromLocal(loc);
    throw new Error("не удалось сгенерировать задачу");
  }

  // ---------- Проверка ответа ----------
  async function checkAnswer(userAnswer, threshold) {
    const task = state.task;
    if (!task) return null;

    // 0) УНИКАЛЬНОСТЬ: текст должен быть новым (не дублировать прошлые попытки).
    //    Для «опиши своими словами» — минимальная длина описания.
    if (!userAnswer.trim()) {
      return { percent: 0, comment: "Пустой ответ — напиши что-нибудь.", passed: false, attempts: state.attempts, duplicate: true };
    }
    if (isDuplicateAnswer(userAnswer)) {
      return { percent: 0, comment: "Такой текст ты уже отправлял — нужен новый, уникальный ответ.", passed: false, attempts: state.attempts, duplicate: true };
    }
    if (task.kind === "describe" && norm(userAnswer).split(" ").length < 5) {
      return { percent: 0, comment: "Слишком короткое описание — нужно минимум 5 слов своими словами.", passed: false, attempts: state.attempts, duplicate: true };
    }

    state.attempts++;
    const filesText = state.files
      .filter(f => f.text)
      .map(f => `--- ${f.name} ---\n${f.text}`).join("\n");
    // склейка: текст ответа + содержимое текстовых файлов
    const combined = userAnswer + (filesText ? "\n" + filesText : "");

    // Для обратной задачи («опиши слово») сравниваем с эталонным ОПИСАНИЕМ,
    // а не угадываем словом; плюс штраф за дословную копию словарного текста.
    let off;
    if (task.kind === "describe") {
      const copySim = similarity(userAnswer, task.desc);
      off = Math.round(Math.max(
        copySim * 100,
        keywordsOverlapScore(task.desc, userAnswer),
      ));
      if (copySim > 0.9) off = Math.min(off, 40); // копипаст из словаря не засчитаем как свой текст
    } else {
      off = offlineScore({ ...task, answer: task.answer + " " + (task.extraAccept || "") }, combined);
    }

    let verdict = { percent: off, comment: "", ai: false };
    if (getAIConfig()?.key) {
      const ai = await aiCheck(task, userAnswer, filesText);
      if (ai) verdict = { ...ai, ai: true };
    }
    const passed = verdict.percent >= threshold;
    rememberAnswer(userAnswer); // запоминаем для проверки уникальности следующих попыток
    if (passed) { state.score.solved++; }
    state.score.total++;
    return { ...verdict, passed, attempts: state.attempts };
  }

  // Сколько ключевых слов эталона присутствует в ответе (0–85)
  function keywordsOverlapScore(reference, answer) {
    const kws = keywords(reference, 10).map(norm);
    const a = norm(answer);
    if (!kws.length) return 0;
    const hit = kws.filter(k => k.length >= 4 && a.includes(k)).length;
    return Math.min(85, Math.round(hit / Math.max(3, kws.length * 0.45) * 70));
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
