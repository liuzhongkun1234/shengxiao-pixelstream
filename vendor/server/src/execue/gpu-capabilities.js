import { execFileSync } from "node:child_process";

export function inferAv1Encoder(gpuName) {
  const name = String(gpuName || "");
  return /(?:RTX\s*(?:40|50)\d{2}|RTX\s*6000\s*Ada|\bL4\b|\bL40S?\b)/i.test(name);
}

export function detectGpuCapabilities() {
  try {
    const output = execFileSync("nvidia-smi.exe", ["--query-gpu=name,driver_version", "--format=csv,noheader"], { encoding: "utf8", windowsHide: true, timeout: 3000 });
    const [gpuName = "", driverVersion = ""] = output.split(/\r?\n/).find(Boolean)?.split(",").map(x => x.trim()) || [];
    const av1Encode = inferAv1Encoder(gpuName);
    return { vendor: "NVIDIA", gpuName, driverVersion, videoEncoders: av1Encode ? ["H264", "AV1"] : ["H264"], av1Encode, av1EncodeConfidence: av1Encode ? "inferred" : "unsupported_or_unknown" };
  } catch { return { vendor: "unknown", gpuName: "unknown", driverVersion: "unknown", videoEncoders: ["H264"], av1Encode: false, av1EncodeConfidence: "unknown" }; }
}
