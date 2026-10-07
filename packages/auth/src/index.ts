import type { TransactionalEmail, TransactionalEmailProvider } from "@rakazo/adapter-kit";
import { PRODUCT_NAME } from "@rakazo/contracts";
import {
  allowlistedSignupAdmission,
  emailAllowed,
  firstAccountClaimDecision,
  isMessagingEmail,
  parseAllowlist,
  signupPolicyFromEnv,
} from "@rakazo/core";
import {
  bootstrapUserSpace,
  type GroupSpace,
  type PrismaClient,
  syncGroupSpaces,
} from "@rakazo/db";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { bearer, organization } from "better-auth/plugins";
import { genericOAuth } from "better-auth/plugins/generic-oauth";

/** Provider id of the operator's OpenID Connect identity provider. */
export const OIDC_PROVIDER_ID = "oidc";

export interface OidcProvider {
  /** Issuer URL; discovery is read from `<issuer>/.well-known/openid-configuration`. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Button label, e.g. the identity provider's name. */
  name: string;
  /** Provider groups whose members share a Space; synced at every sign-in. */
  groupSpaces?: GroupSpace[];
  /** ID token claim that lists the user's groups. Default `groups`. */
  groupsClaim?: string;
  /** Reports group mappings that point at a Space that does not exist. */
  onGroupSpaceMissing?: (spaceIds: string[]) => void;
}

export interface AuthEnv {
  secret: string;
  baseURL: string;
  webOrigin: string;
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
  /** Operator identity provider. Its users skip the signup policy: the provider decides who gets in. */
  oidc?: OidcProvider;
  /** Email and password sign-in and sign-up. Default on. */
  passwordAuth?: boolean;
  extraOrigins?: string[];
  email?: TransactionalEmailProvider;
  onEmailError?: (error: unknown) => void;
  beforeDeleteUser?: (userId: string) => Promise<void>;
  /** Runs when a session row is deleted. Delivery also drops a token whose session is missing or expired. */
  afterDeleteSession?: (session: AuthSession) => Promise<void>;
  /** Runs when a password change replaces the caller's own session instead of ending it. */
  afterReplaceSession?: (previous: AuthSession, session: AuthSession) => Promise<void>;
}

type AuthSession = { id: string; userId: string };

export async function resolveSignupPolicy(
  prisma: Pick<PrismaClient, "deploymentSettings">,
  env: Pick<AuthEnv, "signupsEnabled" | "signupAllowlist">,
): Promise<{ enabled: boolean; allowlist: string[] }> {
  const settings = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { signupsEnabled: true, signupAllowlist: true, signupPolicyInitialized: true },
  });
  if (settings?.signupPolicyInitialized) {
    return {
      enabled: settings.signupsEnabled,
      allowlist: parseAllowlist(settings.signupAllowlist),
    };
  }
  return signupPolicyFromEnv(env);
}

const signupGates = new Map<string, Array<() => Promise<void>>>();

/** Serializes first-account admission inside this process. */
let signupGateTail: Promise<void> = Promise.resolve();

/**
 * Transaction-scoped lock shared by every API process. Held from the
 * allowlist check until that signup finishes, so a second signup cannot
 * insert a user until the first one is visible.
 */
const FIRST_ACCOUNT_ADMISSION_LOCK = 872014;

function enqueueSignupGate(): { wait: Promise<void>; done: () => void } {
  let settle: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const wait = signupGateTail;
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    settle();
  };
  signupGateTail = gate;
  return { wait, done };
}

/**
 * Hold the first-account gate until the signup handler finishes, so a second
 * allowlisted signup cannot insert a user until the first one is visible.
 * The transaction commits on release, which drops the advisory lock.
 */
async function holdFirstAccountGate(prisma: PrismaClient): Promise<{
  admission: "open" | "needs-delivery";
  release: () => Promise<void>;
}> {
  const turn = enqueueSignupGate();
  await turn.wait;
  let resolveReady: (admission: "open" | "needs-delivery") => void = () => undefined;
  let rejectReady: (error: unknown) => void = () => undefined;
  let readySettled = false;
  const ready = new Promise<"open" | "needs-delivery">((resolve, reject) => {
    resolveReady = (admission) => {
      if (readySettled) return;
      readySettled = true;
      resolve(admission);
    };
    rejectReady = (error) => {
      if (readySettled) return;
      readySettled = true;
      reject(error);
    };
  });
  let releaseGate: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  // The catch must not rethrow. Nothing waits on this promise until the
  // signup's after hook, so a later timeout would otherwise be an unhandled
  // rejection. A failure after admission must not replace a completed signup:
  // the account may already exist, and a 500 would leave the client unable to
  // retry that address.
  const finished = prisma
    .$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FIRST_ACCOUNT_ADMISSION_LOCK})`;
        const otherHuman = await tx.user.findFirst({
          where: {
            NOT: { email: { endsWith: "@messaging.invalid", mode: "insensitive" } },
          },
          select: { id: true },
        });
        resolveReady(otherHuman ? "needs-delivery" : "open");
        await released;
      },
      { timeout: 20_000, maxWait: 10_000 },
    )
    .catch((error: unknown) => {
      rejectReady(error);
    })
    .finally(() => {
      turn.done();
    });
  try {
    const admission = await ready;
    return {
      admission,
      release: async () => {
        releaseGate();
        await finished;
      },
    };
  } catch (error) {
    turn.done();
    if (error instanceof APIError) throw error;
    throw new APIError("INTERNAL_SERVER_ERROR");
  }
}

function rememberSignupGate(email: string, release: () => Promise<void>) {
  const key = email.trim().toLowerCase();
  const pending = signupGates.get(key) ?? [];
  pending.push(release);
  signupGates.set(key, pending);
}

async function releaseSignupGate(email: string) {
  const key = email.trim().toLowerCase();
  const pending = signupGates.get(key);
  const release = pending?.shift();
  if (!pending?.length) signupGates.delete(key);
  await release?.();
}

/**
 * One allowlisted account may skip mailbox proof when nothing can send mail.
 * Admission is reserved before the user row is inserted. This claim is the
 * backstop: the deployment-settings row is locked, then a conditional owner
 * update lets only one overlapping signup win. Any other human account,
 * verified or not, denies the exemption.
 */
async function claimUnverifiedFirstAccount(prisma: PrismaClient, userId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM deployment_settings WHERE id = 'default' FOR UPDATE`;
    const [settings, otherHuman] = await Promise.all([
      tx.deploymentSettings.findUnique({
        where: { id: "default" },
        select: { ownerUserId: true },
      }),
      tx.user.findFirst({
        where: {
          id: { not: userId },
          NOT: { email: { endsWith: "@messaging.invalid", mode: "insensitive" } },
        },
        select: { id: true },
      }),
    ]);
    const decision = firstAccountClaimDecision({
      userId,
      ownerUserId: settings?.ownerUserId ?? null,
      otherHuman: otherHuman !== null,
    });
    if (decision === "deny") return false;
    if (decision === "claim") {
      const claimed = await tx.deploymentSettings.updateMany({
        where: { id: "default", ownerUserId: null },
        data: { ownerUserId: userId },
      });
      if (claimed.count !== 1) return false;
    }
    // The signup user can still be invisible here when this runs inside the
    // auth transaction. Mark the row when it is already committed; the caller
    // also updates it through the auth adapter.
    await tx.user.updateMany({
      where: { id: userId },
      data: { emailVerified: true },
    });
    return true;
  });
}

const CREDENTIAL_PATHS = ["/sign-in/email", "/sign-up/email", "/request-password-reset"] as const;

/** Shared across API processes. Off outside production so tests can sign in freely. */
export function authRateLimitOptions(nodeEnv = process.env.NODE_ENV) {
  const rule = { window: 15 * 60, max: 10 };
  return {
    enabled: nodeEnv === "production",
    storage: "database" as const,
    customRules: Object.fromEntries(CREDENTIAL_PATHS.map((path) => [path, rule])),
  };
}

export function createAuth(prisma: PrismaClient, env: AuthEnv) {
  return betterAuth({
    appName: PRODUCT_NAME,
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: buildTrustedOrigins(env),
    rateLimit: authRateLimitOptions(),
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    // The operator's identity provider vouches for its email, so its sign-in
    // may join an existing account with that address.
    account: env.oidc
      ? {
          accountLinking: {
            trustedProviders: [OIDC_PROVIDER_ID],
            // Better Auth will not link into an account whose email was never
            // verified, so whoever registered the address first cannot inherit
            // the sign-in. Without password sign-in that registration has no way
            // in, and installs without email never verify anyone.
            requireLocalEmailVerified: env.passwordAuth !== false,
          },
        }
      : undefined,
    emailAndPassword: {
      enabled: env.passwordAuth !== false,
      // Signup policy is mutable deployment state, so the request hook below
      // enforces it instead of freezing an environment value at process start.
      disableSignUp: false,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: env.email
        ? async ({ user, url }) => {
            // Keep the response timing generic. Production providers track and retry the promise,
            // while the composition root drains accepted delivery during graceful shutdown.
            void env.email
              ?.send(passwordResetEmail(user, url))
              .catch((error) => env.onEmailError?.(error));
          }
        : undefined,
    },
    emailVerification: {
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: env.email
        ? async ({ user, url }) => {
            const verificationUrl = new URL(url);
            verificationUrl.searchParams.set(
              "callbackURL",
              new URL("/sign-in", env.webOrigin).href,
            );
            await env.email!.send(verificationEmail(user.email, verificationUrl.href));
          }
        : undefined,
    },
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          await env.beforeDeleteUser?.(user.id);
          const memberships = await prisma.member.findMany({
            where: { userId: user.id },
            select: {
              organizationId: true,
              organization: { select: { members: { select: { userId: true } } } },
            },
          });
          const personalOrganizationIds = memberships
            .filter(({ organization }) =>
              organization.members.every((member) => member.userId === user.id),
            )
            .map(({ organizationId }) => organizationId);

          await prisma.$transaction([
            prisma.deploymentSettings.updateMany({
              where: { ownerUserId: user.id },
              data: { ownerUserId: null },
            }),
            // Messaging identities are deliberately FK-free, so clear them
            // here or the unique address would point at a deleted bot forever.
            prisma.messagingIdentity.deleteMany({
              where: { userId: user.id },
            }),
            prisma.organization.deleteMany({
              where: { id: { in: personalOrganizationIds } },
            }),
          ]);
        },
      },
    },
    plugins: [
      bearer(),
      organization({
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
        creatorRole: "owner",
      }),
      ...(env.oidc ? [oidcPlugin(env.oidc)] : []),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        for (const value of [ctx.body?.email, ctx.body?.newEmail]) {
          if (typeof value === "string" && isMessagingEmail(value)) {
            throw new APIError("BAD_REQUEST", { message: "Email is not available" });
          }
        }
        // Better Auth skips the password for a session under a day old, so a
        // borrowed session alone could delete the account.
        if (ctx.path === "/delete-user" && !ctx.body?.password) {
          throw new APIError("BAD_REQUEST", {
            message: "Invalid password",
            code: "INVALID_PASSWORD",
          });
        }
        let policy =
          ctx.path === "/sign-up/email" || ctx.path === "/sign-in/email"
            ? await resolveSignupPolicy(prisma, env)
            : undefined;
        let requireEmailVerification = false;
        if (ctx.path === "/sign-up/email") {
          if (!policy?.enabled) {
            throw new APIError("BAD_REQUEST", { message: "Registration is closed" });
          }
          const email = String(ctx.body?.email ?? "");
          if (!emailAllowed(email, policy.allowlist)) {
            throw new APIError("BAD_REQUEST", { message: "Email is not allowed to register" });
          }
          if (policy.allowlist.length > 0 && !env.email) {
            const held = await holdFirstAccountGate(prisma);
            if (held.admission === "needs-delivery") {
              await held.release();
              throw new APIError("BAD_REQUEST", {
                message: "Registration requires email delivery",
              });
            }
            rememberSignupGate(email, held.release);
            requireEmailVerification = false;
          } else {
            requireEmailVerification =
              allowlistedSignupAdmission({
                allowlistSize: policy.allowlist.length,
                hasEmailDelivery: Boolean(env.email),
                existingHumanCount: 0,
              }) === "verify";
          }
        } else if (policy) {
          requireEmailVerification = policy.allowlist.length > 0;
        }
        // Return a request-local override; mutating the shared auth options
        // would leak a concurrent request's policy into another signup.
        return {
          context: {
            context: {
              ...(policy
                ? {
                    options: {
                      emailAndPassword: { requireEmailVerification },
                    },
                  }
                : {}),
              internalAdapter: {
                ...ctx.context.internalAdapter,
                // Authorize at lookup: bearer conversion happens after before
                // hooks, and auth mutations also read sessions through here.
                findSession: async (token: string) => {
                  const session = await ctx.context.internalAdapter.findSession(token);
                  if (!session || isMessagingEmail(session.user.email)) return null;
                  if (session.user.emailVerified) return session;
                  policy ??= await resolveSignupPolicy(prisma, env);
                  return policy.allowlist.length === 0 ? session : null;
                },
              },
            },
          },
        };
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-up/email") {
          await releaseSignupGate(String(ctx.body?.email ?? ""));
        }
        const redacted = withoutSessionTokens(ctx.path, ctx.context.returned);
        if (redacted) return ctx.json(redacted);
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => {
            // The auth adapter can still be inside the signup transaction.
            const user = await ctx?.context.internalAdapter.findUserById(session.userId);
            const policy = await resolveSignupPolicy(prisma, env);
            if (!user || isMessagingEmail(user.email)) {
              throw new APIError("FORBIDDEN", { message: "Email verification required" });
            }
            if (!user.emailVerified && policy.allowlist.length > 0) {
              if (env.email || !emailAllowed(user.email, policy.allowlist)) {
                throw new APIError("FORBIDDEN", { message: "Email verification required" });
              }
              // Mailbox ownership is not proved. The claim serializes the exemption
              // so a second overlapping signup cannot take it as well.
              const admitted = await claimUnverifiedFirstAccount(prisma, user.id);
              if (!admitted || !ctx) {
                throw new APIError("FORBIDDEN", { message: "Email verification required" });
              }
              await ctx.context.internalAdapter.updateUser(user.id, { emailVerified: true });
            }
            if (env.oidc?.groupSpaces?.length && ctx) {
              const account = (await ctx.context.internalAdapter.findAccounts(user.id)).find(
                (candidate) => candidate.providerId === OIDC_PROVIDER_ID,
              );
              const groups = idTokenGroups(account?.idToken, env.oidc.groupsClaim ?? "groups");
              // No groups claim says nothing about membership, so nothing changes.
              if (groups) {
                const { missingSpaceIds } = await syncGroupSpaces(
                  prisma,
                  user.id,
                  groups,
                  env.oidc.groupSpaces,
                );
                if (missingSpaceIds.length > 0) env.oidc.onGroupSpaceMissing?.(missingSpaceIds);
              }
            }
            // Unverified signup must not provision resources or claim the
            // deployment owner. Bootstrap only at the first admitted session.
            const membership = await prisma.spaceMember.findFirst({ where: { userId: user.id } });
            if (!membership) {
              // The identity provider already decided this user may sign in.
              const admittedByProvider =
                env.oidc && ctx
                  ? (await ctx.context.internalAdapter.findAccounts(user.id)).some(
                      (account) => account.providerId === OIDC_PROVIDER_ID,
                    )
                  : false;
              if (
                !admittedByProvider &&
                (!policy.enabled || !emailAllowed(user.email, policy.allowlist))
              ) {
                throw new APIError("FORBIDDEN", { message: "Registration is closed" });
              }
              await bootstrapUserSpace(prisma, user, env);
            }
          },
          after: async (session, ctx) => {
            const previous = replacedSession(ctx);
            if (previous) await env.afterReplaceSession?.(previous, session);
          },
        },
        delete: {
          after: async (session, ctx) => {
            if (replacedSession(ctx)?.id !== session.id) await env.afterDeleteSession?.(session);
          },
        },
      },
      account: {
        create: {
          after: async (account, ctx) => {
            if (env.passwordAuth !== false || account.providerId !== OIDC_PROVIDER_ID || !ctx) {
              return;
            }
            // Joining an unverified account: end sessions its earlier owner may hold.
            const user = await ctx.context.internalAdapter.findUserById(account.userId);
            if (user && !user.emailVerified) {
              await ctx.context.internalAdapter.deleteUserSessions(account.userId);
            }
          },
        },
      },
      user: {
        create: {
          before: async (user) => {
            if (isMessagingEmail(user.email)) {
              throw new APIError("BAD_REQUEST", { message: "Email is not available" });
            }
          },
        },
        update: {
          before: async (user) => {
            if (user.email && isMessagingEmail(user.email)) {
              throw new APIError("BAD_REQUEST", { message: "Email is not available" });
            }
          },
        },
      },
    },
  });
}

/** Better Auth skips a provider whose discovery failed at startup. */
export async function oidcRegistered(auth: ReturnType<typeof createAuth>): Promise<boolean> {
  const context = await auth.$context;
  return context.socialProviders.some((provider) => provider.id === OIDC_PROVIDER_ID);
}

/**
 * Groups from an ID token Better Auth already verified and stored at this sign-in.
 * Undefined when the token or the claim is missing.
 */
export function idTokenGroups(idToken: string | null | undefined, claim: string) {
  const payload = idToken?.split(".")[1];
  if (!payload) return undefined;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const value = (claims as Record<string, unknown> | null)?.[claim];
  if (!Array.isArray(value)) return undefined;
  return value.filter((group): group is string => typeof group === "string");
}

function oidcPlugin(provider: OidcProvider) {
  const issuer = provider.issuer.endsWith("/") ? provider.issuer : `${provider.issuer}/`;
  return genericOAuth({
    config: [
      {
        providerId: OIDC_PROVIDER_ID,
        name: provider.name,
        discoveryUrl: new URL(".well-known/openid-configuration", issuer).href,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        scopes: ["openid", "email", "profile"],
        pkce: true,
        // The operator runs this provider; providers differ on whether they
        // send email_verified at all.
        mapProfileToUser: () => ({ emailVerified: true }),
      },
    ],
  });
}

export function verificationEmail(email: string, url: string): TransactionalEmail {
  return {
    to: email,
    subject: `Verify your ${PRODUCT_NAME} email`,
    text: `Verify your email, then return to ${PRODUCT_NAME} to sign in:\n\n${url}\n\nThis link expires in one hour. If you did not register, ignore this email.`,
    html: `<p><a href="${escapeHtml(url)}">Verify email</a>, then return to ${PRODUCT_NAME} to sign in.</p><p>This link expires in one hour. If you did not register, ignore this email.</p>`,
  };
}

export function passwordResetEmail(
  user: { id: string; email: string; name: string },
  resetUrl: string,
): TransactionalEmail {
  const name = user.name.trim() || "there";
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(resetUrl);
  return {
    to: user.email,
    subject: `Reset your ${PRODUCT_NAME} password`,
    text: [
      `Hi ${name},`,
      "",
      `Reset your ${PRODUCT_NAME} password using this link:`,
      resetUrl,
      "",
      "This link expires in one hour. If you did not request this, you can ignore this email.",
    ].join("\n"),
    html: `<p>Hi ${safeName},</p><p>Reset your ${PRODUCT_NAME} password:</p><p><a href="${safeUrl}">Reset password</a></p><p>This link expires in one hour. If you did not request this, you can ignore this email.</p>`,
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * Changing the password with revokeOtherSessions deletes every session, then signs the
 * caller in again, so the caller's device stays signed in under a new session.
 */
function replacedSession(
  ctx: { path?: string; context: { session?: { session: AuthSession } | null } } | null,
): AuthSession | undefined {
  return ctx?.path === "/change-password" ? ctx.context.session?.session : undefined;
}

/**
 * A session token is a bearer credential. Session reads describe sessions
 * without handing any of them out; sign-in and sign-up still return the token
 * they just issued. Returns the redacted body, or undefined to keep it.
 */
function withoutSessionTokens(
  path: string,
  returned: unknown,
): Record<string, unknown> | unknown[] | undefined {
  if (path === "/list-sessions" && Array.isArray(returned)) {
    return returned.map(withoutToken);
  }
  if (
    (path === "/get-session" || path === "/update-session") &&
    isRecord(returned) &&
    isRecord(returned.session)
  ) {
    return { ...returned, session: withoutToken(returned.session) };
  }
  return undefined;
}

function withoutToken(session: unknown): unknown {
  if (!isRecord(session)) return session;
  const { token: _token, ...rest } = session;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Assemble Better Auth trustedOrigins, adding localhost↔127.0.0.1 twins for loopback. */
export function buildTrustedOrigins(env: Pick<AuthEnv, "webOrigin" | "baseURL" | "extraOrigins">) {
  const configured = [env.webOrigin, env.baseURL, ...(env.extraOrigins ?? [])];
  const twins = [env.webOrigin, env.baseURL].flatMap(loopbackTwinOrigins);
  return [...new Set([...configured, ...twins])];
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/** Same-scheme/port localhost and 127.0.0.1 variants when `origin` is loopback. */
export function loopbackTwinOrigins(origin: string): string[] {
  try {
    const url = new URL(origin);
    if (!isLoopbackHost(url.hostname)) return [];
    const twins: string[] = [];
    for (const host of ["localhost", "127.0.0.1"] as const) {
      if (host === url.hostname) continue;
      const twin = new URL(origin);
      twin.hostname = host;
      twins.push(twin.origin);
    }
    return twins;
  } catch {
    return [];
  }
}

/**
 * Spaces are Better Auth organizations, but their lifecycle belongs to the
 * product RPCs. No client calls the organization plugin over HTTP, so every
 * route under it stays closed, including ones a future plugin version adds.
 */
export function isBlockedAuthPath(path: string): boolean {
  return path.startsWith("/organization");
}
