/* Copyright (C) 2026 Enrico Miot (EndrX)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* Experiment: a real sidebar in the main Thunderbird window.
 *
 * Thunderbird has no sidebar API for add-ons, so this puts a splitter and a
 * <browser> with an extension page on the right of #tabmail, before the
 * Today Pane. The browser is built like Thunderbird's own extension popups
 * (ExtensionPopups.sys.mjs: same attributes, same loading), so the page gets
 * the normal messenger.* APIs. It stays in place across tab switches (mail,
 * calendar, tasks), hiding it keeps the chat history.
 */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");

const BOX_ID = "skai-sidebar-box";
const SPLITTER_ID = "skai-sidebar-splitter";
const DEFAULT_WIDTH = 330;

function whenLoaded(window) {
  if (window.document.readyState === "complete" && window.document.getElementById("tabmail-container")) {
    return Promise.resolve();
  }
  return new Promise((resolve) => window.addEventListener("load", () => resolve(), { once: true }));
}

function removeFrom(window) {
  const doc = window.document;
  for (const id of [BOX_ID, SPLITTER_ID]) {
    const el = doc.getElementById(id);
    if (el) {
      el.remove();
    }
  }
}

async function createIn(window, extension, url) {
  const doc = window.document;
  const container = doc.getElementById("tabmail-container");
  if (!container) {
    throw new Error("tabmail-container not found: not a main Thunderbird window");
  }
  const before = doc.getElementById("today-splitter") || null;

  const splitter = doc.createXULElement("splitter");
  splitter.id = SPLITTER_ID;
  splitter.setAttribute("resizebefore", "closest");
  splitter.setAttribute("resizeafter", "closest");
  splitter.setAttribute("collapse", "after");
  splitter.style.minWidth = "4px";

  const box = doc.createXULElement("vbox");
  box.id = BOX_ID;
  box.style.width = `${DEFAULT_WIDTH}px`;
  box.style.minWidth = "240px";
  box.style.borderInlineStart = "1px solid var(--splitter-color, #444)";

  const browser = doc.createXULElement("browser");
  browser.setAttribute("type", "content");
  browser.setAttribute("disableglobalhistory", "true");
  browser.setAttribute("messagemanagergroup", "webext-browsers");
  browser.setAttribute("webextension-view-type", "popup");
  browser.setAttribute("tooltip", "aHTMLTooltip");
  browser.setAttribute("context", "browserContext");
  browser.setAttribute("autocompletepopup", "PopupAutoComplete");
  browser.setAttribute("selectmenulist", "ContentSelectDropdown");
  browser.setAttribute("datetimepicker", "DateTimePickerPanel");
  browser.setAttribute("maychangeremoteness", "true");
  browser.setAttribute("initialBrowsingContextGroupId", extension.policy.browsingContextGroupId);
  browser.toggleAttribute("nodefaultsrc", true);
  if (extension.remote) {
    browser.toggleAttribute("remote", true);
    browser.setAttribute("remoteType", extension.remoteType);
  }
  browser.setAttribute("flex", "1");

  const ready = extension.remote
    ? new Promise((resolve) => browser.addEventListener("XULFrameLoaderCreated", resolve, { once: true }))
    : Promise.resolve();

  box.appendChild(browser);
  container.insertBefore(splitter, before);
  container.insertBefore(box, before);

  await ready;
  ExtensionParent.apiManager.emit("extension-browser-inserted", browser);
  browser.fixupAndLoadURIString(url, { triggeringPrincipal: extension.principal });
}

this.skaiSidebar = class extends ExtensionCommon.ExtensionAPI {
  onShutdown(isAppShutdown) {
    if (isAppShutdown) {
      return;
    }
    for (const window of Services.wm.getEnumerator("mail:3pane")) {
      removeFrom(window);
    }
  }

  getAPI(context) {
    const extension = context.extension;
    const getWindow = (windowId) => {
      const wrapper = extension.windowManager.get(windowId, context);
      const window = wrapper && wrapper.window;
      if (!window || window.document.documentElement.getAttribute("windowtype") !== "mail:3pane") {
        return null;
      }
      return window;
    };
    return {
      skaiSidebar: {
        async setVisible(windowId, visible, url) {
          const window = getWindow(windowId);
          if (!window) {
            return false;
          }
          await whenLoaded(window);
          let box = window.document.getElementById(BOX_ID);
          if (!box) {
            if (!visible) {
              return false;
            }
            await createIn(window, extension, extension.baseURI.resolve(url));
            box = window.document.getElementById(BOX_ID);
          }
          box.hidden = !visible;
          window.document.getElementById(SPLITTER_ID).hidden = !visible;
          return true;
        },
        async isVisible(windowId) {
          const window = getWindow(windowId);
          const box = window && window.document.getElementById(BOX_ID);
          return !!box && !box.hidden;
        },
        // Thunderbird's own windows, the same ones its menus open
        async openAccountSetup(windowId) {
          const window = getWindow(windowId);
          if (!window) {
            return false;
          }
          await window.openAccountHub("MAIL");
          return true;
        },
        async openNewCalendar(windowId) {
          const window = getWindow(windowId);
          if (!window) {
            return false;
          }
          cal.window.openCalendarWizard(window);
          return true;
        },
      },
    };
  }
};
