import fs from "node:fs";
import path from "node:path";

export function loadGpuProfiles(config, configFile) {
  if (!configFile) return;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(path.dirname(configFile), "gpu-learning.json"), "utf8"));
    for (const project of config.projects || []) {
      const saved = data.projects?.[project.id];
      if (saved?.executable !== project.executable || saved?.generation !== (project.metadata?.gpuLearningGeneration || "")) continue;
      if (saved.profiles && typeof saved.profiles === "object") (project.metadata ||= {}).gpuIncrementProfiles = saved.profiles;
    }
  } catch { /* Existing embedded profiles remain a backwards-compatible fallback. */ }
}

export function saveGpuProfiles(config, configFile) {
  if (!configFile) return;
  const target = path.join(path.dirname(configFile), "gpu-learning.json");
  const data = { schemaVersion: 1, projects: {} };
  for (const project of config.projects || []) {
    if (project.metadata?.gpuIncrementProfiles) data.projects[project.id] = {
      executable: project.executable, generation: project.metadata.gpuLearningGeneration || "", profiles: project.metadata.gpuIncrementProfiles
    };
  }
  fs.writeFileSync(target + ".tmp", JSON.stringify(data, null, 2));
  fs.renameSync(target + ".tmp", target);
}
