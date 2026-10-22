# Meme GIF Maker

Find a GIF, put text or images on it, animate them, export a GIF. Runs entirely in the browser:
nothing is uploaded anywhere, and it installs as an app on desktop and phone (PWA).

**Live:** https://eidriaen.github.io/meme-gif-maker/

## What it does

- **Find GIFs** on GIPHY (GIFs and transparent stickers), or paste a GIPHY / `.gif` link.
- **Use your own** GIF, image (PNG/JPG/WebP) or short video (sampled at 15 fps, max 12 s).
  Drag & drop or paste works too.
- **Text overlays**: Impact-style meme text with outline, fonts, colours, wrapping, shadow.
- **Image overlays**: your own PNG/JPG (with one-click background removal), or an animated GIPHY sticker.
- **Animate overlays**:
  - *Keyframes*: add a keyframe, scrub to another frame, move/scale/rotate/fade the layer; it
    interpolates between keys (smooth, linear or jump).
  - *Track motion*: puts keyframes on every frame so the layer follows what's underneath it,
    for example a face, including zooms.
  - *Presets*: entrance (pop, fade, slide, drop, spin, typewriter), loop (shake, pulse, wiggle,
    bounce, float, spin, flash, rainbow, grow) and exit effects.
  - *Show from/to frame*, so a layer appears only during part of the clip.
- **Output**: trim, speed, reverse, boomerang, width and colour count. On phones, **Share** sends
  the GIF straight to another app.

Shortcuts: `Space` play/pause · `←/→` step (Shift = 5) · `K` keyframe · `T` new text ·
`Del` delete layer · `Ctrl+Z / Ctrl+Shift+Z` undo/redo.

## GIPHY key

Search needs a free GIPHY API key (pasting links works without one):

1. Sign in at https://developers.giphy.com/dashboard/ → **Create an App** → **API** → copy the key.
2. In the app open **⚙ Settings** and paste it. It is stored in that browser only.
   Shortcut for a new device: open the app once as `…/meme-gif-maker/?giphy=YOUR_KEY`.

(Tenor's API was shut down on 30 June 2026, so GIPHY is the source.)

## Develop

No build step. Serve the folder and open it:

```sh
python -m http.server 8000
```

| File | What |
|---|---|
| `js/app.js` | UI, state, playback, canvas interaction, undo |
| `js/layers.js` | Layer model, keyframes, animation presets, drawing |
| `js/gif-decode.js` | GIF decoder (handles disposal, transparency, interlace) |
| `js/media.js` | Loading GIF / image / video / URL into frames |
| `js/track.js` | Template-matching motion tracker |
| `js/bgremove.js` | Edge flood-fill background removal |
| `js/export.js` | GIF encoding via [gifenc](https://github.com/mattdesl/gifenc) (vendored) |
| `sw.js`, `manifest.webmanifest` | Offline + installable |

Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`.
