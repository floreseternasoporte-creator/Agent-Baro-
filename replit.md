# DevAgent

## Overview

DevAgent is a Node.js and Express application with a mobile-first static frontend. It connects to a GitHub repository, reads files from an isolated workspace, asks the configured AI provider for coding help, applies unified diffs, and can commit and push approved changes.

## Running

```bash
PORT=5000 npm start
```

The Replit workflow is named `Start application`.

## User preferences

- The user communicates in Spanish; keep user-facing explanations in Spanish unless asked otherwise.