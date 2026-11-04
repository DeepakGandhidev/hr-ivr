import { createHmac } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sealSecret } from "@pratibha/shared/crypto";
import { __resetSettingsRuntime, startSettings } from "@pratibha/shared/settings-runtime";
import { inlineJson, saarthiConfig, saarthiToken } from "@/lib/saarthi";
import { GET as loader } from "@/app/saarthi.js/route";
import { GET as appChat } from "@/app/app-chat.html/route";

const SECRET = "sk_test_secret_for_unit_tests";

beforeAll(() => {
  process.env.EMAIL_SECRET_KEY = "c".repeat(64);
});
afterEach(() => __resetSettingsRuntime());

async function withSettings(values: Record<string, unknown>) {
  await startSettings({
    app: "web",
    load: async () => Object.entries(values).map(([key, value]) => ({ key, value })),
    intervalMs: 1e9,
  });
}

function decode(token: string) {
  const [h, p, sig] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(h!, "base64url").toString()),
    payload: JSON.parse(Buffer.from(p!, "base64url").toString()),
    valid: createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url") === sig,
  };
}

describe("saarthiToken", () => {
  it("is an HS256 token Saarthi will accept: signed, 15 minutes, single-use nonce", () => {
    const { header, payload, valid } = decode(
      saarthiToken({ id: "u1", name: "Asha", email: "asha@acme.in", plan: "growth", attrs: { workspace: "Acme" } }, SECRET)
    );
    expect(valid).toBe(true);
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(payload).toMatchObject({ user_id: "u1", name: "Asha", email: "asha@acme.in", plan: "growth", attrs: { workspace: "Acme" } });
    expect(payload.exp - payload.iat).toBe(900);
    expect(payload.nonce).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it("leaves out empty claims and keeps attributes within Saarthi's limits", () => {
    const { payload } = decode(
      saarthiToken(
        {
          id: "u2",
          name: null,
          email: "",
          plan: undefined,
          attrs: Object.fromEntries([...Array(12)].map((_, i) => [`k${i}`, i === 0 ? "x".repeat(150) : i === 1 ? null : `v${i}`])),
        },
        SECRET
      )
    );
    expect(payload).not.toHaveProperty("name");
    expect(payload).not.toHaveProperty("email");
    expect(payload).not.toHaveProperty("plan");
    expect(Object.keys(payload.attrs)).toHaveLength(10);
    expect(payload.attrs.k0).toHaveLength(100);
    expect(payload.attrs).not.toHaveProperty("k1");
  });

  it("cuts the name to 100 characters and drops an email Saarthi would reject", () => {
    const long = decode(saarthiToken({ id: "u3", name: "N".repeat(140), email: "not-an-email" }, SECRET)).payload;
    expect(long.name).toHaveLength(100);
    expect(long).not.toHaveProperty("email");

    const tidy = decode(saarthiToken({ id: "u4", name: "  Asha  ", email: " asha@acme.in " }, SECRET)).payload;
    expect(tidy).toMatchObject({ name: "Asha", email: "asha@acme.in" });
  });

  it("refuses to sign without a secret", () => {
    expect(() => saarthiToken({ id: "u1" }, null)).toThrow(/secret/);
  });

  it("two tokens for the same member never share a nonce", () => {
    const a = decode(saarthiToken({ id: "u1" }, SECRET)).payload.nonce;
    const b = decode(saarthiToken({ id: "u1" }, SECRET)).payload.nonce;
    expect(a).not.toBe(b);
  });
});

describe("settings", () => {
  it("is off everywhere until a site key is saved", () => {
    expect(saarthiConfig()).toMatchObject({ publicOn: false, portalOn: false, canSign: false });
  });

  it("turns on with a site key, signs with a saved secret, and honours the switches", async () => {
    await withSettings({
      "integrations.saarthi_site_key": "ws_live_abc",
      "integrations.saarthi_sdk_secret": { sealed: sealSecret(SECRET), last4: "ests" },
      "features.saarthi_public": false,
    });
    expect(saarthiConfig()).toMatchObject({ siteKey: "ws_live_abc", publicOn: false, portalOn: true, canSign: true });
  });

  it("will not load a widget from a non-https address", async () => {
    await withSettings({ "integrations.saarthi_site_key": "ws_x", "integrations.saarthi_widget_url": "http://evil.example/w.js" });
    // The registry refuses the saved value, so the default https widget stays in force.
    expect(saarthiConfig().widgetUrl).toMatch(/^https:\/\//);
  });
});

describe("what visitors receive", () => {
  it("the marketing site loader is an empty script while the chat is off", async () => {
    const res = loader();
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(await res.text()).not.toContain("Saarthi =");
  });

  it("the loader starts the widget with the saved site key", async () => {
    await withSettings({ "integrations.saarthi_site_key": "ws_live_abc" });
    const js = await loader().text();
    expect(js).toContain('"ws_live_abc"');
    expect(js).toContain("saarthi-api-promonkey.onrender.com/widget/v1.js");
  });

  it("no setting can break out of the page's script", async () => {
    expect(inlineJson("</script><script>alert(1)</script>")).not.toContain("</script>");
    await withSettings({ "integrations.saarthi_site_key": "ws_</script><b>" });
    const html = await appChat().text();
    expect(html).not.toContain("ws_</script>");
    expect(html).toContain("noindex");
  });
});
