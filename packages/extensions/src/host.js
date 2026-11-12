import { log as defaultLog } from "@orbik/core";

import { UNLIMITED, normalizeLimits } from "./limits.js";

/**
 * Where an extension can be loaded: the three long-running processes, and `script` for an operator
 * command that must see the same plan limits (`grant:crawl-budget`). A script has none of the
 * process-specific hooks; an extension that registers routes, loops or agents checks
 * `host.process` first, as it must anyway.
 */
export const PROCESSES = Object.freeze(["api", "worker", "scheduler", "script"]);

/**
 * What an extension may listen for. Every event is told after the fact, and a listener that
 * throws is logged and otherwise ignored: an extension metering or mailing never fails the action
 * it is told about.
 *
 * - `account.created` (API): `{ user: { id, email }, via: "setup" | "signup" | "invite" }`
 * - `workspace.created` (API): `{ workspace: { id, name, websiteUrl, ownerId }, userId }`
 * - `workspace.deleted` (API): `{ workspace: { id, name, websiteUrl, ownerId }, userId }`, after
 *   every record of it core keeps is gone; an extension removes what it stored about it
 * - `ai.call.finished` (API and worker): `{ call }`, the `ai_calls` row as it was completed
 */
export const EVENTS = Object.freeze(["account.created", "workspace.created", "workspace.deleted", "ai.call.finished"]);

/** The edition a process is when no extension names another. */
export const COMMUNITY_EDITION = "community";

/** How long one account's resolved limits are reused before the resolver is asked again. */
const LIMITS_TTL_MS = 30_000;

/**
 * Collects what extensions register in one process, and answers for it at run time.
 *
 * Built empty, it is the open-source edition: unlimited limits, no listeners, no email sender
 * beyond the one core builds from its own configuration, no extra routes, loops or agents.
 *
 * @param {object} options
 * @param {string|null} options.processName `api`, `worker`, `scheduler`, or null for a script
 * @param {Function} [options.logger]
 * @param {() => number} [options.now] clock for the limits cache
 */
export function createExtensionHost({ processName = null, logger = defaultLog, now = () => Date.now() } = {}) {
  const loaded = [];
  let planLimits = null;
  let emailSender = null;
  let edition = null;
  const features = new Set();
  const signupChecks = [];
  const listeners = new Map(EVENTS.map((event) => [event, []]));
  const routes = [];
  const loops = [];
  const agents = [];
  const agentDefinitions = [];
  const tools = [];
  const runtimes = new Map();
  const limitsCache = new Map();

  /** One extension's view: the same registry, with its name attached to what it registers. */
  function registrar(extensionName, { database, config }) {
    const only = (wanted, method) => {
      if (processName !== wanted) {
        throw new Error(`${method} is only available in the ${wanted} process; this is ${processName ?? "a script"}. Check host.process first.`);
      }
    };
    const once = (current, what) => {
      if (current) throw new Error(`${what} is already provided by the ${current.extension} extension; only one may.`);
    };
    return Object.freeze({
      name: extensionName,
      process: processName,
      database,
      config,
      logger,

      /** Answers what an account may use; see `limits.js`. One extension per deployment. */
      setPlanLimits(resolve) {
        if (typeof resolve !== "function") throw new TypeError("setPlanLimits takes a function.");
        once(planLimits, "Plan limits are");
        planLimits = { extension: extensionName, resolve };
      },

      /** Listens for one of {@link EVENTS}. */
      on(event, handler) {
        if (!listeners.has(event)) throw new Error(`Unknown event ${event}. Known: ${EVENTS.join(", ")}.`);
        if (typeof handler !== "function") throw new TypeError("on takes an event name and a function.");
        listeners.get(event).push({ extension: extensionName, handler });
      },

      /** Names the edition the API reports to the web app, e.g. `cloud`. */
      setEdition(name) {
        only("api", "setEdition");
        if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
          throw new TypeError("An edition name is lowercase letters, digits and dashes.");
        }
        once(edition, "The edition is");
        edition = { extension: extensionName, name };
      },

      /** Feature names the web app shows extension UI for; a slot naming one is hidden otherwise. */
      addFeatures(...names) {
        only("api", "addFeatures");
        for (const name of names.flat()) {
          if (typeof name !== "string" || !/^[a-z][a-z0-9.-]{0,63}$/.test(name)) {
            throw new TypeError("A feature name is lowercase letters, digits, dots and dashes.");
          }
          features.add(name);
        }
      },

      /**
       * Adds routes to the API, mounted after every core route and before the 404 handler. Takes a
       * factory rather than a router because the helpers it is handed — authentication, CSRF, the
       * workspace access check, the error type — exist only once the API is assembled.
       *
       * @param {(http: object) => import("express").Router} factory
       */
      addRoutes(factory) {
        only("api", "addRoutes");
        if (typeof factory !== "function") throw new TypeError("addRoutes takes a function that returns a router.");
        routes.push({ extension: extensionName, factory });
      },

      /**
       * Replaces how the API sends email. One extension per deployment.
       *
       * @param {(message: {to: string, subject: string, text: string, html?: string}) => Promise<void>} send
       */
      setEmailSender(send) {
        only("api", "setEmailSender");
        if (typeof send !== "function") throw new TypeError("setEmailSender takes a function.");
        once(emailSender, "Email is");
        emailSender = { extension: extensionName, send };
      },

      /**
       * Runs before a self-service signup creates an account. Throwing refuses it; an error with
       * `status` and `code` is answered as given, anything else as a 500.
       *
       * @param {(attempt: {email: string, request: import("express").Request}) => Promise<void>} check
       */
      checkSignup(check) {
        only("api", "checkSignup");
        if (typeof check !== "function") throw new TypeError("checkSignup takes a function.");
        signupChecks.push({ extension: extensionName, check });
      },

      /**
       * Adds a periodic loop to the scheduler, started and stopped with the core ones.
       *
       * @param {{name?: string, start: () => Promise<void>, stop: () => Promise<void>}} loop
       */
      addLoop(loop) {
        only("scheduler", "addLoop");
        if (typeof loop?.start !== "function" || typeof loop?.stop !== "function") {
          throw new TypeError("addLoop takes an object with start() and stop().");
        }
        loops.push({ extension: extensionName, loop });
      },

      /**
       * Adds an agent to the worker: `{ name, version, handlers }`, validated as a core one is.
       * Its jobs are queued like any other, under its name.
       */
      addAgent(agent) {
        only("worker", "addAgent");
        agents.push({ extension: extensionName, agent });
      },

      /**
       * Adds agents to the catalog, in every process: the API lists them and starts their runs,
       * the scheduler runs their schedules, the worker executes them. Each is a definition in the
       * shape `@orbik/protocol` validates (`parseAgentDefinition`), checked as a core one is when
       * the process assembles its catalog after every extension has registered; a slug that is
       * already taken, or a tool no one provides, stops the process.
       *
       * A definition is executed by a model unless one of its `runtimeRequirements` names a
       * plain-code runtime, which an extension adds with {@link addRuntime}.
       */
      addAgentDefinitions(...definitions) {
        for (const definition of definitions.flat()) {
          if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
            throw new TypeError("addAgentDefinitions takes agent definitions (objects).");
          }
          agentDefinitions.push({ extension: extensionName, definition });
        }
      },

      /**
       * Adds tools an agent definition may be granted, in every process (definitions are checked
       * against them wherever the catalog is read; only the worker calls them). A tool is
       * `{ name, description, inputSchema, parseInput(input, errors), handler(input, context) }`,
       * checked when the process assembles its catalog. They are not served over MCP.
       */
      addTools(...added) {
        for (const tool of added.flat()) {
          if (!tool || typeof tool !== "object" || typeof tool.name !== "string") {
            throw new TypeError("addTools takes tools: objects with a name, description, inputSchema, parseInput and handler.");
          }
          tools.push({ extension: extensionName, tool });
        }
      },

      /**
       * Adds a plain-code runtime to the worker: code that executes a definition itself, chosen
       * for any definition whose `runtimeRequirements` names `requirement`. `build(collaborators)`
       * is called once when the worker starts, with what core's own plain-code runtimes are given,
       * and returns `{ run(request) }`; see docs/architecture/extensions.md § "Agents".
       *
       * @param {string} requirement lowercase words joined by hyphens, not one core already runs
       * @param {(collaborators: object) => {run: Function}} build
       */
      addRuntime(requirement, build) {
        only("worker", "addRuntime");
        if (typeof requirement !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(requirement) || requirement.length > 64) {
          throw new TypeError("A runtime requirement is lowercase words joined by hyphens, at most 64 characters.");
        }
        if (typeof build !== "function") throw new TypeError("addRuntime takes a requirement and a function that builds the runtime.");
        const taken = runtimes.get(requirement);
        if (taken) throw new Error(`The ${requirement} runtime is already provided by the ${taken.extension} extension; only one may.`);
        runtimes.set(requirement, { extension: extensionName, build });
      },
    });
  }

  /** Reads one account's limits, asking the resolver at most once per account per TTL. */
  async function limitsFor(ownerId) {
    if (!planLimits || ownerId === null || ownerId === undefined) return UNLIMITED;
    const key = String(ownerId);
    const cached = limitsCache.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
    const value = Promise.resolve()
      .then(() => planLimits.resolve({ ownerId }))
      .then(normalizeLimits);
    limitsCache.set(key, { value, expiresAt: now() + LIMITS_TTL_MS });
    // A failed lookup is not kept: the next call asks again rather than repeating the failure for
    // the rest of the TTL.
    value.catch(() => limitsCache.delete(key));
    return value;
  }

  /** Tells every listener of an event, in registration order; never throws. */
  async function emit(event, payload) {
    for (const { extension, handler } of listeners.get(event) ?? []) {
      try {
        await handler(payload);
      } catch (error) {
        logger("warn", "extension.listener_failed", { extension, event, message: error?.message ?? "unknown" });
      }
    }
  }

  /** Runs every signup check in order; the first to throw refuses the signup. */
  async function checkSignup(attempt) {
    for (const { check } of signupChecks) await check(attempt);
  }

  const host = {
    process: processName,
    /** Names of the extensions loaded, in load order. */
    get extensions() { return loaded.map((entry) => entry.name); },
    limitsFor,
    /** Whether an extension answers plan limits; without one every account is unlimited. */
    get hasPlanLimits() { return Boolean(planLimits); },
    /** Forgets cached limits — for an account, or all of them — after a plan changes. */
    forgetLimits(ownerId) {
      if (ownerId === undefined) limitsCache.clear();
      else limitsCache.delete(String(ownerId));
    },
    emit,
    checkSignup,
    edition() {
      return { name: edition?.name ?? COMMUNITY_EDITION, features: [...features].sort() };
    },
    get emailSender() { return emailSender?.send ?? null; },
    get routes() { return routes.map((entry) => entry.factory); },
    get loops() { return loops.map((entry) => entry.loop); },
    get agents() { return agents.map((entry) => entry.agent); },
    /** Agent definitions extensions added, for the process to put in its catalog. */
    get agentDefinitions() { return agentDefinitions.map((entry) => entry.definition); },
    /** Tools extensions added, for the catalog and the worker's tool registry. */
    get tools() { return tools.map((entry) => entry.tool); },
    /** Plain-code runtimes extensions added, by requirement: `{ [requirement]: build }`. */
    get runtimes() { return Object.fromEntries([...runtimes].map(([requirement, entry]) => [requirement, entry.build])); },

    /** Runs one extension's `register` against this host. Used by the loader. */
    async register(extension, { database = null, config = null } = {}) {
      if (loaded.some((entry) => entry.name === extension.name)) {
        throw new Error(`An extension named ${extension.name} is loaded twice.`);
      }
      loaded.push({ name: extension.name });
      await extension.register(registrar(extension.name, { database, config }));
    },
  };
  return host;
}
