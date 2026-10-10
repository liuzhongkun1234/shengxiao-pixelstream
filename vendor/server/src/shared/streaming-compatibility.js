// Plugin identity and offer direction are independent. Preserve the historical
// fallback only for configurations that predate the explicit plugin field.
export function resolveStreamingPlugin(project = {}) {
  const plugin = project.pixelStreamingPlugin;
  if (["PixelStreaming", "PixelStreaming2"].includes(plugin)) return plugin;
  return resolveStreamingProtocol(project) === "legacy" ? "PixelStreaming" : "PixelStreaming2";
}

export function resolveStreamingProtocol(project = {}) {
  const configured = String(project.pixelStreamingProtocol || "auto").toLowerCase();
  if (["legacy", "unified"].includes(configured)) return configured;
  if (["legacy", "unified"].includes(project.runtimeProtocolOverride)) return project.runtimeProtocolOverride;
  if (project.pixelStreamingPlugin === "PixelStreaming") return "legacy";
  if (project.pixelStreamingPlugin === "PixelStreaming2") return "unified";
  const match = String(project.metadata?.ueVersion || project.ueVersion || "").match(/^(\d+)(?:\.(\d+))?/);
  const major = Number(match?.[1] || 0), minor = Number(match?.[2] || 0);
  return major > 0 && (major < 5 || (major === 5 && minor <= 3)) ? "legacy" : "unified";
}
