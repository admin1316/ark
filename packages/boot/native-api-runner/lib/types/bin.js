#!/usr/bin/env node
/** Ark native API executable entry. */
/* v8 ignore file -- installed Ark acceptance executes this entry under plain Node. */
import { runNativeApi } from "./index.js";
await runNativeApi(process.argv.slice(2));
//# sourceMappingURL=bin.js.map