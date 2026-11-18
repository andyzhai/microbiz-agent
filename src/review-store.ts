import "./offline.js";
import fs from "node:fs";
import { join } from "node:path";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import Database from "better-sqlite3";
import { ensureControlledDirectory, hasCode, isControlledDirectory } from "./artifact.js";

export class ReviewError extends Error {}

const channel = Annotation.Root({ review: Annotation<unknown>() });
const workflow = new StateGraph(channel)
  .addNode("operator", state => state)
  .addEdge(START, "operator").addEdge("operator", END);

interface ReviewStore {
  stage: string;
  read(): Promise<unknown>;
  save(review: unknown): Promise<void>;
  removeAfterClose(): void;
}

export async function withReviewStore<T>(runId: string, create: boolean, work: (store: ReviewStore) => Promise<T>) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId))
    throw new ReviewError("invalid_run_id");
  const root = fs.realpathSync.native(".");
  if (process.platform === "win32" && root.startsWith("\\\\")) throw new ReviewError("unsafe_directory");
  const storage = join(root, ".microbiz");
  const directory = join(storage, "reviews");
  const database = join(directory, runId + ".sqlite");
  let db: Database.Database | undefined;
  let removed = false;
  try {
    for (const path of [storage, directory]) {
      if (!(create ? ensureControlledDirectory(path) : isControlledDirectory(path))) throw new ReviewError("unsafe_directory");
    }
    if (create) fs.closeSync(fs.openSync(database, "wx", 0o600));
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const stat = fs.lstatSync(database + suffix, { throwIfNoEntry: false });
      if (!stat && !suffix) throw new ReviewError("run_not_found");
      if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new ReviewError("unsafe_checkpoint");
    }
    db = new Database(database, { fileMustExist: true, timeout: 0 });
    // The connection keeps its OS lock between commits, including while the
    // operator is at the prompt. Process death releases it. Other runs have their own DB.
    db.pragma("locking_mode = EXCLUSIVE");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.exec("BEGIN EXCLUSIVE; COMMIT");
    const saver = new SqliteSaver(db);
    const graph = workflow.compile({ checkpointer: saver });
    const config = { configurable: { thread_id: runId }, callbacks: [] };
    const connection = db;
    return await work({
      stage: join(directory, runId + ".tmp"),
      async read() {
        let checkpoint;
        try {
          checkpoint = await saver.get(config);
        } catch {
          throw new ReviewError("invalid_checkpoint");
        }
        if (!checkpoint) throw new ReviewError("invalid_checkpoint");
        if (checkpoint.v !== 4) throw new ReviewError("unsupported_checkpoint_version");
        return checkpoint.channel_values?.review;
      },
      async save(review) {
        connection.exec("BEGIN IMMEDIATE");
        try {
          // Each update is a full snapshot. Atomically replacing the thread
          // also keeps older approvals from becoming current after a clock rollback.
          if (!create) await saver.deleteThread(runId);
          await graph.updateState(config, { review }, "operator");
          connection.exec("COMMIT");
        } catch (error) {
          connection.exec("ROLLBACK");
          throw error;
        }
      },
      removeAfterClose() {
        // A terminal run has its own DB. Keep its checkpoint intact until
        // unlink succeeds so an interruption during cleanup can be retried.
        removed = true;
      },
    });
  } catch (error) {
    if (hasCode(error, "SQLITE_BUSY") || hasCode(error, "SQLITE_LOCKED")) throw new ReviewError("run_busy");
    if (hasCode(error, "SQLITE_NOTADB") || hasCode(error, "SQLITE_CORRUPT")) throw new ReviewError("invalid_checkpoint");
    if (hasCode(error, "ENOENT")) throw new ReviewError("run_not_found");
    throw error;
  } finally {
    db?.close();
    if (removed) fs.unlinkSync(database);
  }
}
