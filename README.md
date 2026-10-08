# Annotations for Paseo

A [Paseo](https://paseo.sh) plugin for reviewing an agent's answer like a doc. Select any passage, leave a comment, and every waiting comment goes out with your next message, or ask about the passage in a new chat. See [OVERVIEW.md](OVERVIEW.md) for what it does and what it stores.

## Install

Enable plugins on the target host under **Settings → Plugins**, then:

```bash
paseo plugin add git:neunzig-zehn/paseo-annotations
```

Use `--host <url>` to install on another daemon. It installs as `annotations`.

## Develop

```bash
npm install
npm run typecheck
paseo plugin install "$PWD"
paseo plugin reload annotations
```

`npm run hero` renders `assets/hero.png`, the first listing image, from `assets/hero.html` with Chrome; set `CHROME` to use another Chromium binary.

| Path                     | Runtime | Role                                                                            |
| ------------------------ | ------- | ------------------------------------------------------------------------------- |
| `index.client.tsx`       | App     | Wires the store, the composer pills, and the chat features                      |
| `client/store.ts`        | App     | Client copy of the annotations; changes apply locally, then persist             |
| `client/pill.tsx`        | App     | "N annotations" composer pill and its panel, on every platform                  |
| `client/web/`            | App     | Desktop and browser only: selection toolbar, annotation card, badges, send hook |
| `client/actions.ts`      | App     | Sending messages and starting a new chat through the Paseo SDK                  |
| `index.server.ts`        | Daemon  | RPC handlers                                                                    |
| `server/store.ts`        | Daemon  | `<PASEO_HOME>/plugin-data/annotations/annotations.json`, mode 0600              |
| `shared/annotations.ts`  | Both    | Annotation schema and RPC contracts                                             |

Paseo 0.11.1 has no plugin API for chat selections, the message box, or chat decorations, so `client/web/` drives the app's DOM. Every host selector and internal it relies on is listed at the top of `client/web/dom.ts`; check that file first when a Paseo release breaks the plugin.

- `popover.ts` draws the selection toolbar and the annotation card, styled after Paseo's browser annotation card, in a shadow root on `document.body`.
- `markers.ts` tints annotated passages through the CSS Custom Highlight API and pins numbered badges to waiting ones, styled after Paseo's browser annotation badges.
- `send-hook.ts` appends waiting annotations to the composer on Enter or the send button, and takes them back out when the key did not send.

With the plugin on several hosts, each installation only handles chats of agents on its own host (`client/agents.ts`).

## Credits

Parts of the selection handling are adapted from [paseo-quote](https://github.com/keefeere/paseo-quote) by Chechulin Serhii, under the MIT License; see [NOTICE.md](NOTICE.md).

## License

MIT
