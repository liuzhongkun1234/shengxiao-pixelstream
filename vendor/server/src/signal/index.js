import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsonConfig, resolveFrom } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import { SignalServer } from "./server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const loaded = loadJsonConfig(process.argv[2], path.resolve(here, "../../config/signal.json"));
const config = loaded.config;
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("invalid signal port");
if (!Array.isArray(config.projects)) throw new Error("projects must be an array");
const logger = createLogger("signal-source", { ...config.logging, directory: resolveFrom(loaded.directory, config.logging?.directory) });
const server = new SignalServer(config, logger, resolveFrom(loaded.directory, config.publicDir), loaded.file);
await server.listen();
logger.info("service.started", { host: config.host, port: config.port, projects: config.projects.length });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { logger.info("service.stopping", { signal }); await server.close(); process.exit(0); });
