# IsoSplat

![An office room seen in an isometric cut-away view, rendered three ways: 3DGS scene, depth (jet colormap), and point cloud](.docs/cover.png)

**Live app: [mateosss.github.io/isosplat](https://mateosss.github.io/isosplat)**

IsoSplat is a web viewer for 3D Gaussian Splatting scenes of rooms. It shows them in isometric
views, with cut-planes that remove walls and ceilings. You can import `.ply` splats, place
pinhole or orthographic cameras, edit with Blender-style controls, switch between gaussian,
point-cloud and depth rendering, and export clean PNG renders.

**Example project:** [droneroom.isosplat](https://syncandshare.lrz.de/getlink/fiSYCm4n3M7t8yYcvjA5pz/droneroom.isosplat)
is the scene used for the cover images above. Download it and open it in the app with **Open**
or by dropping it onto the window.

## Running

```sh
npm install
npm run dev       # http://localhost:5173
npm run build     # typecheck + production build in dist/
```

### Deploying to GitHub Pages

`.github/workflows/pages.yml` builds the app on every push to `main` and publishes it with
GitHub Pages (the build is uploaded as a Pages artifact, so `dist/` is never committed).
One-time setup: in the repository settings, **Pages → Source: GitHub Actions**.
The site is fully static and uses relative asset paths, so it works at `https://<user>.github.io/<repo>/`.

Built with [three.js](https://threejs.org) and [Spark](https://sparkjs.dev) (3DGS renderer).
Cut-planes are implemented as a global Spark `SplatEdit` (one PLANE SDF per enabled cut-plane,
opacity 0) for gaussians, and as three.js clipping planes for the point-cloud render.

## Conventions

- World is **Z-up** (like Blender); the floor grid is the XY plane.
- Cameras use the three.js convention: they look down local **−Z** with **+Y** up.
  Pinhole intrinsics (fx, fy, cx, cy) are in pixels of the camera resolution, OpenCV style.
- Orthographic scale is the world size covered by the larger image side (like Blender).

## Controls

| Input | Action |
| --- | --- |
| LMB drag / RMB drag / wheel | orbit / pan / zoom (Shift+LMB also pans) |
| LMB click | select splat, camera or cut-plane (click on the plane border or arrow) |
| G / R / S | move / rotate / scale the selection (mouse must be over the viewport) |
| X / Y / Z during G/R/S | constrain to global axis; press again for local; again to clear |
| digits, `-`, Backspace | type an exact value (metres / degrees / factor) |
| Ctrl / Shift during G/R/S | snap / precision |
| LMB or Enter / RMB or Esc | confirm / cancel transform |
| F | orbit around the surface under the mouse cursor (view pans to center it) |
| ⊕ Orbit center button | orbit around the surface at the viewport center (view doesn't move) |
| Numpad . / Period, Home | frame selected / frame all splats |
| Del | delete selected |
| 1 / 3 / 7 | front / right / top view; with Ctrl (or Shift) back / left / bottom |
| 2 / 4 / 6 / 8 | orbit 15° down / left / right / up; with Ctrl: pan |
| 9 / 5 / 0 | opposite side / persp↔ortho / look from (selected or first) camera |
| Numpad + / − | zoom in / out |
| Z / ◐ Depth button | toggle depth view (jet colormap) |
| Ctrl+S / Ctrl+Shift+S / Ctrl+O | save project / save as / open project |
| Number fields | click to type, drag horizontally to scrub (Shift fine, Ctrl snap, Esc restore) |
| WASD button | fly mode: WASD move, mouse look, Q/E down/up, Shift faster, wheel = base speed, Esc exits |

## Projects, rendering and world

- **Projects** (`.isosplat`) are self-contained: a small header, a JSON description of the scene
  (elements, transforms, camera/cut-plane settings, world, view) and the original splat files
  embedded byte-for-byte. In Chrome/Edge, Save writes back to the opened file; elsewhere it downloads.
  Drop a `.isosplat` file on the window to open it.
- **Render PNG** (toolbar, camera properties, or World properties) renders a clean image without
  overlays, splats sorted for the render camera, with 2× supersampling. From a camera it uses the
  camera's resolution; from the free view it uses the viewport's pixel size.
- **World** (top of the hierarchy): background color, and an option to render PNGs with a
  transparent background.
- **Depth view** colors gaussians and point clouds by their depth along the camera's view axis with
  matplotlib's jet colormap (blue = near, red = far); a legend shows the range. The range is fitted
  automatically to the visible scene (splat bounds clipped by the cut-planes) or set manually in the
  World properties. PNG renders use the depth range of the render camera.

View keys work on the numpad and on the top-row digits. Browsers often reserve Ctrl+1…8 for
switching tabs, which is why Shift also selects the opposite view.

Drag & drop `.ply` (also `.spz`, `.splat`, `.ksplat`, `.sog`) files onto the window to import.
