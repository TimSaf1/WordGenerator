// translations.js — игра «Переводы»: перевод слова с языка на язык +
// ИИ/офлайн-проверка значения + подсчёт результата (серия, очки, точность).
// Слова берутся из живых источников: Викисловарь (langlinks → английский
// перевод), локальная база WORDS_DB (как fallback), случайные статьи Вики.

const Translations = (() => {
  const state = {
    round: null,        // {ru, en, def, dir}
    streak: 0, best: 0, solved: 0, total: 0,
    history: new Set(),
  };

  function norm(s) {
    return String(s || "").toLowerCase().replace(/ё/g, "е")
      .replace(/[^a-zа-я0-9\s'-]/gi, "").replace(/\s+/g, " ").trim();
  }

  // Локальные мини-словари для гарантированной игры без сети
  const LOCAL_PAIRS = [
    { ru: "алгоритм", en: "algorithm", def: "точная последовательность шагов решения задачи" },
    { ru: "нейросеть", en: "neural network", def: "математическая модель, вдохновлённая мозгом" },
    { ru: "облако", en: "cloud", def: "вычисления через интернет-инфраструктуру" },
    { ru: "дедлайн", en: "deadline", def: "крайний срок сдачи" },
    { ru: "энтропия", en: "entropy", def: "мера беспорядка в системе" },
    { ru: "фотосинтез", en: "photosynthesis", def: "питание растений на свету" },
    { ru: "маржа", en: "margin", def: "разница цены продажи и себестоимости" },
    { ru: "иммунитет", en: "immunity", def: "защита организма от инфекций" },
    { ru: "экватор", en: "equator", def: "воображаемая линия вокруг планеты" },
    { ru: "гипотеза", en: "hypothesis", def: "предположение, требующее проверки" },
    { ru: "квант", en: "quantum", def: "минимальная порция энергии" },
    { ru: "вакуум", en: "vacuum", def: "пространство почти без вещества" },
    { ru: "лаборатория", en: "laboratory", def: "помещение для экспериментов" },
    { ru: "орбита", en: "orbit", def: "траектория движения спутника" },
    { ru: "гравитация", en: "gravity", def: "притяжение тел друг к другу" },
  ];

  async function newRound(lang) {
    let pair = null;
    if (lang === "en") {
      try {
        for (let i = 0; i < 3 && !pair; i++) {
          const p = await Api.pickTranslationPair();
          if (p && !state.history.has(norm(p.ru))) pair = p;
        }
      } catch (e) { /* сеть недоступна — берём локальный словарь */ }
    }
    if (!pair) {
      const pool = LOCAL_PAIRS.filter(p => !state.history.has(norm(p.ru)));
      const src = pool.length ? pool : LOCAL_PAIRS;
      pair = src[Math.floor(Math.random() * src.length)];
    }
    state.history.add(norm(pair.ru));
    const dir = Math.random() < 0.5 ? "ru2en" : "en2ru"; // куда переводим
    state.round = { ...pair, dir };
    return state.round;
  }

  // Оценка ответа офлайн: совпадение перевода + ключи определения
  function offlineScore(round, answer) {
    const a = norm(answer);
    if (!a) return 0;
    const targetRu = norm(round.ru), targetEn = norm(round.en);
    if (round.dir === "ru2en") {
      if (a === targetEn) return 100;
      if (a.includes(targetEn) || targetEn.includes(a)) return 85;
      // частичное совпадение по словам перевода + ключам определения
      const wordsT = targetEn.split(" ");
      const hitW = wordsT.filter(w => w.length > 2 && a.includes(w)).length;
      let s = Math.min(75, Math.round(hitW / wordsT.length * 65));
      const kws = norm(round.def).split(" ").filter(w => w.length >= 4);
      const hit = kws.filter(k => a.includes(k)).length;
      s = Math.max(s, Math.min(60, Math.round(hit / Math.max(2, kws.length * 0.5) * 50)));
      return s;
    } else {
      if (a === targetRu) return 100;
      if (a.includes(targetRu) || targetRu.includes(a)) return 85;
      const root = targetRu.slice(0, Math.max(4, targetRu.length - 3)); // с учётом падежей
      let s = a.includes(root) ? 80 : 0;
      const kws = norm(round.def).split(" ").filter(w => w.length >= 4);
      const hit = kws.filter(k => a.includes(k)).length;
      s = Math.max(s, Math.min(60, Math.round(hit / Math.max(2, kws.length * 0.5) * 50)));
      return s;
    }
  }

  async function checkAnswer(answer, threshold) {
    const round = state.round;
    if (!round) return null;
    state.total++;
    const off = offlineScore(round, answer);
    let verdict = { percent: off, comment: "", ai: false };
    // если есть ключ ИИ (тот же localStorage, что у Эрудито) — умная проверка
    try {
      const cfg = JSON.parse(localStorage.getItem("erudito_ai") || "null");
      if (cfg?.key) {
        const expected = round.dir === "ru2en" ? round.en : round.ru;
        const shown = round.dir === "ru2en" ? round.ru : round.en;
        const prompt =
          `Игрок должен перевести слово «${shown}» (${round.dir === "ru2en" ? "с русского на английский" : "с английского на русский"}). ` +
          `Его ответ: «${answer}». Правильный перевод: «${expected}». Значение слова: ${round.def}. ` +
          `Оцени правильность перевода (допустимы синонимы и близкие по смыслу варианты). ` +
          `Ответь СТРОГО JSON {"percent": 0-100, "comment": "одно предложение по-русски"}.`;
        let txt = null;
        if (cfg.provider === "openai") {
          const r = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.key },
            body: JSON.stringify({ model: cfg.model || "gpt-4o-mini", messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" }, max_tokens: 120 }),
          });
          txt = (await r.json())?.choices?.[0]?.message?.content;
        } else {
          const r = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST", headers: { "Content-Type": "application/json", "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
            body: JSON.stringify({ model: cfg.model || "claude-sonnet-4-20250514", max_tokens: 200, messages: [{ role: "user", content: prompt }] }),
          });
          txt = (await r.json())?.content?.[0]?.text;
        }
        const m = txt?.match(/\{[\s\S]*\}/);
        if (m) {
          const obj = JSON.parse(m[0]);
          const p = Math.max(0, Math.min(100, Math.round(Number(obj.percent) || 0)));
          verdict = { percent: p, comment: obj.comment || "", ai: true };
        }
      }
    } catch (e) { console.warn("AI translation check failed:", e); }

    const passed = verdict.percent >= threshold;
    if (passed) { state.solved++; state.streak++; state.best = Math.max(state.best, state.streak); }
    else state.streak = 0;
    return { ...verdict, passed, result: `${state.solved}/${state.total}`, accuracy: Math.round(state.solved / state.total * 100), streak: state.streak, best: state.best };
  }

  function hint() {
    const r = state.round;
    if (!r) return null;
    const word = r.dir === "ru2en" ? r.en : r.ru;
    const n = Math.ceil(r.def.length / 3);
    return `Подсказка: значение — «${r.def.slice(0, n)}…»; в переводе ${word.length} симв., начинается на «${word[0].toUpperCase()}…»`;
  }

  function reveal() {
    const r = state.round;
    if (!r) return null;
    return { ru: r.ru, en: r.en, def: r.def };
  }

  return { state, newRound, checkAnswer, hint, reveal };
})();
