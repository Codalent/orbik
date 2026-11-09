const path = require("node:path");

/**
 * Nine explicit PM2 process definitions. Secrets remain in untracked application env files;
 * this file sets only non-sensitive loopback runtime defaults.
 *
 * Every `cwd` is anchored to __dirname: PM2 resolves a relative `cwd` against the directory
 * pm2 was invoked from, so a bare "./backend" breaks whenever the helper scripts are run
 * from anywhere other than the repository root.
 *
 * The worker and scheduler processes declare no port. The frontend (3100) and backend (4100) remain the only
 * listeners in the system; agent progress is observed by reading MongoDB, so any number of
 * workers can be added without port coordination.
 */
module.exports = {
  apps: [
    {
      name: "orbik-frontend-dev",
      cwd: path.join(__dirname, "frontend"),
      script: "./node_modules/next/dist/bin/next",
      args: "dev --hostname 127.0.0.1 --port 3100",
      env: { NODE_ENV: "development" },
      autorestart: true,
      restart_delay: 2000,
      kill_timeout: 10000,
      listen_timeout: 10000,
    },
    {
      name: "orbik-frontend-prod",
      cwd: path.join(__dirname, "frontend"),
      script: "./node_modules/next/dist/bin/next",
      args: "start --hostname 127.0.0.1 --port 3100",
      env: { NODE_ENV: "production" },
      autorestart: true,
      restart_delay: 2000,
      kill_timeout: 10000,
      listen_timeout: 10000,
    },
    {
      name: "orbik-backend-dev",
      cwd: path.join(__dirname, "backend"),
      script: "./src/server.js",
      node_args: "--watch",
      env: { NODE_ENV: "development", HOST: "127.0.0.1", PORT: "4100" },
      autorestart: true,
      restart_delay: 2000,
      kill_timeout: 12000,
      listen_timeout: 10000,
    },
    {
      name: "orbik-worker-dev",
      cwd: path.join(__dirname, "agents"),
      script: "./src/worker.js",
      node_args: "--watch",
      env: { NODE_ENV: "development" },
      autorestart: true,
      restart_delay: 2000,
      // Longer than the backend's: a worker finishing an in-flight crawl job on SIGTERM is
      // normal, and killing it early only forces the job through lease recovery later.
      kill_timeout: 30000,
      listen_timeout: 10000,
    },
    {
      name: "orbik-worker-prod",
      cwd: path.join(__dirname, "agents"),
      script: "./src/worker.js",
      env: { NODE_ENV: "production" },
      autorestart: true,
      restart_delay: 2000,
      kill_timeout: 30000,
      listen_timeout: 10000,
    },
    {
      name: "orbik-scheduler-dev",
      cwd: path.join(__dirname, "agents"),
      script: "./src/scheduler.js",
      node_args: "--watch",
      env: { NODE_ENV: "development" },
      autorestart: true,
      restart_delay: 2000,
      kill_timeout: 10000,
      listen_timeout: 10000,
    },
    {
      name: "orbik-scheduler-prod",
      cwd: path.join(__dirname, "agents"),
      script: "./src/scheduler.js",
      env: { NODE_ENV: "production" },
      autorestart: true,
      restart_delay: 2000,
      kill_timeout: 10000,
      listen_timeout: 10000,
    },
    {
      name: "orbik-backend-prod",
      cwd: path.join(__dirname, "backend"),
      script: "./src/server.js",
      env: { NODE_ENV: "production", HOST: "127.0.0.1", PORT: "4100" },
      autorestart: true,
      restart_delay: 2000,
      kill_timeout: 12000,
      listen_timeout: 10000,
    },
  ],
};
