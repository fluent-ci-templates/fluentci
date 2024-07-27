import { green, procfile } from "../../deps.ts";
import { getProcfiles, writeToSocket } from "../utils.ts";

export default async function echo(name: string) {
  const files = await getProcfiles();
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
      const socket = file.replace("Procfile", ".overmind.sock");
      infos[service].socket = socket;
    }
  }

  if (!infos[name]) {
    console.log("Service not found in Procfile");
    Deno.exit(1);
  }

  const socket = infos[name].socket;
  try {
    await writeToSocket(socket, "echo\n", true);
  } catch (_e) {
    console.log(`Failed to stream logs for ${green(name)}`);
    Deno.exit(1);
  }
}