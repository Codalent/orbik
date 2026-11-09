#!/usr/bin/env node

import "dotenv/config";
import process from "node:process";

import { closeMongo, connectMongo, getCollections } from "@orbik/core";

import { parseEnvironment } from "../config/env.js";
import { ensureIndexes } from "../db/indexes.js";
import { canonicalizeEmail, createUserRepository } from "../repositories/userRepository.js";
import { createPasswordResetService } from "../services/passwordResetService.js";

/**
 * Prints a one-time password reset link for an account, for an install that sends no email: the
 * operator hands it to the person, who opens it and chooses a new password. It works once, for an
 * hour, and replaces the account's earlier links. The Admin page makes the same link.
 *
 *   pnpm --dir backend run reset:password -- --email user@example.com
 */
async function main() {
  const config = parseEnvironment(process.env);
  const args = process.argv.slice(2)[0] === "--" ? process.argv.slice(3) : process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--email") throw new Error("Usage: pnpm run reset:password -- --email user@example.com");
  const email = canonicalizeEmail(args[1]);
  const database = await connectMongo(config);
  try {
    await ensureIndexes(database);
    const service = createPasswordResetService({
      database,
      userRepository: createUserRepository(getCollections(database).users),
      config,
    });
    const { url, expiresAt } = await service.issueFor({ email, admin: { email: "reset:password" } });
    process.stdout.write(`Reset link for ${email} in ${config.nodeEnv} database "${config.databaseName}", valid until ${expiresAt}:\n${url}\n`);
  } finally {
    await closeMongo();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
