/* Copyright (C) 2026 Enrico Miot (EndrX)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* Minimal client for the local Ollama REST API, shared by the sidebar,
 * the options page and the background script.
 *
 * Same behaviour as every SKAI tool:
 * - host and model come from the settings (storage.local);
 * - an empty model means "automatic": the installed model with the most
 *   parameters (parameter_size from /api/tags) is used, the size on disk
 *   only breaking ties, like the launcher and SKAI Manager;
 * - /api/chat is called streaming (pieces joined here), optional JSON mode
 *   and temperature.
 */
"use strict";

const SKAI_DEFAULT_HOST = "http://localhost:11434";
const SKAI_MODELS_TIMEOUT = 5000;
// Generous: on a slow CPU just reading a long email takes minutes, and
// giving up early shows "AI unavailable" although Ollama is working.
const SKAI_CHAT_TIMEOUT = 600000;
const SKAI_DEFAULTS = { ollama_host: SKAI_DEFAULT_HOST, ollama_model: "" };

/* Every failure carries a kind, so the sidebar can show the right message:
 *   unavailable    Ollama cannot be reached, or no model is installed
 *   model_missing  the model chosen in the settings is not installed
 *   timeout        nothing arrived from Ollama for too long
 *   interrupted    the answer stopped half way (Ollama closed or restarted)
 *   server         Ollama answered with an error (e.g. out of memory)
 *   invalid        Ollama's answer could not be read
 *   empty          the model answered with no text
 */
class OllamaError extends Error {
  constructor(kind, message, detail = "") {
    super(message);
    this.kind = kind;
    this.detail = detail;
  }
}

function skaiBaseUrl(host) {
  return (host || SKAI_DEFAULT_HOST).replace(/\/+$/, "");
}

async function skaiFetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) {
      throw new OllamaError("timeout", `No answer from ${url} in ${timeoutMs} ms.`);
    }
    throw new OllamaError("unavailable", `Cannot reach Ollama at ${url}: ${e.message || e}`);
  } finally {
    clearTimeout(timer);
  }
  let data;
  try {
    data = await response.json();
  } catch (e) {
    throw new OllamaError("invalid", `Invalid reply from Ollama (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const detail = (data && data.error) || `HTTP ${response.status}`;
    throw new OllamaError("server", `Ollama error: ${detail}`, detail);
  }
  return data;
}

async function skaiSettings() {
  const stored = await browser.storage.local.get(SKAI_DEFAULTS);
  return { ...SKAI_DEFAULTS, ...stored };
}

/** Installed models with their details, like list_models_detailed(). */
async function skaiListModelsDetailed(host) {
  const data = await skaiFetchJson(`${skaiBaseUrl(host)}/api/tags`, {}, SKAI_MODELS_TIMEOUT);
  return (data.models || [])
    .filter((m) => m && m.name)
    .map((m) => ({
      name: m.name,
      size: m.size || 0,
      parameter_size: (m.details && m.details.parameter_size) || "",
      quantization_level: (m.details && m.details.quantization_level) || "",
    }));
}

/** '14B', '3.8B', '70M' -> comparable number; empty or unknown -> 0. */
function skaiParameterCount(parameterSize) {
  const match = /^([\d.]+)\s*([kKmMbBtT])?/.exec((parameterSize || "").trim());
  if (!match) {
    return 0;
  }
  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[(match[2] || "").toLowerCase()] || 1;
  return parseFloat(match[1]) * mult;
}

/** The installed model with the most parameters (then the biggest file), or "". */
function skaiPickBest(models) {
  if (!models.length) {
    return "";
  }
  const best = models.reduce((a, b) => {
    const pa = skaiParameterCount(a.parameter_size);
    const pb = skaiParameterCount(b.parameter_size);
    if (pb !== pa) {
      return pb > pa ? b : a;
    }
    return (b.size || 0) > (a.size || 0) ? b : a;
  });
  return best.name;
}

/** Host and model to use now: {host, model}. model is "" when none is available. */
async function skaiResolve() {
  const settings = await skaiSettings();
  const host = settings.ollama_host || SKAI_DEFAULT_HOST;
  if (settings.ollama_model) {
    return { host, model: settings.ollama_model, automatic: false };
  }
  let model = "";
  try {
    model = skaiPickBest(await skaiListModelsDetailed(host));
  } catch (e) {
    model = "";
  }
  return { host, model, automatic: true };
}

/**
 * Sends a conversation ({role, content} list) and returns the assistant's
 * text. Throws OllamaError (see its kinds above) on any failure.
 *
 * The answer is streamed: Ollama sends each piece as soon as it is made, so
 * neither Thunderbird's own 5-minute "no answer yet" limit nor our timeout
 * cut off a slow model. The timeout counts from the last piece received.
 */
async function skaiChat(messages, { json = false, temperature = null, timeout = SKAI_CHAT_TIMEOUT } = {}) {
  const { host, model } = await skaiResolve();
  if (!model) {
    throw new OllamaError("unavailable", "Ollama not reachable or no model installed.");
  }
  const payload = { model, messages, stream: true };
  if (json) {
    payload.format = "json";
  }
  if (temperature !== null) {
    payload.options = { temperature };
  }
  const url = `${skaiBaseUrl(host)}/api/chat`;
  const controller = new AbortController();
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeout);
  };
  arm();
  let content = "";
  try {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new OllamaError("timeout", `Ollama sent nothing for ${timeout / 1000} s.`);
      }
      throw new OllamaError("unavailable", `Cannot reach Ollama at ${url}: ${e.message || e}`);
    }
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.json()).error || "";
      } catch (e) {
        // not JSON
      }
      detail = detail || `HTTP ${response.status}`;
      // Ollama answers 404 "model 'x' not found" for a model that is not installed
      if (response.status === 404 && /model/i.test(detail)) {
        throw new OllamaError("model_missing", `Model ${model} is not installed.`, model);
      }
      throw new OllamaError("server", `Ollama error: ${detail}`, detail);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const handle = (line) => {
      line = line.trim();
      if (!line) {
        return;
      }
      let data;
      try {
        data = JSON.parse(line);
      } catch (e) {
        throw new OllamaError("invalid", "Invalid reply from Ollama.");
      }
      if (data.error) {
        throw new OllamaError("server", `Ollama error: ${data.error}`, String(data.error));
      }
      content += (data.message && data.message.content) || "";
    };
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (controller.signal.aborted) {
          throw new OllamaError("timeout", `Ollama sent nothing for ${timeout / 1000} s.`);
        }
        throw new OllamaError("interrupted", `Ollama stopped answering: ${e.message || e}`);
      }
      if (chunk.done) {
        break;
      }
      arm();
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      lines.forEach(handle);
    }
    handle(buffer + decoder.decode());
  } finally {
    clearTimeout(timer);
  }
  content = content.trim();
  if (!content) {
    throw new OllamaError("empty", "Ollama returned an empty reply.");
  }
  return content;
}
