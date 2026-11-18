import { createServer } from "node:net";
import { spawn } from "node:child_process";

const services = [];

function portIsAvailable(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function requireAvailablePort(port, serviceName) {
  if (await portIsAvailable(port)) return;
  throw new Error(`${serviceName} cannot start because port ${port} is already in use. No existing process was stopped.`);
}

function start(label, argumentsList) {
  const child = spawn(process.execPath, argumentsList, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  services.push(child);
  child.once("exit", (code, signal) => {
    if (code && code !== 0) {
      console.error(`${label} exited with code ${code}${signal ? ` (${signal})` : ""}.`);
      shutdown(code);
    }
  });
}

function shutdown(exitCode = 0) {
  for (const service of services) {
    if (!service.killed) service.kill("SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 250).unref();
}

try {
  await requireAvailablePort(3000, "Next.js frontend");
  await requireAvailablePort(8787, "Digital Twin API");

  start("Next.js frontend", ["node_modules/next/dist/bin/next", "dev", "-H", "127.0.0.1", "-p", "3000"]);
  start("Digital Twin API", ["--watch", "--env-file-if-exists=.env", "server/index.mjs"]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
