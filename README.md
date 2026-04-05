# AURYN

AURYN is a chatbot with a dynamic context layer — it speaks the language of your knowledge garden.

Install it into the [InterBrain](https://github.com/projectliminality/InterBrain) and it becomes aware of every DreamNode in your vault. Reference them while you type, speak their names out loud, or load them as context petals. The richer your garden, the richer your conversations.

## What it does

**Dynamic context (petals)**
- Type `@` to reference any DreamNode by name — it loads as a context petal with its thumbnail
- Speak DreamNode names during voice transcription — they are auto-detected and loaded as petals
- Click any petal to navigate to that DreamNode in the DreamSpace
- Click **clear** to drop all loaded context and start fresh

**Voice transcription**
- 30-second Whisper chunks with vocabulary awareness
- DreamNode names from your garden are injected as transcription hints — the model learns your language
- First pass transcribes, feeds BM25 semantic search, enriches vocabulary; second pass retranscribes with enriched vocab
- Detected DreamNode names load as petals automatically
- Drop an audio file into the chat to transcribe it the same way

**Chat**
- Streams responses from Claude using your loaded petals as context
- Full chat history with session browsing
- Start a new thread any time via the history panel

**Vocabulary panel**
- Always visible at the bottom — shows core, pinned, and ephemeral vocab
- Click **edit** to customize the core vocabulary (persisted to `~/.auryn/core-vocab.txt`)

## What this points toward

DreamNodes are universal vehicles — they contain tools, knowledge, and context. AURYN's ability to load knowledge dynamically is also the ability to load skills and tools dynamically. A DreamNode with CLI tools becomes a capability AURYN can invoke. The dynamic context layer is the foundation for a dynamic agentic layer.

## Prerequisites

1. [InterBrain](https://github.com/projectliminality/InterBrain) installed in Obsidian
2. Claude API key set in InterBrain settings (Settings → AI Magic → Claude API Key)
3. [uv](https://docs.astral.sh/uv/getting-started/installation/) — `curl -LsSf https://astral.sh/uv/install.sh | sh`

**Voice transcription** additionally requires:
- macOS with Apple Silicon (uses mlx-whisper large-v3-turbo)
- [ffmpeg](https://ffmpeg.org/) — `brew install ffmpeg`

Chat and search work on any platform.

## Install

Click this link with Obsidian open:

```
obsidian://interbrain-clone?ids=github.com/projectliminality/AURYN-Prototype
```

This clones AURYN into your vault root and registers it as a DreamNode.

## Usage

Open AURYN in the InterBrain and open its custom UI. The server starts automatically — first launch takes ~10 seconds to build the search index.

- **`@` + name** — reference a DreamNode, load it as context
- **Mic button** — record voice; DreamNode names detected and loaded as petals
- **Drag audio file** — transcribe with the same vocabulary-aware pipeline
- **Click petal** — navigate to that DreamNode in DreamSpace
- **clear** — drop all loaded context petals
- **history** — browse and resume previous chat sessions
- **reload** — restart the server

## Notes

- Recordings saved to `recordings/`, daily transcripts to `transcripts/` — both gitignored
- Server runs on port 47392 while the UI is open
- This is a prototype
