// Subprocess-only fault injection at real durability boundaries.
import fs from "node:fs";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

const point = process.env.MICROBIZ_TEST_CRASH;
function crash() {
  fs.writeSync(2, "crash at " + point);
  process.kill(process.pid, "SIGKILL");
}

if (point === "approved") {
  const put = SqliteSaver.prototype.put;
  SqliteSaver.prototype.put = function (config, checkpoint, ...rest) {
    if (checkpoint.channel_values.review?.progress.status === "exporting") crash();
    return put.call(this, config, checkpoint, ...rest);
  };
} else if (point === "partial-stage") {
  const write = fs.writeFileSync;
  fs.writeFileSync = function (file, data, ...rest) {
    if (typeof file === "number" && typeof data === "string" && data.startsWith("merchant,")) {
      fs.writeSync(file, data.slice(0, 7));
      crash();
    }
    return write.call(this, file, data, ...rest);
  };
} else if (point === "published") {
  const link = fs.linkSync;
  fs.linkSync = function (source, destination) {
    link(source, destination);
    crash();
  };
}
