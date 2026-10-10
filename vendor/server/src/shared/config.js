import fs from "node:fs";
import path from "node:path";

export function loadJsonConfig(argument, fallback) {
  const file = path.resolve(argument || fallback);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  return { file, config, directory: path.dirname(file) };
}

export function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

export function resolveFrom(base, value) {
  return path.resolve(base, value || ".");
}
