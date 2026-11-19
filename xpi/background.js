/* Copyright (C) 2026 Enrico Miot (EndrX)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* Puts the SKAI sidebar in every main Thunderbird window and lets the
 * toolbar button show/hide it. Visible by default;
 * the last choice is remembered.
 */
"use strict";

async function sidebarWanted() {
  const { sidebar_visible } = await browser.storage.local.get({ sidebar_visible: true });
  return sidebar_visible;
}

async function applyTo(windowId, visible) {
  try {
    await browser.skaiSidebar.setVisible(windowId, visible, `sidebar.html?windowId=${windowId}`);
  } catch (e) {
    console.error("SKAI: cannot place the sidebar", e);
  }
}

async function applyToAll() {
  const visible = await sidebarWanted();
  for (const win of await browser.windows.getAll({ windowTypes: ["normal"] })) {
    await applyTo(win.id, visible);
  }
}

browser.windows.onCreated.addListener(async (win) => {
  if (win.type === "normal") {
    await applyTo(win.id, await sidebarWanted());
  }
});

browser.browserAction.onClicked.addListener(async (tab) => {
  const visible = !(await browser.skaiSidebar.isVisible(tab.windowId));
  await browser.storage.local.set({ sidebar_visible: visible });
  await applyToAll();
});

applyToAll();
