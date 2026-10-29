# HERTZ Studio visual references

Six original screenshots supplied by Kingsley, copied without conversion from `C:\Users\Kingsley\Downloads\hertz-references` on 20 October 2026. Every copy was checked against its source using SHA-256.

**Updated 20 October 2026 (Kingsley):** do **not** use these screenshots as UI references. Build an original, polished HERTZ Studio interface with the installed Shadcn plugin. The files below remain in the repo as historical context only; they do not dictate layout, styling, component choices, or visual language.

| File | Historical context only |
| --- | --- |
| [01-dashboard.webp](01-dashboard.webp) | Early product discussion artifact — not a UI kit. |
| [02-level-editor.webp](02-level-editor.webp) | Early product discussion artifact — not a UI kit. |
| [03-weapons.webp](03-weapons.webp) | Early product discussion artifact — not a UI kit. |
| [04-model-search.webp](04-model-search.webp) | Early product discussion artifact — not a UI kit. |
| [05-editor-catalog.webp](05-editor-catalog.webp) | Early product discussion artifact — not a UI kit. |
| [06-connections.webp](06-connections.webp) | Early product discussion artifact — not a UI kit. |

## Visual direction (original Studio)

- Ship an original dark Studio shell with HERTZ branding and a clear primary accent via Shadcn + Tailwind. Prefer clarity and comfort over cloning third-party editor chrome.
- Use **HERTZ Studio** for the entire web interface. Persistent narrow left sidebar; Dashboard, Level Editor, Characters & Enemies, Weapons, Asset Library, Find Assets, Sound, Materials & Lighting, Animation, Analytics, Performance, Snapshots, Encounters, Connections, and Deploy.
- Level editor (W03+): maximize viewport space; floating library and selection inspector. Orbit/pan/zoom, visible selection, transform controls, and explicit save state.
- Use HERTZ branding and real project content. Toy bedroom, Action Figures naming, economy, shop, chapter labels, and sprint labels from any external reference game are not requirements.
- The product is a hosted private Studio. Show accurate cloud draft, Unity connection, and last-sync states. Show `Draft saved` separately from `Applied to Unity`; keep browsing and draft editing usable when Unity is disconnected. Provider credentials belong in backend secret storage.

## Kenney category brief — added 20 October 2026

Kingsley's additional Kenney screenshot shows a search field, the **2D, 3D, UI, Audio, Pixel, Textures** category filters, sort control, and thumbnail cards with names/category labels. Use that **category/search/card information architecture** inside HERTZ Studio's own Shadcn design — not a visual clone of the Kenney site. The original six local image files above remain historical only.

Support free individual packs from [Kenney's official asset catalog](https://kenney.nl/assets), with source links and local file/ZIP import. The All-in-1 banner, donation/promotional panels, and Kenney branding are not Studio UI requirements. Do not use Kenney's logo as Studio branding.

Library entries must be typed and draggable: 3D props and modular ground/wall geometry into the scene; textures/materials onto surfaces; 2D/pixel sprites and UI art onto compatible sprite/Canvas targets; audio onto emitters/sound slots; animations onto compatible character/enemy states. Show valid-target previews and clear mismatch feedback. Editing a floor's appearance must not silently alter collision geometry or unrelated shared materials.

Implementation sequence and prompts: [WEB_STUDIO_TASKS.md](../../WEB_STUDIO_TASKS.md).
