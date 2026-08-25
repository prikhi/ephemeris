/* Publishes tab positions. Holds NO index cache: structural events
 * only TRIGGER a renumber, & every renumber does a fresh tabs.query,
 * so a stale snapshot (the old Tab Numbers defect) is unrepresentable.
 * Positions are 1-based, matching Firefox's Alt+1..8 tab shortcuts.
 * No permissions needed: query/index/sendMessage are permission-free
 * (only url/title on Tab objects require the "tabs" permission). */

"use strict";

let renumberScheduled = false;

/* Coalesce event bursts (a window close fires one onRemoved per tab)
 * into a single renumber on a 0-tick, which also lets the tab list
 * settle before it is queried. */
const scheduleRenumber = () => {
  if (renumberScheduled) return;
  renumberScheduled = true;
  setTimeout(renumber, 0);
};

/* Over-sending is harmless by construction: the content script writes
 * only when its index actually changes. Failed sends (about: pages,
 * AMO, lazy restored tabs, closing tabs) are swallowed - an unloaded
 * tab pulls a fresh index when its content script wakes. */
const renumber = async () => {
  renumberScheduled = false;
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    browser.tabs
      .sendMessage(tab.id, { type: "index", index: tab.index + 1 })
      .catch(() => {});
  }
};

browser.tabs.onCreated.addListener(scheduleRenumber);
browser.tabs.onRemoved.addListener(scheduleRenumber);
browser.tabs.onMoved.addListener(scheduleRenumber);
browser.tabs.onAttached.addListener(scheduleRenumber);
browser.tabs.onDetached.addListener(scheduleRenumber);

/* A content script's hello: its position rides the reply, so a script
 * cannot miss a push it was not yet alive for. */
browser.runtime.onMessage.addListener((message, sender) => {
  if (message && message.type === "hello" && sender.tab) {
    return Promise.resolve({ type: "index", index: sender.tab.index + 1 });
  }
  return undefined;
});
