import { Context } from "./graphql/context.ts";
import { Action } from "./graphql/objects/action.ts";
import { Run } from "./graphql/objects/run.ts";
import { createId, dayjs } from "../../deps.ts";
import { Log } from "./graphql/objects/log.ts";
import { sendSocketMessage, stopServices } from "../utils.ts";

export default async function run(ctx: Context, actions: Action[], data: Run) {
  let currentActionIndex = 0;
  const runStart = dayjs();
  let jobs = [...data.jobs];

  const project = await ctx.kv.projects.get(data.projectId);

  Object.values(ctx.sockets).forEach((s) =>
    sendSocketMessage(
      s,
      JSON.stringify({
        channel: "run",
        data: {
          ...data,
          status: "RUNNING",
          date: new Date().toISOString(),
        },
      })
    )
  );

  await ctx.kv.runs.save(data.projectId, {
    ...data,
    date: new Date().toISOString(),
  });
  let run = await ctx.kv.runs.get(data.id);
  ctx.runs.set(data.id, run!);

  for (const action of actions) {
    if (!action.enabled) {
      currentActionIndex += 1;
      continue;
    }

    const start = dayjs();
    const logs: Log[] = [];

    jobs = jobs.map((job, j) => ({
      ...job,
      startedAt: currentActionIndex === j ? start.toISOString() : job.startedAt,
      status: currentActionIndex === j ? "RUNNING" : job.status,
    }));

    Object.values(ctx.sockets).forEach((s) =>
      sendSocketMessage(
        s,
        JSON.stringify({
          channel: "job",
          data: {
            ...jobs[currentActionIndex],
            startedAt: start.toISOString(),
            status: "RUNNING",
          },
        })
      )
    );

    await ctx.kv.runs.save(data.projectId, {
      ...run!,
      jobs,
    });

    for (const cmd of action.commands.split("\n")) {
      const result = await spawn(
        ctx,
        `fluentci run ${action.useWasm ? "--wasm" : ""} ${
          action.plugin
        } ${cmd}`,
        action.workingDirectory
          ? project
            ? `${project?.path}/${action.workingDirectory}`
            : undefined
          : project?.path,
        jobs[currentActionIndex].id,
        data.id,
        action.env
          ? Object.fromEntries(action.env.map((x) => x.split("=")))
          : undefined
      );

      logs.push(...result.logs);

      if (result.cancelled) {
        jobs = jobs.map((job, j) => ({
          ...job,
          status: currentActionIndex === j ? "CANCELLED" : job.status,
          duration:
            currentActionIndex === j
              ? dayjs().diff(start, "milliseconds")
              : job.duration,
          logs:
            currentActionIndex === j
              ? [...(job.logs || []), ...result.logs]
              : job.logs,
        }));

        await ctx.kv.runs.save(data.projectId, {
          ...run!,
          jobs,
          status: "CANCELLED",
        });

        return;
      }

      if (result.code !== 0) {
        Object.values(ctx.sockets).forEach((s) =>
          sendSocketMessage(
            s,
            JSON.stringify({
              channel: "job",
              data: {
                ...jobs[currentActionIndex],
                status: "FAILURE",
                duration: dayjs().diff(start, "milliseconds"),
                logs: [...(jobs[currentActionIndex].logs || []), ...logs],
              },
            })
          )
        );

        jobs = jobs.map((job, j) => ({
          ...job,
          status: currentActionIndex === j ? "FAILURE" : job.status,
          duration:
            currentActionIndex === j
              ? dayjs().diff(start, "milliseconds")
              : job.duration,
          logs:
            currentActionIndex === j
              ? [...(job.logs || []), ...result.logs]
              : job.logs,
        }));
        const duration = dayjs().diff(runStart, "milliseconds");
        await ctx.kv.runs.save(data.projectId, {
          ...run!,
          jobs,
          status: "FAILURE",
          duration,
        });
        await ctx.kv.projects.updateStats(data.projectId);

        if (actions.some((x) => x.useWasm)) {
          await stopServices(project?.path!);
        }

        ctx.runs.delete(data.id);

        return;
      }
    }

    jobs = jobs.map((job, j) => ({
      ...job,
      status: currentActionIndex === j ? "SUCCESS" : job.status,
      duration:
        currentActionIndex === j
          ? dayjs().diff(start, "milliseconds")
          : job.duration,
      logs:
        currentActionIndex === j ? [...(job.logs || []), ...logs] : job.logs,
    }));

    await ctx.kv.runs.save(data.projectId, {
      ...run!,
      jobs,
    });

    currentActionIndex += 1;
  }

  run = await ctx.kv.runs.get(data.id);
  const duration = dayjs().diff(runStart, "milliseconds");
  await ctx.kv.runs.save(data.projectId, {
    ...run!,
    status: "SUCCESS",
    duration,
  });
  await ctx.kv.projects.updateStats(data.projectId);

  Object.values(ctx.sockets).forEach((s) =>
    sendSocketMessage(
      s,
      JSON.stringify({
        channel: "run",
        data: {
          ...run!,
          status: "SUCCESS",
          duration,
        },
      })
    )
  );

  if (actions.some((x) => x.useWasm)) {
    await stopServices(project?.path!);
  }

  ctx.runs.delete(data.id);
}

async function spawn(
  ctx: Context,
  cmd: string,
  cwd = Deno.cwd(),
  jobId: string,
  runId: string,
  env?: Record<string, string>
) {
  const cancelled = ctx.runs.get(runId) ? false : true;
  const logs: Log[] = [];
  const child = new Deno.Command("bash", {
    args: ["-c", cmd],
    stdout: "piped",
    stderr: "piped",
    cwd,
    env,
  }).spawn();

  const writableStdoutStream = new WritableStream({
    write: (chunk) => {
      const text = new TextDecoder().decode(chunk);
      console.log(text);
      const log = new Log({
        id: createId(),
        jobId: jobId!,
        message: text,
        createdAt: new Date().toISOString(),
      });
      logs.push(log);
      Object.values(ctx.sockets).forEach((s) =>
        sendSocketMessage(
          s,
          JSON.stringify({ channel: "logs", data: { text, jobId } })
        )
      );
    },
  });

  const writableStderrStream = new WritableStream({
    write: (chunk) => {
      const text = new TextDecoder().decode(chunk);
      console.log(text);
      const log = new Log({
        id: createId(),
        jobId: jobId!,
        message: text,
        createdAt: new Date().toISOString(),
      });
      logs.push(log);
      Object.values(ctx.sockets).forEach((s) =>
        sendSocketMessage(
          s,
          JSON.stringify({ channel: "logs", data: { text, jobId } })
        )
      );
    },
  });

  const [_stdout, _stderr, { code }] = await Promise.all([
    child.stdout.pipeTo(writableStdoutStream),
    child.stderr.pipeTo(writableStderrStream),
    child.status,
  ]);

  return { logs, code, cancelled };
}
