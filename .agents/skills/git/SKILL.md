---
name: git
description: Git workflow automation for committing, pushing, checking status, branches, and version control tasks. Triggered via /git command or explicit git instructions.
---

# Git Workflow Skill

This skill governs Git version control operations, repository status checks, commits, and remote pushing.

## Safeguards & Rules
- **STRICT REQUIREMENT**: ONLY execute `git` commands if the user explicitly triggers the `/git` command.
- **NO EXCEPTIONS**: If the user does not use the `/git` command, do NOT interact with `git` or execute any `git` commands under any circumstances (even if words like "push" or "commit" are used without `/git`).
- **No `cd` Commands**: Always execute shell commands with the current working directory set to the project root.

## Standard Workflows

### 1. Push Changes (`/git push` or "push")
When the user requests to push changes:
1. Stage all modified and untracked files:
   `git add .`
2. Commit with a clear, concise summary of the changes:
   `git commit -m "<Summary of changes>"`
3. Push to the remote repository:
   `git push`
4. Confirm successful execution and summarize the commit details.

### 2. Check Repository Status (`/git status` or "status")
1. Run `git status` to inspect modified, staged, or untracked files.
2. Provide a clear summary of working tree state.

### 3. View Recent History (`/git log` or "history")
1. Run `git log -n 5 --oneline` to inspect recent commits.
