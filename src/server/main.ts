#!/usr/bin/env node
import { startServer } from "./server.js";

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? "localhost";
const dataDir = process.env.WEAVE_DATA ?? undefined;

const running = await startServer({ port, host, dataDir, log: (m) => console.log(m) });
console.log(`weave is running at http://${host}:${running.port}/`);
console.log(`  open http://${host}:${running.port}/r/demo in two windows and type in both`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await running.close();
    process.exit(0);
  });
}
