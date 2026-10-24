const TYPE_LABELS = { word: "Слово", phrase: "Выражение", collocation: "Словосочетание" };
const usedTerms = new Set(); // для режима «без повторов»

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

function generate() {
  const selected = getSelectedDomains();
  if (!selected.length) {
    showNotice("⚠️ Выберите хотя бы одну сферу (область) в чекбоксах.");
    return;
  }

  const type = document.querySelector('input[name="wordType"]:checked').value;
  const count = Number(countRange.value);
  const noDup = document.getElementById("noDuplicates").checked;

  let pool = WORDS_DB.filter(w => selected.includes(w.domain));
  if (type !== "all") pool = pool.filter(w => w.type === type);

  if (noDup) pool = pool.filter(w => !usedTerms.has(w.term));

  if (!pool.length) {
    showNotice("😕 По выбранным фильтрам слов не осталось. Попробуйте добавить сферы, сменить тип лексики или снять ограничение «без повторов».");
    return;
  }

  const picked = shuffle(pool).slice(0, count);
  if (noDup) picked.forEach(w => usedTerms.add(w.term));

  render(picked);
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

function render(items) {
  const showImages = document.getElementById("showImages").checked;
  const results = document.getElementById("results");
  results.innerHTML = "";

  items.forEach((w, idx) => {
    const card = document.createElement("article");
    card.className = "card";
    card.style.animationDelay = `${idx * 0.08}s`;

    const imgHtml = showImages
      ? `<img class="card-img" src="https://picsum.photos/seed/${encodeURIComponent(w.imgSeed)}/640/300" alt="Иллюстрация к «${esc(w.term)}»" loading="lazy">`
      : "";

    card.innerHTML = `
      ${imgHtml}
      <div class="card-body">
        <div class="badges">
          <span class="badge badge-type">${TYPE_LABELS[w.type]}</span>
          <span class="badge badge-domain">${DOMAINS[w.domain]}</span>
        </div>
        <h3 class="term">${esc(w.term)}</h3>
        <p class="desc">${esc(w.desc)}</p>
        <div class="related">
          <strong>Похожие и связанные слова:</strong>
          ${w.related.map(r => `<button type="button" class="chip" title="Нажмите, чтобы скопировать">${esc(r)}</button>`).join("")}
        </div>
        <div class="links">
          <a href="${esc(w.infoUrl)}" target="_blank" rel="noopener">ℹ️ Информационный ресурс (Википедия)</a>
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
