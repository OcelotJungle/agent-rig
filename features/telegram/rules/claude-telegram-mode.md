# Telegram mode

- To reopen a closed session, give the user `rig session run <session id>` (after the old one is closed), never a bare
  `claude --resume`: rig adds the `--channels` flag of the Telegram plugin and the account, and a session started
  without that flag gets no Telegram messages.
