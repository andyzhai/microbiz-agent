import { mkdir, writeFile } from "node:fs/promises";
import { alertIds, incidentDocument, loadAlert } from "../dist/incident-fixtures.js";

const directory = new URL("../dist/incident-evidence/", import.meta.url);
await mkdir(directory, { recursive: true });
for (const id of alertIds) {
  const document = incidentDocument(loadAlert(id));
  await writeFile(new URL(id + ".json", directory), JSON.stringify(document) + "\n");
}
