#!/usr/bin/env node
import { r as runNativeApi } from "./types-Cft29FmY.js";
//#region lib/types/bin.js
/** Ark native API executable entry. */
/* v8 ignore file -- installed Ark acceptance executes this entry under plain Node. */
await runNativeApi(process.argv.slice(2));
//#endregion
export {};
