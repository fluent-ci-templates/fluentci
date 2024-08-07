import { brightGreen, gray, bold, procfile, Table, Cell } from "../../deps.ts";
import { getServicePid, writeToSocket } from "../utils.ts";

export default async function status(name: string) {
  const command = new Deno.Command("bash", {
    args: ["-c", "ls .fluentci/*/Procfile"],
    stdout: "piped",
  });
  const process = await command.spawn();
  const { stdout, success } = await process.output();
  if (!success) {
    console.log("No services running");
    Deno.exit(0);
  }
  const decoder = new TextDecoder();
  const files = decoder.decode(stdout).trim().split("\n");
  const services = [];
  // deno-lint-ignore no-explicit-any
  let infos: Record<string, any> = {};

  for (const file of files) {
    const manifest = procfile.parse(Deno.readTextFileSync(file));
    services.push(...Object.keys(manifest));
    infos = {
      ...infos,
      ...manifest,
    };

    for (const service of Object.keys(manifest)) {
      infos[service].procfile = file;
      const socket = file.replace("Procfile", ".overmind.sock");
      infos[service].socket = socket;
      try {
        const response = await writeToSocket(socket, "status\n");
        if (!response.includes("running")) {
          infos[service].status = "Stopped";
          continue;
        }
      } catch (_e) {
        infos[service].status = "Stopped";
      }
      infos[service].status = "Up";
    }
  }

  if (!infos[name]) {
    console.log("Service not found in Procfile");
    Deno.exit(1);
  }

  const pid = await getServicePid(name, infos[name].socket);

  console.log(
    `${infos[name].status === "Up" ? brightGreen("●") : "○"} ${name}`
  );

  const table = new Table().body([
    [
      new Cell("Procfile:").align("right"),
      `${infos[name].procfile}\n└─ ${gray(
        infos[name].command + " " + infos[name].options.join(" ")
      )}`,
    ],
    [
      new Cell("Active:").align("right"),
      infos[name].status === "Up"
        ? bold(brightGreen("active (running)"))
        : "inactive (dead)",
    ],
    [new Cell("Socket:").align("right"), infos[name].socket],
    [new Cell("Main PID:").align("right"), pid],
    [
      new Cell("WorkDir:").align("right"),
      infos[name].socket.replace("/.overmind.sock", ""),
    ],
  ]);
  table.render();
  console.log("");
}
