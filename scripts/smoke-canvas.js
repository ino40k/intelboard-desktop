process.env.INTELBOARD_CANVAS_SMOKE = "1";
if (process.argv.includes("--shared"))
  process.env.INTELBOARD_CANVAS_SHARED = "1";
await import("./smoke-desktop.js");
