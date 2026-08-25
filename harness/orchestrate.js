/* The scripted acceptance scenario, run top-to-bottom on first load:
 * settle -> 3 self-titled navigations -> head churn at rest -> tab
 * churn behind an observer tab -> 3 reloads. Posts the cumulative
 * recorder log to the verify.py collector at each phase boundary;
 * reload state rides sessionStorage. */

(async () => {
  "use strict";
  const rec = window.__titleRecorder;
  const statusEl = document.getElementById("status");
  const status = (msg) => {
    statusEl.textContent += msg + "\n";
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const loadCount = Number(sessionStorage.getItem("ephemeris-loads") || "1");

  const post = (phase) =>
    fetch("/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "orchestrator",
        load: loadCount,
        phase,
        title: document.title,
        log: rec.log,
      }),
    }).catch(() => {});

  const waitDecorated = async (timeoutMs) => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (/^\d+ .*\[.*\]$/.test(document.title)) return true;
      await sleep(50);
    }
    return false;
  };

  status("load " + loadCount);
  const decorated = await waitDecorated(3000);
  await sleep(300);
  if (!decorated) {
    /* Non-fatal: in RED mode legacy extensions decorate in a foreign
     * shape (or fight); the scenario still runs to produce the log. */
    await post("undecorated");
    status("title never matched the ephemeris shape - continuing");
  }

  if (loadCount > 1) {
    await post("reload-" + loadCount);
    if (loadCount < 4) {
      sessionStorage.setItem("ephemeris-loads", String(loadCount + 1));
      location.reload();
    } else {
      await post("done");
      status("done");
    }
    return;
  }

  rec.mark("load-done");
  await post("load");
  status("decorated: " + document.title);

  for (let k = 1; k <= 3; k++) {
    rec.mark("nav-" + k);
    location.hash = "route-" + k;
    document.title = "Route " + k;
    await sleep(400);
  }
  rec.mark("navs-done");
  await post("nav");
  status("navigations done");

  rec.mark("rest");
  const style = document.createElement("style");
  document.head.appendChild(style);
  for (let i = 0; i < 50; i++) {
    style.textContent = "/* churn " + i + " */";
    const meta = document.createElement("meta");
    meta.name = "churn";
    meta.content = String(i);
    document.head.appendChild(meta);
    meta.remove();
    await sleep(20);
  }
  await sleep(400);
  rec.mark("rest-done");
  await post("rest");
  status("rest churn done");

  rec.mark("shift");
  const churn1 = window.open("blank.html");
  await sleep(400);
  const churn2 = window.open("blank.html");
  await sleep(400);
  const observer = window.open("observer.html");
  if (!churn1 || !churn2 || !observer) {
    await post("shift-blocked");
    status("window.open blocked - check dom.disable_open_during_load");
    return;
  }
  await sleep(1200);
  churn1.close();
  await sleep(700);
  churn2.close();
  await sleep(700);
  rec.mark("shift-done");
  await post("shift");
  status("tab churn done");

  sessionStorage.setItem("ephemeris-loads", "2");
  await post("pre-reload");
  location.reload();
})();
