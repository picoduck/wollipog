import { readFile } from "node:fs/promises";
import { writeIsolatedProfile } from "./openclaw-assistant.mjs";

const [root, descriptor] = process.argv.slice(2);
if (!root || !descriptor) {
  console.error("Usage: node scripts/openclaw-assistant-profile.mjs <new-absolute-profile-directory> <connections.json>");
  process.exitCode = 1;
} else {
  try {
    const connections = JSON.parse(await readFile(descriptor, "utf8"));
    await writeIsolatedProfile(root, connections);
    console.log("Created a dedicated OpenClaw profile with credential environment references. Configure model authentication separately; no owner baseline state was changed.");
  } catch {
    console.error("Profile creation refused. Use a new absolute directory and valid named /assistant/mcp connections with credential environment-variable names. Existing state is never overwritten.");
    process.exitCode = 1;
  }
}
