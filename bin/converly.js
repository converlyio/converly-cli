#!/usr/bin/env node
// Keep this file to syntax that very old Node versions can parse: it has to
// run far enough to explain the version problem instead of crashing on it.
var MIN_MAJOR = 18;
var current = process.versions.node;
var major = parseInt(current.split(".")[0], 10);

if (!(major >= MIN_MAJOR)) {
  var message =
    "Converly needs Node.js " + MIN_MAJOR + " or newer, and this computer has " + current + ". " +
    "Install the current version from https://nodejs.org, then run the command again.";
  if (process.stderr.isTTY) {
    process.stderr.write("Error: " + message + "\n");
  } else {
    process.stderr.write(
      JSON.stringify({ error: { code: "node_version_unsupported", message: message } }, null, 2) + "\n"
    );
  }
  process.exitCode = 1;
} else {
  import("../src/main.js").then(function (mod) {
    return mod.main(process.argv.slice(2));
  });
}
