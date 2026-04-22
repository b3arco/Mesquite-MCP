const state = {
  data: null
};

const statsEl = document.querySelector("#stats");
const boardEl = document.querySelector("#pipeline-board");
const taskListEl = document.querySelector("#task-list");
const eventListEl = document.querySelector("#event-list");
const taskLeadSelectEl = document.querySelector("#task-lead-select");
const scrapeResultsEl = document.querySelector("#scrape-results");

document.querySelector("[data-refresh]").addEventListener("click", () => loadDashboard());
document.querySelector("#lead-form").addEventListener("submit", handleLeadSubmit);
document.querySelector("#task-form").addEventListener("submit", handleTaskSubmit);
document.querySelector("#scrape-form").addEventListener("submit", handleScrapeSubmit);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

async function loadDashboard() {
  try {
    const data = await api("/api/dashboard");
    state.data = data;
    renderDashboard();
  } catch (error) {
    statsEl.innerHTML = `<div class="empty">${error.message}</div>`;
  }
}

function renderDashboard() {
  renderStats();
  renderPipeline();
  renderTasks();
  renderEvents();
  hydrateLeadSelect();
}

function renderStats() {
  statsEl.innerHTML = state.data.counts
    .map(
      (item) => `
        <article class="stat">
          <span>${item.status.replace("_", " ")}</span>
          <strong>${item.count}</strong>
        </article>
      `
    )
    .join("");
}

function renderPipeline() {
  boardEl.innerHTML = state.data.statuses
    .map((status) => {
      const leads = state.data.leads.filter((lead) => lead.status === status);
      const cards = leads.length
        ? leads
            .map(
              (lead) => `
                <article class="lead-card">
                  <h5>${escapeHtml(lead.name || "Unnamed lead")}</h5>
                  <p class="lead-meta">${escapeHtml(lead.company || lead.service || "No company/service yet")}</p>
                  <p class="lead-meta">${escapeHtml(lead.email || lead.phone || lead.website || "No contact info")}</p>
                  <div class="lead-actions">
                    ${state.data.statuses
                      .filter((next) => next !== status)
                      .slice(0, 3)
                      .map(
                        (next) =>
                          `<button data-lead-status="${lead.id}" data-next-status="${next}">${next.replace("_", " ")}</button>`
                      )
                      .join("")}
                  </div>
                </article>
              `
            )
            .join("")
        : `<div class="empty">No leads in this stage.</div>`;

      return `
        <section class="column">
          <h4>${status.replace("_", " ")}</h4>
          ${cards}
        </section>
      `;
    })
    .join("");

  boardEl.querySelectorAll("[data-lead-status]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/leads/${button.dataset.leadStatus}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: button.dataset.nextStatus })
      });
      await loadDashboard();
    });
  });
}

function renderTasks() {
  taskListEl.innerHTML = state.data.tasks.length
    ? state.data.tasks
        .map(
          (task) => `
            <article class="task-item">
              <h5>${escapeHtml(task.title)}</h5>
              <p>${escapeHtml(task.leadName || task.leadCompany || "Unknown lead")}</p>
              <p>${escapeHtml(task.channel || "general")} ${task.dueAt ? `· due ${new Date(task.dueAt).toLocaleString()}` : ""}</p>
            </article>
          `
        )
        .join("")
    : `<div class="empty">No follow-up tasks yet.</div>`;
}

function renderEvents() {
  eventListEl.innerHTML = state.data.recentEvents.length
    ? state.data.recentEvents
        .map(
          (event) => `
            <article class="event-item">
              <strong>${escapeHtml(event.eventType)}</strong>
              <p>${escapeHtml(event.leadName || event.leadCompany || "Unknown lead")}</p>
              <p>${escapeHtml(event.body || "")}</p>
            </article>
          `
        )
        .join("")
    : `<div class="empty">No events yet.</div>`;
}

function hydrateLeadSelect() {
  taskLeadSelectEl.innerHTML = state.data.leads
    .map(
      (lead) =>
        `<option value="${lead.id}">${escapeHtml(lead.name || lead.company || lead.email || lead.id)}</option>`
    )
    .join("");
}

async function handleLeadSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);

  await api("/api/leads", {
    method: "POST",
    body: JSON.stringify({
      name: form.get("name") || null,
      company: form.get("company") || null,
      email: form.get("email") || null,
      phone: form.get("phone") || null,
      website: form.get("website") || null,
      service: form.get("service") || null,
      source: form.get("source") || "manual",
      status: form.get("status"),
      notes: form.get("notes") || null,
      tags: String(form.get("tags") || "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    })
  });

  event.currentTarget.reset();
  await loadDashboard();
}

async function handleTaskSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);

  await api("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      leadId: form.get("leadId"),
      title: form.get("title"),
      channel: form.get("channel") || null,
      dueAt: form.get("dueAt") || null,
      details: form.get("details") || null
    })
  });

  event.currentTarget.reset();
  await loadDashboard();
}

async function handleScrapeSubmit(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);

  scrapeResultsEl.className = "results";
  scrapeResultsEl.innerHTML = "Running scrape...";

  try {
    const result = await api("/api/scrape", {
      method: "POST",
      body: JSON.stringify({
        actorId: form.get("actorId") || undefined,
        limit: Number(form.get("limit") || 10),
        runInput: {
          queries: form.get("query"),
          countryCode: form.get("countryCode") || "us",
          languageCode: form.get("languageCode") || "en",
          maxPagesPerQuery: Number(form.get("maxPagesPerQuery") || 2)
        }
      })
    });

    scrapeResultsEl.innerHTML = `<pre>${escapeHtml(JSON.stringify(result, null, 2))}</pre>`;
  } catch (error) {
    scrapeResultsEl.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

loadDashboard();
