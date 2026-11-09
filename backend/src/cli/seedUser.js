#!/usr/bin/env node

import "dotenv/config";
import process from "node:process";
import readline from "node:readline";

import argon2 from "argon2";

import { parseEnvironment } from "../config/env.js";
import { closeMongo, connectMongo, getCollections } from "@orbik/core";
import { ensureIndexes } from "../db/indexes.js";
import { canonicalizeEmail, createUserRepository } from "../repositories/userRepository.js";

/**
 * Provisions one pre-provisioned user without placing a password in shell history.
 * Runs in every environment because signup is disabled: this is the only way to create
 * the operational account in production. The target database and email are echoed before
 * the password prompt so an unintended target can be abandoned with Ctrl+C.
 */
async function main() {
  const config = parseEnvironment(process.env);
  const email = parseEmailArgument(process.argv.slice(2));
  process.stdout.write(`Provisioning ${email} in ${config.nodeEnv} database "${config.databaseName}".\n`);
  const password = await promptHidden("Password: ");
  validatePassword(password);
  const database = await connectMongo(config);
  try {
    await ensureIndexes(database);
    const repository = createUserRepository(getCollections(database).users);
    await repository.create({
      email,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      status: "active",
    });
    process.stdout.write(`Created ${config.nodeEnv} user ${email}.\n`);
  } finally {
    await closeMongo();
  }
}

/**
 * Parses the operational CLI shape and canonicalizes its email value.
 * A leading bare "--" is dropped first: pnpm forwards the separator itself, so the
 * documented `pnpm seed:user -- --email ...` arrives here as three arguments.
 */
function parseEmailArgument(argumentsList) {
  const args = argumentsList[0] === "--" ? argumentsList.slice(1) : argumentsList;
  if (args.length !== 2 || args[0] !== "--email") {
    throw new Error("Usage: pnpm run seed:user -- --email user@example.com");
  }
  const email = canonicalizeEmail(args[1]);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new Error("Email must be a valid address of at most 254 characters.");
  }
  return email;
}

/** Applies the operational password boundary before expensive hashing. */
function validatePassword(password) {
  if (password.length < 8 || password.length > 1024) {
    throw new Error("Password must contain 8 to 1024 characters.");
  }
}

/** Reads a password from a real TTY without echoing or retaining it outside memory. */
function promptHidden(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.reject(new Error("A TTY is required for the hidden password prompt."));
  }
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    let value = "";
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    output.write(prompt);
    function finish(error) {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) reject(error); else resolve(value);
    }
    function onKeypress(character, key) {
      if (key?.ctrl && key.name === "c") return finish(new Error("Seeding cancelled."));
      if (key?.name === "return") return finish();
      if (key?.name === "backspace") value = value.slice(0, -1);
      else if (character && !key?.ctrl && !key?.meta) value += character;
    }
    input.on("keypress", onKeypress);
    input.resume();
  });
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
