import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const originalHome = process.env["HOME"];
const originalUserProfile = process.env["USERPROFILE"];
const testHome = mkdtempSync(join(tmpdir(), "agentmemory-vitest-home-"));

process.env["HOME"] = testHome;
process.env["USERPROFILE"] = testHome;

afterAll(() => {
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;

  if (originalUserProfile === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = originalUserProfile;

  rmSync(testHome, { recursive: true, force: true });
});
