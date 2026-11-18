import { describe, expect, it } from "vite-plus/test";

import {
  CLI_RELEASES_PAGE_URL,
  cliArchiveTarCommand,
  cliReleaseAssetUrl,
  cliReleaseIndexPageUrl,
  compareCliReleaseVersions,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });

  it("reads the fork's releases", () => {
    expect(CLI_RELEASES_PAGE_URL).toBe("https://github.com/applejxd/t3code/releases");
    expect(cliReleaseIndexPageUrl(2)).toBe(
      "https://api.github.com/repos/applejxd/t3code/releases?per_page=100&page=2",
    );
    expect(cliReleaseAssetUrl("1.2.3-fork.4", "SHA256SUMS")).toBe(
      "https://github.com/applejxd/t3code/releases/download/v1.2.3-fork.4/SHA256SUMS",
    );
  });

  // The stable rows mirror the installer cases in scripts/install.test.ts.
  it.each([
    {
      name: "the highest base, then the highest number, wherever they sit and above a newer plain release",
      tags: [
        "v2.0.0",
        "v1.9.9-fork.12",
        "v1.4.0-preview.20261019.50",
        "v1.2.3",
        "v1.10.0-fork.2",
        "v1.10.0-fork.10",
        "v1.10.0-fork.9",
      ],
      expected: "1.10.0-fork.10",
    },
    {
      name: "a plain release only without a fork release",
      tags: ["v1.4.0-nightly.20261019.50", "v1.2.3", "v1.1.0"],
      expected: "1.2.3",
    },
    {
      name: "no lookalike as a fork release",
      tags: ["v1.11.0-fork.1-rc.1", "v1.11.0-fork", "v1.10.0-fork.1"],
      expected: "1.10.0-fork.1",
    },
    {
      name: "no draft fork release",
      tags: ["v1.10.0-fork.3", "v1.10.0-fork.2"],
      drafts: ["v1.10.0-fork.3"],
      expected: "1.10.0-fork.2",
    },
  ])("picks on stable $name", ({ tags, drafts = [], expected }) => {
    expect(
      newestCliReleaseVersion(
        tags.map((tag_name) => ({ tag_name, draft: drafts.includes(tag_name) })),
        "stable",
      ),
    ).toBe(expected);
  });

  it("keeps fork releases off the nightly and preview channels", () => {
    const releases = [{ tag_name: "v1.2.3-fork.1" }, { tag_name: "v1.2.3-nightly.20260911.2" }];
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.3-nightly.20260911.2");
    expect(newestCliReleaseVersion(releases, "preview")).toBeUndefined();
  });
});

describe("compareCliReleaseVersions", () => {
  const newer = (candidate: string, current: string) =>
    compareCliReleaseVersions(candidate, current) > 0;

  it("updates a fork build to a newer fork release, by base and then number", () => {
    expect(newer("0.1.10-fork.2", "0.1.10-fork.1")).toBe(true);
    expect(newer("0.1.10-fork.10", "0.1.10-fork.9")).toBe(true);
    expect(newer("0.1.11-fork.1", "0.1.10-fork.7")).toBe(true);
    expect(newer("1.0.0-fork.1", "0.9.9-fork.3")).toBe(true);
    expect(compareCliReleaseVersions("0.1.10-fork.1", "0.1.10-fork.1")).toBe(0);
  });

  it("never downgrades a fork build to an older fork release", () => {
    expect(newer("0.1.10-fork.1", "0.1.10-fork.2")).toBe(false);
    expect(newer("0.1.9-fork.5", "0.1.10-fork.1")).toBe(false);
  });

  it("never moves a fork build sideways to a plain release of its base or an older one", () => {
    expect(newer("0.1.10", "0.1.10-fork.1")).toBe(false);
    expect(newer("0.1.10", "0.1.10-fork.9")).toBe(false);
    expect(newer("0.1.9", "0.1.10-fork.1")).toBe(false);
    // A plain release of a later base is later, though the installers would not offer it.
    expect(newer("0.1.11", "0.1.10-fork.1")).toBe(true);
  });

  it("updates a plain build to the fork release of its base or a later one", () => {
    expect(newer("0.1.10-fork.1", "0.1.10")).toBe(true);
    expect(newer("0.1.11-fork.1", "0.1.10")).toBe(true);
    expect(newer("0.1.9-fork.4", "0.1.10")).toBe(false);
  });

  it("orders plain versions as semver does", () => {
    expect(newer("0.1.11", "0.1.10")).toBe(true);
    expect(newer("0.1.10", "0.1.10")).toBe(false);
    expect(newer("0.1.9", "0.1.10")).toBe(false);
    expect(newer("0.1.10", "0.1.10-rc.1")).toBe(true);
    expect(newer("1.0.0-nightly.20260924.2", "1.0.0-nightly.20260923.1")).toBe(true);
    expect(newer("1.0.0-nightly.20260923.1", "1.0.0-nightly.20260924.2")).toBe(false);
  });
});
