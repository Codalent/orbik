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

/** Creates the documented opaque-cookie server session middleware. */
export function createSessionMiddleware(config) {
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
