import {
  _,
  brightGreen,
  Confirm,
  decompress,
  green,
  Input,
  prompt,
  SpinnerTypes,
  TerminalSpinner,
  toml,
} from "../../deps.ts";
import { directoryExists } from "../utils.ts";
import { extractVersion } from "../utils.ts";
import { existsSync } from "node:fs";

const BASE_URL = "https://api.fluentci.io/v1";

/**
 * Initializes a Fluent CI pipeline by fetching the specified template from the registry, downloading it, and copying it to the specified output directory.
 * @param {Object} options - The options for the initialization.
 * @param {string} [options.template="base"] - The name of the template to use for the pipeline.
 * @param {boolean} [options.standalone=false] - Whether to create a standalone pipeline or not.
 * @param {string} [_name] - The name of the pipeline.
 * @returns {Promise<void>}
 */
async function init(
  {
    template,
    standalone,
    wasm,
  }: { template?: string; standalone?: boolean; wasm?: boolean } = {},
  name?: string,
) {
  const infos = await promptPackageDetails(standalone, name);
  let version = extractVersion(template || "base_pipeline");
  template = template?.split("@")[0] || "base_pipeline";

  const result = await fetch(`${BASE_URL}/pipeline/${template}`);
  const data = await result.json();

  if (data.version) {
    version = version === "latest"
      ? data.version || data.default_branch
      : version;
    if (
      await downloadTemplateFromRegistry(template, version, standalone, wasm)
    ) {
      await overrideFluentciToml(infos, standalone ? "." : ".fluentci");
      if (wasm) {
        await overrideCargoToml(infos, standalone ? "." : ".fluentci");
        return;
      }

      await overrideDaggerJson(infos, standalone ? "." : ".fluentci");
      return;
    }
  }

  if (data.github_url) {
    version = version === "latest"
      ? data.version || data.default_branch
      : version;
    await downloadTemplateFromGithub(data, template, version, standalone, wasm);
    await overrideFluentciToml(infos, standalone ? "." : ".fluentci");
    if (wasm) {
      await overrideCargoToml(infos, standalone ? "." : ".fluentci");
      return;
    }

    await overrideDaggerJson(infos, standalone ? "." : ".fluentci");
    return;
  }

  console.log(
    `Pipeline template ${green('"')}${green(template)}${
      green(
        '"',
      )
    } not found in Fluent CI registry`,
  );
  Deno.exit(1);
}

/**
 * Copies a directory from the source to the destination.
 * @param src The source directory.
 * @param dest The destination directory.
 */
async function copyDir(src: string, dest: string) {
  if (dest !== ".") {
    await Deno.mkdir(dest);
  }
  for await (const dirEntry of Deno.readDir(src)) {
    const srcPath = `${src}/${dirEntry.name}`;
    const destPath = `${dest}/${dirEntry.name}`;
    if (dirEntry.isDirectory) {
      await copyDir(srcPath, destPath);
    } else {
      await Deno.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Downloads a template from the specified URL and extracts it to the current directory.
 * @param url The URL of the template to download.
 * @param template The name of the template being downloaded.
 */
async function download(url: string, template: string) {
  const terminalSpinner = new TerminalSpinner({
    text: `Downloading ${green(template)} template ...`,
    spinner: SpinnerTypes.dots,
  });
  terminalSpinner.start();

  const tempFilePath = await Deno.makeTempFile();

  const response = await fetch(url);
  const value = await response.arrayBuffer();

  terminalSpinner.succeed("Downloaded template");

  await Deno.writeFile(tempFilePath, new Uint8Array(value));

  await decompress(tempFilePath, ".", { overwrite: true });

  // Cleanup the temp file
  await Deno.remove(tempFilePath);
}

/**
 * Sets up the devbox configuration files.
 */
async function setupDevbox() {
  const devboxFiles = ["devbox.json", "devbox.lock"];
  for (const devboxFile of devboxFiles) {
    if (exists(`.fluentci/example/${devboxFile}`) && !exists(devboxFile)) {
      await Deno.copyFile(`.fluentci/example/${devboxFile}`, devboxFile);
    }
  }
}

function exists(file: string): boolean {
  try {
    return Deno.statSync(file).isFile;
  } catch (_) {
    return false;
  }
}

async function downloadTemplateFromGithub(
  data: {
    github_url: string;
    version: string;
    default_branch: string;
    directory?: string;
    owner: string;
  },
  template: string,
  version: string,
  standalone?: boolean,
  wasm?: boolean,
) {
  const archiveUrl = data.version && data.version.startsWith("v")
    ? `${
      data.github_url.replace(
        "https://github.com",
        "https://codeload.github.com",
      )
    }/zip/refs/tags/${version}`
    : `${
      data.github_url.replace(
        "https://github.com",
        "https://api.github.com/repos",
      )
    }/zipball/${version}`;

  await download(archiveUrl, template);

  const repoName = data.github_url.split("/").pop();

  let outputDir = `${repoName}-${version.replace("v", "")}`;

  if (data.directory) {
    outputDir += `/${data.directory}`;
    outputDir = `${data.owner}-${outputDir}`;
  }

  if (wasm) {
    if (await directoryExists(`${outputDir}/plugin`)) {
      outputDir += "/plugin";
    }
  }

  await copyDir(outputDir, standalone ? "." : ".fluentci");

  if (!standalone) {
    await removeUnnecessaryFiles();
  }

  if (data.directory) {
    outputDir = outputDir.split("/")[0];
  }

  await Deno.remove(outputDir.replace("/plugin", ""), { recursive: true });

  if (!standalone) {
    await setupDevbox();
  }
}

async function downloadTemplateFromRegistry(
  template: string,
  version: string,
  standalone?: boolean,
  wasm?: boolean,
) {
  const status = await fetch(
    `https://pkg.fluentci.io/${template}@${version}`,
  ).then((res) => res.status);
  if (status === 200) {
    await download(`https://pkg.fluentci.io/${template}@${version}`, template);

    let outputDir = `${template}/${version}`;

    if (wasm) {
      if (await directoryExists(`${outputDir}/plugin`)) {
        outputDir += "/plugin";
      }
    }

    await copyDir(outputDir, standalone ? "." : ".fluentci");

    if (!standalone) {
      await removeUnnecessaryFiles();
    }

    await Deno.remove(template, { recursive: true });

    if (!standalone) {
      await setupDevbox();
    }
    return true;
  }
  return false;
}

async function removeUnnecessaryFiles() {
  if (existsSync(".fluentci/.github")) {
    await Deno.remove(".fluentci/.github", { recursive: true });
  }
  if (existsSync(".fluentci/.fluentci")) {
    await Deno.remove(".fluentci/.fluentci", { recursive: true });
  }
  if (existsSync(".fluentci/example")) {
    await Deno.remove(".fluentci/example", { recursive: true });
  }
}

async function promptPackageDetails(standalone?: boolean, name?: string) {
  console.log(`👋 Welcome to ${brightGreen("Fluent CI")}!\n`);
  console.log(`This utility will walk you through creating a new pipeline.`);
  console.log(
    `It only covers the most common items, and tries to guess sensible defaults.\n`,
  );
  console.log(
    `Use ${
      brightGreen(
        "`fluentci run <pkg>`",
      )
    } to run a published pipeline, or ${
      brightGreen(
        "`fluentci publish`",
      )
    } to publish one.\n`,
  );
  console.log(`See ${brightGreen("`fluentci help`")} for more information.\n`);
  console.log(`Press ${brightGreen("CTRL+C")} at any time to quit.\n`);
  const infos = await prompt([
    {
      name: "name",
      message: "package name",
      type: Input,
      default: name || Deno.cwd().split("/").pop(),
    },
    {
      name: "version",
      message: "version",
      type: Input,
      default: "v0.1.0",
    },
    {
      name: "description",
      message: "description",
      type: Input,
    },
    {
      name: "keywords",
      message: "keywords",
      type: Input,
    },
    {
      name: "author",
      message: "author",
      type: Input,
    },
    {
      name: "license",
      message: "license",
      type: Input,
      default: "MIT",
    },
  ]);

  console.log(
    `\n✨ About to create a new${standalone ? " reusable " : " "}pipeline in ${
      brightGreen(Deno.cwd())
    }\n`,
  );

  console.log("📦 Package details:\n");
  const meta = {
    ...infos,
    keywords: infos.keywords?.split(",").map((keyword) => keyword.trim()),
  };
  if (_.isEqual(meta.keywords, [""])) {
    delete meta.keywords;
  }
  console.log(meta);

  const { confirm } = await prompt([
    {
      name: "confirm",
      message: "Is this OK? (yes)",
      type: Confirm,
    },
  ]);

  if (!confirm) {
    console.log("Aborting");
    Deno.exit(1);
  }

  return meta;
}

async function overrideDaggerJson(infos: Record<string, unknown>, path = ".") {
  try {
    const dagger = await Deno.readFile(`${path}/dagger.json`);
    // deno-lint-ignore no-explicit-any
    const daggerJson: Record<string, any> = JSON.parse(
      new TextDecoder().decode(dagger),
    );
    for (const key of Object.keys(infos)) {
      daggerJson[key] = _.get(infos, key);
    }
    await Deno.writeFile(
      `${path}/dagger.json`,
      new TextEncoder().encode(JSON.stringify(daggerJson, null, 2)),
    );

    if (_.isEqual(path, ".fluentci")) {
      await Deno.copyFile(".fluentci/dagger.json", "dagger.json");
    }
    // deno-lint-ignore no-empty no-unused-vars
  } catch (e) {}
}

async function overrideCargoToml(infos: Record<string, unknown>, path = ".") {
  const cargoToml = await Deno.readFile(`${path}/Cargo.toml`);
  const config = toml.parse(new TextDecoder().decode(cargoToml));
  _.set(config, "package.name", _.get(infos, "name"));
  _.set(config, "package.version", _.get(infos, "version").replace("v", ""));
  _.set(config, "package.description", _.get(infos, "description"));
  _.set(config, "package.license", _.get(infos, "license"));

  if (_.get(infos, "author")) {
    _.set(config, "package.authors", [_.get(infos, "author")]);
  }

  await Deno.writeFile(
    `${path}/Cargo.toml`,
    new TextEncoder().encode(toml.stringify(config)),
  );
}

async function overrideFluentciToml(
  infos: Record<string, unknown>,
  path = ".",
) {
  let config = {};
  try {
    const fluentciToml = await Deno.readFile(`${path}/fluentci.toml`);
    config = toml.parse(new TextDecoder().decode(fluentciToml));
    // deno-lint-ignore no-unused-vars no-empty
  } catch (e) {}

  _.set(config, "package.name", _.get(infos, "name"));
  _.set(config, "package.version", _.get(infos, "version").replace("v", ""));
  _.set(config, "package.description", _.get(infos, "description"));
  _.set(config, "package.license", _.get(infos, "license"));
  _.set(config, "package.keywords", _.get(infos, "keywords"));

  if (_.get(infos, "author")) {
    _.set(config, "package.authors", [_.get(infos, "author")]);
  }

  await Deno.writeFile(
    `${path}/fluentci.toml`,
    new TextEncoder().encode(toml.stringify(config)),
  );
}

export default init;
