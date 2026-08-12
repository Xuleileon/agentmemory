import { describe, expect, it } from "vitest";
import { extractFirstJsonObject } from "../scripts/migrate-legacy-index-to-lance.js";

describe("legacy Lance migration", () => {
  it("extracts the iii JSON envelope without parsing its binary trailer", () => {
    const json = JSON.stringify({ data: JSON.stringify([["id", { text: "括号 } 和引号 \\\"" }]]) });
    const file = Buffer.concat([Buffer.from(json), Buffer.from([0, 255, 123, 34, 125])]);
    expect(JSON.parse(extractFirstJsonObject(file))).toEqual(JSON.parse(json));
  });

  it("rejects a truncated envelope", () => {
    expect(() => extractFirstJsonObject(Buffer.from('{"data":"x"'))).toThrow(
      "complete JSON object",
    );
  });
});
