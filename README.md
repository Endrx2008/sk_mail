# sk_mail — SKAI for Thunderbird

A Thunderbird add-on of [Skorpion OS](https://github.com/Endrx2008/skorpion_os): **SKAI** in a sidebar on
the right, for mail and for the calendar. *Italiano: [README.it.md](README.it.md).*

## Install

Download `skai-thunderbird.xpi` from the [latest release](https://github.com/Endrx2008/sk_mail/releases/latest),
then in Thunderbird open **Add-ons and Themes → gear icon → Install Add-on From File** and select it.
Needs Thunderbird 128 or newer.

## What it does

- **Mail:** *Chat* about the open message, *Summary* in a few sentences, *Reply*: an editable draft and
  **Use this reply** to open it in a compose window.
- **Calendar:** a chat that adds, moves and deletes events; every deletion asks first.
- The toolbar button **SKAI** shows or hides the sidebar; the choice is remembered.

## SKAI

The add-on talks to the local Ollama (`http://localhost:11434`) and uses the installed model with the most parameters. The
gear in the sidebar opens the settings: another Ollama host, or a fixed model. When Ollama is off, the
model is missing or an answer takes more than 10 minutes, a message says what happened.

When SKAI_ Memory is installed (it comes with the [`sk-notes`](https://github.com/Endrx2008/sk_notes)
package; then `sudo usermod -aG skai <user>`), what the other SKAI apps know is added to the prompt and
each exchange is recorded in the add-on's own notes (`plugins/sk_mail`). Without it nothing changes.

## Build

```sh
python3 tools/build_xpi.py          # → dist/skai-thunderbird.xpi
```

`xpi/lib/skai_memory.js` is generated from `skai_memory/skai_memory.js` of sk_notes:
`python3 tools/make_memory_lib.py <path to skai_memory.js>`. Do not edit it by hand.

## License

GPL-3.0-or-later, see [LICENSE](LICENSE). © 2026 Enrico Miot (EndrX), founder and maintainer of Skorpion OS.
