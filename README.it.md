# sk_mail — SKAI per Thunderbird

Un componente aggiuntivo di Thunderbird per [Skorpion OS](https://github.com/Endrx2008/skorpion_os):
**SKAI** in una barra laterale a destra, per la posta e per il calendario. *English: [README.md](README.md).*

## Installazione

Scarica `skai-thunderbird.xpi` dall'[ultima release](https://github.com/Endrx2008/sk_mail/releases/latest),
poi in Thunderbird apri **Componenti aggiuntivi e temi → icona a ingranaggio → Installa componente
aggiuntivo da file** e selezionalo. Serve Thunderbird 128 o successivo.

## Cosa fa

- **Posta:** *Chat* sul messaggio aperto, *Summary* (riassunto in poche frasi), *Reply*: una bozza
  modificabile e **Use this reply** per aprirla in una finestra di scrittura.
- **Calendario:** una chat che aggiunge, sposta ed elimina eventi; ogni eliminazione chiede prima conferma.
- Il pulsante **SKAI** nella barra degli strumenti mostra o nasconde la barra laterale; la scelta viene ricordata.

L'interfaccia del componente è in inglese.

## SKAI

Il componente parla con Ollama in locale (`http://localhost:11434`) e usa il modello installato con
più parametri. L'ingranaggio nella barra laterale apre le impostazioni: un altro indirizzo di Ollama o un modello
fisso. Se Ollama è spento, il modello manca o una risposta impiega più di 10 minuti, un messaggio spiega
cosa è successo.

Se SKAI_ Memory è installata (arriva con il pacchetto [`sk-notes`](https://github.com/Endrx2008/sk_notes);
poi `sudo usermod -aG skai <utente>`), quello che sanno le altre app SKAI viene aggiunto al prompt e ogni
scambio viene registrato nelle note del componente (`plugins/sk_mail`). Senza, non cambia nulla.

## Compilazione

```sh
python3 tools/build_xpi.py          # → dist/skai-thunderbird.xpi
```

`xpi/lib/skai_memory.js` è generato da `skai_memory/skai_memory.js` di sk_notes:
`python3 tools/make_memory_lib.py <percorso di skai_memory.js>`. Non modificarlo a mano.

## Licenza

GPL-3.0-or-later, vedi [LICENSE](LICENSE). © 2026 Enrico Miot (EndrX), fondatore e manutentore di Skorpion OS.
