import { PRODUCT_NAME } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const { syncGroupSpaces } = vi.hoisted(() => ({
  syncGroupSpaces: vi.fn(async () => ({ missingSpaceIds: [] as string[] })),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  syncGroupSpaces,
}));

import {
  authRateLimitOptions,
  buildTrustedOrigins,
  createAuth,
  idTokenGroups,
  isBlockedAuthPath,
  OIDC_PROVIDER_ID,
  oidcRegistered,
  passwordResetEmail,
  resolveSignupPolicy,
} from "./index.js";

describe("auth policy", () => {
  it("closes every organization plugin route", () => {
    for (const path of [
      "/organization/delete",
      "/organization/update",
      "/organization/leave",
      "/organization/create",
      "/organization/invite-member",
      "/organization/cancel-invitation",
      "/organization/set-active",
      "/organization/list",
      "/organization/create-team",
      "/organization/some-future-route",
    ]) {
      expect(isBlockedAuthPath(path), path).toBe(true);
    }
  });

  it("keeps the account routes the apps call", () => {
    for (const path of [
      "/sign-up/email",
      "/sign-in/email",
      "/sign-out",
      "/get-session",
      "/change-password",
      "/request-password-reset",
      "/reset-password",
      "/delete-user",
    ]) {
      expect(isBlockedAuthPath(path), path).toBe(false);
    }
  });

  it("disables organization deletion inside Better Auth as well", async () => {
    const auth = createAuth({} as never, {
      secret: "test-secret-that-is-long-enough-for-better-auth",
      baseURL: "http://127.0.0.1:3100",
      webOrigin: "http://127.0.0.1:5173",
      signupsEnabled: undefined,
      signupAllowlist: undefined,
    });

    const res = await auth.handler(
      new Request("http://127.0.0.1:3100/api/auth/organization/delete", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({ organizationId: "space-1" }),
      }),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "ORGANIZATION_DELETION_DISABLED" });
  });
});

describe("authRateLimitOptions", () => {
  it("caps credential routes at 10 attempts per 15 minutes in a shared table", () => {
    expect(authRateLimitOptions("production")).toEqual({
      enabled: true,
      storage: "database",
      customRules: {
        "/sign-in/email": { window: 15 * 60, max: 10 },
        "/sign-up/email": { window: 15 * 60, max: 10 },
        "/request-password-reset": { window: 15 * 60, max: 10 },
      },
    });
  });

  it("stays off outside production so the test suite can sign in", () => {
    expect(authRateLimitOptions("test").enabled).toBe(false);
  });
});

describe("buildTrustedOrigins", () => {
  it("adds the localhost twin for a 127.0.0.1 web origin", () => {
    expect(
      buildTrustedOrigins({
        webOrigin: "http://127.0.0.1:5173",
        baseURL: "http://127.0.0.1:5173",
      }),
    ).toEqual(expect.arrayContaining(["http://127.0.0.1:5173", "http://localhost:5173"]));
  });

  it("keeps extraOrigins and does not twin non-loopback hosts", () => {
    expect(
      buildTrustedOrigins({
        webOrigin: "https://app.example.test",
        baseURL: "https://api.example.test",
        extraOrigins: ["https://extra.example.test"],
      }),
    ).toEqual([
      "https://app.example.test",
      "https://api.example.test",
      "https://extra.example.test",
    ]);
  });
});

describe("passwordResetEmail", () => {
  it("keeps the reset URL in text and escapes user-controlled HTML", () => {
    const message = passwordResetEmail(
      { id: "user-1", email: "ada@example.test", name: '<Ada & "team">' },
      "https://rakazo.test/reset-password?token=secret&next=1",
    );

    expect(message).toMatchObject({
      to: "ada@example.test",
      subject: `Reset your ${PRODUCT_NAME} password`,
    });
    expect(message.text).toContain("https://rakazo.test/reset-password?token=secret&next=1");
    expect(message.html).toContain("&lt;Ada &amp; &quot;team&quot;&gt;");
    expect(message.html).toContain("token=secret&amp;next=1");
    expect(message.html).not.toContain('<Ada & "team">');
  });
});

describe("resolveSignupPolicy", () => {
  it("uses environment defaults before deployment settings exist", async () => {
    const prisma = {
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    await expect(
      resolveSignupPolicy(prisma as never, {
        signupsEnabled: "false",
        signupAllowlist: "you@example.com,@company.test",
      }),
    ).resolves.toEqual({
      enabled: false,
      allowlist: ["you@example.com", "@company.test"],
    });
  });

  it("keeps using the environment policy for a pre-upgrade uninitialized row", async () => {
    const prisma = {
      deploymentSettings: {
        findUnique: vi.fn().mockResolvedValue({
          signupsEnabled: true,
          signupAllowlist: "",
          signupPolicyInitialized: false,
        }),
      },
    };
    await expect(
      resolveSignupPolicy(prisma as never, {
        signupsEnabled: "false",
        signupAllowlist: "existing-policy@example.com",
      }),
    ).resolves.toEqual({ enabled: false, allowlist: ["existing-policy@example.com"] });
  });

  it("uses live deployment settings as the effective policy after initial seeding", async () => {
    const prisma = {
      deploymentSettings: {
        findUnique: vi.fn().mockResolvedValue({
          signupsEnabled: false,
          signupAllowlist: "approved@example.com",
          signupPolicyInitialized: true,
        }),
      },
    };
    await expect(
      resolveSignupPolicy(prisma as never, {
        signupsEnabled: "false",
        signupAllowlist: "environment-only@example.com",
      }),
    ).resolves.toEqual({ enabled: false, allowlist: ["approved@example.com"] });
  });
});

describe("operator OIDC provider", () => {
  const baseEnv = {
    secret: "test-secret-that-is-long-enough-for-better-auth",
    baseURL: "http://127.0.0.1:3100",
    webOrigin: "http://127.0.0.1:5173",
    signupsEnabled: undefined,
    signupAllowlist: undefined,
  };
  const prisma = {
    deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    // Holds the OAuth state between the redirect and the callback.
    verification: {
      create: vi.fn(async ({ data }: { data: object }) => ({ id: "state", ...data })),
    },
  };
  const post = (path: string, body: unknown) =>
    new Request(`http://127.0.0.1:3100/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify(body),
    });

  afterEach(() => vi.unstubAllGlobals());

  it("refuses email sign-in when password auth is off", async () => {
    const auth = createAuth(prisma as never, { ...baseEnv, passwordAuth: false });
    const res = await auth.handler(
      post("/sign-in/email", { email: "you@example.com", password: "password123" }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("sends sign-in to the issuer with the core social callback", async () => {
    const issuer = "https://id.example.test/application/o/app/";
    const fetchMock = vi.fn(async () =>
      Response.json({
        issuer,
        authorization_endpoint: "https://id.example.test/application/o/authorize/",
        token_endpoint: "https://id.example.test/application/o/token/",
        userinfo_endpoint: "https://id.example.test/application/o/userinfo/",
        jwks_uri: `${issuer}jwks/`,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const auth = createAuth(prisma as never, {
      ...baseEnv,
      oidc: { issuer, clientId: "client", clientSecret: "secret", name: "SSO" },
    });

    const res = await auth.handler(
      post("/sign-in/social", {
        provider: OIDC_PROVIDER_ID,
        callbackURL: "http://127.0.0.1:5173/app",
      }),
    );

    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { url: string }).url);
    expect(`${url.origin}${url.pathname}`).toBe("https://id.example.test/application/o/authorize/");
    expect(url.searchParams.get("client_id")).toBe("client");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:3100/api/auth/callback/oidc",
    );
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(["openid", "email", "profile"]);
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("reports the provider unregistered when discovery fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );
    const auth = createAuth(prisma as never, {
      ...baseEnv,
      oidc: {
        issuer: "https://id.example.test/",
        clientId: "client",
        clientSecret: "secret",
        name: "SSO",
      },
    });

    await expect(oidcRegistered(auth)).resolves.toBe(false);
  });

  it("links unverified accounts only when password sign-in is off", () => {
    const oidc = {
      issuer: "https://id.example.test/",
      clientId: "c",
      clientSecret: "s",
      name: "SSO",
    };
    const linking = (passwordAuth: boolean) =>
      createAuth(prisma as never, { ...baseEnv, oidc, passwordAuth }).options.account
        ?.accountLinking?.requireLocalEmailVerified;

    expect(linking(true)).toBe(true);
    expect(linking(false)).toBe(false);
  });

  it("ends earlier sessions when SSO joins an unverified account", async () => {
    const oidc = {
      issuer: "https://id.example.test/",
      clientId: "c",
      clientSecret: "s",
      name: "SSO",
    };
    const onAccountCreated = createAuth(prisma as never, { ...baseEnv, oidc, passwordAuth: false })
      .options.databaseHooks?.account?.create?.after;
    const contextFor = (emailVerified: boolean) => {
      const internalAdapter = {
        findUserById: vi.fn(async () => ({ id: "user", emailVerified })),
        deleteUserSessions: vi.fn(async () => undefined),
      };
      return { internalAdapter, ctx: { context: { internalAdapter } } as never };
    };
    const account = { providerId: OIDC_PROVIDER_ID, userId: "user" } as never;

    const unverified = contextFor(false);
    await onAccountCreated?.(account, unverified.ctx);
    expect(unverified.internalAdapter.deleteUserSessions).toHaveBeenCalledWith("user");

    const verified = contextFor(true);
    await onAccountCreated?.(account, verified.ctx);
    expect(verified.internalAdapter.deleteUserSessions).not.toHaveBeenCalled();
  });

  describe("group Spaces", () => {
    const idToken = (claims: object) =>
      `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
    const oidc = {
      issuer: "https://id.example.test/",
      clientId: "c",
      clientSecret: "s",
      name: "SSO",
      groupSpaces: [{ group: "orca", spaceId: "space-1" }],
      onGroupSpaceMissing: vi.fn(),
    };
    const signIn = async (token: string | null) => {
      const groupPrisma = {
        deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
        spaceMember: { findFirst: vi.fn().mockResolvedValue({ id: "membership" }) },
      };
      const internalAdapter = {
        findUserById: vi.fn(async () => ({
          id: "user",
          email: "member@example.com",
          emailVerified: true,
        })),
        findAccounts: vi.fn(async () => [{ providerId: OIDC_PROVIDER_ID, idToken: token }]),
      };
      const beforeSession = createAuth(groupPrisma as never, { ...baseEnv, oidc }).options
        .databaseHooks?.session?.create?.before;
      await beforeSession?.({ userId: "user" } as never, { context: { internalAdapter } } as never);
    };

    afterEach(() => syncGroupSpaces.mockClear());

    it("syncs Space membership from the ID token groups at sign-in", async () => {
      syncGroupSpaces.mockResolvedValueOnce({ missingSpaceIds: ["space-1"] });
      await signIn(idToken({ sub: "user", groups: ["orca", "staff"] }));

      expect(syncGroupSpaces).toHaveBeenCalledWith(
        expect.anything(),
        "user",
        ["orca", "staff"],
        oidc.groupSpaces,
      );
      expect(oidc.onGroupSpaceMissing).toHaveBeenCalledWith(["space-1"]);
    });

    it("changes nothing when the token has no groups claim", async () => {
      await signIn(idToken({ sub: "user" }));
      await signIn(null);

      expect(syncGroupSpaces).not.toHaveBeenCalled();
    });

    it("reads groups from the configured claim", () => {
      expect(idTokenGroups(idToken({ roles: ["orca", 7] }), "roles")).toEqual(["orca"]);
      expect(idTokenGroups(idToken({ roles: "orca" }), "roles")).toBeUndefined();
      expect(idTokenGroups("not-a-jwt", "groups")).toBeUndefined();
      expect(idTokenGroups("a.%%%.c", "groups")).toBeUndefined();
    });
  });
});
