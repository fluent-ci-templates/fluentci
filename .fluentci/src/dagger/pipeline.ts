import { Directory } from "../../deps.ts";
import * as jobs from "./jobs.ts";

const { fmt, lint, test, runnableJobs } = jobs;

export default async function pipeline(src = ".", args: string[] = []) {
  if (args.length > 0) {
    await runSpecificJobs(args as jobs.Job[]);
    return;
  }

  await fmt(src);
  await lint(src);
  await test(src);
}

async function runSpecificJobs(args: jobs.Job[]) {
  for (const name of args) {
    const job = runnableJobs[name];
    if (!job) {
      throw new Error(`Job ${name} not found`);
    }
    if (name === "publish") {
      const publish = job as (
        src: string | Directory,
        version: string,
        ref: string,
        ghToken: string,
        actionsIdTokenRequestToken: string,
        actionsIdTokenRequestUrl: string,
        url?: string,
        ignoreConflicts?: boolean
      ) => Promise<string>;
      await publish(
        ".",
        Deno.env.get("VERSION")!,
        Deno.env.get("REF")!,
        Deno.env.get("GH_TOKEN")!,
        Deno.env.get("ACTIONS_ID_TOKEN_REQUEST_TOKEN")!,
        Deno.env.get("ACTIONS_ID_TOKEN_REQUEST_URL")!,
        Deno.env.get("URL"),
        Deno.env.get("IGNORE_CONFLICTS") === "true"
      );
    }
    if (name === "compile") {
      const compile = job as (
        src: string | Directory | undefined,
        file?: string,
        output?: string,
        target?: string
      ) => Promise<File | string>;
      await compile(".");
    }
  }
}
