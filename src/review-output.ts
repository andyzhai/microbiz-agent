import { createHash } from "node:crypto";
import fs from "node:fs";
import { dirname } from "node:path";
import { ensureControlledDirectory, hasCode, isControlledDirectory } from "./artifact.js";
import type { ArtifactPreview } from "./artifact.js";
import { ReviewError } from "./review-store.js";

// A staging path belongs to one run under its exclusive checkpoint lock.
export function discardStage(stage: string) {
  if (!isControlledDirectory(dirname(stage))) throw new ReviewError("unsafe_directory");
  const stat = fs.lstatSync(stage, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile()) throw new ReviewError("unsafe_staging_file");
  fs.unlinkSync(stage);
}

export function outputMatches(review: ArtifactPreview) {
  const directory = dirname(review.destination);
  for (const path of [dirname(directory), directory]) {
    if (!fs.lstatSync(path, { throwIfNoEntry: false })) return false;
    if (!isControlledDirectory(path)) throw new ReviewError("unsafe_directory");
  }
  const stat = fs.lstatSync(review.destination, { bigint: true, throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(Buffer.byteLength(review.content)))
    throw new ReviewError("destination_conflict");
  const fd = fs.openSync(review.destination, "r");
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (opened.dev !== stat.dev || opened.ino !== stat.ino ||
        createHash("sha256").update(fs.readFileSync(fd)).digest("hex") !== review.sha256)
      throw new ReviewError("destination_conflict");
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

export function finalizeOutput(review: ArtifactPreview, stage: string, authorize: () => void) {
  const directory = dirname(review.destination);
  for (const path of [dirname(directory), directory]) {
    if (!ensureControlledDirectory(path)) throw new ReviewError("unsafe_directory");
  }
  if (!isControlledDirectory(dirname(stage))) throw new ReviewError("unsafe_directory");
  const fd = fs.openSync(stage, "wx", 0o600);
  let opened: fs.BigIntStats;
  try {
    try {
      opened = fs.fstatSync(fd, { bigint: true });
      fs.writeFileSync(fd, review.content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    authorize();
    if (!isControlledDirectory(dirname(directory)) || !isControlledDirectory(directory) || !isControlledDirectory(dirname(stage)))
      throw new ReviewError("unsafe_directory");
    const staged = fs.lstatSync(stage, { bigint: true });
    if (!staged.isFile() || staged.nlink !== 1n || staged.dev !== opened.dev || staged.ino !== opened.ino ||
        staged.size !== BigInt(Buffer.byteLength(review.content))) throw new ReviewError("unsafe_staging_file");
    try {
      // Publishing a fully flushed file with link is atomic and fails if the name exists.
      fs.linkSync(stage, review.destination);
      return "created" as const;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (!outputMatches(review)) throw new ReviewError("destination_conflict");
      return "reconciled" as const;
    }
  } finally {
    discardStage(stage);
  }
}
