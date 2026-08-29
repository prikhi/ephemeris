# ephemeris

[![ephemeris Build Status](https://github.com/prikhi/ephemeris/actions/workflows/main.yml/badge.svg)](https://github.com/prikhi/ephemeris/actions/workflows/main.yml)


Number Your Tabs & Name Your Hosts, Without The Fight.

A Firefox WebExtension that composes every page title into
`<tab-index> <page-title> [<hostname>]`, replacing the Tab Numbers &
Domain in Title pair whose rewrite fight oscillated ~50 writes/300ms
against any SPA that titles its own routes. Ephemeris is immune by
construction: the content script is the only title writer, a
page-origin write always becomes the new core verbatim (never parsed,
never stripped), & the extension never reads the title register back
to recover its own state - so accumulation & write loops have no
representation.

Requires [`node`][install-node]:

```sh
npm ci --ignore-scripts
npm start          # web-ext run: a throwaway profile with the extension loaded
```

[install-node]: https://nodejs.org/en/download


## Design

Three files, no permissions:

- `content.js` holds the state in-band (`core`, `index`, `lastWrite`)
  & is the sole writer. It observes `document.head` (not the title
  node, which pages may replace or lack): its own echoes are skipped
  by value, an already-correct title is left alone, & anything else is
  the page speaking - it becomes the new core & gets recomposed. No
  write happens before the first index arrives. Headless XML/SVG
  documents & bfcache restores are handled; frames are not decorated.
- `background.js` holds no index cache: structural tab events
  (created, removed, moved, attached, detached) only schedule one
  coalesced 0-tick renumber, which does a fresh `tabs.query` & fans
  the 1-based positions out. A stale snapshot - the old Tab Numbers
  defect - is unrepresentable because there is no snapshot. Failed
  sends (about: pages, AMO, lazy restored tabs) are swallowed; an
  unloaded tab pulls a fresh index when its content script wakes.
- `manifest.json` is MV2 with zero permissions: tab ids & indexes are
  permission-free, & only `url`/`title` on Tab objects would need the
  `tabs` permission - which nothing here reads.

about:, AMO, & other restricted pages stay undecorated (no content
script runs there). Private windows stay undecorated unless the
extension is allowed in private browsing.


## Verify

The acceptance invariants are proven by a harness, not claimed:

```sh
npm run verify                             # hermetic, headless: 14 checks
python3 harness/verify.py --headed         # same, watching the browser
python3 harness/verify.py --old /tmp/ext-scope   # RED: the legacy pair fails it
```

`harness/verify.py` serves the fixture pages, launches a throwaway
headless Firefox with the extension temporary-loaded, & asserts: one
decoration write on load, exactly 2 writes per self-titled navigation
(the page's, then ours), 0 writes across sustained head churn, exactly
1 write per tab-index shift & 0 on unshifted tabs, 1 write per reload
with byte-identical titles across 3 reloads, & 0 echo / oscillation /
accumulation anywhere. `--old` sideloads the signed legacy XPIs & runs
the same scenario as the RED receipt (it exits 0 when the failures
show up).

Against a live page (e.g. an orrery instance), paste
`harness/recorder.js` into the console, exercise the page, & read
`__titleRecorder.summary()`: it logs every title write with value,
timestamp, & origin - the patched `document.title` setter tags
page-context writes, & extension writes (which bypass the patch from
their Xray sandbox) surface via mutation records.


## Install

Install it from [addons.mozilla.org][amo].

[amo]: https://addons.mozilla.org/firefox/addon/ephemeris/

Releases are signed & published from this repo, with the public
listing's metadata riding `amo-metadata.json`:

```sh
WEB_EXT_API_KEY=... WEB_EXT_API_SECRET=... npm run sign
```

Credentials come from <https://addons.mozilla.org/developers/addon/api/key/>;
the signed XPI also lands in `web-ext-artifacts/`. For a temporary dev
install use `npm start` or about:debugging (This Firefox, Load
Temporary Add-on).

NOTE: CI uploads an `ephemeris-unsigned` artifact (the same zip `npm
run build` produces). Release & beta Firefox refuse unsigned installs,
so it only serves temporary loads, manual dev-hub uploads, & build
provenance - permanent installs need the signed XPI above.


## LICENSE

BSD-3-Clause, see `LICENSE`.
