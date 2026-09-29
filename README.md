# claude-compaction-tools

This project and its plugins have moved to **[agentic-tool-labs/agent-tools](https://github.com/agentic-tool-labs/agent-tools)**. This repository is archived and no longer updated.

## Switching an existing install

In Claude Code, uninstall the plugins you have from the old marketplace, remove it, and install them from the new one. Skip the lines for plugins you don't use.

```
/plugin uninstall idle-compactor@jcline-claude-compaction-tools
/plugin uninstall compaction-capture@jcline-claude-compaction-tools
/plugin uninstall compaction-guard@jcline-claude-compaction-tools
/plugin marketplace remove jcline-claude-compaction-tools

/plugin marketplace add agentic-tool-labs/agent-tools
/plugin install idle-compactor@agent-tools
/plugin install compaction-capture@agent-tools
/plugin install compaction-guard@agent-tools
```

If you already switched to `JimCline/agent-tools`, follow the steps at [JimCline/agent-tools](https://github.com/JimCline/agent-tools) instead.
