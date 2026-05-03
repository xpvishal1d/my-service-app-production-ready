import os from "node:os";
import { env } from "../config/env.js";

export function getInstanceId() {
  return env.INSTANCE_ID ?? `${os.hostname()}-${process.pid}`;
}
