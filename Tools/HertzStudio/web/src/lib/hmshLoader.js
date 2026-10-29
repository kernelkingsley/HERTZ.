/**
 * Load Hertz mesh snapshot (.hmsh1 / .hmsh2) into Three.js geometry (+ materials for v2).
 * Binary layout matches HertzStudioRenderSnapshotExporter.WriteMeshBinary.
 *
 * hmsh1: magic + ver=1 + vCount + iCount + flags + pos + nrm? + uv? + indices
 * hmsh2: same header fields then subMeshCount + materialCount before attributes;
 *        after indices: submeshes (start,count,matIndex)* + materials (rgba)*
 */

export async function loadHmshGeometry(url, THREE, { signal } = {}) {
  const res = await fetch(url, {
    credentials: "include",
    signal,
  });
  if (!res.ok) throw new Error(`hmsh HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return parseHmshArrayBuffer(buf, THREE);
}

/**
 * @returns {{ geometry: import('three').BufferGeometry, materials: import('three').Material[], version: number }}
 */
export function parseHmshArrayBuffer(arrayBuffer, THREE) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 20) throw new Error("hmsh too small");
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== "HMSH") throw new Error(`bad hmsh magic ${magic}`);
  const version = view.getUint32(4, true);
  if (version !== 1 && version !== 2) {
    throw new Error(`unsupported hmsh version ${version} (expected 1 or 2; regenerate snapshot)`);
  }
  const vCount = view.getUint32(8, true);
  const iCount = view.getUint32(12, true);
  const flags = view.getUint32(16, true);
  let offset = 20;

  let subMeshCount = 1;
  let materialCount = 0;
  if (version === 2) {
    if (view.byteLength < 28) throw new Error("hmsh2 header truncated");
    subMeshCount = view.getUint32(offset, true);
    offset += 4;
    materialCount = view.getUint32(offset, true);
    offset += 4;
    if (!Number.isFinite(subMeshCount) || subMeshCount < 1 || subMeshCount > 4096) {
      throw new Error(`hmsh2 malformed subMeshCount ${subMeshCount}`);
    }
    if (!Number.isFinite(materialCount) || materialCount < 0 || materialCount > 4096) {
      throw new Error(`hmsh2 malformed materialCount ${materialCount}`);
    }
  }

  const positions = new Float32Array(vCount * 3);
  for (let i = 0; i < vCount; i += 1) {
    // Unity LH → Three RH: negate X
    positions[i * 3] = -view.getFloat32(offset, true);
    positions[i * 3 + 1] = view.getFloat32(offset + 4, true);
    positions[i * 3 + 2] = view.getFloat32(offset + 8, true);
    offset += 12;
  }

  let normals = null;
  if (flags & 1) {
    normals = new Float32Array(vCount * 3);
    for (let i = 0; i < vCount; i += 1) {
      normals[i * 3] = -view.getFloat32(offset, true);
      normals[i * 3 + 1] = view.getFloat32(offset + 4, true);
      normals[i * 3 + 2] = view.getFloat32(offset + 8, true);
      offset += 12;
    }
  }

  let uvs = null;
  if (flags & 2) {
    uvs = new Float32Array(vCount * 2);
    for (let i = 0; i < vCount; i += 1) {
      uvs[i * 2] = view.getFloat32(offset, true);
      uvs[i * 2 + 1] = view.getFloat32(offset + 4, true);
      offset += 8;
    }
  }

  const indices = new Uint32Array(iCount);
  for (let i = 0; i < iCount; i += 1) {
    indices[i] = view.getUint32(offset, true);
    offset += 4;
  }

  // Flip winding for LH→RH (swap every triangle's first two indices).
  for (let i = 0; i + 2 < iCount; i += 3) {
    const a = indices[i];
    indices[i] = indices[i + 1];
    indices[i + 1] = a;
  }

  /** @type {{ start: number, count: number, materialIndex: number }[]} */
  const groups = [];
  /** @type {{ r: number, g: number, b: number, a: number }[]} */
  const materialColors = [];

  if (version === 2) {
    for (let s = 0; s < subMeshCount; s += 1) {
      if (offset + 12 > view.byteLength) throw new Error("hmsh2 truncated submesh table");
      const start = view.getUint32(offset, true);
      const count = view.getUint32(offset + 4, true);
      let materialIndex = view.getUint32(offset + 8, true);
      offset += 12;
      if (start + count > iCount) {
        throw new Error(`hmsh2 submesh ${s} range out of bounds`);
      }
      if (materialCount > 0 && materialIndex >= materialCount) {
        materialIndex = Math.min(s, materialCount - 1);
      }
      groups.push({ start, count, materialIndex });
    }
    for (let m = 0; m < materialCount; m += 1) {
      if (offset + 16 > view.byteLength) throw new Error("hmsh2 truncated material table");
      materialColors.push({
        r: view.getFloat32(offset, true),
        g: view.getFloat32(offset + 4, true),
        b: view.getFloat32(offset + 8, true),
        a: view.getFloat32(offset + 12, true),
      });
      offset += 16;
    }
  } else {
    groups.push({ start: 0, count: iCount, materialIndex: 0 });
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (normals) geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  else geometry.computeVertexNormals();
  if (uvs) geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  for (const g of groups) {
    geometry.addGroup(g.start, g.count, g.materialIndex);
  }

  geometry.computeBoundingSphere();

  const matCount = Math.max(1, materialColors.length || 1);
  const materials = [];
  for (let i = 0; i < matCount; i += 1) {
    const bc = materialColors[i] || { r: 0.75, g: 0.75, b: 0.75, a: 1 };
    materials.push(
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(bc.r ?? 0.75, bc.g ?? 0.75, bc.b ?? 0.75),
        roughness: 0.7,
        metalness: 0.05,
        transparent: (bc.a ?? 1) < 0.999,
        opacity: bc.a ?? 1,
        side: THREE.DoubleSide,
      }),
    );
  }

  // Fewer materials than groups: clamp group materialIndex (already clamped above).
  return { geometry, materials, version, groups, materialColors };
}

/** Build a minimal hmsh1 ArrayBuffer for tests. */
export function encodeHmsh1ForTest({ positions, indices, normals = null, uvs = null }) {
  const vCount = positions.length / 3;
  const iCount = indices.length;
  let flags = 0;
  if (normals) flags |= 1;
  if (uvs) flags |= 2;
  let size = 20 + vCount * 12 + iCount * 4;
  if (flags & 1) size += vCount * 12;
  if (flags & 2) size += vCount * 8;
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  view.setUint8(0, 72);
  view.setUint8(1, 77);
  view.setUint8(2, 83);
  view.setUint8(3, 72);
  view.setUint32(4, 1, true);
  view.setUint32(8, vCount, true);
  view.setUint32(12, iCount, true);
  view.setUint32(16, flags, true);
  let o = 20;
  for (let i = 0; i < vCount; i += 1) {
    // Store Unity LH (negate Three X when encoding from RH test helpers if needed).
    view.setFloat32(o, positions[i * 3], true);
    view.setFloat32(o + 4, positions[i * 3 + 1], true);
    view.setFloat32(o + 8, positions[i * 3 + 2], true);
    o += 12;
  }
  if (flags & 1) {
    for (let i = 0; i < vCount; i += 1) {
      view.setFloat32(o, normals[i * 3], true);
      view.setFloat32(o + 4, normals[i * 3 + 1], true);
      view.setFloat32(o + 8, normals[i * 3 + 2], true);
      o += 12;
    }
  }
  if (flags & 2) {
    for (let i = 0; i < vCount; i += 1) {
      view.setFloat32(o, uvs[i * 2], true);
      view.setFloat32(o + 4, uvs[i * 2 + 1], true);
      o += 8;
    }
  }
  for (let i = 0; i < iCount; i += 1) {
    view.setUint32(o, indices[i], true);
    o += 4;
  }
  return buf;
}

/** Build a minimal hmsh2 ArrayBuffer for tests. */
export function encodeHmsh2ForTest({
  positions,
  indices,
  normals = null,
  uvs = null,
  groups = [{ start: 0, count: indices.length, materialIndex: 0 }],
  materials = [{ r: 1, g: 0, b: 0, a: 1 }],
}) {
  const vCount = positions.length / 3;
  const iCount = indices.length;
  let flags = 0;
  if (normals) flags |= 1;
  if (uvs) flags |= 2;
  let size =
    28 +
    vCount * 12 +
    iCount * 4 +
    groups.length * 12 +
    materials.length * 16;
  if (flags & 1) size += vCount * 12;
  if (flags & 2) size += vCount * 8;
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  view.setUint8(0, 72);
  view.setUint8(1, 77);
  view.setUint8(2, 83);
  view.setUint8(3, 72);
  view.setUint32(4, 2, true);
  view.setUint32(8, vCount, true);
  view.setUint32(12, iCount, true);
  view.setUint32(16, flags, true);
  view.setUint32(20, groups.length, true);
  view.setUint32(24, materials.length, true);
  let o = 28;
  for (let i = 0; i < vCount; i += 1) {
    view.setFloat32(o, positions[i * 3], true);
    view.setFloat32(o + 4, positions[i * 3 + 1], true);
    view.setFloat32(o + 8, positions[i * 3 + 2], true);
    o += 12;
  }
  if (flags & 1) {
    for (let i = 0; i < vCount; i += 1) {
      view.setFloat32(o, normals[i * 3], true);
      view.setFloat32(o + 4, normals[i * 3 + 1], true);
      view.setFloat32(o + 8, normals[i * 3 + 2], true);
      o += 12;
    }
  }
  if (flags & 2) {
    for (let i = 0; i < vCount; i += 1) {
      view.setFloat32(o, uvs[i * 2], true);
      view.setFloat32(o + 4, uvs[i * 2 + 1], true);
      o += 8;
    }
  }
  for (let i = 0; i < iCount; i += 1) {
    view.setUint32(o, indices[i], true);
    o += 4;
  }
  for (const g of groups) {
    view.setUint32(o, g.start, true);
    view.setUint32(o + 4, g.count, true);
    view.setUint32(o + 8, g.materialIndex, true);
    o += 12;
  }
  for (const m of materials) {
    view.setFloat32(o, m.r, true);
    view.setFloat32(o + 4, m.g, true);
    view.setFloat32(o + 8, m.b, true);
    view.setFloat32(o + 12, m.a, true);
    o += 16;
  }
  return buf;
}
