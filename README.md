This will be a 3D gaussian splatting viewer.

The idea is to visualize splats of rooms in isometric views with wall/ceiling cuts.

For this, this app will have the following characteristics:

- It's a web app using an existing 3dgs web renderer that is good
- The suer can import and show ply files as gaussian splats.
- There is a hierarchy panel with all elements
- There is a properties panel, with the properties of the selected hierarchy element
- The hierarchy can have cameras, 3dgs scenes, and cut-planes (will be explained below)
- The properties panel shows for all elements transform propertiess: XYZ position, XYZW quaternion orientation, that define their pose in the scene
- For cameras, also the camera type property: pinhole or orthographic. If pinhole, you can select fx,fy,cx,cy; if orthographic you can select the "orthographic scale" (similar to blender) that defines how much of the scene the orthographic camera is looking at (all rays parallel).
- The hierarchy panel allows you to select elements, to add new cameras, and  to delete elements. When you select an element here, the properties panel updates to accomodate for it
- You can have multiple cameras on the scene and you can make the viewport look like one of them by clicking a button on their properties "look from camera".
- The other type of element is 3dgs scenes, I want you to add in the properties panel a way to switch between 3DGS render and point cloud render (the scenes will be a bit heavy and having a point cloud render might help speed)
- The final type of element is cut-plane, these are planes meshes, that are rendered in "wireframe". By the fault they will be 6 of them covering a cube of 10x10x10 meters. The idea is that these cut-plans remove gaussians from all the 3dgs scenes in the hierarcy until the point of the plane. So, in the properties panel, you can only change the location of the plane (not the rotation). And instead they have a property "cut direction" that can be any of: +X +Y +Z -X -Y -Z. When you select +Y for example, the view will show the plane in XZ with an arrow putting towards +Y, and any gaussian mean that has an Y coordinate that is less than the Y component of the location of this cut plane, will not be rendered. Same for all other components. The idea is to remove some walls and ceilings from the splat.
- I want to have an editor like blender of some things: move with g, rotate with r, scale with s. Then constraint G,R or S, by buttons X Y Z, and second press of X Y Z makes the movement in local coordinates instead of global.
- I also want to be able to left-click elements in the viewer to select them: the splat, the cameras, the cut-planes.
- When something is selected, either from the hierarchy or the viewer, it has an orange outline
- I want you to render the XYZ axes like blender in the scene, and also a grid in the floor (you decide which 2 axes will be the floor)
- For the viewe itself I want some buttons: one for going viewer full screen, with esc I restor to the standard view
- One for entering WASD movement: when clicked I move with WASD and mouse like a shooter game, (shift to go faster, mouse scroll wheel to increase/decrease the base velocity), when I press esc, I go back to regular viewer mode
- Regular viewer mode allows me to orbit, zoom in and pan the viewer
- There is also a button in the viewer that toggles all outlines from the viewer: cut-planes wireless render, orange selection outline, floor grid, X Y Z axes, and anything else

---

## Running

```sh
npm install
npm run dev       # http://localhost:5173
npm run build     # typecheck + production build in dist/
```

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
