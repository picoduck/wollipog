// Inert MCP substitute only. Never imports a provider, credentials or network client.
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, renameSync, unlinkSync } from "node:fs";
if (process.argv.slice(2).join(",") !== "--agent-control-mcp") process.exit(96);
const lines = createInterface({ input: process.stdin });
const reply = value => process.stdout.write(`${JSON.stringify(value)}\n`);
lines.on("line", line => {
  const request = JSON.parse(line);
  switch (request.method) {
    case "inspect": reply({ id: request.id, envDelivered: process.env.WOLLIPOG_CANARY === "inert-canary-value-3922",
      argvSafe: !process.argv.some(arg => arg.includes("inert-canary-value-3922")),
      loaderSafe: !process.env.NODE_OPTIONS && !process.env.LD_PRELOAD,
      fixedArgs: process.argv.slice(2) }); break;
    case "echo": reply({ id: request.id, result: request.value }); break;
    case "exit": process.exit(request.code); break;
    case "hang": break;
    case "descendant": {
      const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
      reply({ id: request.id, pid: child.pid }); break;
    }
    case "large": reply({ result: "x".repeat(request.bytes) }); break;
    case "write": {
      try {
        if (request.operation === "delete") unlinkSync(request.path);
        else if (request.operation === "rename") { writeFileSync(request.temporary, "inert-replacement"); renameSync(request.temporary, request.path); }
        else writeFileSync(request.path, "inert-write");
        reply({ id: request.id, denied: false });
      } catch (error) { reply({ id: request.id, denied: ["EROFS", "EACCES", "EXDEV"].includes(error.code) }); }
      break;
    }
    case "read": reply({ id: request.id, result: readFileSync(request.path, "utf8") }); break;
    case "descendant-write": {
      const child = spawn(process.execPath, ["-e", "try{require('fs').writeFileSync(process.argv[1],'inert-write');process.exit(97)}catch(e){process.exit(['EROFS','EACCES'].includes(e.code)?0:98)}", request.path],
        { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
      child.once("close", code => reply({ id: request.id, denied: code === 0 })); break;
    }
    default: reply({ id: request.id, unknown: true });
  }
});
