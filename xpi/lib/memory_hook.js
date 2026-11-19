/* Copyright (C) 2026 Enrico Miot (EndrX)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* SKAI_ Memory for the sidebar chats: what other SKAI apps know goes into the prompt, and a short record of
 * each exchange is kept in this add-on's own notes (plugins/sk_mail/). Every failure is swallowed: without the
 * memory (not installed, no permission to write) the chats work exactly as before. */
"use strict";

const SKAI_MEMORY_APP = "sk_mail";
let skaiMemoryInstance = null;
const skaiMemoryWarned = new Set();

async function skaiMemory() {
  if (skaiMemoryInstance === null) {
    skaiMemoryInstance = false;
    try {
      if (await messenger.skaiMemory.available()) {
        const fs = {
          list: (dir) => messenger.skaiMemory.list(dir),
          read: (path) => messenger.skaiMemory.read(path),
          write: (path, text, mode, rel, caller) => messenger.skaiMemory.write(mode, rel, text, caller),
        };
        skaiMemoryInstance = new SkaiMemory.Memory({ app: SKAI_MEMORY_APP, fs });
      }
    } catch (e) {
      console.info("SKAI_ Memory not used:", e);
    }
  }
  return skaiMemoryInstance || null;
}

/** A system message with what the memory knows about `query`, or null. */
async function skaiMemoryContext(query, k = 3) {
  try {
    const mem = await skaiMemory();
    if (!mem || !query) {
      return null;
    }
    const hits = (await mem.search(query, { hops: 1, limit: k })).slice(0, k);
    if (!hits.length) {
      return null;
    }
    const lines = hits.map((h) => `- [${h.title}] (${h.path}) ${h.snippet}` +
      (h.external.length ? ` Links: ${h.external.slice(0, 3).join(", ")}` : ""));
    return {
      role: "system",
      content: "Shared SKAI memory (what other SKAI apps know; use it only when it helps):\n" + lines.join("\n"),
    };
  } catch (e) {
    console.info("SKAI_ Memory search failed:", e);
    return null;
  }
}

/** Keep the exchange in this add-on's sub-chat of the day ("mail" or "calendar"). */
async function skaiMemoryRemember(kind, question, reply) {
  try {
    const mem = await skaiMemory();
    if (!mem || !question || !reply) {
      return;
    }
    await mem.remember(`${kind} ${new Date().toISOString().slice(0, 10)}`,
      `**Q:** ${question.slice(0, 600)}\n\n**A:** ${reply.slice(0, 900)}`);
  } catch (e) {
    if (!skaiMemoryWarned.has("write")) {
      skaiMemoryWarned.add("write");
      console.info("SKAI_ Memory not written:", e);
    }
  }
}
