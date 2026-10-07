# Third-party assets

The sprites under `sprites/` come from two free asset packs by Kenney
(Nikolai Clausen), licensed CC0 1.0 Universal:

- **Kenney Space Shooter Extension** — ships, meteors, station parts, effects
- **Kenney Space Kit** — structure and base pieces

The full packs are not committed here because they are several hundred
megabytes of 3D models and vector source that this 2D canvas game never loads.
Only the curated, renamed copies in `sprites/` are tracked, so the page works
straight from a clone.

To restore the originals, drop both kit folders in beside this file:

```
assets/
  kenney_space-kit/
  kenney_space-shooter-extension/
  sprites/          <- committed, used by the page
```

Renaming was deliberate: the renderer references stable semantic names such as
`ship_entry.png` and `wall_a.png`, so swapping a different pack means editing
`SPRITE_FILES` in `docs/app.js` rather than hunting through source filenames.

CC0 1.0 Universal: https://creativecommons.org/publicdomain/zero/1.0/