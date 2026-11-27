# Supplementary-material build

`scripts/build-supplementary.mjs` turns `.isosplat` projects into an anonymous, self-contained
folder for paper supplementary material: a welcome page with a card per scene and a view-only
viewer. It opens straight from disk (`file://`) and makes no network requests. The main
[README](../README.md#sharing-scenes-as-an-offline-folder) has the overview; this is the reference.

```sh
npm run supplementary                                   # reads splats.config.json, writes splats/
node scripts/build-supplementary.mjs other.json --out some/dir --no-thumbs
```

A build with rendered thumbnails takes a few minutes: they are drawn in software by headless
Chrome. If Chrome is not found, set `CHROME=/path/to/chrome`, or pass `--no-thumbs`.

## Config

`splats.config.json` in the repository root is git-ignored, because it usually names the paper.
Paths in it are relative to the config file.

```json
{
  "title": "Paper title",
  "subtitle": "Supplementary material",
  "intro": "Optional sentence under the title.",
  "forbidden": ["author name", "university"],
  "scenes": [
    { "file": "room.isosplat", "label": "Room", "description": "Optional line under the card." },
    { "file": "hall.isosplat", "label": "Hall", "thumbnail": "thumbs/hall.png" }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `title`, `subtitle`, `intro` | Texts of the welcome page. `intro` is optional. |
| `forbidden` | Extra strings (author names, affiliations…) that must not appear in the output. |
| `scenes[].file` | The `.isosplat` project. Required. |
| `scenes[].label` | Card and viewer name. Defaults to "Scene N". |
| `scenes[].description` | Optional short line under the card. |
| `scenes[].thumbnail` | Optional `.png`, `.jpg` or `.webp` image. Defaults to a render of the scene's saved view. |

## Adding a scene

1. Set the scene up in the app and save it as a `.isosplat` project. The viewer opens it exactly
   as saved: the view (camera position, projection and zoom), the cut-planes and cut-boxes that are
   enabled, overlays, minimap, background, depth view, render mode (gaussians or points) and the
   WASD fly speed. The selection is cleared. Reviewers can move cut-planes (drag an arrow, or
   click a plane and press G) but not edit anything else; reloading the scene restores it.
2. Add an entry to `scenes` in the config. The order of the entries is the order of the cards, and
   the number keys `1`–`9` on the welcome page open them.
3. Rebuild.

Scene data is stored once per scene (gzipped, base64), so two scenes that share a splat cost twice.
It lives in `scenes/sceneN.js` rather than as `.ply` files because a page opened from disk may load
scripts but not read data files.
Trajectories are included like splats (renamed, `#` comment lines removed).

## Thumbnails

By default each card shows a clean render (no overlays) of the scene's saved view (16:9),
with a transparent background if the project has "transparent render" on. To change it:

- Change the saved view in the project (frame the scene, then Save) and rebuild, or
- Render any image you like (e.g. with Render PNG from a camera in the app), and set it as
  `thumbnail` for that scene. It is shown whole (fitted, not cropped) in a 4:3 card.

Thumbnails are embedded in `index.html` as base64 images, so the welcome page is a single file.

## Output and packaging

```
splats/
├── index.html        welcome page (thumbnails embedded)
├── viewer.html       viewer: app code and styles inlined; viewer.html#sceneN opens a scene
├── README.txt        instructions for reviewers
└── scenes/sceneN.js  scene data, one script per scene
```

Keep the layout as it is (renaming the `splats` folder itself is fine). Check it by opening
`index.html` from disk, then zip it without user and group IDs:

```sh
zip -r -X splats.zip splats
```

The build writes to `splats.partial/` and renames it to `splats/` only once everything succeeded,
so a failed build never leaves a half-written folder.

## Anonymity

The output contains no app name, links, original splat file names or PLY header comments. The build
fails without writing anything if a page, scene description or PLY header contains a string from
`FORBIDDEN` in the script (the app and its hosting) or from `forbidden` in the config: put every
author name and affiliation there.
Element names inside projects (cameras, cut-planes) are kept: name them neutrally.

The viewer itself is this public app, so its interface could lead a determined reviewer to the
repository. During a double-blind review, consider making the repository and its GitHub Pages site
private.
