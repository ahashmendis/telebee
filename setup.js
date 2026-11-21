import "dotenv/config";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import readline from "node:readline";

function commandExists(command) {
  const result = process.platform === "win32"
    ? spawnSync("where", [command], { stdio: "ignore" })
    : spawnSync("which", [command], { stdio: "ignore" });
  return result.status === 0;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function argsMap() {
  const values = new Map();
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      if (equals >= 0) values.set(arg.slice(2, equals), arg.slice(equals + 1));
      else values.set(arg.slice(2), process.argv[index + 1]?.startsWith("--") ? "true" : process.argv[++index]);
    }
  }
  return values;
}

async function ask(question, defaultAnswer = "") {
  if (!process.stdin.isTTY) return defaultAnswer;
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    input.question(question, answer => {
      input.close();
      resolve(answer.trim() || defaultAnswer);
    });
  });
}

console.log("Telebee setup");

if (!commandExists("node")) {
  console.error("Node.js is required: https://nodejs.org/");
  process.exit(1);
}
console.log("✓ Node.js");

if (!commandExists("npm")) {
  console.error("npm is required.");
  process.exit(1);
}
console.log("✓ npm");

if (!existsSync("node_modules")) {
  console.log("Installing dependencies...");
  run("npm", ["install"]);
} else {
  console.log("✓ dependencies");
}

async function serverIsRunning() {
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3001}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

let server = null;
if (await serverIsRunning()) {
  console.log(`✓ Telebee signaling server is already running on port ${process.env.PORT || 3001}`);
} else {
  console.log("Starting Telebee signaling server...");
  server = spawn(process.execPath, ["server.js"], {
    stdio: "inherit",
    env: process.env
  });

  const stop = () => {
    server.kill();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await new Promise(resolve => setTimeout(resolve, 700));
  if (server.exitCode !== null) process.exit(server.exitCode || 1);
}

const options = argsMap();
const ngrokDomain = options.get("ngrok-url") || process.env.TELEBEE_NGROK_URL || "";
const ngrokRequested = options.has("ngrok") || process.env.TELEBEE_NGROK === "1";
let exposeWithNgrok = ngrokRequested;

if (!exposeWithNgrok && options.get("ngrok") !== "false" && process.stdin.isTTY) {
  const answer = await ask("Expose this server to the internet with ngrok? [y/N]: ", "n");
  exposeWithNgrok = ["y", "yes"].includes(answer.toLowerCase());
}

if (exposeWithNgrok) {
  if (!commandExists("ngrok")) {
    console.error("ngrok is not installed.");
    console.error("Install it from https://ngrok.com/download");
    if (server) server.kill();
    process.exit(1);
  }

  if (process.env.NGROK_AUTHTOKEN) {
    const auth = spawnSync("ngrok", ["config", "add-authtoken", process.env.NGROK_AUTHTOKEN], {
      stdio: "inherit"
    });
    if (auth.status !== 0) process.exit(auth.status || 1);
  } else {
    console.log("NGROK_AUTHTOKEN is missing. Add it to .env for unattended startup.");
  }

  async function discoverNgrokUrl() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      for (let port = 4040; port <= 4050; port += 1) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/tunnels`);
          if (!response.ok) continue;
          const data = await response.json();
          const publicUrl = data.tunnels
            ?.filter(tunnelInfo =>
              tunnelInfo.public_url?.startsWith("https://") &&
              (tunnelInfo.config?.addr === "http://localhost:3001" ||
                tunnelInfo.config?.addr?.endsWith(":3001"))
            )
            ?.map(tunnelInfo => tunnelInfo.public_url)[0];
          if (publicUrl) return publicUrl;
        } catch {}
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return null;
  }

  const existingPublicUrl = await discoverNgrokUrl();
  if (existingPublicUrl) {
    const wssUrl = `wss://${existingPublicUrl.replace(/^https?:\/\//, "")}`;
    console.log(`\nTelebee public WSS URL: ${wssUrl}`);
    console.log("Share this WSS URL with the extension client.");
    process.on("SIGINT", () => process.exit(0));
    process.on("SIGTERM", () => process.exit(0));
    setInterval(() => {}, 60_000);
  } else {
    const ngrokArgs = ["http", String(process.env.PORT || 3001)];
  if (ngrokDomain) {
    const domain = ngrokDomain
      .replace(/^https?:\/\//, "")
      .replace(/^wss?:\/\//, "")
      .replace(/\/$/, "");
    const looksReserved = domain && !domain.includes(".ngrok-");
    if (!looksReserved) {
      console.log("Custom ngrok domains require a paid ngrok plan.");
      console.log("Starting without a custom domain instead.");
    } else {
      ngrokArgs.push("--url", domain);
    }
  }

  console.log("Starting ngrok tunnel...");
  const tunnel = spawn("ngrok", ngrokArgs, { stdio: "inherit" });

  const stop = () => {
    tunnel.kill();
    if (server) server.kill();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await new Promise(resolve => setTimeout(resolve, 1200));

  const publicUrl = await discoverNgrokUrl();

  if (publicUrl) {
    const wssUrl = `wss://${publicUrl.replace(/^https?:\/\//, "")}`;
    console.log(`\nTelebee public WSS URL: ${wssUrl}`);
    console.log("Share this WSS URL with the extension client.");
  } else {
    console.log("ngrok started. Copy the HTTPS forwarding URL and use it with wss://");
  }

    const exitCode = await new Promise(resolve => tunnel.once("exit", resolve));
    if (server) server.kill();
    process.exit(exitCode || 0);
  }
}
