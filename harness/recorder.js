/* ephemeris verification harness - the in-page title-write recorder.
 *
 * Include via <script> (fixtures) or paste into the console of a live
 * page (orrery) BEFORE exercising it. Records every title write as
 * { n, ms, origin, value }:
 *
 *   - "page": the write went through the patched document.title
 *     setter, i.e. page-context JS. The ephemeris content script runs
 *     in an Xray sandbox & sees the ORIGINAL setter, so its writes
 *     bypass the patch entirely.
 *   - "extension": a title mutation with no matching setter call.
 *   - "mark": a caller-inserted phase label, via mark(label).
 *
 * API: window.__titleRecorder = { log, mark, summary, reset, subscribe }
 *
 * summary() self-checks the standing invariants: no echo (adjacent
 * duplicate values), no oscillation (an A-B-A value flip inside
 * 500ms), no accumulation (a doubled index prefix or bracket suffix).
 *
 * Known approximation: individual write values are reconstructed from
 * batched mutation records via characterData oldValue chaining; a
 * childList record (an empty title gaining its first text node) falls
 * back to the live title. Non-empty-to-non-empty writes - every write
 * orrery & ephemeris make - reconstruct exactly.
 */

(() => {
  "use strict";
  if (window.__titleRecorder) {
    console.warn("titleRecorder: already installed");
    return;
  }

  const t0 = performance.now();
  const log = [];
  const listeners = [];

  const record = (origin, value) => {
    const entry = {
      n: log.length,
      ms: Math.round((performance.now() - t0) * 10) / 10,
      origin,
      value,
    };
    log.push(entry);
    console.log(
      "[title-write " + entry.n + "] +" + entry.ms + "ms " +
        origin + ": " + JSON.stringify(value)
    );
    listeners.forEach((listener) => listener(entry));
  };

  /* The title accessor pair lives up the prototype chain (Document);
   * patch the document INSTANCE so page-context writes hit us first. */
  let proto = Object.getPrototypeOf(document);
  let descriptor = null;
  while (
    proto &&
    !(descriptor = Object.getOwnPropertyDescriptor(proto, "title"))
  ) {
    proto = Object.getPrototypeOf(proto);
  }
  const nativeGet = descriptor.get.bind(document);
  const nativeSet = descriptor.set.bind(document);

  /* Setter-recorded values awaiting their mutation records, so they
   * are not double-counted as extension writes. Entries are dropped
   * after 1s: a same-value page write may produce no visible record. */
  const pendingPageWrites = [];
  Object.defineProperty(document, "title", {
    configurable: true,
    get: nativeGet,
    set(value) {
      pendingPageWrites.push({ value: String(value), at: performance.now() });
      record("page", String(value));
      nativeSet(String(value));
    },
  });

  const isTitleRecord = (r) => {
    if (r.type === "characterData") {
      const parent = r.target.parentNode;
      return parent !== null && parent.nodeName === "TITLE";
    }
    if (r.type === "childList") {
      if (r.target.nodeName === "TITLE") return true;
      const added = Array.from(r.addedNodes);
      return added.some((node) => node.nodeName === "TITLE");
    }
    return false;
  };

  /* Reconstruct each individual write from a batch: the value AFTER
   * title record i is the NEXT title record's oldValue; the last one
   * is the live title. */
  const onMutations = (records) => {
    const titleRecords = records.filter(isTitleRecord);
    if (titleRecords.length === 0) return;
    const now = performance.now();
    while (pendingPageWrites.length > 0 && now - pendingPageWrites[0].at > 1000) {
      pendingPageWrites.shift();
    }
    for (let i = 0; i < titleRecords.length; i++) {
      let after = null;
      for (let j = i + 1; j < titleRecords.length; j++) {
        if (titleRecords[j].type === "characterData") {
          after = titleRecords[j].oldValue;
          break;
        }
      }
      if (after === null) after = nativeGet();
      if (
        pendingPageWrites.length > 0 &&
        pendingPageWrites[0].value === after
      ) {
        pendingPageWrites.shift();
      } else {
        record("extension", after);
      }
    }
  };

  /* Observe document.head, mirroring the extension: catches writes to
   * an existing title, an auto-created title element, & wholesale
   * element replacement; isTitleRecord screens out unrelated churn. */
  new MutationObserver(onMutations).observe(document.head, {
    subtree: true,
    childList: true,
    characterData: true,
    characterDataOldValue: true,
  });

  const writes = () => log.filter((e) => e.origin !== "mark");

  const summary = () => {
    const all = writes();
    const counts = { page: 0, extension: 0 };
    all.forEach((e) => {
      counts[e.origin] += 1;
    });
    let echo = 0;
    let oscillation = 0;
    let accumulation = 0;
    for (let i = 1; i < all.length; i++) {
      if (all[i].value === all[i - 1].value) echo += 1;
      if (
        i >= 2 &&
        all[i].value === all[i - 2].value &&
        all[i].value !== all[i - 1].value &&
        all[i].ms - all[i - 2].ms < 500
      ) {
        oscillation += 1;
      }
    }
    all.forEach((e) => {
      const doubledSuffix = e.value.split(" [").length > 2;
      const doubledIndex = /^\d+ \d+ /.test(e.value);
      if (doubledSuffix || doubledIndex) accumulation += 1;
    });
    const result = {
      totalWrites: all.length,
      pageWrites: counts.page,
      extensionWrites: counts.extension,
      echo,
      oscillation,
      accumulation,
      healthy: echo === 0 && oscillation === 0 && accumulation === 0,
    };
    console.table(log);
    console.log("titleRecorder summary:", result);
    return result;
  };

  window.__titleRecorder = {
    log,
    mark: (label) => record("mark", label),
    summary,
    reset: () => {
      log.length = 0;
    },
    subscribe: (listener) => {
      listeners.push(listener);
    },
  };
  console.log("titleRecorder: installed (window.__titleRecorder)");
})();
