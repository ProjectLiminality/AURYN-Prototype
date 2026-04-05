# AURYN

AURYN is a voice-first AI assistant for the [InterBrain](https://github.com/projectliminality/InterBrain). It lives inside your knowledge garden as a custom UI — chat with your DreamNodes, load them as context, search by voice, and let AURYN reveal files directly in the DreamSpace.

## What it does

- **Chat** with Claude using your DreamNodes as context
- **Search** across your vault on every keystroke
- **Autocomplete** DreamNode names while you type
- **Petals** — load DreamNodes into context by mentioning them; they appear as icons you can click to navigate
- **Voice transcription** with vocabulary awareness — DreamNode names in your speech are auto-detected and loaded as petals (macOS Apple Silicon only)
- **Reveal** — ask AURYN to show you a file, it opens in the DreamSpace

## Prerequisites

1. [InterBrain](https://github.com/projectliminality/InterBrain) installed in Obsidian
2. Claude API key set in InterBrain settings (Settings → AI Magic → Claude API Key)
3. [uv](https://docs.astral.sh/uv/getting-started/installation/) installed — `curl -LsSf https://astral.sh/uv/install.sh | sh`

**Transcription** additionally requires macOS with Apple Silicon (uses mlx-whisper). Chat and search work on any platform.

## Install

Click this link with Obsidian open:

```
obsidian://interbrain-clone?ids=github.com/projectliminality/AURYN-Prototype
```

This clones AURYN into your vault root and registers it as a DreamNode.

## First run

Open AURYN in the InterBrain — click it in the constellation or navigate to it. Then open its custom UI (the `</>` button or via the context menu).

The server starts automatically. On first launch it will take ~10 seconds to build the search index across your vault. After that, search is instant.

## Usage

- **Type** to search your vault — results appear below the input
- **Tab** on a result to load it as a petal (context)
- **Enter** on a result to open it in the InterBrain
- **Type a message and Enter** to chat with Claude
- **Mic button** to transcribe voice — speak DreamNode names and they load automatically
- **Ask AURYN to reveal a file** — e.g. "show me the README for DreamTalk" — it opens in the DreamSpace

## Notes

- AURYN uses Claude via the API key you set in InterBrain settings — no separate key needed
- The server runs locally on port 8080 while the custom UI is open and stops when you close it
- This is a prototype — things may be rough around the edges
