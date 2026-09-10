# tictac

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run dev
```

## Icons

HUD and loadout glyphs come from [game-icons.net](https://game-icons.net), whose
collection is pinned as a submodule at `vendor/game-icons` (CC BY 3.0). The files
the game actually loads are generated into `public/icons/` and committed, so a
plain clone runs without fetching the submodule.

To add one: pick an icon from the collection, add a `"<app name>": "<author>/<icon>"`
line to `scripts/icons.json`, and regenerate.

```bash
git submodule update --init
bun run icons
```

`public/icons/CREDITS.txt` is generated alongside and names the author of every
icon in use.

This project was created using `bun init` in bun v1.3.14. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
