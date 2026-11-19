/* Copyright (C) 2026 Enrico Miot (EndrX)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
"use strict";

const $ = (id) => document.getElementById(id);
const AUTOMATIC = "";

async function effectiveText(host) {
  try {
    const best = skaiPickBest(await skaiListModelsDetailed(host));
    return best
      ? `Automatic uses the installed model with the most parameters: ${best}.`
      : "Ollama has no model installed yet.";
  } catch (e) {
    return `Ollama is not reachable at ${host}.`;
  }
}

async function fillModels(selected) {
  const host = $("host").value.trim() || SKAI_DEFAULT_HOST;
  const select = $("model");
  select.textContent = "";
  const auto = new Option("Automatic (most parameters)", AUTOMATIC);
  select.append(auto);
  let names = [];
  try {
    names = (await skaiListModelsDetailed(host)).map((m) => m.name).sort();
  } catch (e) {
    names = [];
  }
  if (selected && !names.includes(selected)) {
    names.unshift(selected);
  }
  for (const name of names) {
    select.append(new Option(name, name));
  }
  select.value = selected || AUTOMATIC;
  $("effective").textContent = await effectiveText(host);
}

async function load() {
  const settings = await skaiSettings();
  $("host").value = settings.ollama_host;
  await fillModels(settings.ollama_model);
}

$("refresh").addEventListener("click", () => fillModels($("model").value));
$("host").addEventListener("change", () => fillModels($("model").value));
$("save").addEventListener("click", async () => {
  await browser.storage.local.set({
    ollama_host: $("host").value.trim() || SKAI_DEFAULT_HOST,
    ollama_model: $("model").value,
  });
  $("status").textContent = "Saved.";
  setTimeout(() => ($("status").textContent = ""), 2000);
});

load();
