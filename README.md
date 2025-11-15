# affine-cli

A command‑line interface for **AFFiNE** workspaces and documents.

`affine-cli` lets you:

- Authenticate once and work from the terminal.
- Inspect and manage workspaces (list, embeddings on/off).
- Create and edit real Yjs BlockSuite pages via the realtime channel.
- Read documents as markdown via AFFiNE's MCP tools.
- Run keyword and semantic search over your docs.
- Manage comments, blobs, and access tokens.

This tool communicates with **live AFFiNE servers** (self‑hosted or cloud) using affine's existing web APIs.

---

## Table of Contents

- [Installation](#installation)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Authentication](#authentication)
  - [Getting an access token](#getting-an-access-token)
  - [`auth login`](#auth-login)
  - [`auth logout`](#auth-logout)
  - [`whoami`](#whoami)
- [Configuration & Profiles](#configuration--profiles)
- [Core Commands](#core-commands)
  - [`ws` – workspaces](#ws--workspaces)
  - [`doc` – documents](#doc--documents)
  - [`search` – search](#search--search)
  - [`blob` – blobs](#blob--blobs)
  - [`comment` – comments](#comment--comments)
  - [`auth token` – access tokens](#auth-token--access-tokens)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

---

## Installation

You can install `affine-cli` globally, or use it on demand via `npx`.

```sh
# Global install
npm install -g affine-cli

# One‑shot usage
npx affine-cli --help
```

This installs the `affine` binary on your `PATH`.

---

## Requirements

- **Node.js**: `>= 20`
- A reachable **AFFiNE server** (cloud or self‑hosted).
- An **AFFiNE access token** (or cookie) for authenticated operations.

The CLI communicates with AFFiNE via:

- `https://…/graphql` for metadata, comments, tokens, etc.
- `https://…/api` for blob operations.
- A Socket.IO endpoint at your base URL for Yjs realtime docs.

---

## Quick Start

1. **Install** the CLI:

   ```sh
   npm install -g affine-cli
   ```

2. **Login** (guided, interactive, with validation):

   ```sh
   affine auth login --validate --open-browser
   ```

   - If you don't provide `--token`/`--cookie`, the CLI:
     - Points you at the AFFiNE web UI where you can create an access token.
     - Optionally opens that URL in your browser when `--open-browser` is set.
     - Prompts:

       ```text
       AFFiNE access token: <paste from browser>
       Base URL [https://api.affine.pro]:
       ```

   - It stores credentials in a config profile and runs `whoami` to confirm.

3. **Use the CLI**:

   ```sh
   affine whoami
   affine ws list
   affine doc list --workspace-id <workspace-id>
   affine search keyword "my term" --workspace-id <workspace-id>
   ```

No need to keep passing `--token`/`--cookie` after `auth login`; the CLI loads credentials from your profile.

---

## Authentication

### Getting an access token

The CLI does not issue tokens itself; it uses the same tokens your AFFiNE web app uses.

To obtain a token for the first time:

1. Open your AFFiNE web app (cloud or self‑hosted).
2. Sign in with your normal credentials.
3. Navigate to your account / settings / tokens page (exact location depends on your deployment).
4. Create a new access token.
5. Copy the token string.

You can either:

- Paste this token into `affine auth login` interactively, or
- Pass it directly with `--token` for non‑interactive scripts.

Once you have a valid token, you can create more from the CLI with `auth token create`.

### `auth login`

`auth login` writes credentials into your CLI config profile so you don't have to pass them on every command.

```sh
affine auth login [options]
```

**Options:**

- `--token <token>` – AFFiNE access token to store.
- `--cookie <cookie>` – cookie string to store instead of a token.
- `--base-url <url>` – AFFiNE API base URL (e.g. `https://api.affine.pro` or your self‑hosted URL).
- `--profile <name>` – config profile name (default: `default`).
- `--open-browser` – best‑effort attempt to open the AFFiNE web UI in your browser to help you create a token.
- `--validate` – after writing config, call `whoami` to verify credentials.
- `--json` – output a structured JSON summary.

**Typical usage:**

```sh
# Guided, interactive, with browser hint and validation
affine auth login --validate --open-browser

# Non‑interactive, e.g. in CI
affine auth login --profile ci --token "$AFFINE_TOKEN" --base-url "$AFFINE_BASE_URL" --validate --json
```

**JSON output example:**

```json
{
  "ok": true,
  "profile": "default",
  "apiBaseUrl": "https://api.affine.pro",
  "tokenSet": true,
  "cookieSet": false,
  "configPath": "/home/user/.affine/cli/config.json",
  "validation": {
    "ok": true,
    "userId": "…"
  }
}
```

If `--validate` fails (wrong token, wrong URL, or server down), the CLI still saves the config but reports the failure in the `validation` block and via a non‑zero exit code.

### `auth logout`

`auth logout` clears stored credentials (`token` and `cookie`) for a given profile.

```sh
affine auth logout [options]

Options:
  --profile <name>   Profile to clear (default: active profile)
  --json             JSON output
```

Example:

```sh
# Clear credentials for the default profile
affine auth logout

# Clear credentials for 'dev' profile
affine auth logout --profile dev

# Verify
affine whoami   # -> "Not authenticated"
```

Note: environment variables (`AFFINE_TOKEN`, `AFFINE_COOKIE`) still take precedence if set. Logout only affects the config file.

### `whoami`

`whoami` shows your current AFFiNE user, or reports that you're not authenticated.

```sh
affine whoami [--json]
```

- If authenticated, you'll see your user ID (and email if available).
- If not, text mode prints `Not authenticated`; JSON mode prints `null`.

The CLI probes multiple GraphQL fields (`me`, `currentUser`, `viewer`) to adapt to different AFFiNE server versions.

---

## Configuration & Profiles

`affine-cli` uses a JSON config file to persist settings:

- Default location: `~/.affine/cli/config.json`
- Override via:
  - `AFFINE_CONFIG_PATH`
  - or `AFFINE_CLI_CONFIG_PATH`

Structure:

```json
{
  "apiBaseUrl": "https://api.affine.pro",
  "profile": "default",
  "profiles": {
    "default": {
      "apiBaseUrl": "https://api.affine.pro",
      "token": "…",
      "cookie": "…"
    },
    "dev": {
      "apiBaseUrl": "https://dev.affine.local",
      "token": "…"
    }
  }
}
```

Precedence for HTTP options (highest → lowest):

1. CLI flags (`--base-url`, `--token`, `--cookie`, `--profile`).
2. Environment variables (`AFFINE_BASE_URL`, `AFFINE_TOKEN`, `AFFINE_COOKIE`, `AFFINE_PROFILE`, `AFFINE_API_BASE_URL`).
3. Config file: default + selected profile.

This means you can:

- Set global defaults via config.
- Override per‑shell via env.
- Override per‑command via flags.

`affine config show` makes it easy to inspect the merged view.

---

## Core Commands

### `ws` – workspaces

```sh
affine ws list
affine ws get <id>
affine ws embeddings enable <id>
affine ws embeddings disable <id>
```

- `ws list`: list workspaces (id + embeddings flag).
- `ws get`: show a workspace's id and embeddings state.
- `ws embeddings enable|disable`: toggle `enableDocEmbedding` for a workspace.

### `doc` – documents

```sh
affine doc list --workspace-id <id> [--first N] [--after cursor]
affine doc get <docId> --workspace-id <id>
affine doc read-md <docId> --workspace-id <id> [--json]
affine doc create --workspace-id <id> --title "Title" [--content "Body"]
affine doc append <docId> --workspace-id <id> --text "Paragraph"
affine doc delete <docId> --workspace-id <id> [--json]
affine doc publish <docId> --workspace-id <id> --mode Page|Edgeless
affine doc revoke <docId> --workspace-id <id>
```

Highlights:

- `doc create` / `doc append` use the realtime Yjs channel to create real BlockSuite pages and paragraphs.
- `doc read-md` uses MCP `read_document`:
  - If embeddings are disabled, it returns a helpful error with hints.
  - If the doc has been deleted in realtime but metadata still lingers, it detects the "doc not found" marker and treats it as missing.

### `search` – search

```sh
affine search keyword "<query>" --workspace-id <id> [--first N] [--json]
affine search semantic "<query>" --workspace-id <id> [--json]
```

- `search keyword`:
  - Uses GraphQL `searchDocs` when available.
  - Falls back to MCP `keyword_search` if configured.
  - Finally, scans recently updated docs via MCP `read_document` as a last resort.
- `search semantic`:
  - Uses MCP `semantic_search`.
  - Requires embeddings to be enabled; the CLI checks and gives clear hints if not.

### `blob` – blobs

```sh
affine blob upload <path> --workspace-id <id> --name <name> [--json]
affine blob get --workspace-id <id> --name <name> --out <file> [--redirect follow|manual] [--json]
affine blob rm --workspace-id <id> --name <name> [--json]
```

- `upload`: uploads a local file; optionally maps short aliases to internal blob keys.
- `get`:
  - `--redirect follow` (default): downloads the blob to `--out` and prints the path.
  - `--redirect manual`: returns a JSON payload with redirect location and status, without following (useful for tooling).
- `rm`: removes a blob by name.

### `comment` – comments

```sh
affine comment list <docId> --workspace-id <id> [--first N] [--after cursor]
affine comment add <docId> --workspace-id <id> --text "Comment text"
affine comment rm <docId> --workspace-id <id> --id <commentId>
```

- `list`: lists comments with id and plain‑text content (rich JSON normalized to text).
- `add`: creates a comment.
- `rm`: deletes a comment.

### `auth token` – access tokens

```sh
affine auth token list [--json]
affine auth token create --name <name> [--expires-at <ISO>]
affine auth token revoke <id>
```

Once you're authenticated via `auth login` (or env), you can manage user access tokens purely from the CLI.

---

## Examples

```sh
# List workspaces
affine ws list

# Enable embeddings for a workspace
affine ws embeddings enable <workspace-id>

# Create a Yjs page with initial content
affine doc create --workspace-id <ws-id> --title "My Page" --content "Hello AFFiNE!"

# Append a paragraph
affine doc append <doc-id> --workspace-id <ws-id> --text "Another paragraph"

# Read as markdown (JSON)
affine doc read-md <doc-id> --workspace-id <ws-id> --json

# Keyword search
affine search keyword "affine" --workspace-id <ws-id> --first 10 --json

# Semantic search
affine search semantic "how does auth work" --workspace-id <ws-id> --json

# Upload a file as a blob
affine blob upload ./src.txt --workspace-id <ws-id> --name "example.txt" --json

# Download it with manual redirect
affine blob get --workspace-id <ws-id> --name "example.txt" --out ./out.txt --redirect manual --json
```

---

## Troubleshooting

- **"Not authenticated" / 401 / 403:**
  - Check `affine whoami`.
  - Re‑run `affine auth login --validate`.
  - Ensure `AFFINE_BASE_URL`/`--base-url` matches your server and the token comes from that instance.

- **Embeddings / MCP errors:**
  - Enable embeddings for the workspace:

    ```sh
    affine ws embeddings enable <workspace-id>
    ```

  - Check your AFFiNE server's Copilot/MCP configuration.

- **Realtime errors (doc create/append/delete):**
  - Verify your base URL and cookie/token are valid.
  - Check server logs for Socket.IO or Yjs errors.

- **Search not returning fresh docs:**
  - The AFFiNE indexer is asynchronous. The CLI's keyword search already compensates with content scanning, but very fresh docs may take a few seconds to appear in GraphQL `searchDocs`.

---

## Development

Inside the repo:

```sh
# Install deps
npm install

# Build
npm run build

# Unit & integration tests
npm test

# E2E tests against a real AFFiNE server
export AFFINE_E2E=1
export AFFINE_BASE_URL=...
export AFFINE_TOKEN=...
export AFFINE_WORKSPACE_ID=...

npm run e2e:local
```

---

## License

`affine-cli` is released under the **MIT License**.

> Note: AFFiNE itself uses its own licensing (including Enterprise and Community/MPL 2.0 components). This CLI does not embed or redistribute AFFiNE server code; it is a client that talks to your AFFiNE instance over HTTP/WebSockets. Using `affine-cli` with an AFFiNE server does not change your obligations under AFFiNE's own licenses or terms.
