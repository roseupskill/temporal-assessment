// Juniper Salon: staff view of openings, the waitlist, and simulated client texts.
// Refreshes from /api/state once a second; countdowns tick locally.

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const shortDate = (ms) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
const first = (name) => String(name).split(" ")[0];
const initial = (name) => String(name).trim().charAt(0).toUpperCase();
const RING = 2 * Math.PI * 27; // circumference for r=27

let state = { now: Date.now(), openings: [], waitlist: [], stylists: [] };
let serverOffset = 0;
const rendered = { openings: "", waitlist: "", phones: "" };
const openHistory = new Set(); // keep "What's happened" open across refreshes

// ── Small helpers ──
async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "That didn’t go through. Try again.");
  return data;
}

let toastTimer;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3800);
}

function fmtLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function dayWord(ms) {
  const d = new Date(ms);
  const now = new Date(Date.now() + serverOffset);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

function lengthWords(min) {
  if (min === 60) return "1 hour";
  if (min === 90) return "1½ hours";
  if (min === 120) return "2 hours";
  return `${min} minutes`;
}

// ── Openings ──
const STATE = {
  finding: ["Looking", ""],
  waiting_for_clients: ["Waiting", ""],
  awaiting_approval: ["Needs you", "brass"],
  sending: ["Texting", "berry"],
  offer_out: ["Offer out", "berry"],
  booked: ["Booked", "green"],
};
const ENDED = {
  booked: ["Filled", "green"],
  no_show: ["No-show", "rose"],
  no_acceptance: ["Unfilled", "rose"],
  cutoff_reached: ["Unfilled", "rose"],
  approval_not_given: ["Unfilled", "rose"],
  reopened_too_late: ["Unfilled", "rose"],
  cancelled_by_staff: ["Released", ""],
};

function story(o) {
  const next = o.remainingEligible?.[0];
  switch (o.phase) {
    case "finding":
      return "Checking the waitlist for the next good fit…";
    case "waiting_for_clients":
      return "Everyone who fits is considering another opening right now. We’ll check again in a minute.";
    case "awaiting_approval":
      return `${first(o.proposed.name)} is next on the waitlist. Send the offer?`;
    case "sending":
      return `Texting ${first(o.proposed?.name ?? o.offer?.name ?? "the client")}…`;
    case "offer_out":
      return next
        ? `Waiting to hear back. If there’s no answer, ${first(next.name)} is next.`
        : "Waiting to hear back. No one else fits this time if there’s no answer.";
    case "booked":
      return `${first(o.booking.name)} is coming in for a ${o.booking.service.toLowerCase()}.`;
    case "ended":
      return o.outcome?.message ?? "This opening is closed.";
    default:
      return o.headline;
  }
}

function moment(o) {
  const id = esc(o.workflowId);
  const now = Date.now() + serverOffset;

  if (o.phase === "awaiting_approval" && o.proposed) {
    const p = o.proposed;
    const stylist = p.stylistPreference === "any" ? "any stylist" : p.stylistPreference;
    return `
      <div class="moment ask">
        <div class="person">
          <span class="initial">${esc(initial(p.name))}</span>
          <div>
            <p class="name">${esc(p.name)}</p>
            <p class="detail">${esc(p.service)} (${p.serviceMinutes} min) with ${esc(stylist)}, waiting since ${shortDate(p.joinedAt)}</p>
          </div>
        </div>
        <p class="quote">${esc(o.proposedMessage)}</p>
        <div class="actions">
          <button class="primary" data-action="approve" data-id="${id}" data-client="${esc(p.clientId)}">Text ${esc(first(p.name))}</button>
          <button class="secondary" data-action="skip" data-id="${id}" data-client="${esc(p.clientId)}">Skip this time</button>
        </div>
        <p class="footnote">Nothing is sent until you choose. Offers stop at ${clock(o.cutoffAt)}.</p>
      </div>`;
  }

  if (o.phase === "offer_out" && o.offer) {
    const total = o.offer.expiresAt - o.offer.sentAt;
    const left = Math.max(0, o.offer.expiresAt - now);
    return `
      <div class="moment live">
        <div class="person">
          <div class="ring" aria-hidden="true">
            <svg viewBox="0 0 64 64"><circle class="track" cx="32" cy="32" r="27" />
              <circle class="left" cx="32" cy="32" r="27" stroke-dasharray="${RING}"
                stroke-dashoffset="${RING * (1 - left / total)}" data-ring-expires="${o.offer.expiresAt}" data-ring-total="${total}" /></svg>
            <span class="initial">${esc(initial(o.offer.name))}</span>
          </div>
          <div>
            <p class="name">${esc(o.offer.name)} has the offer</p>
            <p class="detail"><span class="clock-left" data-expires="${o.offer.expiresAt}">${fmtLeft(left)}</span> left to reply. Sent at ${clock(o.offer.sentAt)}.</p>
          </div>
        </div>
      </div>`;
  }

  if (o.phase === "booked" && o.booking) {
    const started = now >= o.opening.startsAt;
    return `
      <div class="moment booked">
        <div class="person">
          <span class="initial">${esc(initial(o.booking.name))}</span>
          <div>
            <p class="name">${esc(o.booking.name)}</p>
            <p class="detail">Booked at ${clock(o.booking.bookedAt)}. Confirmation texted and added to Square.</p>
          </div>
        </div>
        <div class="actions one">
          ${started
            ? `<button class="secondary" data-action="no-show" data-id="${id}">Mark as a no-show</button>`
            : `<button class="secondary" data-action="reopen" data-id="${id}">${esc(first(o.booking.name))} can’t make it: reopen</button>`}
        </div>
      </div>`;
  }
  return "";
}

function renderOpening(o) {
  const [label, tone] = o.phase === "ended" ? ENDED[o.outcome?.kind] ?? ["Closed", ""] : STATE[o.phase] ?? ["", ""];
  const [time, ampm] = clock(o.opening.startsAt).split(" ");
  const id = esc(o.workflowId);
  const live = o.phase !== "ended";
  const canRelease = !["booked", "ended"].includes(o.phase);

  const queue = (o.phase === "offer_out" || o.phase === "awaiting_approval") && o.remainingEligible?.length
    ? `<p class="next">Next in line: <strong>${o.remainingEligible.map((c) => esc(first(c.name))).join(", ")}</strong></p>`
    : "";
  const busy = live && o.busyElsewhere?.length
    ? `<p class="next">Considering another opening: ${o.busyElsewhere.map((c) => esc(first(c.name))).join(", ")}</p>`
    : "";

  const events = [...o.timeline].filter((e) => e.kind !== "opened").reverse();
  const history = `
    <details class="history" data-history="${id}" ${openHistory.has(o.workflowId) ? "open" : ""}>
      <summary>What’s happened${events.length ? ` (${events.length})` : ""}</summary>
      <ol>${events.map((e) => `<li><time>${clock(e.at)}</time><span>${esc(e.note)}</span></li>`).join("") || "<li><time></time><span>Just added.</span></li>"}</ol>
      <p class="tech">Workflow ID ${id}. <a href="http://localhost:8233/namespaces/default/workflows/${encodeURIComponent(o.workflowId)}" target="_blank" rel="noreferrer">Open in Temporal</a></p>
    </details>`;

  return `
    <article class="opening ${live ? "" : "done"}">
      <div class="when">
        <div>
          <p class="time">${esc(time)}<small>${esc(ampm ?? "")}</small></p>
          <p class="with">${dayWord(o.opening.startsAt)} with ${esc(o.opening.stylist)}, ${lengthWords(o.opening.lengthMinutes)}</p>
        </div>
        <span class="state ${tone}">${esc(label)}</span>
      </div>
      <p class="story">${esc(story(o))}</p>
      ${moment(o)}
      ${queue}${busy}
      ${history}
      ${canRelease ? `<div class="bottom-actions"><button class="link rose" data-action="cancel" data-id="${id}">Give this time to a walk-in</button></div>` : ""}
    </article>`;
}

function renderOpenings() {
  const list = [...state.openings].sort(
    (a, b) => (a.phase === "ended") - (b.phase === "ended") || a.opening.startsAt - b.opening.startsAt,
  );
  const json = JSON.stringify(list) + [...openHistory].join();
  if (json === rendered.openings) return;
  rendered.openings = json;
  $("#openings").innerHTML = list.length
    ? list.map(renderOpening).join("")
    : `<div class="empty"><strong>No open times right now</strong>When a client cancels, add the opening above and we’ll line up the right person from the waitlist.</div>`;
  if (!list.length) $("#new-opening-box").open = true;
}

// ── Waitlist ──
function renderWaitlist() {
  const active = document.activeElement;
  if ($("#waitlist").contains(active) && active.tagName === "INPUT") return;
  const json = JSON.stringify(state.waitlist);
  if (json === rendered.waitlist) return;
  rendered.waitlist = json;

  $("#waitlist").innerHTML = [...state.waitlist]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((c) => {
      let chip = '<span class="state">Waiting</span>';
      if (c.status === "booked") chip = '<span class="state green">Booked</span>';
      else if (c.status === "removed") chip = '<span class="state">Removed</span>';
      else if (c.unreachable) chip = '<span class="state rose">Can’t text</span>';
      else if (c.activeOfferOpeningId) chip = '<span class="state berry">Has an offer</span>';
      const stylist = c.stylistPreference === "any" ? "any stylist" : c.stylistPreference;
      const fix = c.unreachable && c.status === "waiting"
        ? `<p class="warn">The last text didn’t go through. Update the number and ${esc(first(c.name))} goes back in line.</p>
           <div class="fix">
             <input value="${esc(c.phone)}" inputmode="tel" data-phone-for="${esc(c.clientId)}" aria-label="Mobile number for ${esc(c.name)}" />
             <button class="secondary" data-action="fix-phone" data-client="${esc(c.clientId)}">Save number</button>
           </div>`
        : "";
      const removable = c.status === "waiting" && !c.activeOfferOpeningId;
      return `<li>
        <span class="initial">${esc(initial(c.name))}</span>
        <div>
          <p class="name">${esc(c.name)}</p>
          <p class="detail">${esc(c.service)} (${c.serviceMinutes} min) with ${esc(stylist)}</p>
          <p class="detail">${esc(c.availabilityLabel)}. Joined ${shortDate(c.joinedAt)}.</p>
          ${removable ? `<button class="link" data-action="remove" data-client="${esc(c.clientId)}">Take off the waitlist</button>` : ""}
        </div>
        ${chip}
        ${fix}
      </li>`;
    })
    .join("");
}

// ── Client texts ──
function renderPhones() {
  const byClient = new Map();
  for (const o of state.openings) {
    for (const m of o.messages) {
      if (!byClient.has(m.clientId)) byClient.set(m.clientId, { name: m.name, items: [] });
      byClient.get(m.clientId).items.push({ ...m, openingId: o.workflowId, from: "salon" });
    }
  }
  // Client replies come from each opening's history, so the view is always what really happened.
  for (const o of state.openings) {
    for (const e of o.timeline) {
      let body;
      if (e.kind === "accepted") body = "Yes, book me";
      else if (e.kind === "declined") body = "No thanks";
      else if (e.kind === "late_reply") body = e.note.includes("“accept”") ? "Yes, book me" : "No thanks";
      if (body && byClient.has(e.clientId)) {
        byClient.get(e.clientId).items.push({ clientId: e.clientId, openingId: o.workflowId, from: "client", at: e.at, body });
      }
    }
  }
  const phones = [...byClient.entries()]
    .map(([clientId, p]) => ({ clientId, ...p, items: p.items.sort((a, b) => a.at - b.at) }))
    .sort((a, b) => b.items.at(-1).at - a.items.at(-1).at);

  let awaiting = 0;
  const html = phones
    .map((p) => {
      const lastOffer = p.items.map((i) => i.kind).lastIndexOf("offer");
      const items = p.items
        .map((m, i) => {
          if (m.from === "client") return `<div class="bubble mine">${esc(m.body)}<time>${clock(m.at)}</time></div>`;
          const replied = p.items.slice(i + 1).some((x) => x.from === "client" && x.openingId === m.openingId);
          const canReply = m.kind === "offer" && i === lastOffer && !replied;
          if (canReply) awaiting++;
          return `<div class="bubble">${esc(m.body)}<time>${clock(m.at)}</time></div>${
            canReply
              ? `<div class="reply">
                  <button class="primary" data-action="reply" data-response="accept" data-id="${esc(m.openingId)}" data-client="${esc(p.clientId)}">Yes, book me</button>
                  <button class="secondary" data-action="reply" data-response="decline" data-id="${esc(m.openingId)}" data-client="${esc(p.clientId)}">No thanks</button>
                </div>`
              : ""
          }`;
        })
        .join("");
      return `<div class="phone"><p class="phone-name"><span class="initial">${esc(initial(p.name))}</span>${esc(p.name)}</p>${items}</div>`;
    })
    .join("");

  const badge = $("#texts-badge");
  badge.hidden = awaiting === 0;
  badge.textContent = awaiting;

  const json = JSON.stringify(phones);
  if (json === rendered.phones) return;
  rendered.phones = json;
  $("#phones").innerHTML = html || `<div class="empty"><strong>No texts yet</strong>Offers you approve show up here, and you can reply as the client.</div>`;
}

// ── Live countdowns ──
function tick() {
  const now = Date.now() + serverOffset;
  document.querySelectorAll("[data-expires]").forEach((el) => {
    el.textContent = fmtLeft(Number(el.dataset.expires) - now);
  });
  document.querySelectorAll("[data-ring-expires]").forEach((el) => {
    const left = Math.max(0, Number(el.dataset.ringExpires) - now);
    el.setAttribute("stroke-dashoffset", String(RING * (1 - left / Number(el.dataset.ringTotal))));
  });
}

async function refresh() {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error((await response.json()).error);
    state = await response.json();
    serverOffset = state.now - Date.now();
    $("#today").textContent = new Date(state.now).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    renderOpenings();
    renderWaitlist();
    renderPhones();
  } catch {
    rendered.openings = "";
    $("#openings").innerHTML =
      '<div class="empty"><strong>Can’t reach the scheduler</strong>Make sure <code>npm run dev</code> is running, then this page will catch up on its own.</div>';
  }
}

// ── Tabs ──
function showTab(name) {
  document.querySelectorAll("[role=tab]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
  document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
  window.scrollTo({ top: 0 });
}
document.querySelectorAll("[role=tab]").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

document.addEventListener(
  "toggle",
  (event) => {
    const d = event.target;
    if (!d.dataset?.history) return;
    if (d.open) openHistory.add(d.dataset.history);
    else openHistory.delete(d.dataset.history);
  },
  true,
);

// ── Actions ──
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id, client } = button.dataset;
  button.disabled = true;
  try {
    let message;
    if (action === "approve") {
      await post(`/api/openings/${id}/approve`, { clientId: client });
      message = "Offer sent.";
    }
    if (action === "skip") {
      await post(`/api/openings/${id}/skip`, { clientId: client });
      message = "Skipped for this opening. They’re still on the waitlist.";
    }
    if (action === "cancel") {
      await post(`/api/openings/${id}/cancel`, { reason: "given to a walk-in" });
      message = "Given to a walk-in. Any open offer was withdrawn.";
    }
    if (action === "reopen") {
      await post(`/api/openings/${id}/reopen`, { reason: "client can’t make it" });
      message = "Reopened. The next person in line is ready for your OK.";
    }
    if (action === "no-show") {
      await post(`/api/openings/${id}/no-show`);
      message = "Marked as a no-show.";
    }
    if (action === "remove") {
      await post(`/api/waitlist/${client}/remove`);
      message = "Taken off the waitlist.";
    }
    if (action === "fix-phone") {
      const phone = document.querySelector(`[data-phone-for="${client}"]`).value;
      await post(`/api/waitlist/${client}/phone`, { phone });
      document.activeElement?.blur();
      message = "Number saved. They’re back in line for future openings.";
    }
    if (action === "reply") {
      const response = button.dataset.response;
      const result = await post(`/api/openings/${id}/reply`, { clientId: client, response });
      message = result.result.message;
    }
    if (message) toast(message);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    await refresh();
  }
});

$("#reset").addEventListener("click", async () => {
  try {
    await post("/api/demo/reset-waitlist");
    toast("Sample waitlist restored.");
  } catch (error) {
    toast(error.message);
  }
  refresh();
});

$("#new-opening").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  $("#form-error").textContent = "";
  try {
    await post("/api/openings", {
      stylist: form.get("stylist"),
      date: form.get("date"),
      time: form.get("time"),
      lengthMinutes: Number(form.get("lengthMinutes")),
      demoSpeed: form.get("demoSpeed") === "on",
    });
    $("#new-opening-box").open = false;
    toast("Opening added. Have a look at who’s first in line.");
  } catch (error) {
    $("#form-error").textContent = error.message;
  }
  refresh();
});

// Defaults: today at 3 PM if that's over an hour away, otherwise tomorrow at 3 PM.
function initForm() {
  ["Maria", "Jordan", "Sam"].forEach((s) => ($("#stylist").innerHTML += `<option>${s}</option>`));
  const d = new Date();
  d.setHours(15, 0, 0, 0);
  if (d.getTime() - Date.now() < 60 * 60 * 1000) d.setDate(d.getDate() + 1);
  const pad = (n) => String(n).padStart(2, "0");
  $("#date").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  $("#time").value = "15:00";
  $("#demo-speed").checked = true;
}

initForm();
refresh();
setInterval(refresh, 1000);
setInterval(tick, 250);
