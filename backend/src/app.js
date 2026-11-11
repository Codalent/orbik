import express from "express";

import { correlationId, errorHandler, notFound } from "./middleware/errors.js";
import { applySecurityMiddleware, DEVBAR_PATH } from "./middleware/security.js";
import { createSessionMiddleware } from "./middleware/session.js";
import { createCsrfProtection } from "./middleware/csrf.js";
import { createAgentSetupStore, createAiCallLog, getAgentCollections, getCollections, log } from "@orbik/core";
import { createUserRepository } from "./repositories/userRepository.js";
import { createWorkspaceRepository } from "./repositories/workspaceRepository.js";
import { createAuthService } from "./services/authService.js";
import { createAuthRouter } from "./routes/authRoutes.js";
import { createWorkspaceService } from "./services/workspaceService.js";
import { createWorkspaceRouter } from "./routes/workspaceRoutes.js";
import { createWorkspaceErasureRepository } from "./repositories/workspaceErasureRepository.js";
import { createCrawlRepository } from "./repositories/crawlRepository.js";
import { createCrawlService } from "./services/crawlService.js";
import { createCrawlRouter } from "./routes/crawlRoutes.js";
import { createHealthRouter } from "./routes/healthRoutes.js";
import { createRunRepository } from "./repositories/runRepository.js";
import { createAgentScheduleRepository } from "./repositories/agentScheduleRepository.js";
import { createRunService } from "./services/runService.js";
import { createRunRouter } from "./routes/runRoutes.js";
import { createAiCallRouter } from "./routes/aiCallRoutes.js";
import { createActivityRouter } from "./routes/activityRoutes.js";
import { createActivityService } from "./services/activityService.js";
import { createAiCallRepository } from "./repositories/aiCallRepository.js";
import { createAiCallService } from "./services/aiCallService.js";
import { createAgentSetupService } from "./services/agentSetupService.js";
import { createAgentSetupRouter } from "./routes/agentSetupRoutes.js";
import { createKnowledgeRepository } from "./repositories/knowledgeRepository.js";
import { createKnowledgeService } from "./services/knowledgeService.js";
import { createKnowledgeRouter } from "./routes/knowledgeRoutes.js";
import { createLibraryService } from "./services/libraryService.js";
import { createLibraryRouter } from "./routes/libraryRoutes.js";
import { createConversationRepository } from "./repositories/conversationRepository.js";
import { createConversationService } from "./services/conversationService.js";
import { createConversationRouter } from "./routes/conversationRoutes.js";
import { createMcpTokenRepository } from "./mcp/mcpTokenRepository.js";
import { createMcpTokenService } from "./mcp/mcpTokenService.js";
import { createMcpTokenRouter } from "./routes/mcpTokenRoutes.js";
import { createMcpService } from "./mcp/mcpService.js";
import { createMcpRouter } from "./mcp/mcpRoutes.js";
import { createMcpCallLog } from "./mcp/mcpCallLog.js";
import { createMcpUsageService } from "./services/mcpUsageService.js";
import { createOauthRepository } from "./oauth/oauthRepository.js";
import { createOauthClientService } from "./oauth/oauthClientService.js";
import { createOauthService } from "./oauth/oauthService.js";
import { createOauthRouter } from "./oauth/oauthRoutes.js";
import { createOauthConsentRouter } from "./routes/oauthConsentRoutes.js";
import { createBrandRepository } from "./repositories/brandRepository.js";
import { createBrandService } from "./services/brandService.js";
import { createBrandRouter } from "./routes/brandRoutes.js";
import { createAssetStore, createAssetUrlSigner } from "@orbik/assets";
import { createBrandChangeLog, createDesignSystemStore } from "@orbik/design-system";
import { createCrawlBudget } from "@orbik/crawl-budget";
import { createIndexEraser, createRetrieval } from "@orbik/retrieval";
import { createWorkspaceMemberRepository } from "./repositories/workspaceMemberRepository.js";
import { createWorkspaceInviteRepository } from "./repositories/workspaceInviteRepository.js";
import { createMemberService } from "./services/memberService.js";
import { createInviteService } from "./services/inviteService.js";
import { createMemberRouter } from "./routes/memberRoutes.js";
import { createInviteRouter } from "./routes/inviteRoutes.js";
import { createCredentialRelease } from "./mcp/credentialRelease.js";
import { createHomePreferenceRepository } from "./repositories/homePreferenceRepository.js";
import { createHomeService } from "./services/homeService.js";
import { createHomeRouter } from "./routes/homeRoutes.js";
import { createAgentOverviewRepository } from "./repositories/agentOverviewRepository.js";
import { createAgentOverviewService } from "./services/agentOverviewService.js";
import { createAgentOverviewRouter } from "./routes/agentOverviewRoutes.js";
import { createAiCallHooks, createExtensionHost } from "@orbik/extensions";
import { createEditionRouter } from "./routes/editionRoutes.js";
import { createSetupService } from "./services/setupService.js";
import { createEmailSender } from "./services/email.js";
import { createInstallAdmins } from "./services/installAdmin.js";
import { createAccessRequestService } from "./services/accessRequestService.js";
import { createPasswordResetService } from "./services/passwordResetService.js";
import { createAccessRouter } from "./routes/accessRoutes.js";
import { createWorkspaceAccessCheck } from "./services/workspaceAccess.js";
import { requireAuthentication } from "./middleware/auth.js";
import { AppError } from "./errors/appError.js";

/**
 * Assembles the complete API without opening a network listener.
 *
 * `extensions` is the host `loadExtensions` built at startup. Left out — a script, or a process
 * with `ORBIK_EXTENSIONS` unset — it is the open-source edition: every limit unlimited, nothing
 * listening, no extra routes.
 *
 * `devbar` is the development toolbar's handler (`createDevbar` from `@codalent/devbar/server`), made at
 * startup when ORBIK_DEVBAR is on; null otherwise, and nothing is served at /v1/devbar.
 */
export function createApp({ config, database, readiness, extensions = createExtensionHost({ processName: "api" }), devbar = null }) {
  const collections = getCollections(database);
  // Every plan limit core enforces is read through here: the workspace owner's, whoever acts.
  const limitsFor = (ownerId) => extensions.limitsFor(ownerId);
  const userRepository = createUserRepository(collections.users);
  const workspaceRepository = createWorkspaceRepository(collections.workspaces, collections.workspaceMembers);
  // The install's own admins (ORBIK_ADMIN_EMAILS, or its first account): the Admin page's people.
  const admins = createInstallAdmins({ users: collections.users, adminEmails: config.adminEmails ?? [] });
  const authService = createAuthService({
    userRepository,
    workspaceRepository,
    signup: { open: config.signup === "open", check: (attempt) => extensions.checkSignup(attempt), events: extensions },
    admins,
  });
  const setupService = createSetupService({ database, userRepository, events: extensions });
  const sendEmail = createEmailSender({ config, extensionSender: extensions.emailSender });
  // Getting in when signup is closed (an access request an admin approves), and back in without
  // the password (a reset link).
  const accessRequestService = createAccessRequestService({ database, userRepository, admins, config, sendEmail, events: extensions, logger: log });
  const passwordResetService = createPasswordResetService({ database, userRepository, config, sendEmail, logger: log });
  // Who besides the owner belongs to a workspace, and the invite links that add them.
  const memberRepository = createWorkspaceMemberRepository(collections.workspaceMembers);
  const inviteRepository = createWorkspaceInviteRepository(collections.workspaceInvites, collections.workspaces);
  // A person removed from a workspace, or leaving it, also lets go of the MCP tokens and OAuth
  // grants that read only it, and stops naming it in the ones that read others.
  const credentialRelease = createCredentialRelease(collections);
  const memberService = createMemberService({
    workspaceRepository,
    memberRepository,
    inviteRepository,
    userRepository,
    credentialRelease,
    limitsFor,
    logger: log,
  });
  const inviteService = createInviteService({
    workspaceRepository,
    inviteRepository,
    memberRepository,
    userRepository,
    config,
    limitsFor,
    sendEmail,
    events: extensions,
    logger: log,
  });
  const agentCollections = getAgentCollections(database);
  const crawlRepository = createCrawlRepository(agentCollections);
  // One reader of the month's page allowance for the API: the crawl page shows it.
  const crawlBudget = createCrawlBudget({ database, limitsFor });
  const crawlService = createCrawlService({
    workspaceRepository,
    crawlRepository,
    crawlBudget,
    database,
  });
  const setupStore = createAgentSetupStore({ database });
  const runRepository = createRunRepository(agentCollections);
  const aiCallRepository = createAiCallRepository(agentCollections);
  const runService = createRunService({
    workspaceRepository,
    runRepository,
    crawlRepository,
    limitsFor,
  });
  const agentSetupService = createAgentSetupService({
    workspaceRepository,
    setupStore,
    agentScheduleRepository: createAgentScheduleRepository(agentCollections),
    runRepository,
    crawlRepository,
  });
  const knowledgeRepository = createKnowledgeRepository(agentCollections, database);
  const knowledgeService = createKnowledgeService({
    workspaceRepository,
    knowledgeRepository,
    crawlRepository,
    runRepository,
  });
  // The search index, built once for the process. It holds an embedding credential and a Qdrant
  // client, so a copy per request would open a connection per request; and the reason it is null
  // rather than absent when unconfigured is that `content_search` must be able to say *why* it
  // cannot answer, rather than return an empty list a model would read as "the site says nothing".
  //
  // The API only ever reads it: a search for an MCP client or for the Library page's quick
  // switcher. Filling the index remains the agents worker's job, and no route here writes to it.
  const { index: retrieval, reason: retrievalReason } = createRetrieval({
    database,
    config,
    logger: log,
    callLog: createAiCallLog({ database, logger: log, hooks: createAiCallHooks({ database, host: extensions }) }),
  });
  if (!retrieval) log("info", "mcp.index_disabled", { code: retrievalReason.code });
  const libraryService = createLibraryService({
    workspaceRepository,
    knowledgeRepository,
    crawlRepository,
    runRepository,
    userRepository,
    database,
    retrieval,
    retrievalReason,
  });
  // The images of a workspace's brand, in the one store the agents worker writes them through.
  // Built once: it holds a GridFS bucket over the shared connection.
  const assetStore = createAssetStore({ database });
  // The signer behind the links an outside AI fetches an image by. Null without a secret, in
  // which case everything else about a brand is still served and the tools that would carry a
  // link say that links are not configured.
  const assetUrls = config.assetUrlSecret
    ? createAssetUrlSigner({ secret: config.assetUrlSecret, baseUrl: config.publicApiUrl })
    : null;
  if (!assetUrls) log("info", "brand.asset_links_disabled", { code: "ASSET_LINKS_NOT_CONFIGURED" });
  const designSystemStore = createDesignSystemStore({ database });
  const brandRepository = createBrandRepository({
    collections: agentCollections,
    assetStore,
    designSystemStore,
    changeLog: createBrandChangeLog({ database, designSystemStore, assetStore }),
  });
  const brandService = createBrandService({ workspaceRepository, brandRepository, assetUrls });
  // Chat reuses the run service rather than creating runs its own way, so a question costs, is
  // recorded and can be cancelled exactly as pressing Run on any agent does.
  const conversationService = createConversationService({
    workspaceRepository,
    conversationRepository: createConversationRepository(agentCollections),
    runRepository,
    runService,
    brandRepository,
  });

  // Workspaces themselves: made, listed and selected, renamed or moved to another website, and
  // deleted. Built after everything a deletion reaches into — the crawl, the brand images —
  // because removing a workspace is removing what each of them holds for it. The index
  // eraser needs only Qdrant, not the embedding key `retrieval` above needs, so a workspace indexed
  // before a key was taken away can still be removed from the index.
  const workspaceService = createWorkspaceService({
    userRepository,
    workspaceRepository,
    limitsFor,
    events: extensions,
    crawlRepository,
    erasure: createWorkspaceErasureRepository(database),
    credentialRelease,
    assetStore,
    indexEraser: createIndexEraser({ config }),
    logger: log,
  });

  const mcpTokenService = createMcpTokenService({
    mcpTokenRepository: createMcpTokenRepository(collections.mcpTokens),
    workspaceRepository,
  });
  // Orbik as an OAuth authorization server, which is how the clients that will not take a pasted
  // token — Claude.ai, Claude Desktop, ChatGPT — connect. It issues credentials the MCP endpoint
  // resolves to exactly what a pasted token resolves to, so nothing below this line knows which
  // kind it was handed.
  const oauthRepository = createOauthRepository(collections);
  const oauthClientService = createOauthClientService({ oauthRepository, config, logger: log });
  const oauthService = createOauthService({
    oauthRepository,
    oauthClientService,
    workspaceRepository,
    config,
    logger: log,
  });

  const mcpService = createMcpService({
    mcpTokenService,
    oauthService,
    workspaceRepository,
    crawlRepository,
    database,
    retrieval,
    retrievalReason,
    assetUrls,
  });
  // Every MCP tool call, kept for the settings page's "What your AI asked".
  const mcpCallLog = createMcpCallLog({ collection: collections.mcpCalls, logger: log });
  const mcpUsageService = createMcpUsageService({ workspaceRepository, mcpCallLog });

  // The Home page: a composition of the reads above — the crawl, the Library, the person's own
  // tokens and apps, the members, the brand — into one setup checklist, plus the one thing it
  // stores itself, each person's skips and hidden checklist.
  const homeService = createHomeService({
    workspaceRepository,
    crawlService,
    crawlRepository,
    libraryService,
    mcpTokenService,
    oauthService,
    memberRepository,
    inviteRepository,
    brandRepository,
    runRepository,
    userRepository,
    homePreferenceRepository: createHomePreferenceRepository(database),
  });

  // The Agents overview: every agent's newest run and schedule, in one read.
  const agentOverviewService = createAgentOverviewService({
    workspaceRepository,
    agentOverviewRepository: createAgentOverviewRepository(agentCollections),
  });

  const csrfProtection = createCsrfProtection(config);
  const app = express();
  app.use(correlationId);
  applySecurityMiddleware(app, config);
  app.use(createHealthRouter(readiness));
  // devbar, the development toolbar, when ORBIK_DEVBAR is on: no session, the API's CORS only.
  if (devbar) app.use(DEVBAR_PATH, devbar.handle);
  app.use(createEditionRouter({ extensions, config, setupRequired: () => setupService.required(), passwordReset: passwordResetService.selfService ? "email" : "admin" }));
  app.use(createSessionMiddleware(config, log));
  app.use(createAuthRouter({
    config,
    authService,
    setupService,
    csrfProtection,
    rateLimitCollection: collections.rateLimits,
  }));
  app.use(createAccessRouter({
    accessRequestService,
    passwordResetService,
    admins,
    authService,
    csrfProtection,
    rateLimitCollection: collections.rateLimits,
  }));
  app.use(createWorkspaceRouter({ workspaceService, csrfProtection }));
  app.use(createMemberRouter({ memberService, inviteService, csrfProtection, rateLimitCollection: collections.rateLimits }));
  app.use(createInviteRouter({ inviteService, csrfProtection, rateLimitCollection: collections.rateLimits }));
  app.use(createCrawlRouter({ crawlService, csrfProtection }));
  app.use(createRunRouter({ runService, csrfProtection }));
  app.use(createAiCallRouter({
    aiCallService: createAiCallService({ workspaceRepository, aiCallRepository }),
  }));
  app.use(createActivityRouter({
    activityService: createActivityService({
      workspaceRepository,
      crawlRepository,
      runRepository,
      aiCallRepository,
      userRepository,
    }),
  }));
  app.use(createAgentSetupRouter({ agentSetupService, csrfProtection }));
  app.use(createKnowledgeRouter({ knowledgeService, csrfProtection }));
  app.use(createLibraryRouter({ libraryService, csrfProtection }));
  app.use(createHomeRouter({ homeService, csrfProtection }));
  app.use(createAgentOverviewRouter({ agentOverviewService }));
  app.use(createBrandRouter({ brandService, csrfProtection, rateLimitCollection: collections.rateLimits }));
  app.use(createConversationRouter({ conversationService, csrfProtection }));
  app.use(createMcpTokenRouter({ mcpTokenService, oauthService, mcpUsageService, csrfProtection }));
  app.use(createOauthConsentRouter({ oauthService, csrfProtection }));
  // The last two are the ones outside software talks to, and neither takes a session. They share
  // the API's listener: one listener, one certificate, one nginx block to operate.
  app.use(createOauthRouter({
    oauthService,
    oauthClientService,
    config,
    rateLimitCollection: collections.rateLimits,
    logger: log,
  }));
  app.use(createMcpRouter({ mcpService, config, rateLimitCollection: collections.rateLimits, logger: log, callLog: mcpCallLog }));
  // An extension's routes, after every core route so none can shadow one. Each factory is handed
  // what a route of the API's own is built from; a route that needs a session uses
  // `requireAuthentication`, and one that writes uses `csrfProtection` as well.
  const http = Object.freeze({
    database,
    config,
    logger: log,
    AppError,
    requireAuthentication,
    csrfProtection,
    requireWorkspaceAccess: createWorkspaceAccessCheck(workspaceRepository),
  });
  for (const routes of extensions.routes) app.use(routes(http));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
