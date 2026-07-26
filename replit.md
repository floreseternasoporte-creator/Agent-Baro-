# DevAgent

## Overview

DevAgent is a Node.js and Express application with a mobile-first static frontend. It connects to a GitHub repository, builds a structural project profile, asks the configured AI provider for coding help, applies and verifies safe unified diffs automatically, executes approved JavaScript/Python checks inside an isolated workspace, and can commit and push approved changes.

## Running

```bash
PORT=5000 npm start
```

The Replit workflow is named `Start application`.

Python 3.11 is enabled in `.replit` for repository checks such as `python -m compileall` and `pytest`. The autonomous loop still requires an active AI provider: configure `OPENROUTER_API_KEY` or run Ollama with the configured model.

## User preferences

- The user communicates in Spanish; keep user-facing explanations in Spanish unless asked otherwise.