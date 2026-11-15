import { spawnSync } from "node:child_process";
const result = spawnSync(
  process.execPath,
  ["tests/collaboration-network.test.js"],
  {
    env: { ...process.env, INTELBOARD_TEST_TAILCAT: "1" },
    stdio: "inherit",
    windowsHide: true,
  },
);
if (result.error) throw result.error;
process.exit(result.status || 0);
