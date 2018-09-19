#!/usr/bin/env node
import * as fs from "fs";
import * as util from "util";
import * as yargs from "yargs";
import * as path from "path";
import { NodeVM } from "vm2";
import * as glob from "glob";
import { protos, utils } from "@dataform/core";
import * as runners from "./runners";
import { Executor } from "./executor";
import * as childProcess from "child_process";

const vm = new NodeVM({
  timeout: 5000,
  wrapper: "none",
  require: {
    context: "sandbox",
    root: "./",
    external: true
  },
  sourceExtensions: ["js", "sql"],
  compiler: (code, file) => {
    if (file.includes(".sql")) {
      return utils.compileSql(code, file);
    } else {
      return code;
    }
  }
});

export function init(projectDir: string) {
  var dataformJsonPath = path.join(projectDir, "dataform.json");
  var packageJsonPath = path.join(projectDir, "package.json");
  if (fs.existsSync(dataformJsonPath) || fs.existsSync(packageJsonPath)) {
    throw "Cannot init dataform project, this already appears to be an NPM or Dataform directory.";
  }
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir);
  }
  fs.writeFileSync(
    dataformJsonPath,
    JSON.stringify(
      protos.ProjectConfig.create({
        warehouse: "bigquery",
        defaultSchema: "dataform"
      }),
      null,
      4
    ) + "\n"
  );
  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify(
      {
        name: utils.baseFilename(path.resolve(projectDir)),
        version: "0.0.1",
        description: "New Dataform project.",
        dependencies: {
          "@dataform/core": "^0.0.1"
        }
      },
      null,
      4
    ) + "\n"
  );
  // Make the default datasets, includes folders.
  fs.mkdirSync(path.join(projectDir, "datasets"));
  fs.mkdirSync(path.join(projectDir, "includes"));
  // Run npm i in the directory.
  util
    .promisify(childProcess.exec)("npm i", { cwd: path.resolve(projectDir) })
    .catch(e => {
      console.log(e);
      console.log("Failed to initialize project.");
    });
}

export function run(
  graph: protos.IExecutionGraph,
  profile: protos.IProfile
): Promise<protos.IExecutedGraph> {
  return Executor.execute(
    runners.create(graph.projectConfig.warehouse, profile),
    graph
  );
}

export function build(
  projectDir: string,
  runConfig?: protos.IRunConfig
): protos.IExecutionGraph {
  var indexScript = genIndex(
    projectDir,
    `dft.build(${JSON.stringify(runConfig)})`
  );
  return vm.run(indexScript, path.resolve(path.join(projectDir, "index.js")));
}

export function compile(
  projectDir: string
): (protos.IMaterialization | protos.IOperation | protos.IAssertion)[] {
  var indexScript = genIndex(projectDir, "dft.compile()");
  console.log(indexScript);
  return vm.run(indexScript, path.resolve(path.join(projectDir, "index.js")));
}

function genIndex(projectDir: string, returnStatement: string): string {
  var projectConfig = protos.ProjectConfig.create({
    datasetPaths: ["datasets/*"],
    includePaths: ["includes/*"]
  });

  var projectConfigPath = path.join(projectDir, "dataform.json");
  if (fs.existsSync(projectConfigPath)) {
    Object.assign(
      projectConfig,
      JSON.parse(fs.readFileSync(projectConfigPath, "utf8"))
    );
  }

  var packageJsonPath = path.join(projectDir, "package.json");
  var packageConfig = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  var includePaths = [];
  projectConfig.includePaths.forEach(pathPattern =>
    glob.sync(pathPattern, { cwd: projectDir }).forEach(path => {
      if (includePaths.indexOf(path) < 0) {
        includePaths.push(path);
      }
    })
  );
  var datasetPaths = [];
  projectConfig.datasetPaths.forEach(pathPattern =>
    glob.sync(pathPattern, { cwd: projectDir }).forEach(path => {
      if (datasetPaths.indexOf(path) < 0) {
        datasetPaths.push(path);
      }
    })
  );

  var packageRequires = Object.keys(packageConfig.dependencies || {})
    .map(packageName => {
      return `global.${utils.variableNameFriendly(
        packageName
      )} = require("${packageName}");`;
    })
    .join("\n");

  var includeRequires = includePaths
    .map(path => {
      return `global.${utils.baseFilename(path)} = require("./${path}");`;
    })
    .join("\n");
  var datasetRequires = datasetPaths
    .map(path => {
      return `require("./${path}");`;
    })
    .join("\n");

  return `
    const dft = require("@dataform/core");
    dft.init(require("./dataform.json"));
    ${packageRequires}
    ${includeRequires}
    ${datasetRequires}
    return ${returnStatement};`;
}