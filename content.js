/* The ONLY title writer. Composes "<index> <core> [<host>]" around a
 * core it never parses: a page-origin write ALWAYS becomes the new
 * core verbatim, & our own state (core, index, lastWrite) lives here
 * in-band - the title register is never read back to recover it, so
 * accumulation & rewrite fights are unrepresentable. */

"use strict";

/* Headless XML/SVG documents have no <head> to observe & no HTML
 * title to decorate - leave them untouched. */
if (document.head) {
  let core = document.title;
  let index = null;
  let lastWrite = null;

  const compose = () => {
    const host = location.hostname;
    const parts = [
      index === null ? "" : String(index),
      core,
      host === "" ? "" : "[" + host + "]",
    ];
    return parts.filter((part) => part !== "").join(" ");
  };

  /* No write before the first index fact arrives: pre-index page
   * writes only update core, so the composed format never flickers
   * & load costs at most one extension write. */
  const write = () => {
    if (index === null) return;
    const composed = compose();
    if (document.title === composed) return;
    lastWrite = composed;
    document.title = composed;
  };

  /* Observe document.head, not the title node: assignment auto-creates
   * a missing <title>, & frameworks may replace the element wholesale.
   * document.title is read live at callback time, so batched mutation
   * records cannot resurrect a superseded value. */
  const onHeadMutation = () => {
    const title = document.title;
    if (title === lastWrite) return;
    if (title === compose()) return;
    core = title;
    write();
  };
  new MutationObserver(onHeadMutation).observe(document.head, {
    subtree: true,
    childList: true,
    characterData: true,
  });

  const receiveIndex = (message) => {
    if (
      message &&
      message.type === "index" &&
      typeof message.index === "number" &&
      message.index !== index
    ) {
      index = message.index;
      write();
    }
  };

  browser.runtime.onMessage.addListener(receiveIndex);

  /* Failed sends are swallowed: a dead background means no numbering
   * anyway, & the next structural push heals the gap. */
  const hello = () => {
    browser.runtime.sendMessage({ type: "hello" }).then(receiveIndex, () => {});
  };

  /* A bfcache restore revives this script's state & a decorated title
   * whose index may have gone stale while frozen, & no structural tab
   * event fires for it - re-pull. */
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) hello();
  });

  hello();
}
