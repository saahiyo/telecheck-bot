module.exports = {
  apps: [
    {
      name: "telecheck-bot",
      script: "src/bot.js",
      cwd: ".",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "250M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
