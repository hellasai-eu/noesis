/**
 * The default brand — deliberately generic.
 *
 * This repository carries no product identity. A deployment supplies its own
 * by pointing `DEPLOYMENT_DIR` at a directory with its own copy of these files
 * (see `deployment/README.md`); what is here is what an unconfigured clone
 * shows, and it should stay neutral enough that nobody mistakes it for a
 * product.
 *
 * The plain-data fields live in `brand.meta.json` rather than in this file,
 * because `vite.config.ts` reads that file with `readFileSync` to fill in the
 * static document head before any module has run. Spreading it here is what
 * keeps the two in agreement: the `<title>` a crawler sees and the name the
 * app renders come from the same eleven lines of JSON.
 *
 * Everything is optional — `defineBrand` fills in the rest — so this file
 * lists only what it means to override.
 */

import { defineBrand } from "@/deployment/contract";

import meta from "./brand.meta.json";

export default defineBrand({
  ...meta,

  // No `logo`, so the app draws its neutral fallback mark in a tile. A
  // deployment sets one — preferably from a Vite asset import next to this
  // file, so the artwork is hashed with the bundle rather than served from
  // `public/` where a change can go stale:
  //
  //   import logo from "./logo.svg";
  //   export default defineBrand({ ...meta, logo: { src: logo } });

  // No `icon` either. Any component taking a `className` works here, which
  // includes every `lucide-react` icon and any inline SVG of your own.
});
