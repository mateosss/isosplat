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
