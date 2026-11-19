import { randomUUID } from "node:crypto";
import { copyFile, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureControlledDirectory } from "../dist/artifact.js";
import { alertIds } from "../dist/incident-fixtures.js";
import { microbizSandbox } from "../dist/localbridge.js";

if (process.platform !== "win32") throw new Error("The MicroBiz sandbox is configured for Windows.");
const bridgeDist = pathToFileURL("C:\\localbridge\\apps\\private-chatgpt-local-bridge\\dist\\");
const { parseConfig, UNAUTHENTICATED_ACCESS_ACK } = await import(new URL("config.js", bridgeDist));
const { createBridgeHttpServer } = await import(new URL("http.js", bridgeDist));
const directory = join(microbizSandbox, "incident-evidence");
if (!ensureControlledDirectory(microbizSandbox) || !ensureControlledDirectory(directory))
  throw new Error("MicroBiz needs a local sandbox and evidence directory without links.");
const config = parseConfig({ allowedDirectories: [microbizSandbox] }, {
  AUTH_MODE: "none", PORT: "3001", PUBLIC_ORIGIN: "https://127.0.0.1:3001",
  ACK_UNAUTHENTICATED_FILESYSTEM_ACCESS: UNAUTHENTICATED_ACCESS_ACK,
});
const bridge = await createBridgeHttpServer(config);
try {
  for (const id of alertIds) {
    const temp = join(directory, randomUUID() + ".tmp");
    await copyFile(new URL("../dist/incident-evidence/" + id + ".json", import.meta.url), temp, constants.COPYFILE_EXCL);
    try { await rename(temp, join(directory, id + ".json")); }
    finally { await rm(temp, { force: true }); }
  }
  await new Promise((resolve, reject) => {
    bridge.server.once("error", reject);
    bridge.server.listen(config.port, "127.0.0.1", resolve);
  });
  console.log("MicroBiz LocalBridge listening at http://127.0.0.1:3001/mcp with root " + microbizSandbox);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void bridge.close());
} catch (error) {
  await bridge.close();
  throw error;
}
