/** Pure helpers for Asset Library search / empty-state UX (unit + UI tested). */

export const EMPTY_FILTERS = Object.freeze({
  q: "",
  type: "",
  provider: "",
  pack: "",
  license: "",
  state: "",
  page: 1,
});

export const TYPE_OPTIONS = Object.freeze([
  { value: "", label: "All types" },
  { value: "sprite", label: "2D / sprite" },
  { value: "image_2d", label: "2D image" },
  { value: "model_3d", label: "3D model" },
  { value: "ui", label: "UI" },
  { value: "audio", label: "Audio" },
  { value: "pixel", label: "Pixel" },
  { value: "texture", label: "Texture" },
  { value: "material", label: "Material" },
  { value: "animation", label: "Animation" },
]);

export const PROVIDER_OPTIONS = Object.freeze([
  { value: "", label: "All providers" },
  { value: "upload", label: "Upload" },
  { value: "kenney", label: "Kenney" },
  { value: "sketchfab", label: "Sketchfab" },
]);

export const LICENSE_OPTIONS = Object.freeze([
  { value: "", label: "All licenses" },
  { value: "CC0", label: "CC0" },
  { value: "uploaded", label: "Uploaded" },
  { value: "sketchfab", label: "Sketchfab" },
  { value: "unknown", label: "Unknown" },
]);

export const STATE_OPTIONS = Object.freeze([
  { value: "", label: "All import states" },
  { value: "uploading", label: "Uploading" },
  { value: "uploaded", label: "Uploaded" },
  { value: "processing", label: "Processing" },
  { value: "preview_ready", label: "Preview ready" },
  { value: "pending_unity", label: "Pending Unity" },
  { value: "importing_unity", label: "Importing to Unity" },
  { value: "unity_imported", label: "Unity imported" },
  { value: "failed", label: "Failed" },
  { value: "unsupported", label: "Unsupported" },
]);

const FILTER_KEYS = ["q", "type", "provider", "pack", "license", "state"];

export function createEmptyFilters() {
  return { ...EMPTY_FILTERS };
}

export function hasActiveFilters(filters) {
  if (!filters) return false;
  return FILTER_KEYS.some((key) => Boolean(filters[key]));
}

export function buildAssetQuery(filters, { pageSize = 24 } = {}) {
  const p = new URLSearchParams();
  const page = Math.max(1, Number(filters?.page) || 1);
  for (const key of FILTER_KEYS) {
    const v = filters?.[key];
    if (v !== "" && v != null) p.set(key, String(v));
  }
  p.set("page", String(page));
  p.set("pageSize", String(pageSize));
  return p.toString();
}

/**
 * Submit draft filters as a new search: copy draft → applied, force page 1.
 */
export function submitSearch(draft) {
  return { ...createEmptyFilters(), ...draft, page: 1 };
}

/**
 * Clear all filters (draft + applied).
 */
export function clearAllFilters() {
  return createEmptyFilters();
}

/**
 * Paginate while preserving applied filter values.
 */
export function changePage(applied, nextPage) {
  return { ...applied, page: Math.max(1, Number(nextPage) || 1) };
}

/**
 * @returns {'loading'|'results'|'empty_library'|'no_matches'}
 */
export function resolveListState({ data, applied }) {
  if (!data) return "loading";
  if ((data.assets?.length || 0) > 0 || (data.total || 0) > 0) return "results";
  // Zero assets with zero storage means the library itself is empty — even if
  // the user left filters filled in (screenshot case: 0 B + several filters).
  if ((data.storageUsedBytes || 0) === 0) return "empty_library";
  if (hasActiveFilters(applied)) return "no_matches";
  return "empty_library";
}

export const LIBRARY_SCOPE_NOTE =
  "Asset Library searches assets already imported into this project. Use Find Assets to search Sketchfab for new models.";
