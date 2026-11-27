// Recovery for "Save failed" (NotReadableError / network error) without reloading the app.
// Paste into the DevTools console of the app tab. A panel lists the splats / trajectories whose
// data can no longer be read (the file they came from changed or was emptied) and offers:
//   1. Relink files…: pick files holding the same bytes (an older .isosplat of the project,
//      the original .ply / trajectory files). Matched by exact size (same kind and name preferred).
//   2. Rebuild from memory: last resort for what can't be relinked. Splats are rebuilt from the
//      loaded scene as a .ply WITHOUT view-dependent color (spherical harmonics) and with the
//      renderer's precision; trajectories are rebuilt from their parsed poses (TUM).
// Once everything is readable, all data is copied into memory, so the save no longer depends
// on any file on disk and can safely overwrite any of them. Then save with Save as….
(async () => {
  const readable = async (blob) => {
    try {
      await blob.slice(0, 1).arrayBuffer();
      return true;
    } catch {
      return false;
    }
  };
  const withSource = () => editor.elements.filter((el) => el.source);
  const findStale = async () => {
    const out = [];
    for (const el of withSource()) if (!(await readable(el.source))) out.push(el);
    return out;
  };
  const describe = (els) => els.map((e) => `${e.name} (${e.kind}, ${e.fileName}, ${e.source.size} bytes)`).join("; ");

  // ---------------------------------------------------------------- relink

  /** Candidate copies in a picked file: the whole file, or each embedded entry of a project file. */
  const candidates = async (file) => {
    if (!(await readable(file)) || file.size < 16) return [];
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (new TextDecoder().decode(head.slice(0, 8)) !== "ISOSPLAT") return [{ blob: file, kind: null, name: file.name }];
    const jsonLength = new DataView(head.buffer).getUint32(12, true);
    const json = JSON.parse(await file.slice(16, 16 + jsonLength).text());
    const start = 16 + jsonLength;
    return json.elements
      .filter((j) => j.data)
      .map((j) => ({ blob: file.slice(start + j.data.offset, start + j.data.offset + j.data.length), kind: j.kind, name: j.fileName }));
  };

  const relink = async (files) => {
    const all = [];
    for (const f of files) all.push(...(await candidates(f)));
    for (const el of await findStale()) {
      const same = all.filter((c) => c.blob.size === el.source.size && (c.kind === null || c.kind === el.kind));
      const pick = same.find((c) => c.name === el.fileName) ?? same[0];
      if (pick && (await readable(pick.blob))) {
        el.source = pick.blob;
        console.log(`Relinked ${el.name} → ${pick.name}`);
      }
    }
  };

  // ---------------------------------------------------------------- rebuild from memory

  /** 3DGS .ply (base color only) from the splat's loaded data. */
  const splatToPly = (el) => {
    const n = el.mesh.numSplats;
    const props = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
    const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${props.map((p) => `property float ${p}`).join("\n")}\nend_header\n`;
    const head = new TextEncoder().encode(header);
    const body = new Float32Array(n * props.length);
    const C0 = 0.28209479177387814;
    const logit = (o) => {
      const c = Math.min(Math.max(o, 1e-6), 1 - 1e-6);
      return Math.log(c / (1 - c));
    };
    el.mesh.forEachSplat((i, c, s, q, opacity, color) => {
      body.set(
        [c.x, c.y, c.z, (color.r - 0.5) / C0, (color.g - 0.5) / C0, (color.b - 0.5) / C0, logit(opacity),
          Math.log(Math.max(s.x, 1e-12)), Math.log(Math.max(s.y, 1e-12)), Math.log(Math.max(s.z, 1e-12)), q.w, q.x, q.y, q.z],
        i * props.length,
      );
    });
    return new Blob([head, body]);
  };

  /** TUM text (seconds, position, qx qy qz qw) from the trajectory's parsed poses. */
  const trajectoryToTum = (el) => {
    const { t, p, q } = el.poses;
    const lines = [];
    for (let i = 0; i < t.length; i++) {
      lines.push([t[i].toFixed(9), p[i * 3], p[i * 3 + 1], p[i * 3 + 2], q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3]].join(" "));
    }
    return new Blob([lines.join("\n") + "\n"]);
  };

  const rebuild = async () => {
    for (const el of await findStale()) {
      if (el.kind === "splat" && el.mesh) {
        el.source = splatToPly(el);
        el.fileName = `${el.name}.ply`;
      } else if (el.kind === "trajectory" && el.poses) {
        el.source = trajectoryToTum(el);
        el.fileName = `${el.name}.tum`;
      } else continue;
      console.log(`Rebuilt ${el.name} from memory → ${el.fileName} (${el.source.size} bytes)`);
    }
  };

  /** Copy every source into memory: saving then reads no file, so it can't break on any of them. */
  const detach = async () => {
    for (const el of withSource()) el.source = new Blob([await el.source.arrayBuffer()]);
  };

  // ---------------------------------------------------------------- UI

  const panel = document.createElement("div");
  Object.assign(panel.style, {
    position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 9999,
    background: "#262626", color: "#ddd", border: "2px solid #ff8c1a", borderRadius: "8px",
    padding: "14px 18px", font: "13px system-ui, sans-serif", maxWidth: "560px", lineHeight: "1.5",
  });
  const text = document.createElement("div");
  const row = document.createElement("div");
  Object.assign(row.style, { display: "flex", gap: "8px", marginTop: "10px" });
  const btn = (label, onClick) => {
    const b = document.createElement("button");
    b.textContent = label;
    Object.assign(b.style, { padding: "6px 12px", cursor: "pointer" });
    b.onclick = onClick;
    row.append(b);
    return b;
  };
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.id = "relink-input";
  input.hidden = true;
  btn("Relink files…", () => input.click());
  btn("Rebuild rest from memory", async () => {
    await rebuild();
    await refresh();
  });
  btn("Close", () => panel.remove());
  panel.append(text, row, input);

  const refresh = async () => {
    const stale = await findStale();
    if (stale.length) {
      text.textContent = `Unreadable: ${describe(stale)}`;
      console.warn("Unreadable:", describe(stale));
      return;
    }
    text.textContent = "Copying all data into memory…";
    await detach();
    panel.remove();
    console.log("%cAll data is readable and held in memory. Save now (Save as… to be safe).", "color:#8bdc00;font-weight:bold");
  };
  input.onchange = async () => {
    await relink([...input.files]);
    input.value = "";
    await refresh();
  };

  document.body.append(panel);
  await refresh();
})();
