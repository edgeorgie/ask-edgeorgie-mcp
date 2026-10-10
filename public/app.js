const form = document.getElementById("ask-form");
const input = document.getElementById("question");
const resultEl = document.getElementById("result");

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = input.value.trim();
  if (!question) return;
  resultEl.hidden = false;
  resultEl.innerHTML = '<p class="loading">Retrieving + answering…</p>';
  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();
    if (!res.ok) {
      resultEl.innerHTML = `<p class="loading">Error: ${escapeHtml(data.error || res.statusText)}</p>`;
      return;
    }
    const citationsHtml = (data.citations || [])
      .map(
        (c) =>
          `<div class="citation"><span class="loc">[${c.rank}] ${escapeHtml(c.source)} (lines ${c.startLine}-${c.endLine}, score ${c.score})</span><br/>${escapeHtml(c.excerpt.slice(0, 280))}${c.excerpt.length > 280 ? "…" : ""}</div>`,
      )
      .join("");
    resultEl.innerHTML =
      `<span class="badge">answerMode: ${escapeHtml(data.answerMode)}${data.model ? " · " + escapeHtml(data.model) : ""}</span>` +
      `<div class="answer">${escapeHtml(data.answer)}</div>` +
      citationsHtml;
  } catch (err) {
    resultEl.innerHTML = `<p class="loading">Request failed: ${escapeHtml(String(err))}</p>`;
  }
});

const storyEl = document.getElementById("story");
if (storyEl) {
  fetch("/api/story")
    .then((res) => res.json())
    .then((data) => {
      const beatsHtml = (data.beats || [])
        .map(
          (b) =>
            `<div class="story-beat"><span class="year">${escapeHtml(b.year)}</span><span class="label">${escapeHtml(b.label)}</span><p class="body">${escapeHtml(b.body)}</p></div>`,
        )
        .join("");
      storyEl.innerHTML = `<p class="story-intro">${escapeHtml(data.intro || "")}</p>${beatsHtml}`;
    })
    .catch((err) => {
      storyEl.innerHTML = `<p class="loading">Could not load story: ${escapeHtml(String(err))}</p>`;
    });
}
