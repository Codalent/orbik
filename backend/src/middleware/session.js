import MongoStore from "connect-mongo";
import session from "express-session";

/**
 * Creates a Mongo-backed production session store.
 * connect-mongo stores the serialized session under `session` and TTL time under `expires`;
 * neither physical field is part of the public API contract.
 */
function createSessionStore(config) {
  return MongoStore.create({
    mongoUrl: config.mongodbUri,
    dbName: config.databaseName,
    collectionName: "sessions",
    ttl: config.sessionMaxAgeSeconds,
    autoRemove: "native",
    stringify: false,
  });
}

/**
 * Says once, in the log, that an HTTPS install got a request it cannot tell came over HTTPS.
 *
 * The session cookie is Secure on such an install, and express-session will not set a Secure
 * cookie on a request Express believes is plain HTTP — silently: signing in "works" and the next
 * page is the sign-in page again. It happens when the proxy in front of the API does not say the
 * scheme (X-Forwarded-Proto), or when a proxy before that one is not trusted to (Caddy's
 * ORBIK_TRUSTED_PROXIES in the Docker install, TRUST_PROXY here).
 */
function warnOnPlainHttp(logger) {
  let warned = false;
  return function plainHttpWarning(req, _res, next) {
    if (!warned && !req.secure) {
      warned = true;
      logger("warn", "session.request_not_https", {
        detail: "This install's address is HTTPS, but a request reached the API as plain HTTP, so no session cookie can be set and nobody can stay signed in. Behind another proxy: the Docker install needs ORBIK_TRUSTED_PROXIES in .env; a direct install needs that proxy to send X-Forwarded-Proto and TRUST_PROXY to cover it.",
        protocol: req.protocol,
        forwardedProto: req.get("x-forwarded-proto") ?? null,
        peer: req.socket?.remoteAddress ?? null,
      });
    }
    next();
  };
}

/** Creates the documented opaque-cookie server session middleware. */
export function createSessionMiddleware(config, logger = null) {
  const sessions = createSession(config);
  if (!config.secureCookies || !logger) return sessions;
  const warning = warnOnPlainHttp(logger);
  return (req, res, next) => warning(req, res, () => sessions(req, res, next));
}

function createSession(config) {
  return session({
    name: config.cookieName,
    secret: config.sessionSecret,
    store: createSessionStore(config),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: "lax",
      path: "/",
      maxAge: config.sessionMaxAgeMs,
    },
  });
}
