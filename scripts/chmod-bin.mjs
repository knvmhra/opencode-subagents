import { chmod } from "node:fs/promises"

await chmod(new URL("../dist/src/cli.js", import.meta.url), 0o755)
await chmod(new URL("../dist/src/dash.js", import.meta.url), 0o755)
