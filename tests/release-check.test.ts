import { checkTag } from "../scripts/release-check.mjs";

describe("checkTag", () => {
  it("accepts a tag matching the manifest version", () => {
    expect(checkTag("v1.0.0", "1.0.0")).toBeNull();
    expect(checkTag("v1.2.3.4", "1.2.3.4")).toBeNull();
  });

  it("names both versions when the tag differs from the manifest", () => {
    const reason = checkTag("v1.0.1", "1.0.0");
    expect(reason).toContain("1.0.0");
    expect(reason).toContain("v1.0.1");
  });

  it.each([
    ["1.0.0", "1.0.0"],
    ["v1.0.0-rc1", "1.0.0-rc1"],
    ["v1.65536", "1.65536"],
    ["v01.0", "01.0"],
  ])("rejects %s as a Chrome extension version", (tag, version) => {
    expect(checkTag(tag, version)).not.toBeNull();
  });
});
