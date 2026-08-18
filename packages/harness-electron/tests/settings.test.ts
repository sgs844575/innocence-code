import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  MOCK_MODEL,
  MOCK_PROFILE_ID,
  PROVIDER_PRESETS,
  listModels,
  mergeSettings,
  newCustomProfile,
  resolveActive,
} from "../src";

describe("mergeSettings", () => {
  it("garbage input falls back to defaults with presets", () => {
    expect(mergeSettings(null).profiles).toHaveLength(PROVIDER_PRESETS.length);
    expect(mergeSettings(undefined).activeProfileId).toBe(MOCK_PROFILE_ID);
    expect(mergeSettings("junk").permissionMode).toBe("ask");
  });

  it("migrates v1 single-provider settings to v2 profiles", () => {
    const v1 = {
      providerId: "openai",
      openai: { apiKey: "sk-old", baseURL: "https://gw.example/v1", model: "gpt-4o-mini" },
      anthropic: { apiKey: "", model: "claude-sonnet-4-5" },
      workspaceRoot: "D:/work",
      permissionMode: "plan",
    };
    const s = mergeSettings(v1);
    const openai = s.profiles.find((p) => p.name === "OpenAI");
    expect(openai).toMatchObject({
      kind: "openai",
      apiKey: "sk-old",
      baseURL: "https://gw.example/v1",
      enabled: true,
      models: ["gpt-4o-mini"],
    });
    // Anthropic had no key -> not migrated as enabled
    expect(s.profiles.find((p) => p.name === "Anthropic")?.enabled).toBe(false);
    expect(s.activeProfileId).toBe(openai!.id);
    expect(s.activeModel).toBe("gpt-4o-mini");
    expect(s.workspaceRoot).toBe("D:/work");
    expect(s.permissionMode).toBe("plan");
  });

  it("v1 with mock providerId keeps mock active", () => {
    const s = mergeSettings({ providerId: "mock" });
    expect(s.activeProfileId).toBe(MOCK_PROFILE_ID);
    expect(s.activeModel).toBe(MOCK_MODEL);
  });

  it("normalizes v2: drops malformed profiles, resets invalid active selection", () => {
    const s = mergeSettings({
      profiles: [
        { id: "a", name: "A", kind: "openai", apiKey: "k", baseURL: "", enabled: true, models: ["m1"] },
        { id: "", name: "bad" },
        { id: "b", kind: "bogus" },
      ],
      activeProfileId: "zzz",
      activeModel: "nope",
      permissionMode: "bogus",
    });
    expect(s.profiles).toHaveLength(2);
    expect(s.profiles[1]).toMatchObject({ id: "b", kind: "openai", enabled: false, models: [] });
    expect(s.activeProfileId).toBe(MOCK_PROFILE_ID);
    expect(s.activeModel).toBe(MOCK_MODEL);
    expect(s.permissionMode).toBe("ask");
  });

  it("round-trips valid v2 settings unchanged", () => {
    const profile = newCustomProfile("我的网关");
    profile.apiKey = "k";
    profile.baseURL = "https://gw/v1";
    profile.models = ["x", "y"];
    const input = {
      profiles: [profile],
      activeProfileId: profile.id,
      activeModel: "y",
      workspaceRoot: "D:/x",
      permissionMode: "auto" as const,
      themeMode: "dark" as const,
      locale: "zh-CN" as const,
    };
    expect(mergeSettings(input)).toEqual(input);
  });

  it("normalizes ui prefs: invalid themeMode/locale fall back to system defaults", () => {
    const s = mergeSettings({
      profiles: [],
      themeMode: "neon",
      locale: "fr-FR",
    });
    expect(s.themeMode).toBe("system");
    expect(s.locale).toBe("");
    expect(mergeSettings({ profiles: [], themeMode: "light", locale: "en-US" })).toMatchObject({
      themeMode: "light",
      locale: "en-US",
    });
  });
});

describe("resolveActive", () => {
  it("returns mock when nothing valid is active", () => {
    expect(resolveActive(DEFAULT_SETTINGS)).toEqual({ kind: "mock" });
    expect(
      resolveActive({ ...DEFAULT_SETTINGS, activeProfileId: "preset_OpenAI" }),
    ).toEqual({ kind: "mock" }); // preset disabled by default
  });

  it("returns the active profile with its model", () => {
    const s = mergeSettings(DEFAULT_SETTINGS);
    const p = s.profiles[0];
    p.enabled = true;
    p.apiKey = "k";
    const r = resolveActive({
      ...s,
      activeProfileId: p.id,
      activeModel: p.models[0],
    });
    expect(r).toEqual({
      kind: p.kind,
      apiKey: "k",
      baseURL: p.baseURL,
      model: p.models[0],
    });
  });
});

describe("listModels", () => {
  it("parses OpenAI-style /models responses", async () => {
    const models = await listModels(
      { kind: "openai", apiKey: "k", baseURL: "https://gw/v1" },
      async (url, init) => {
        expect(String(url)).toBe("https://gw/v1/models");
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer k");
        return new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }, { name: "c" }] }));
      },
    );
    expect(models).toEqual(["a", "b", "c"]);
  });

  it("parses Anthropic /v1/models with x-api-key", async () => {
    const models = await listModels(
      { kind: "anthropic", apiKey: "ak", baseURL: "" },
      async (url, init) => {
        expect(String(url)).toBe("https://api.anthropic.com/v1/models");
        expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("ak");
        return new Response(
          JSON.stringify({ data: [{ id: "claude-sonnet-4-5", display_name: "Sonnet" }] }),
        );
      },
    );
    expect(models).toEqual(["claude-sonnet-4-5"]);
  });

  it("surfaces HTTP errors with status", async () => {
    await expect(
      listModels({ kind: "openai", apiKey: "k", baseURL: "" }, async () =>
        new Response("unauthorized", { status: 401 }),
      ),
    ).rejects.toThrow("HTTP 401");
  });
});
