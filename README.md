<div align="center">

# godly-mcp

**[Godly](https://godly.website) (now [Recent Design](https://recent.design)), right inside Claude.**
Search design references, browse the feeds, pull palettes as hex and watch motion frame by frame without leaving the chat.

[![MCP](https://img.shields.io/badge/MCP-server-1f1f1f?style=flat-square)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-3c873a?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-b5b5b5?style=flat-square)](LICENSE)

</div>

---

Godly was the go-to gallery for websites with bold animation and interaction. It now lives at **recent.design** (`godly.website` redirects there) and grew into a daily feed of interface, motion, branding and web work picked from X, plus recorded websites, launch videos, OG images, App Store screenshots, app icons, tools and agent skills.

This MCP server turns all of that into tools Claude (or any MCP client) calls on its own. It reads the same public, read-only API the site itself uses. No login, no saved items, no account data.

## Tools

| Tool | What it does |
| --- | --- |
| `godly_search` | Full-text search over titles, descriptions, creators and tags (`dark`, `3d`, `scroll-animation`, `microinteraction`, `saas`...). Filters by feed, category, tag and video-only. |
| `godly_browse` | Live listing of a feed, sorted by recent, popular or staff picks, with category/tag filters and pagination. |
| `godly_get` | Full details of one item: description, creator and original post/site, tags grouped by kind (color, style, interaction, framework...), **palette as hex with screen share**, media list, and pricing/links/install command for tools and skills. |
| `godly_taxonomy` | Every category (with post counts) and every tag grouped by kind, to use as filters. |
| `godly_media` | Shows the reference to the model: the still of each media, and with `frames > 0` it downloads the video and returns N frames spread over it (needs `ffmpeg`). Nothing is kept on disk unless `save: true`. |
| `godly_status` | Checks the API, the local index and `ffmpeg`. `refresh: true` rebuilds the index. |

Inputs accept a `recent.design/i/<id>-<slug>` URL, an old `godly.website` link, the 7-character id or the slug.

## Feeds

`x` (design posts from X), `websites` (recorded sites, the classic Godly), `launch-videos`, `og-images`, `app-store-screenshots`, `app-icons`, `tools`, `skills`.

## Install

Requires Node 18+. `ffmpeg` is optional (only for `frames`).

```bash
git clone https://github.com/G4rutti/godly-mcp.git
cd godly-mcp
npm install
```

### Claude Code

```bash
claude mcp add godly -- node /absolute/path/to/godly-mcp/src/server.js
```

### Claude Desktop / Cursor / any stdio client

```json
{
  "mcpServers": {
    "godly": {
      "command": "node",
      "args": ["/absolute/path/to/godly-mcp/src/server.js"]
    }
  }
}
```

## Example prompts

```text
find me dark portfolio sites with 3d on godly
```

```text
show me how this animates: https://recent.design/i/6wmr7uw-nothing-to-watch
```

```text
staff picks from the websites feed this week, and pull the palette of the best one
```

## How search works

The API has no text search, so on first use the server pages through every feed once (about 20 requests, spaced out) and keeps a local index at `~/.godly-mcp/index.json`. It refreshes after 12 hours. Every search after that is instant and offline.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `GODLY_MEDIA_DIR` | `~/godly-media` | Where `godly_media` saves when `save: true` |
| `GODLY_INDEX` | `~/.godly-mcp/index.json` | Index file |
| `GODLY_INDEX_TTL_H` | `12` | Hours before the index is rebuilt |
| `GODLY_UA` | `godly-mcp/<version>` | User-Agent sent to the API |

## Being a good citizen

Recent Design's `robots.txt` allows use **as reference** and forbids **AI training** (`Content-Signal: search=yes, ai-train=no, use=reference`). This server only fetches on demand when you ask, spaces its requests, caches, identifies itself with an honest User-Agent and credits the creator in every response. Don't use it to train models or to copy someone's work 1:1: use it to study and build something of your own, and credit the original.

Not affiliated with Godly or Recent Design. If the site changes its API, the tools will return an error until the client is updated.

## Development

```bash
npm run check   # boots the server over stdio and calls every tool against the live API
```

## License

[MIT](LICENSE)
