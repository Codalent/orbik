#!/usr/bin/env node

import "dotenv/config";
import process from "node:process";

import { closeMongo, connectMongo, getCollections } from "@orbik/core";
import { createCrawlBudget } from "@orbik/crawl-budget";
import { loadExtensions } from "@orbik/extensions";

import { parseEnvironment } from "../config/env.js";
import { ensureIndexes } from "../db/indexes.js";
import { canonicalizeEmail } from "../repositories/userRepository.js";

/**
 * Adds pages to one account's crawl budget for the current month.
 *
 * For a deployment whose plans set a monthly limit: an account that has spent its allowance
 * either waits for the next month or has an operator top it up here. The grant applies to **this
 * month only** — next month starts from the plan's allowance again — which is what keeps a
 * one-off top-up from quietly becoming a permanent plan change nobody decided on. With no plan
 * limits (the open-source edition) a month is unlimited and there is nothing to add.
 *
 * It loads the same extensions the processes do (`ORBIK_EXTENSIONS`), so a month it is the first
 * to touch gets the allowance the account's plan says, not an unlimited one.
 *
 * The target database, account, and amount are echoed before anything is written, so an
 * unintended target can be abandoned with Ctrl+C.
 */
async function main() {
  const config = parseEnvironment(process.env);
  const { email, pages, reason } = parseArguments(process.argv.slice(2));

  const database = await connectMongo(config);
  try {
    await ensureIndexes(database);
    const user = await getCollections(database).users.findOne({ email }, { projection: { _id: 1 } });
    if (!user) {
      // The address is echoed because an operator typing it needs to see what did not match. It
      // is their own input, not a lookup oracle exposed to anyone else.
      throw new Error(`No user with email ${email} exists in database "${config.databaseName}".`);
    }

    process.stdout.write(
      `Granting ${pages} crawl pages to ${email} in ${config.nodeEnv} database "${config.databaseName}".\n`,
    );
    await loadExtensions({ processName: "script", specifiers: process.env.ORBIK_EXTENSIONS, database, config });
    const budget = createCrawlBudget({ database });
    const { allowance, remaining, period, unlimited } = await budget.grant({ userId: user._id, pages, reason });
    process.stdout.write(unlimited
      ? `${period}: this account has no monthly page limit, so nothing was added.\n`
      : `${period}: ${remaining} of ${allowance} pages remaining.\n`);
  } finally {
    await closeMongo();
  }
}

/**
 * Parses and validates the CLI shape.
 *
 * A leading bare `--` is dropped first: pnpm forwards the separator itself, so the documented
 * `pnpm grant:crawl-budget -- --email ...` arrives here with it attached.
 *
 * @param {string[]} argumentsList arguments after the script name
 * @returns {{email: string, pages: number, reason: string}}
 * @throws {Error} with usage text when any argument is missing or malformed
 */
function parseArguments(argumentsList) {
  const args = argumentsList[0] === "--" ? argumentsList.slice(1) : argumentsList;
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = { "--email": "email", "--pages": "pages", "--reason": "reason" }[args[index]];
    if (!name) throw new Error(`Unknown argument "${args[index]}".\n\n${USAGE}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${args[index]} requires a value.\n\n${USAGE}`);
    }
    values[name] = value;
  }

  if (!values.email || !values.pages) throw new Error(`--email and --pages are required.\n\n${USAGE}`);

  const email = canonicalizeEmail(values.email);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new Error(`Email must be a valid address of at most 254 characters.\n\n${USAGE}`);
  }

  const pages = Number(values.pages);
  // Bounded above as well as below: a mistyped amount is the difference between granting 50,000
  // pages and granting 50,000,000, and only one of those is recoverable by asking nicely.
  if (!Number.isInteger(pages) || pages < 1 || pages > 10_000_000) {
    throw new Error(`--pages must be a whole number from 1 through 10000000.\n\n${USAGE}`);
  }

  const reason = (values.reason ?? "Granted by an operator.").trim();
  if (!reason || reason.length > 200) {
    throw new Error(`--reason must be 1-200 characters.\n\n${USAGE}`);
  }

  return { email, pages, reason };
}

const USAGE = `Usage: pnpm --dir backend run grant:crawl-budget -- --email user@example.com --pages 50000 [--reason "..."]`;

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 64;
    await closeMongo().catch(() => {});
  }
}
