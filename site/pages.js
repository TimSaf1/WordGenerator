// pages.js — навигация между разделами + UI логики «Эрудито» и «Переводы».

(() => {
  // ---------- Навигация (табы) ----------
  const tabs = document.querySelectorAll(".tab");
  const pages = document.querySelectorAll(".page");
  function showPage(id) {
    pages.forEach(p => { p.hidden = p.id !== id; });
    tabs.forEach(t => t.classList.toggle("active", t.dataset.page === id));
  }
  tabs.forEach(t => t.addEventListener("click", (e) => {
    e.preventDefault();
    showPage(t.dataset.page);
    history.replaceState(null, "", "#" + t.getAttribute("href").slice(1));
  }));
  window.addEventListener("hashchange", () => {
    const map = { "#generator": "page-generator", "#erudito": "page-erudito", "#translations": "page-translations" };
    showPage(map[location.hash] || "page-generator");
  });
  const initMap = { "#erudito": "page-erudito", "#translations": "page-translations" };
  if (initMap[location.hash]) showPage(initMap[location.hash]);

  // ================= ЭРУДИТО =================
  const $ = (id) => document.getElementById(id);
  const er = {
    newBtn: $("erNewBtn"), taskBox: $("erTask"), kindBadge: $("erKindBadge"),
    scoreEl: $("erScore"), imageBox: $("erImageBox"), image: $("erImage"),
    question: $("erQuestion"), answer: $("erAnswer"), files: $("erFiles"),
    checkBtn: $("erCheckBtn"), hintBtn: $("erHintBtn"), revealBtn: $("erRevealBtn"),
    hintsBox: $("erHints"), verdict: $("erVerdict"), thr: $("erThreshold"), thrLabel: $("thrLabel"),
    settingsBtn: $("erSettingsBtn"), aiBox: $("erAiSettings"),
  };
  er.thr.addEventListener("input", () => er.thrLabel.textContent = er.thr.value);

  // Настройки ИИ
  er.settingsBtn.addEventListener("click", () => { er.aiBox.hidden = !er.aiBox.hidden; });
  try {
    const cfg = JSON.parse(localStorage.getItem("erudito_ai") || "null");
    if (cfg) { $("aiProvider").value = cfg.provider || "claude"; $("aiKey").value = cfg.key || ""; $("aiModel").value = cfg.model || ""; $("aiStatus").textContent = cfg.key ? "✅ Ключ сохранён — включена ИИ-проверка" : ""; }
  } catch (e) { /* ignore */ }
  $("aiSave").addEventListener("click", () => {
    const cfg = { provider: $("aiProvider").value, key: $("aiKey").value.trim(), model: $("aiModel").value.trim() };
    localStorage.setItem("erudito_ai", JSON.stringify(cfg));
    $("aiStatus").textContent = cfg.key ? "✅ Ключ сохранён — включена ИИ-проверка" : "⚠ Ключ пуст — работает офлайн-проверка";
  });

  function updateScore() {
    const s = Erudito.state.score;
    er.scoreEl.textContent = s.total ? `Решено: ${s.solved}/${s.total}` : "";
  }

  async function loadErTask() {
    er.newBtn.disabled = true;
    er.newBtn.textContent = "Генерирую задачку… 🎲";
    er.verdict.hidden = true; er.hintsBox.innerHTML = "";
    Erudito.state.attempts = 0; Erudito.state.hintLevel = 0;
    Erudito.clearFiles();
    const topic = $("erTopic").value.trim();
    const kind = document.querySelector('input[name="erKind"]:checked').value;
    try {
      const task = await Erudito.newTask(kind, topic || null, null);
      Erudito.state.task = task;
      er.taskBox.hidden = false;
      er.kindBadge.textContent = task.kindName;
      er.question.textContent = task.question;
      er.answer.value = "";
      if (task.imageUrl && !task.hideLabelInHint) {
        er.imageBox.hidden = false;
        er.image.src = task.imageUrl;
        er.image.onerror = () => { // фолбэк картинки из интернета
          er.image.onerror = () => { er.imageBox.hidden = true; };
          er.image.src = `https://picsum.photos/seed/${encodeURIComponent(task.imgSeed || "erudito")}/640/360`;
        };
      } else if (task.imageUrl) {
        er.imageBox.hidden = false; er.image.src = task.imageUrl;
        er.image.onerror = () => { er.imageBox.hidden = true; };
      } else { er.imageBox.hidden = true; }
      updateScore();
    } catch (e) {
      er.verdict.hidden = false;
      er.verdict.className = "verdict fail";
      er.verdict.textContent = "Не удалось сгенерировать задачку (источники недоступны). Попробуйте ещё раз или выберите другую тему.";
    } finally {
      er.newBtn.disabled = false;
      er.newBtn.textContent = "Новая задачка 🧠";
    }
  }
  er.newBtn.addEventListener("click", loadErTask);
  er.files.addEventListener("change", (e) => { Erudito.attachFiles(e.target.files); e.target.value = ""; });

  er.checkBtn.addEventListener("click", async () => {
    if (!Erudito.state.task) return;
    er.checkBtn.disabled = true; er.checkBtn.textContent = "Проверяю…";
    try {
      const r = await Erudito.checkAnswer(er.answer.value, Number(er.thr.value));
      er.verdict.hidden = false;
      if (r.passed) {
        er.verdict.className = "verdict pass";
        er.verdict.innerHTML = `🎉 <b>Верно!</b> Правильность: <b>${r.percent}%</b> (порог ${er.thr.value}%)` +
          (r.ai ? " · проверено ИИ" : " · офлайн-проверка") +
          (r.comment ? `<br><i>${r.comment}</i>` : "") +
          `<br><a href="${(Erudito.state.task.infoUrl || "#").replace(/"/g, "%22")}" target="_blank">ℹ Источник</a> · ` +
          `<a href="${(Erudito.state.task.articleUrl || "#").replace(/"/g, "%22")}" target="_blank">📰 ${Erudito.state.task.articleName || "Статья по теме"}</a>`;
        updateScore();
      } else {
        const left = Math.max(0, 3 - Erudito.state.attempts);
        er.verdict.className = "verdict fail";
        er.verdict.innerHTML = (r.duplicate
          ? `🔁 <b>Ответ не засчитан:</b> ${r.comment || "текст должен быть уникальным"}`
          : `❌ Пока неверно: <b>${r.percent}%</b> нужно ≥ ${er.thr.value}%.` + (r.comment ? ` <i>${r.comment}</i>` : "")) +
          (left > 0 ? ` Осталось попыток: <b>${left}</b>. Подумай и попробуй ещё раз, или возьми 💡 подсказку.` : ` Попытки кончились — нажми «Показать ответ» или возьми новую задачку.`);
      }
    } finally {
      er.checkBtn.disabled = false; er.checkBtn.textContent = "Проверить ✔";
    }
  });

  er.hintBtn.addEventListener("click", () => {
    const h = Erudito.nextHint();
    if (!h) return;
    const li = document.createElement("div");
    li.className = "hint-item";
    li.textContent = "💡 " + h;
    er.hintsBox.appendChild(li);
  });

  er.revealBtn.addEventListener("click", () => {
    const a = Erudito.revealAnswer();
    if (!a) return;
    er.verdict.hidden = false;
    er.verdict.className = "verdict reveal";
    er.verdict.innerHTML = `🔑 Ответ: <b>${a.answer}</b><br>${(a.desc || "").slice(0, 300)}` +
      (a.infoUrl ? `<br><a href="${a.infoUrl}" target="_blank">ℹ Подробнее</a>` : "") +
      (a.articleUrl ? ` · <a href="${a.articleUrl}" target="_blank">📰 ${a.articleName || "Статья"}</a>` : "");
  });

  // ================= ПЕРЕВОДЫ =================
  const tr = {
    newBtn: $("trNewBtn"), card: $("trCard"), word: $("trWord"), prompt: $("trPrompt"),
    answer: $("trAnswer"), checkBtn: $("trCheckBtn"), hintBtn: $("trHintBtn"),
    revealBtn: $("trRevealBtn"), verdict: $("trVerdict"), stats: $("trStats"),
    thr: $("trThreshold"), thrLabel: $("trThrLabel"),
  };
  tr.thr.addEventListener("input", () => tr.thrLabel.textContent = tr.thr.value);

  async function newTrRound() {
    tr.newBtn.disabled = true; tr.newBtn.textContent = "Ищу слово…";
    tr.verdict.hidden = true;
    const level = document.querySelector('input[name="trLevel"]:checked')?.value || "intermediate";
    try {
      const round = await Translations.newRound("en", level);
      tr.card.hidden = false;
      tr.word.textContent = round.dir === "ru2en" ? round.ru : round.en;
      tr.prompt.textContent = (round.dir === "ru2en"
        ? "Переведи это слово на английский и напиши, что оно означает."
        : "Переведи это слово на русский и напиши, что оно означает.") +
        ` [уровень: ${({elementary:"базовый", intermediate:"средний", advanced:"сложный", offline:"офлайн"})[round.level] || round.level}; источник: ${round.source || "Викисловарь"}]`;
      tr.answer.value = "";
      updateTrStats();
    } finally {
      tr.newBtn.disabled = false; tr.newBtn.textContent = "Новое слово 🌍";
    }
  }
  function updateTrStats() {
    const s = Translations.state;
    tr.stats.textContent = s.total ? `${s.solved}/${s.total} · точность ${Math.round(s.solved / s.total * 100)}% · серия ${s.streak} (рекорд ${s.best})` : "";
  }
  tr.newBtn.addEventListener("click", newTrRound);

  tr.checkBtn.addEventListener("click", async () => {
    if (!Translations.state.round) return;
    tr.checkBtn.disabled = true; tr.checkBtn.textContent = "Проверяю…";
    try {
      const r = await Translations.checkAnswer(tr.answer.value, Number(tr.thr.value));
      tr.verdict.hidden = false;
      const ans = Translations.reveal();
      if (r.passed) {
        tr.verdict.className = "verdict pass";
        tr.verdict.innerHTML = `🎉 Верно! (${r.percent}%) ${ans.ru} → <b>${ans.en}</b><br><i>${ans.def}</i>` +
          (r.ai ? " · проверено ИИ" : "") + (r.comment ? `<br><i>${r.comment}</i>` : "");
      } else {
        tr.verdict.className = "verdict fail";
        tr.verdict.innerHTML = `❌ ${r.percent}% < ${tr.thr.value}%. Попробуй ещё раз или бери подсказку.` + (r.comment ? ` <i>${r.comment}</i>` : "");
      }
      updateTrStats();
    } finally {
      tr.checkBtn.disabled = false; tr.checkBtn.textContent = "Проверить ✔";
    }
  });

  tr.hintBtn.addEventListener("click", () => {
    const h = Translations.hint();
    if (!h) return;
    tr.verdict.hidden = false;
    tr.verdict.className = "verdict reveal";
    tr.verdict.textContent = "💡 " + h;
  });

  tr.revealBtn.addEventListener("click", () => {
    const a = Translations.reveal();
    if (!a) return;
    tr.verdict.hidden = false;
    tr.verdict.className = "verdict reveal";
    tr.verdict.innerHTML = `🔑 ${a.ru} → <b>${a.en}</b><br><i>${a.def}</i>`;
  });
})();
