/* Copyright (C) 2026 Enrico Miot (EndrX)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* SKAI sidebar: a mail assistant (chat, summary, reply draft) and a
 * calendar assistant, working on Thunderbird's own mail and calendars.
 */
"use strict";

const WINDOW_ID = parseInt(new URLSearchParams(location.search).get("windowId"), 10);
const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------ shared UI */

// Same text as every SKAI tool (skcommon.AI_UNAVAILABLE_MESSAGE in the launcher).
const AI_UNAVAILABLE_TITLE = "AI unavailable";
const AI_UNAVAILABLE_MESSAGE =
  "AI features are disabled.\n" +
  "It looks like you turned off AI in the SKAI settings.\n" +
  "Without a selected model, SKAI cannot function.";

let modalResolve = null;

function showModal(title, text, { question = false } = {}) {
  $("modal-title").textContent = title;
  $("modal-text").textContent = text;
  $("modal-no").hidden = !question;
  $("modal-ok").textContent = question ? "Yes" : "OK";
  $("modal").hidden = false;
  (question ? $("modal-no") : $("modal-ok")).focus();
  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

function closeModal(answer) {
  if ($("modal").hidden) {
    return;
  }
  $("modal").hidden = true;
  const resolve = modalResolve;
  modalResolve = null;
  if (resolve) {
    resolve(answer);
  }
}

$("modal-ok").addEventListener("click", () => closeModal(true));
$("modal-no").addEventListener("click", () => closeModal(false));
document.addEventListener("keydown", (e) => {
  if ($("modal").hidden) {
    return;
  }
  e.preventDefault();
  if ($("modal-no").hidden) {
    closeModal(true); // "Press any key"
  } else if (e.key === "Enter" && document.activeElement === $("modal-ok")) {
    closeModal(true);
  } else if (e.key === "Escape" || e.key === "Enter") {
    closeModal(false);
  }
}, true);

// The "AI unavailable" popup is only for "no Ollama / no model at all";
// every other failure says what really happened.
function aiErrorText(error) {
  const kind = error instanceof OllamaError ? error.kind : "bug";
  switch (kind) {
    case "unavailable":
      return [AI_UNAVAILABLE_TITLE, AI_UNAVAILABLE_MESSAGE];
    case "model_missing":
      return ["Model not installed",
        `The model "${error.detail}" chosen in the SKAI settings is not installed.\n` +
        "Open the settings (gear button) and pick an installed model, or leave the " +
        "model empty to use the installed one with the most parameters."];
    case "timeout":
      return ["SKAI is taking too long",
        "The model sent nothing for 10 minutes, so SKAI stopped waiting.\n" +
        "This computer may be too slow for this request: try a shorter message, " +
        "or a smaller model."];
    case "interrupted":
      return ["Answer interrupted",
        "Ollama stopped in the middle of the answer (it may have been closed or " +
        "restarted). Try again."];
    case "server":
      return ["Ollama error",
        `Ollama could not answer:\n${error.detail || error.message}\n\n` +
        "If it says it is out of memory, close some programs or use a smaller model."];
    case "invalid":
      return ["Unreadable answer", "Ollama sent an answer SKAI cannot read. Try again."];
    case "empty":
      return ["Empty answer", "The model gave an empty answer. Try again, maybe with different words."];
    default:
      return ["Something went wrong", `SKAI hit an unexpected error:\n${(error && error.message) || error}`];
  }
}

function showAiError(error) {
  console.warn("SKAI:", error);
  const [title, text] = aiErrorText(error);
  return showModal(title, text);
}

function setActive(selector, attr, value) {
  for (const el of document.querySelectorAll(selector)) {
    el.classList.toggle("active", el.dataset[attr] === value);
  }
}

/* --------------------------------------------------------- mode switch */

let mode = "mail";

function setMode(newMode) {
  mode = newMode;
  setActive(".mode", "mode", mode);
  $("panel-mail").classList.toggle("active", mode === "mail");
  $("panel-calendar").classList.toggle("active", mode === "calendar");
}

for (const button of document.querySelectorAll(".mode")) {
  button.addEventListener("click", () => setMode(button.dataset.mode));
}
for (const button of document.querySelectorAll(".tab")) {
  button.addEventListener("click", () => setTab(button.dataset.tab));
}
function setTab(tab) {
  setActive(".tab", "tab", tab);
  for (const page of document.querySelectorAll(".tabpage")) {
    page.classList.toggle("active", page.id === `tab-${tab}`);
  }
}

$("settings").addEventListener("click", () => browser.runtime.openOptionsPage());

async function refreshModelLine() {
  const { model, automatic } = await skaiResolve();
  $("model-line").textContent = model
    ? `Model: ${model}${automatic ? " (automatic: most parameters)" : ""}`
    : "Model: none available";
}
browser.storage.onChanged.addListener(() => refreshModelLine());

/* ------------------------------------------------------ mail assistant */

const MAIL_SYSTEM_PROMPT =
  "You are SKAI, the AI assistant built into the Thunderbird mail client of Skorpion OS. " +
  "If the user asks who you are, say you are SKAI. " +
  "Always answer in English, concisely and helpfully.";
const MAIL_CHAT_GREETING =
  "Hi! I'm SKAI. Ask me anything about your mail: tick the box below to let me " +
  "read the open email. Summary and Reply are in the tabs above.";
const BODY_CHAR_LIMIT = 6000;

let currentMessage = null; // {id, subject, author, text}
let mailChatHistory = [];
const busy = { summary: false, reply: false, chat: false, calendar: false };

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll("script, style, head")) {
    el.remove();
  }
  for (const el of doc.querySelectorAll("br")) {
    el.replaceWith("\n");
  }
  for (const el of doc.querySelectorAll("p, div, li, tr, h1, h2, h3, h4, blockquote")) {
    el.append("\n");
  }
  return (doc.body ? doc.body.textContent : "").replace(/\n{3,}/g, "\n\n");
}

function findParts(part, out) {
  if (!part) {
    return out;
  }
  if (part.body && /^text\/(plain|html)/i.test(part.contentType || "")) {
    out.push({ contentType: part.contentType, content: part.body });
  }
  for (const child of part.parts || []) {
    findParts(child, out);
  }
  return out;
}

async function messagePlainText(id) {
  let parts = [];
  try {
    parts = await browser.messages.listInlineTextParts(id);
  } catch (e) {
    parts = findParts(await browser.messages.getFull(id), []);
  }
  const plain = parts.find((p) => /^text\/plain/i.test(p.contentType));
  const html = parts.find((p) => /^text\/html/i.test(p.contentType));
  let text = plain ? plain.content : html ? htmlToText(html.content) : "";
  text = text.trim();
  if (text.length > BODY_CHAR_LIMIT) {
    text = text.slice(0, BODY_CHAR_LIMIT) + "\n[...truncated...]";
  }
  return text;
}

function messageContext(message) {
  return `Subject: ${message.subject || "(no subject)"}\nFrom: ${message.author}\n\n${message.text}`;
}

// Bumped on every change: when the user clicks A then B quickly, reading A
// may finish after B, and must not put A back as the current message.
let messageSerial = 0;

async function setMessage(header) {
  if (header && currentMessage && currentMessage.id === header.id) {
    return;
  }
  const serial = ++messageSerial;
  currentMessage = null;
  if (header) {
    let text = "";
    try {
      text = await messagePlainText(header.id);
    } catch (e) {
      console.error("SKAI: cannot read the message", e);
    }
    if (serial !== messageSerial) {
      return; // another message was chosen meanwhile
    }
    currentMessage = { id: header.id, subject: header.subject, author: header.author || "", text };
  }
  const label = currentMessage
    ? `Current message: ${currentMessage.subject || "(no subject)"}`
    : "No message selected.";
  for (const el of document.querySelectorAll("#panel-mail .context")) {
    el.textContent = label;
  }
  $("summary-btn").disabled = !currentMessage || busy.summary;
  $("reply-btn").disabled = !currentMessage || busy.reply;
  $("summary-out").textContent = "";
  $("reply-out").value = "";
  $("reply-use").disabled = true;
  $("mail-chat-context").disabled = !currentMessage;
  if (!currentMessage) {
    $("mail-chat-context").checked = false;
  }
}

function listOf(result) {
  // Thunderbird 128+ returns a MessageList, older versions an array
  return Array.isArray(result) ? result : (result && result.messages) || [];
}

// The open tab picks the assistant: mail tabs -> Mail, calendar/tasks tabs ->
// Calendar, and the Mail/Calendar buttons are hidden. On any other tab
// (address book, settings, a web page...) the buttons come back so the user
// chooses, starting from the assistant that was shown last.
function showModeButtons(show) {
  $("modes").hidden = !show;
}

async function followTab(tab) {
  if (!tab || tab.windowId !== WINDOW_ID) {
    return;
  }
  if (tab.type === "calendar" || tab.type === "tasks") {
    showModeButtons(false);
    setMode("calendar");
    return;
  }
  if (tab.type !== "mail" && tab.type !== "messageDisplay") {
    showModeButtons(true);
    return;
  }
  showModeButtons(false);
  setMode("mail");
  let messages = [];
  try {
    messages = listOf(await browser.messageDisplay.getDisplayedMessages(tab.id));
  } catch (e) {
    messages = [];
  }
  await setMessage(messages.length === 1 ? messages[0] : null);
}

browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (windowId === WINDOW_ID) {
    await followTab(await browser.tabs.get(tabId));
  }
});
browser.messageDisplay.onMessagesDisplayed.addListener(async (tab, displayed) => {
  if (tab.windowId === WINDOW_ID && tab.active) {
    const messages = listOf(displayed);
    await setMessage(messages.length === 1 ? messages[0] : null);
  }
});
// Also follow the selection in the message list: deselecting, or selecting
// several messages, leaves no single current message.
browser.mailTabs.onSelectedMessagesChanged.addListener(async (tab, selected) => {
  if (tab.windowId === WINDOW_ID && tab.active) {
    const messages = listOf(selected);
    await setMessage(messages.length === 1 ? messages[0] : null);
  }
});

async function runMail(kind, button, label, prompt, onDone, onFail) {
  if (!currentMessage || busy[kind]) {
    return;
  }
  busy[kind] = true;
  button.disabled = true;
  button.textContent = "Generating…";
  const message = currentMessage;
  const stillShown = () => currentMessage === message;
  try {
    const reply = await skaiChat([
      { role: "system", content: MAIL_SYSTEM_PROMPT },
      { role: "user", content: prompt + "\n\n" + messageContext(message) },
    ]);
    // the user may have opened another email while the model was working:
    // its summary/draft must not appear under (or be sent as a reply to) that one
    if (stillShown()) {
      onDone(reply);
    }
  } catch (e) {
    if (stillShown()) {
      onFail();
    }
    await showAiError(e);
  } finally {
    busy[kind] = false;
    button.textContent = label;
    button.disabled = !currentMessage;
  }
}

$("summary-btn").addEventListener("click", () => {
  $("summary-out").textContent = "Generating the summary…";
  runMail(
    "summary",
    $("summary-btn"),
    "Summarize",
    "Summarize the following email in English in 2-4 sentences. Be concise and keep " +
      "only the essential information (sender, request, any deadline).",
    (text) => ($("summary-out").textContent = text),
    () => ($("summary-out").textContent = "")
  );
});

$("reply-btn").addEventListener("click", () => {
  $("reply-out").value = "Generating the draft…";
  $("reply-use").disabled = true;
  runMail(
    "reply",
    $("reply-btn"),
    "Generate reply draft",
    "Write a draft reply in English to this email, in a professional and concise tone. " +
      "Write only the body of the message: no subject, no opening like 'Here is the " +
      "draft', no signature.",
    (text) => {
      $("reply-out").value = text;
      $("reply-use").disabled = false;
    },
    () => ($("reply-out").value = "")
  );
});

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function composeDetailsWhenReady(tabId) {
  // the reply window needs a moment before its body can be read and changed
  for (let i = 0; i < 40; i++) {
    try {
      const details = await browser.compose.getComposeDetails(tabId);
      if (details && (details.body || details.plainTextBody !== undefined)) {
        return details;
      }
    } catch (e) {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return browser.compose.getComposeDetails(tabId);
}

// Open a reply to the current message with the draft above the quote
$("reply-use").addEventListener("click", async () => {
  const text = $("reply-out").value.trim();
  if (!text || !currentMessage) {
    return;
  }
  const tab = await browser.compose.beginReply(currentMessage.id, "replyToSender");
  const details = await composeDetailsWhenReady(tab.id);
  if (details.isPlainText) {
    await browser.compose.setComposeDetails(tab.id, {
      plainTextBody: text + "\n\n" + (details.plainTextBody || ""),
    });
    return;
  }
  const doc = new DOMParser().parseFromString(details.body || "<html><body></body></html>", "text/html");
  const block = doc.createElement("div");
  block.innerHTML = text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  doc.body.prepend(block);
  await browser.compose.setComposeDetails(tab.id, {
    body: "<!DOCTYPE html>\n" + doc.documentElement.outerHTML,
  });
});

// Chat bubbles, used by both chats: the user's on the right, SKAI's on the left
function addBubble(log, text, isUser) {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${isUser ? "user" : "assistant"}`;
  bubble.textContent = text;
  log.append(bubble);
  log.scrollTop = log.scrollHeight;
  return bubble;
}

function addPendingBubble(log) {
  const bubble = addBubble(log, "…", false);
  bubble.classList.add("pending");
  return bubble;
}

async function sendMailChat() {
  const input = $("mail-chat-input");
  const text = input.value.trim();
  if (!text || busy.chat) {
    return;
  }
  addBubble($("mail-chat"), text, true);
  input.value = "";

  const messages = [{ role: "system", content: MAIL_SYSTEM_PROMPT }];
  if ($("mail-chat-context").checked && currentMessage) {
    messages.push({
      role: "user",
      content: "Here is the email that is open now, as context for the conversation:\n\n" +
        messageContext(currentMessage),
    });
  }
  const memory = await skaiMemoryContext(text);
  if (memory) {
    messages.push(memory);
  }
  messages.push(...mailChatHistory, { role: "user", content: text });

  busy.chat = true;
  input.disabled = true;
  $("mail-chat-send").disabled = true;
  const pending = addPendingBubble($("mail-chat"));
  try {
    const reply = await skaiChat(messages);
    pending.remove();
    mailChatHistory.push({ role: "user", content: text }, { role: "assistant", content: reply });
    addBubble($("mail-chat"), reply, false);
    skaiMemoryRemember("mail", text, reply);
  } catch (e) {
    pending.remove();
    await showAiError(e);
  } finally {
    busy.chat = false;
    input.disabled = false;
    $("mail-chat-send").disabled = false;
    input.focus();
  }
}

$("mail-chat-send").addEventListener("click", sendMailChat);
$("mail-chat-input").addEventListener("keydown", (e) => e.key === "Enter" && sendMailChat());
function startMailChat() {
  mailChatHistory = [];
  $("mail-chat").textContent = "";
  addBubble($("mail-chat"), MAIL_CHAT_GREETING, false);
}

$("mail-chat-new").addEventListener("click", startMailChat);

/* -------------------------------------------------- calendar assistant */

// The model only proposes actions; they are applied here through the
// skaiCalendar experiment.
const CALENDAR_SYSTEM_PROMPT = `You are SKAI, the assistant of the calendar in Thunderbird on Skorpion OS.
If the user asks who you are, say in "reply" that you are SKAI.
Your job is to read the user's message and turn it into a list of structured actions
to apply to the calendar. Answer ONLY with a valid JSON object, with no text before or
after, in exactly this format:

{
  "reply": "short conversational answer in English to show in the chat",
  "actions": [
    {
      "type": "add",
      "title": "...",
      "start": "YYYY-MM-DDTHH:MM:SS",
      "end": "YYYY-MM-DDTHH:MM:SS",
      "all_day": false,
      "category": "...",
      "description": "optional",
      "recurrence": "optional: DAILY, WEEKLY, MONTHLY or YEARLY",
      "recurrence_until": "optional: YYYY-MM-DDTHH:MM:SS, end date of the recurrence"
    },
    {
      "type": "edit",
      "id": 12,
      "fields": {"start": "...", "end": "...", "title": "...", "category": "...",
                 "recurrence": "...", "recurrence_until": "..."}
    },
    {
      "type": "delete",
      "id": 12
    }
  ]
}

Rules:
- If no change to the calendar is needed (the user is only asking for information),
  return "actions": [] and put the answer/the information in "reply".
- For "edit" and "delete" ALWAYS use the exact id taken from the list of existing events
  given in the context. If you are not sure which event the user means, do not invent an
  id: put "actions": [] and ask for clarification in "reply".
- Dates are always local ISO 8601, without time zone (YYYY-MM-DDTHH:MM:SS).
- If the user gives no time and it looks like an event for the whole day, use
  "all_day": true with start at 00:00:00 and end the next day at 00:00:00.
- If no category is given, use "General".
- For repeated events ("every day", "every Monday", "every month", "every year") create ONE
  event with "recurrence" set (DAILY/WEEKLY/MONTHLY/YEARLY), with "start" at the first
  occurrence: do NOT create many separate events. If the user gives an end ("until June"),
  set "recurrence_until".
- Recurring events in the context have the "recurrence" field: changing or deleting them
  acts on the whole series, tell the user about this in "reply" when relevant.
- Never add text outside the JSON.`;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const FREQS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;

let calendarHistory = []; // [{role, content}], plain texts only
let shortIds = new Map(); // number shown to the model -> real event id
let shortIdOf = new Map(); // real event id -> number
let lastTitles = new Map(); // real event id -> title, from the last context

function localIso(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function shortId(realId) {
  if (!shortIdOf.has(realId)) {
    const n = shortIdOf.size + 1;
    shortIdOf.set(realId, n);
    shortIds.set(n, realId);
  }
  return shortIdOf.get(realId);
}

async function eventsContext(daysBack = 7, daysFwd = 60) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFwd);
  const events = await browser.skaiCalendar.getEvents(localIso(start), localIso(end));
  lastTitles = new Map(events.map((e) => [e.id, e.title]));
  return events.map((e) => {
    const entry = { id: shortId(e.id), title: e.title, start: e.start, end: e.end, category: e.category };
    if (e.all_day) {
      entry.all_day = true;
    }
    if (e.recurrence) {
      entry.recurrence = e.recurrence;
      if (e.recurrence_until) {
        entry.recurrence_until = e.recurrence_until;
      }
    }
    return entry;
  });
}

async function buildCalendarUserMessage(text) {
  const now = new Date();
  const context = {
    today: localIso(now),
    weekday: WEEKDAYS[now.getDay()],
    existing_categories: await browser.skaiCalendar.getCategories(),
    existing_events: await eventsContext(),
  };
  return `CONTEXT:\n${JSON.stringify(context)}\n\nUSER MESSAGE:\n${text}`;
}

function realId(id) {
  const real = shortIds.get(parseInt(id, 10));
  if (!real) {
    throw new Error(`no event with id ${id}`);
  }
  return real;
}

/** "Title, 2026-11-25 10:00-11:00 (Work, weekly until 2026-12-31)" from an event as the calendar stored it. */
function describeEvent(e) {
  const day = (iso) => String(iso || "").slice(0, 10);
  const time = (iso) => String(iso || "").slice(11, 16);
  let when;
  if (e.all_day) {
    when = day(e.start);
  } else if (day(e.start) === day(e.end)) {
    when = `${day(e.start)} ${time(e.start)}-${time(e.end)}`;
  } else {
    when = `${day(e.start)} ${time(e.start)} - ${day(e.end)} ${time(e.end)}`;
  }
  const extra = [];
  if (e.category) {
    extra.push(e.category);
  }
  if (e.recurrence) {
    extra.push(e.recurrence.toLowerCase() + (e.recurrence_until ? ` until ${day(e.recurrence_until)}` : ""));
  }
  return `"${e.title || "Untitled"}", ${when}${extra.length ? ` (${extra.join(", ")})` : ""}` +
    (e.calendar ? ` in calendar ${e.calendar}` : "");
}

/** Applies the model's actions. Every line describes what the calendar really holds afterwards
 *  (read back from it), what the user declined and what failed: never what the model claimed. */
async function applyCalendarActions(actions, titles) {
  const applied = [];
  for (const act of Array.isArray(actions) ? actions : []) {
    const type = act && act.type;
    try {
      if (type === "add") {
        let recurrence = String(act.recurrence || "").toUpperCase();
        if (!FREQS.includes(recurrence)) {
          recurrence = "";
        }
        if (!act.start) {
          throw new Error("missing start");
        }
        // checked here: an error thrown inside the calendar experiment reaches us without its message
        for (const [name, value] of [["start", act.start], ["end", act.end], ["recurrence_until", act.recurrence_until]]) {
          if (value && !ISO_DATE.test(String(value))) {
            throw new Error(`invalid ${name} date "${value}" (expected YYYY-MM-DDTHH:MM:SS)`);
          }
        }
        // small models copy the example: a series that ends before its
        // second occurrence is just a single event
        if (recurrence && act.recurrence_until && String(act.recurrence_until) <= String(act.end || act.start)) {
          recurrence = "";
        }
        const added = await browser.skaiCalendar.addEvent({
          title: act.title || "Untitled",
          start: act.start,
          end: act.end || act.start,
          all_day: !!act.all_day,
          category: act.category || "General",
          description: act.description || "",
          recurrence,
          recurrence_until: recurrence ? act.recurrence_until || "" : "",
        });
        applied.push(`Created event #${shortId(added.id)}: ${describeEvent(added)}`);
      } else if (type === "edit") {
        const id = realId(act.id);
        const saved = await browser.skaiCalendar.modifyEvent(id, act.fields || {});
        applied.push(`Changed event #${act.id}, now: ${describeEvent(saved)}`);
      } else if (type === "delete") {
        const id = realId(act.id);
        const title = titles.get(id) || `#${act.id}`;
        const ok = await showModal("Delete event", `Delete "${title}" from the calendar?`, { question: true });
        if (!ok) {
          applied.push(`Not deleted (you said no): event #${act.id} "${title}"`);
          continue;
        }
        const gone = await browser.skaiCalendar.deleteEvent(id);
        applied.push(`Deleted event #${act.id}: ${describeEvent(gone)}`);
      } else {
        applied.push(`Action ignored (unknown type ${JSON.stringify(type)})`);
      }
    } catch (e) {
      applied.push(`Action failed (${type}): ${e.message || e}`);
    }
  }
  return applied;
}

function addCalBubble(text, isUser) {
  return addBubble($("cal-chat"), text, isUser);
}

async function sendCalendarMessage() {
  const input = $("cal-input");
  const text = input.value.trim();
  if (!text || busy.calendar) {
    return;
  }
  input.value = "";
  addCalBubble(text, true);
  busy.calendar = true;
  $("cal-send").disabled = true;
  $("cal-send").textContent = "...";
  const pending = addPendingBubble($("cal-chat"));
  try {
    const userMessage = await buildCalendarUserMessage(text);
    const titles = lastTitles;
    const memory = await skaiMemoryContext(text);
    const raw = await skaiChat(
      [
        { role: "system", content: CALENDAR_SYSTEM_PROMPT },
        ...(memory ? [memory] : []),
        ...calendarHistory.slice(-6),
        { role: "user", content: userMessage },
      ],
      { json: true, temperature: 0.2 }
    );
    pending.remove();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      addCalBubble("I could not understand the model's answer. Try again with different words.", false);
      return;
    }
    const reply = typeof payload.reply === "string" && payload.reply ? payload.reply : "Done.";
    const applied = await applyCalendarActions(payload.actions, titles);
    addCalBubble(applied.length ? `${reply}\n\n${applied.join("\n")}` : reply, false);
    // the history and the memory keep what really happened in the calendar, not the model's claim
    const outcome = applied.length ? `Calendar changes:\n${applied.join("\n")}` : "No change to the calendar.";
    calendarHistory.push({ role: "user", content: text }, { role: "assistant", content: `${reply}\n\n${outcome}` });
    skaiMemoryRemember("calendar", text, applied.length ? outcome : `${outcome} ${reply}`);
  } catch (e) {
    pending.remove();
    if (e instanceof OllamaError) {
      await showAiError(e);
    } else {
      addCalBubble(`Calendar error: ${e.message || e}`, false);
    }
  } finally {
    busy.calendar = false;
    $("cal-send").disabled = false;
    $("cal-send").textContent = "Send";
    input.focus();
  }
}

$("cal-send").addEventListener("click", sendCalendarMessage);
$("cal-input").addEventListener("keydown", (e) => e.key === "Enter" && sendCalendarMessage());

/* ---------------------------------- "log in" / "create a calendar" notices */

// Account types that are not a mail login (local folders, news, feeds)
const NOT_MAIL_ACCOUNTS = ["none", "nntp", "rss", "im"];

async function refreshMailGate() {
  let hasMail = true; // on an error keep the assistant usable
  try {
    const accounts = await browser.accounts.list(false);
    hasMail = accounts.some((a) => !NOT_MAIL_ACCOUNTS.includes(a.type));
  } catch (e) {
    console.error("SKAI: cannot list the accounts", e);
  }
  $("panel-mail").classList.toggle("gated", !hasMail);
}

async function refreshCalendarGate() {
  let hasCalendar = true;
  try {
    hasCalendar = await browser.skaiCalendar.hasWritableCalendar();
  } catch (e) {
    console.error("SKAI: cannot check the calendars", e);
  }
  $("panel-calendar").classList.toggle("gated", !hasCalendar);
}

$("mail-gate-btn").addEventListener("click", () => browser.skaiSidebar.openAccountSetup(WINDOW_ID));
$("cal-gate-btn").addEventListener("click", () => browser.skaiSidebar.openNewCalendar(WINDOW_ID));
browser.accounts.onCreated.addListener(() => refreshMailGate());
browser.accounts.onDeleted.addListener(() => refreshMailGate());
browser.skaiCalendar.onCalendarsChanged.addListener(() => refreshCalendarGate());

/* ----------------------------------------------------------------- start */

refreshMailGate();
refreshCalendarGate();

addCalBubble(
  "Hi! I'm SKAI. Tell me what you want to add, move or delete in the calendar and I'll take care of it.",
  false
);
startMailChat();
setTab("chat");
setMode("mail");
refreshModelLine();
browser.tabs.query({ active: true, windowId: WINDOW_ID }).then(([tab]) => followTab(tab));
