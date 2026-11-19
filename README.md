# SKAI for Thunderbird

AI add-on for Thunderbird, part of [Skorpion OS](https://github.com/Endrx2008/skorpion_os).

## Install
Download `skai-thunderbird.xpi` from the latest release, then in Thunderbird open
**Add-ons and Themes > gear icon > Install Add-on From File** and select it.

## SKAI_ Memory
The chats use the shared SKAI memory (`/var/lib/skai/SKAI_ Memory`, installed with the `sk-notes` package): what other
SKAI apps know is added to the prompt, and each exchange is recorded in this add-on's own notes (`plugins/sk_mail`).
Without the memory nothing changes. `xpi/lib/skai_memory.js` is generated: `python3 tools/make_memory_lib.py <skai_memory.js>`.

## Build
`python3 tools/build_xpi.py` writes `dist/skai-thunderbird.xpi`.
